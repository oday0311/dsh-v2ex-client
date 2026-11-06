import type { AuthService } from './credentials.js';
import type { ContentService } from './content-service.js';
import type { AccountStatus, ApiResult, Cached, ReplyItem, TopicThread } from './contract.js';
import { V2exError, toPublicError } from './errors.js';
import { assertNodeName, assertPage, assertTopicId } from './validation.js';

const PREFIX = '/api/v2ex';
const MAX_LOGIN_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ROUTED_METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'];
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export interface V2exRouteServices { auth: Pick<AuthService, 'status' | 'login' | 'logout'>; credential: { resolve(): Promise<string | undefined> }; content: Pick<ContentService, 'latest' | 'hot' | 'node' | 'nodeTopics' | 'topic' | 'replies'> }
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

function boundedReplies(result: Cached<ReplyItem[]>): Cached<ReplyItem[]> & { truncated: boolean; omittedReplies: number } {
  const replies = result.value.slice(0, 40);
  const value = replies.map(reply => ({ ...reply, content: reply.content.slice(0, 512) }));
  return { ...result, value, truncated: replies.length < result.value.length ||
    replies.some(reply => reply.content.length > 512), omittedReplies: result.value.length - replies.length };
}

function boundedTopic(result: Cached<TopicThread>): Cached<TopicThread> & { truncated: boolean; omittedReplies: number } {
  const replies = result.value.replies.slice(0, 20);
  const content = result.value.content.slice(0, 8_000);
  const value = { ...result.value, content, replies: replies.map(reply => ({ ...reply, content: reply.content.slice(0, 512) })),
    hasMoreReplies: result.value.hasMoreReplies || replies.length < result.value.replies.length };
  return { ...result, value, truncated: content.length < result.value.content.length ||
    replies.length < result.value.replies.length || replies.some(reply => reply.content.length > 512),
    omittedReplies: result.value.replies.length - replies.length };
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

class BodyTooLarge extends Error {}

function route(path: string, methods: string[], services: V2exRouteServices): V2exFetchRoute {
  return { path: PREFIX + path, methods: ROUTED_METHODS, requestBody: 'buffered', async fetch(request) {
    if (new URL(request.url).pathname !== PREFIX + path) return failure(new V2exError('not_found'));
    if (!methods.includes(request.method)) {
      return failure(new V2exError('invalid_request'), 405, { allow: methods.join(', ') });
    }
    try {
      const query = new URL(request.url);
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
      if (path === '/latest') {
        const input = params(query, ['page']);
        return json({ ok: true, data: await services.content.latest({ page: page(input.get('page')) }, request.signal) });
      }
      if (path === '/hot') {
        params(query, []);
        return json({ ok: true, data: await services.content.hot(request.signal) });
      }
      if (path === '/node') {
        const input = params(query, ['node']);
        return json({ ok: true, data: await services.content.node({ node: assertNodeName(input.get('node')) }, request.signal) });
      }
      if (path === '/node/topics') {
        const input = params(query, ['node', 'page']);
        return json({ ok: true, data: await services.content.nodeTopics({ node: assertNodeName(input.get('node')), page: page(input.get('page')) }, request.signal) });
      }
      if (path === '/topic') {
        const input = params(query, ['topic', 'replyPages']);
        const replyPages = input.get('replyPages');
        if (replyPages !== null && !/^(?:0|[1-9]|10)$/.test(replyPages)) throw new V2exError('invalid_request');
        return json({ ok: true, data: boundedTopic(await services.content.topic({ topic: String(assertTopicId(input.get('topic'))), replyPages: replyPages === null ? 0 : Number(replyPages) }, request.signal)) });
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
