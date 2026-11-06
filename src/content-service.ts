import type { Cached, CredentialVault, NodeInfo, ReplyItem, TopicListItem, TopicPage, TopicThread } from './contract.js';
import { ContentCache, RequestBudget } from './cache.js';
import { V2exError, toPublicError } from './errors.js';
import { assertNodeName, assertPage, assertTopicId } from './validation.js';
import type { V2exApi, V2exNode, V2exReply, V2exTopic } from './v2ex-api.js';

const LIST_TTL = 60_000;
const DETAIL_TTL = 10 * 60_000;
const PAGE_SIZE = 20;

function item(topic: V2exTopic): TopicListItem {
  return {
    id: topic.id, title: topic.title.slice(0, 500),
    node: { name: topic.node.name, title: topic.node.title.slice(0, 200) },
    author: { username: topic.member.username }, replyCount: topic.replies,
    createdAt: new Date(topic.created * 1000).toISOString(),
    lastReplyAt: topic.last_touched ? new Date(topic.last_touched * 1000).toISOString() : null,
    url: `https://www.v2ex.com/t/${topic.id}`,
  };
}

function reply(value: V2exReply): ReplyItem {
  return { id: value.id, author: { username: value.member.username },
    content: (value.content ?? '').slice(0, 100_000), createdAt: new Date(value.created * 1000).toISOString() };
}

interface Flight { key: string; promise: Promise<Cached<unknown>>; controller: AbortController; waiters: number }

function stableError(error: unknown, code: 'incompatible_runtime' | 'upstream'): V2exError {
  return error instanceof V2exError ? error : new V2exError(code);
}

export class ContentService {
  private readonly flights = new Map<string, Flight>();
  private activeRequests = 0;
  private readonly waiting: Array<{ grant(): void }> = [];
  constructor(private readonly api: V2exApi, private readonly vault: CredentialVault,
    private readonly cache: ContentCache, private readonly budget: RequestBudget) {}

