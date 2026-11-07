import type { AuthService } from './credentials.js';
import type { ContentService } from './content-service.js';
import type { AccountStatus, ApiResult, Cached, PluginSettings, ReplyItem, TopicListItem, TopicPage, TopicThread } from './contract.js';
import { V2exError, toPublicError } from './errors.js';
import { assertNodeName, assertPage, assertTopicId } from './validation.js';
import type { IntelligenceService, SummaryMode } from './intelligence.js';
import type { InterestService } from './interests.js';
import type { RecommendationService } from './recommendations.js';
import { PluginSettingsSchema } from './store.js';

const PREFIX = '/api/v2ex';
const MAX_LOGIN_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PAGE_SIZE = 20;
const MAX_EMBEDDED_REPLY_PAGES = 3;
const ROUTED_METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'];
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export interface V2exRouteServices { auth: Pick<AuthService, 'status' | 'login' | 'logout'>; credential: { resolve(): Promise<string | undefined> }; content: Pick<ContentService, 'latest' | 'hot' | 'node' | 'nodeTopics' | 'topic' | 'replies'>; intelligence?: Pick<IntelligenceService, 'summarizeTopic'>; interests?: Pick<InterestService, 'perform'>; recommendations?: Pick<RecommendationService, 'list' | 'feedback' | 'markRead' | 'clear'>; settings?: { get(): Promise<PluginSettings>; update(settings: PluginSettings): Promise<PluginSettings> } }
export interface V2exFetchRoute { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }
export interface FetchConnection { fetch?: { register(route: V2exFetchRoute): unknown } }

function json<T>(result: ApiResult<T>, status = 200, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify(result);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: toPublicError(new V2exError('invalid_response')) }),
      { status: 502, headers: JSON_HEADERS });
  }
  return new Response(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

const secretShape = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|(?:bearer|token)[=: ]+[A-Za-z0-9_-]{8,})/i;

function accountStatus(value: unknown, secrets: Array<string | undefined>): AccountStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new V2exError('invalid_response');
  const fields = Object.keys(value);
  if (fields.length !== 5 || !['authenticated', 'writable', 'username', 'tokenScope', 'expiresAt'].every(key => fields.includes(key))) {
    throw new V2exError('invalid_response');
  }
  const status = value as Record<string, unknown>;
  if (typeof status.authenticated !== 'boolean' || typeof status.writable !== 'boolean' ||
      !(status.username === null || typeof status.username === 'string' && status.username.length <= 100 && !/[\u0000-\u001f\u007f]/.test(status.username)) ||
      !(status.tokenScope === null || typeof status.tokenScope === 'string' && status.tokenScope.length <= 128 && !/[\u0000-\u001f\u007f]/.test(status.tokenScope)) ||
      !(status.expiresAt === null || typeof status.expiresAt === 'string' &&
        status.expiresAt.length <= 40 && !Number.isNaN(Date.parse(status.expiresAt)) &&
        new Date(status.expiresAt).toISOString() === status.expiresAt)) {
    throw new V2exError('invalid_response');
  }
  for (const field of [status.username, status.tokenScope, status.expiresAt]) {
    if (typeof field === 'string' && (secretShape.test(field) || secrets.some(secret => secret && field.includes(secret)))) {
      throw new V2exError('invalid_response');
    }
  }
  return { authenticated: status.authenticated, writable: status.writable,
    username: status.username as string | null, tokenScope: status.tokenScope as string | null,
    expiresAt: status.expiresAt as string | null };
}

function boundedTopicPage(result: Cached<TopicPage>): Cached<TopicPage> & { truncated: boolean; omittedItems: number } {
  const items = result.value.items.slice(0, PAGE_SIZE);
  const omittedItems = result.value.items.length - items.length;
  return { ...result, value: { ...result.value, items, hasMore: result.value.hasMore || omittedItems > 0 },
    truncated: omittedItems > 0, omittedItems };
}

function boundedHot(result: Cached<TopicListItem[]>): Cached<TopicListItem[]> & { truncated: boolean; omittedItems: number } {
  const value = result.value.slice(0, PAGE_SIZE);
  const omittedItems = result.value.length - value.length;
  return { ...result, value, truncated: omittedItems > 0, omittedItems };
}

