import { z } from 'zod';
import type { RateLimitState, TopicTab } from './contract.js';
import { V2exError } from './errors.js';
import { assertNodeName, assertPage, assertTab, assertTopicId } from './validation.js';

const ORIGIN = 'https://www.v2ex.com';
const API_PREFIX = '/api/v2/';
/** Official public JSON feed root. It carries the list feeds API 2.0 does not expose. */
const FEED_PREFIX = '/api/';
/** List page size shared by the Host content service and the browser view. */
export const LIST_PAGE_SIZE = 20;

const tokenSchema = z.object({
  scope: z.string().min(1).max(100),
  // Validity duration in seconds for current API responses; older absolute
  // timestamps are still accepted and normalised by `tokenExpiresAt`.
  expiration: z.number().int().nonnegative().max(8_640_000_000_000).nullable().optional(),
  good_for_days: z.number().int().nonnegative().max(10_000).optional(),
  created: z.number().int().nonnegative().optional(),
});
const memberSchema = z.object({
  id: z.number().int().nonnegative(),
  username: z.string().min(1).max(64),
  url: z.string().url().optional(),
  created: z.number().int().nonnegative().optional(),
});
const nodeSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1).max(64),
  title: z.string().max(500),
  url: z.string().url().optional(),
  topics: z.number().int().nonnegative().optional(),
});
const topicSchema = z.object({
  id: z.number().int().nonnegative(),
  title: z.string().max(10_000),
  url: z.string().url().optional(),
  content: z.string().max(1_000_000).nullable().optional(),
  content_rendered: z.string().max(1_000_000).nullable().optional(),
  replies: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  last_modified: z.number().int().nonnegative().optional(),
  last_touched: z.number().int().nonnegative().optional(),
  deleted: z.number().int().nonnegative().optional(),
  node: nodeSchema,
  member: memberSchema,
});
const replySchema = z.object({
  id: z.number().int().nonnegative(),
  content: z.string().max(1_000_000).nullable().optional(),
  content_rendered: z.string().max(1_000_000).nullable().optional(),
  created: z.number().int().nonnegative(),
  last_modified: z.number().int().nonnegative().optional(),
  member: memberSchema,
});

export type V2exToken = z.infer<typeof tokenSchema>;
export type V2exMember = z.infer<typeof memberSchema>;
export type V2exNode = z.infer<typeof nodeSchema>;
export type V2exTopic = z.infer<typeof topicSchema>;
export type V2exReply = z.infer<typeof replySchema>;

/** One topic row read from the public `/?tab=` HTML page. */
export interface V2exTabTopic {
  id: number;
  title: string;
  node: { name: string; title: string };
  author: string;
  replyCount: number;
  activityAt: string;
}

const TAB_PAGE_LIMIT = 60;
const TAB_ROW_PREFIX = '<div class="cell item">';
const TAB_TOPIC_LINK = /<span class="item_title"><a href="\/t\/([1-9][0-9]{0,15})#reply([0-9]{1,9})"[^>]*>([\s\S]{0,4000}?)<\/a><\/span>/;
const TAB_NODE_LINK = /<a class="node" href="\/go\/([a-zA-Z0-9_-]{1,64})"[^>]*>([\s\S]{0,600}?)<\/a>/;
const TAB_MEMBER_LINK = /<strong><a href="\/member\/([^"/<>\s]{1,64})"[^>]*>([\s\S]{0,600}?)<\/a><\/strong>/g;
const TAB_TIME_ATTR = /<span title="([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} [+-][0-9]{2}:[0-9]{2})"/;
const TAB_COUNT = /class="count_livid">([0-9]{1,9})<\/a>/;
const HTML_TAG = /<[^>]{0,512}>/g;
const HTML_CONTROL = /[\u0000-\u001f\u007f]+/g;
const HTML_ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', bull: '•', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
  deg: '°', plusmn: '±', frac12: '½', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§', euro: '€',
  pound: '£', yen: '¥', cent: '¢', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', spades: '♠',
  clubs: '♣', diams: '♦', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', lrm: '', rlm: '',
};