  private async withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new V2exError('timeout');
    if (this.activeRequests >= 4) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { grant: () => {
          signal.removeEventListener('abort', onAbort);
          this.activeRequests++;
          resolve();
        } };
        const onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new V2exError('timeout'));
        };
        this.waiting.push(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      this.activeRequests++;
    }
    try {
      if (signal.aborted) throw new V2exError('timeout');
      return await work();
    } finally {
      this.activeRequests--;
      this.waiting.shift()?.grant();
    }
  }

  private async load<T>(key: string, ttl: number, fetcher: (token: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<Cached<T>> {
    if (signal?.aborted) throw new V2exError('timeout');
    let token: string | undefined;
    try { token = await this.vault.resolve(); }
    catch (error) {
      if (signal?.aborted) throw new V2exError('timeout');
      throw stableError(error, 'incompatible_runtime');
    }
    if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new V2exError('not_authenticated');
    }
    if (signal?.aborted) throw new V2exError('timeout');
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        let cached: Cached<T> | undefined;
        try { cached = await this.cache.read<T>(key); }
        catch (error) {
          if (controller.signal.aborted) throw new V2exError('timeout');
          throw stableError(error, 'incompatible_runtime');
        }
        if (cached && !cached.stale) return cached;
        try {
          const value = await this.withSlot(controller.signal, async () => {
            if (!this.budget.reserve('interactive')) throw new V2exError('budget_exhausted');
            try { return await fetcher(token, controller.signal); }
            finally { this.budget.update(this.api.rateLimit); }
          });
          if (controller.signal.aborted) throw new V2exError('timeout');
          try { return await this.cache.writeSuccess(key, value, ttl); }
          catch (error) { throw stableError(error, 'incompatible_runtime'); }
        } catch (error) {
          if (controller.signal.aborted) throw new V2exError('timeout');
          const safe = stableError(error, 'upstream');
          if (!cached) throw safe;
          return { ...cached, stale: true, refreshError: toPublicError(safe) };
        }
      });
      flight = { key, promise, controller, waiters: 0 };
      this.flights.set(key, flight);
      void promise.finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); }).catch(() => {});
    }
    return this.join(flight, signal) as Promise<Cached<T>>;
  }

  private join(flight: Flight, signal?: AbortSignal): Promise<Cached<unknown>> {
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        flight.waiters--;
        if (flight.waiters === 0 && signal?.aborted) {
          if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
          flight.controller.abort();
        }
        return true;
      };
      const onAbort = () => { if (finish()) reject(new V2exError('timeout')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      void flight.promise.then((value) => { if (finish()) resolve(value); }, (error) => { if (finish()) reject(error); });
    });
  }

  latest(input: { page: number }, signal?: AbortSignal): Promise<Cached<TopicPage>> {
    const page = assertPage(input.page);
    return this.load(`latest:${page}`, LIST_TTL, async (token, requestSignal) => {
      const topics = await this.api.latest(page, token, requestSignal);
      return { items: topics.map(item), page, hasMore: topics.length >= PAGE_SIZE, stale: false };
    }, signal).then((result) => ({ ...result, value: { ...result.value, stale: result.stale } }));
  }

  hot(signal?: AbortSignal): Promise<Cached<TopicListItem[]>> {
    return this.load('hot:1', LIST_TTL, async (token, requestSignal) =>
      (await this.api.hot(token, requestSignal)).map(item), signal);
  }

  node(input: { node: string }, signal?: AbortSignal): Promise<Cached<NodeInfo>> {
    const name = assertNodeName(input.node);
    return this.load(`node-info:${name}`, DETAIL_TTL, async (token, requestSignal) => {
      const value: V2exNode = await this.api.node(name, token, requestSignal);
      return { name: value.name, title: value.title.slice(0, 200), topicCount: value.topics ?? null,
        url: `https://www.v2ex.com/go/${value.name}` };
    }, signal);
  }

  nodeTopics(input: { node: string; page: number }, signal?: AbortSignal): Promise<Cached<TopicPage>> {
    const name = assertNodeName(input.node);
    const page = assertPage(input.page);
    return this.load(`node:${name}:${page}`, LIST_TTL, async (token, requestSignal) => {
      const topics = await this.api.nodeTopics(name, page, token, requestSignal);
      return { items: topics.map(item), page, hasMore: topics.length >= PAGE_SIZE, stale: false };
    }, signal).then((result) => ({ ...result, value: { ...result.value, stale: result.stale } }));
  }

  replies(input: { topic: string; page: number }, signal?: AbortSignal): Promise<Cached<ReplyItem[]>> {
    const id = assertTopicId(input.topic);
    const page = assertPage(input.page);
    return this.load(`replies:${id}:${page}`, DETAIL_TTL, async (token, requestSignal) =>
      (await this.api.replies(id, page, token, requestSignal)).map(reply), signal);
  }

  async topic(input: { topic: string; replyPages: number }, signal?: AbortSignal): Promise<Cached<TopicThread>> {
    const id = assertTopicId(input.topic);
    if (!Number.isSafeInteger(input.replyPages) || input.replyPages < 0 || input.replyPages > 10) throw new V2exError('invalid_request');
    const topic = await this.load(`topic:${id}`, DETAIL_TTL, async (token, requestSignal) => {
      const value = await this.api.topic(id, token, requestSignal);
      return { topic: item(value), content: (value.content ?? '').slice(0, 100_000) };
    }, signal);
    const pages: Array<Cached<ReplyItem[]>> = [];
    for (let page = 1; page <= input.replyPages; page++) pages.push(await this.replies({ topic: String(id), page }, signal));
    const last = pages.at(-1)?.value ?? [];
    const stale = topic.stale || pages.some((page) => page.stale);
    return { value: { ...topic.value, replies: pages.flatMap((page) => page.value), replyPage: input.replyPages,
      hasMoreReplies: input.replyPages > 0 ? last.length >= PAGE_SIZE : topic.value.topic.replyCount > 0, stale },
      fetchedAt: topic.fetchedAt, stale, source: topic.source === 'cache' && pages.every((page) => page.source === 'cache') ? 'cache' : 'network',
      refreshError: topic.refreshError ?? pages.find((page) => page.refreshError)?.refreshError };
  }
}