function boundedRecommendationList(result: Awaited<ReturnType<RecommendationService['list']>>) {
  const all = result.items;
  const items = all.slice(0, 100);
  const bounded = { ...result, items, truncated: items.length < all.length, omittedItems: all.length - items.length };
  while (Buffer.byteLength(JSON.stringify({ ok: true, data: bounded })) > MAX_RESPONSE_BYTES && bounded.items.length) {
    bounded.items.pop(); bounded.truncated = true; bounded.omittedItems++;
  }
  if (!bounded.items.length && all.length) throw new V2exError('invalid_response');
  return bounded;
}

function boundedReplies(result: Cached<ReplyItem[]>): Cached<ReplyItem[]> & { truncated: boolean; omittedReplies: number } {
  if (result.value.length > PAGE_SIZE) throw new V2exError('invalid_response');
  const value = result.value.map(reply => ({ ...reply, content: reply.content.slice(0, 256) }));
  return { ...result, value, truncated: result.value.some(reply => reply.content.length > 256), omittedReplies: 0 };
}

function boundedTopic(result: Cached<TopicThread>, replyPages: number): Cached<TopicThread> & { truncated: boolean; omittedReplies: number } {
  if (result.value.replyPage !== replyPages || result.value.replies.length > replyPages * PAGE_SIZE) {
    throw new V2exError('invalid_response');
  }
  const replies = result.value.replies;
  const content = result.value.content.slice(0, 4_000);
  const value = { ...result.value, content, replies: replies.map(reply => ({ ...reply, content: reply.content.slice(0, 256) })) };
  return { ...result, value, truncated: content.length < result.value.content.length ||
    replies.some(reply => reply.content.length > 256), omittedReplies: 0 };
}

function statusFor(code: ReturnType<typeof toPublicError>['code']): number {
  switch (code) {
    case 'invalid_request': return 400;
    case 'not_authenticated': case 'token_invalid': case 'token_expired': return 401;
    case 'history_access_denied': return 403;
    case 'not_found': return 404;
    case 'rate_limited': case 'budget_exhausted': return 429;
    case 'timeout': return 504;
    case 'offline': case 'ai_unavailable': case 'incompatible_runtime': return 503;
    case 'invalid_response': case 'upstream': return 502;
  }
}

function failure(error: unknown, status?: number, headers: Record<string, string> = {}): Response {
  const publicError = toPublicError(error);
  return json({ ok: false, error: publicError }, status ?? statusFor(publicError.code), headers);
}

function params(url: URL, allowed: string[]): URLSearchParams {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new V2exError('invalid_request');
  }
  return url.searchParams;
}

function page(value: string | null): number {
  if (value === null) return 1;
  if (!/^[1-9][0-9]*$/.test(value)) throw new V2exError('invalid_request');
  return assertPage(Number(value));
}

async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_LOGIN_BYTES) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_LOGIN_BYTES) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new V2exError('invalid_request'); }
}

async function loginBody(request: Request): Promise<string> {
  const value = await readBody(request);
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 1 || typeof Reflect.get(value, 'token') !== 'string') {
    throw new V2exError('invalid_request');
  }
  const token = Reflect.get(value, 'token') as string;
  if (!token || token.length > MAX_LOGIN_BYTES || /[\r\n]/.test(token)) throw new V2exError('invalid_request');
  return token;
}

async function logoutOption(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const value = await readBody(request);
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 1 || typeof Reflect.get(value, 'clearPersonalData') !== 'boolean') {
    throw new V2exError('invalid_request');
  }
  return Reflect.get(value, 'clearPersonalData') as boolean;
}

async function summaryBody(request: Request): Promise<{ topic: string; mode: SummaryMode; replyPages: number }> {
  const value = await readBody(request);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['topic', 'mode', 'replyPages'].includes(key)) ||
    Object.keys(value).length < 2) throw new V2exError('invalid_request');
  const input = value as Record<string, unknown>;
  if (typeof input.topic !== 'string') throw new V2exError('invalid_request');
  const topic = String(assertTopicId(input.topic));
  if (input.mode !== 'quick' && input.mode !== 'viewpoints' && input.mode !== 'full') throw new V2exError('invalid_request');
  const replyPages = input.replyPages === undefined ? 1 : input.replyPages;
  if (!Number.isSafeInteger(replyPages) || (replyPages as number) < 1 || (replyPages as number) > 3) throw new V2exError('invalid_request');
  return { topic, mode: input.mode, replyPages: replyPages as number };
}