/** Decode the small, bounded plain-text subset used by V2EX topic rows. */
function plainText(value: string, limit: number): string {
  const decoded = value.replace(HTML_TAG, ' ').replace(HTML_ENTITY, (_match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? '';
  });
  return decoded.replace(HTML_CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function pageTimeIso(value: string): string | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2}):([0-9]{2})$/.exec(value);
  if (!match) return null;
  const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7]}${match[8]}:${match[9]}`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Parse the topic rows of one V2EX tab page. The page is server-rendered HTML,
 * so parsing is deliberately narrow: only rows that carry the complete
 * `item_title`/node/author/time markup are accepted, and every field is bounded.
 */
export function parseV2exTabPage(html: string): V2exTabTopic[] {
  const topics: V2exTabTopic[] = [];
  const seen = new Set<number>();
  let index = html.indexOf(TAB_ROW_PREFIX);
  while (index >= 0 && topics.length < TAB_PAGE_LIMIT) {
    const start = index + TAB_ROW_PREFIX.length;
    const next = html.indexOf(TAB_ROW_PREFIX, start);
    const block = html.slice(start, next >= 0 ? next : start + 20_000);
    index = next;
    const topic = TAB_TOPIC_LINK.exec(block);
    if (!topic) continue;
    const id = Number(topic[1]);
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue;
    const node = TAB_NODE_LINK.exec(block);
    const time = TAB_TIME_ATTR.exec(block);
    if (!node || !time) continue;
    const activityAt = pageTimeIso(time[1]!);
    const title = plainText(topic[3]!, 500);
    if (!activityAt || !title) continue;
    const members = [...block.matchAll(TAB_MEMBER_LINK)];
    const author = members.length ? plainText(members[0]![2], 64) : '';
    if (!author) continue;
    const count = TAB_COUNT.exec(block);
    const replyCount = count ? Number(count[1]) : Number(topic[2]);
    if (!Number.isSafeInteger(replyCount) || replyCount < 0) continue;
    seen.add(id);
    topics.push({
      id, title,
      node: { name: node[1]!, title: plainText(node[2], 200) || node[1]! },
      author, replyCount, activityAt,
    });
  }
  return topics;
}

export interface V2exApiOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  responseLimitBytes: number;
}

function headerInteger(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null && /^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isSafeInteger(value)) return value;
    }
  }
  return null;
}

function responseCode(status: number, message: unknown): V2exError {
  if (status === 401 || status === 403 ||
    (status === 200 && typeof message === 'string' && /token/i.test(message))) {
    return new V2exError(typeof message === 'string' && /expir/i.test(message) ? 'token_expired' : 'token_invalid');
  }
  if (status === 404) return new V2exError('not_found');
  if (status === 429) return new V2exError('rate_limited');
  return new V2exError('upstream');
}

export class V2exApi {
  private observedRateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };

  constructor(private readonly options: V2exApiOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
      !Number.isSafeInteger(options.responseLimitBytes) || options.responseLimitBytes <= 0) {
      throw new V2exError('invalid_request');
    }
  }

  get rateLimit(): RateLimitState { return { ...this.observedRateLimit }; }

  async readToken(token: string, signal?: AbortSignal): Promise<V2exToken> {
    return this.requestJson('token', token, tokenSchema, signal);
  }

  async readMember(token: string, signal?: AbortSignal): Promise<V2exMember> {
    return this.requestJson('member', token, memberSchema, signal);
  }

  async latest(page: number, token: string, signal?: AbortSignal): Promise<V2exTopic[]> {
    const requested = assertPage(page);
    // API 2.0 has no full-site latest feed, so use the official public JSON feed and
    // page locally; it currently returns the 38 newest topics per request.
    const topics = await this.readFeed('topics/latest.json', token, signal);
    return topics.slice((requested - 1) * LIST_PAGE_SIZE, requested * LIST_PAGE_SIZE);
  }

  async hot(token: string, signal?: AbortSignal): Promise<V2exTopic[]> {
    return this.readFeed('topics/hot.json', token, signal);
  }

  async node(name: string, token: string, signal?: AbortSignal): Promise<V2exNode> {
    return this.requestJson(`nodes/${assertNodeName(name)}`, token, nodeSchema, signal);
  }

  async nodeTopics(name: string, page: number, token: string, signal?: AbortSignal): Promise<V2exTopic[]> {
    const node = assertNodeName(name);
    const requested = assertPage(page);
    // API 2.0 list items omit `member` and `node`, so the panel could not show the
    // author; the public node feed carries both but has a single page of topics.
    if (requested > 1) return [];
    return this.readFeed(`topics/show.json?node_name=${node}`, token, signal);
  }

  async topic(id: number | string, token: string, signal?: AbortSignal): Promise<V2exTopic> {
    return this.requestJson(`topics/${assertTopicId(id)}`, token, topicSchema, signal);
  }

  async replies(id: number | string, page: number, token: string, signal?: AbortSignal): Promise<V2exReply[]> {
    return this.requestJson(`topics/${assertTopicId(id)}/replies?p=${assertPage(page)}`, token, z.array(replySchema), signal);
  }

  /**
   * Read every public node. `xna` is intentionally unsupported here: upstream
   * has no `/?tab=xna` topic page and serves the default tab instead.
   */
  async tabTopics(tab: TopicTab, token: string, signal?: AbortSignal): Promise<V2exTabTopic[]> {
    const value = assertTab(tab);
    if (value === 'xna') throw new V2exError('invalid_request');
    const { response, text } = await this.fetchBody(`?tab=${value}`, token, signal, '/', 'text/html', false);
    if (!response.ok) throw responseCode(response.status, undefined);
    if (!/^text\/html\b/i.test(response.headers.get('content-type') ?? '')) throw new V2exError('invalid_response');
    const topics = parseV2exTabPage(text);
    if (!topics.length) throw new V2exError('invalid_response');
    return topics;
  }

  async allNodes(token: string, signal?: AbortSignal): Promise<V2exNode[]> {
    const { response, text } = await this.fetchBody('nodes/all.json', token, signal, FEED_PREFIX, 'application/json');
    if (!response.ok) throw responseCode(response.status, undefined);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new V2exError('invalid_response'); }
    const parsed = z.array(nodeSchema).max(5_000).safeParse(json);
    if (!parsed.success) throw new V2exError('invalid_response');
    return parsed.data;
  }

  private observeRateLimit(headers: Headers): void {
    const limit = headerInteger(headers, ['x-rate-limit-limit', 'x-ratelimit-limit']);
    const remaining = headerInteger(headers, ['x-rate-limit-remaining', 'x-ratelimit-remaining']);
    const reset = headerInteger(headers, ['x-rate-limit-reset', 'x-ratelimit-reset']);
    this.observedRateLimit = {
      limit,
      remaining,
      resetAt: reset === null || reset > 8_640_000_000_000 ? null : new Date(reset * 1000).toISOString(),
    };
  }

  /**
   * Read one official public feed. Those responses are bare JSON arrays without
   * the API 2.0 `{ success, result }` envelope, and they include the author and
   * node objects the panel needs.
   */
  private async readFeed(path: string, token: string, signal?: AbortSignal): Promise<V2exTopic[]> {
    const { response, json } = await this.fetchJson(path, token, signal, FEED_PREFIX);
    if (!response.ok) throw responseCode(response.status, undefined);
    const parsed = z.array(topicSchema).safeParse(json);
    if (!parsed.success) throw new V2exError('invalid_response');
    return parsed.data.filter((topic) => topic.deleted !== 1);
  }

  private async fetchBody(path: string, token: string, signal: AbortSignal | undefined, prefix: string,
    accept: string, observeRateLimit = true): Promise<{ response: Response; text: string }> {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new V2exError('not_authenticated');
    const url = new URL(prefix + path, ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || !url.pathname.startsWith(prefix)) {
      throw new V2exError('invalid_request');
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
    try {
      const response = await this.options.fetch(url.toString(), {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: accept },
        signal: combined, redirect: 'error', cache: 'no-store',
      });
      // The HTML pages do not report rate-limit headers; observing them would
      // erase the state learned from the JSON API.
      if (observeRateLimit) this.observeRateLimit(response.headers);
      if (response.status === 404 || response.status === 429 || response.status >= 500) {
        throw responseCode(response.status, undefined);
      }
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > this.options.responseLimitBytes) throw new V2exError('invalid_response');
      if (!response.body) throw new V2exError('invalid_response');

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.options.responseLimitBytes) throw new V2exError('invalid_response');
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { throw new V2exError('invalid_response'); }
      return { response, text };
    } catch (error) {
      if (error instanceof V2exError) throw error;
      if (timeout.signal.aborted || signal?.aborted) throw new V2exError('timeout');
      throw new V2exError('offline');
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchJson(path: string, token: string, signal: AbortSignal | undefined,
    prefix: string): Promise<{ response: Response; json: unknown }> {
    const { response, text } = await this.fetchBody(path, token, signal, prefix, 'application/json');
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new V2exError('invalid_response'); }
    return { response, json };
  }

  private async requestJson<T>(path: string, token: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const { response, json } = await this.fetchJson(path, token, signal, API_PREFIX);
    const envelope = z.object({ success: z.boolean(), message: z.unknown().optional(), result: z.unknown().optional() }).safeParse(json);
    if (!envelope.success) throw new V2exError('invalid_response');
    if (!response.ok || !envelope.data.success) {
      throw responseCode(response.status, envelope.data.message);
    }
    const parsed = schema.safeParse(envelope.data.result);
    if (!parsed.success) throw new V2exError('invalid_response');
    return parsed.data;
  }
}