async function recommendationMutation(request: Request, feedback: boolean): Promise<{ topicId: number; value?: 'interested' | 'not_interested' }> {
  const body = await readBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new V2exError('invalid_request');
  const keys = Object.keys(body);
  const expected = feedback ? ['topicId', 'value'] : ['topicId'];
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) throw new V2exError('invalid_request');
  const topicId = Reflect.get(body, 'topicId');
  if (!Number.isSafeInteger(topicId) || topicId < 1) throw new V2exError('invalid_request');
  if (!feedback) return { topicId };
  const value = Reflect.get(body, 'value');
  if (value !== 'interested' && value !== 'not_interested') throw new V2exError('invalid_request');
  return { topicId, value };
}

async function settingsBody(request: Request): Promise<PluginSettings> {
  const parsed = PluginSettingsSchema.safeParse(await readBody(request));
  if (!parsed.success || parsed.data.pagesPerNode > 2) throw new V2exError('invalid_request');
  return parsed.data;
}

class BodyTooLarge extends Error {}

function route(path: string, methods: string[], services: V2exRouteServices): V2exFetchRoute {
  return { path: PREFIX + path, methods: ROUTED_METHODS, requestBody: 'buffered', async fetch(request) {
    if (new URL(request.url).pathname !== PREFIX + path) return failure(new V2exError('not_found'));
    if (!methods.includes(request.method)) {
      return failure(new V2exError('invalid_request'), 405, { allow: methods.join(', ') });
    }
    try {
      const query = new URL(request.url);
      if (request.method !== 'GET') {
        const origin = request.headers.get('origin');
        if (origin !== null && origin !== query.origin ||
            request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
          throw new V2exError('invalid_request');
        }
        if (request.body && !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
          throw new V2exError('invalid_request');
        }
      }
      if (path === '/session') {
        params(query, []);
        if (request.method === 'POST') {
          const token = await loginBody(request);
          const prior = await services.credential.resolve();
          return json({ ok: true, data: accountStatus(await services.auth.login(token), [token, prior]) });
        }
        const clearPersonalData = request.method === 'DELETE' ? await logoutOption(request) : false;
        const prior = await services.credential.resolve();
        if (request.method === 'DELETE') await services.auth.logout(clearPersonalData);
        return json({ ok: true, data: accountStatus(await services.auth.status(), [prior]) });
      }
      if (path === '/topic/summary') {
        params(query, []);
        const input = await summaryBody(request);
        const thread = await services.content.topic({ topic: input.topic, replyPages: input.replyPages }, request.signal);
        if (!services.intelligence) throw new V2exError('ai_unavailable');
        return json({ ok: true, data: await services.intelligence.summarizeTopic({ topic: thread.value, mode: input.mode }, request.signal) });
      }
      if (path === '/interests') {
        params(query, []);
        if (!services.interests) throw new V2exError('ai_unavailable');
        let action: string;
        let payload: unknown;
        if (request.method === 'GET') action = 'get';
        else if (request.method === 'DELETE') {
          if (request.body) throw new V2exError('invalid_request');
          action = 'clear';
        } else if (request.method === 'PUT') {
          action = 'update'; payload = await readBody(request);
        } else {
          const body = await readBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof Reflect.get(body, 'action') !== 'string') {
            throw new V2exError('invalid_request');
          }
          action = Reflect.get(body, 'action') as string;
          const keys = Object.keys(body);
          if (action === 'feedback') {
            if (keys.length !== 3 || !['action', 'topicId', 'interested'].every(key => keys.includes(key))) throw new V2exError('invalid_request');
            payload = { topicId: Reflect.get(body, 'topicId'), interested: Reflect.get(body, 'interested') };
          } else if (keys.length !== 1 || !['authorize', 'revoke', 'relearn'].includes(action)) throw new V2exError('invalid_request');
        }
        const result = await services.interests.perform(action, payload, request.signal);
        if (action === 'clear') await services.recommendations?.clear();
        return json({ ok: true, data: result });
      }
      if (path === '/recommendations') {
        params(query, []);
        if (!services.recommendations) throw new V2exError('ai_unavailable');
        return json({ ok: true, data: boundedRecommendationList(await services.recommendations.list()) });
      }
      if (path === '/recommendations/feedback') {
        params(query, []);
        if (!services.recommendations) throw new V2exError('ai_unavailable');
        const input = await recommendationMutation(request, true);
        await services.recommendations.feedback(input as { topicId: number; value: 'interested' | 'not_interested' });
        return json({ ok: true, data: { updated: true } });
      }
      if (path === '/recommendations/read') {
        params(query, []);
        if (!services.recommendations) throw new V2exError('ai_unavailable');
        const input = await recommendationMutation(request, false);
        await services.recommendations.markRead(input.topicId);
        return json({ ok: true, data: { updated: true } });
      }
      if (path === '/settings') {
        params(query, []);
        if (!services.settings) throw new V2exError('incompatible_runtime');
        const value = request.method === 'GET' ? await services.settings.get() : await services.settings.update(await settingsBody(request));
        const parsed = PluginSettingsSchema.safeParse(value);
        if (!parsed.success) throw new V2exError('invalid_response');
        return json({ ok: true, data: parsed.data });
      }
      if (path === '/latest') {
        const input = params(query, ['page']);
        return json({ ok: true, data: boundedTopicPage(await services.content.latest({ page: page(input.get('page')) }, request.signal)) });
      }
      if (path === '/hot') {
        params(query, []);
        return json({ ok: true, data: boundedHot(await services.content.hot(request.signal)) });
      }
      if (path === '/node') {
        const input = params(query, ['node']);
        return json({ ok: true, data: await services.content.node({ node: assertNodeName(input.get('node')) }, request.signal) });
      }
      if (path === '/node/topics') {
        const input = params(query, ['node', 'page']);
        return json({ ok: true, data: boundedTopicPage(await services.content.nodeTopics({ node: assertNodeName(input.get('node')), page: page(input.get('page')) }, request.signal)) });
      }
      if (path === '/topic') {
        const input = params(query, ['topic', 'replyPages']);
        const replyPages = input.get('replyPages');
        if (replyPages !== null && !/^(?:0|[1-9][0-9]*)$/.test(replyPages)) throw new V2exError('invalid_request');
        const coveredPages = replyPages === null ? 0 : Number(replyPages);
        if (coveredPages > MAX_EMBEDDED_REPLY_PAGES) throw new V2exError('invalid_request');
        return json({ ok: true, data: boundedTopic(await services.content.topic({ topic: String(assertTopicId(input.get('topic'))), replyPages: coveredPages }, request.signal), coveredPages) });
      }
      if (path === '/replies') {
        const input = params(query, ['topic', 'page']);
        return json({ ok: true, data: boundedReplies(await services.content.replies({ topic: String(assertTopicId(input.get('topic'))), page: page(input.get('page')) }, request.signal)) });
      }
      params(query, []);
      return json({ ok: true, data: { healthy: true } });
    } catch (error) {
      return error instanceof BodyTooLarge ? failure(new V2exError('invalid_request'), 413) : failure(error);
    }
  } };
}

export async function registerV2exHttpRoutes(connection: FetchConnection, services: V2exRouteServices): Promise<() => Promise<void>> {
  if (typeof connection.fetch?.register !== 'function') throw new V2exError('incompatible_runtime');
  const releases: Array<() => unknown> = [];
  let disposing: Promise<void> | undefined;
  const dispose = () => disposing ??= (async () => {
    let failed = false;
    for (const release of releases.reverse()) {
      try { await release(); } catch { failed = true; }
    }
    if (failed) throw new V2exError('incompatible_runtime');
  })();
  try {
    for (const [path, methods] of [
      ['/session', ['GET', 'POST', 'DELETE']], ['/latest', ['GET']], ['/hot', ['GET']],
      ['/node', ['GET']], ['/node/topics', ['GET']], ['/topic', ['GET']],
      ['/topic/summary', ['POST']],
      ['/interests', ['GET', 'PUT', 'POST', 'DELETE']],
      ['/recommendations', ['GET']],
      ['/recommendations/feedback', ['POST']],
      ['/recommendations/read', ['POST']],
      ['/settings', ['GET', 'PUT']],
      ['/replies', ['GET']], ['/health', ['GET']],
    ] as const) {
      const release = connection.fetch.register(route(path, [...methods], services));
      if (typeof release !== 'function') throw new V2exError('incompatible_runtime');
      releases.push(release as () => unknown);
    }
  } catch {
    try { await dispose(); } catch { /* Preserve the registration failure. */ }
    throw new V2exError('incompatible_runtime');
  }
  return dispose;
}
