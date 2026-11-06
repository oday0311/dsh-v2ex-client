import type { AccountStatus, ApiResult, Cached, NodeInfo, ReplyItem, TopicListItem, TopicPage, TopicThread } from '../contract.js';
import type { V2exErrorCode } from '../errors.js';

export type ClientErrorCode = V2exErrorCode | 'cancelled';
const codes = new Set<string>(['not_authenticated', 'token_invalid', 'token_expired', 'rate_limited', 'offline', 'timeout', 'not_found', 'invalid_request', 'invalid_response', 'upstream', 'ai_unavailable', 'history_access_denied', 'budget_exhausted', 'incompatible_runtime']);

export class V2exClientError extends Error {
  constructor(readonly code: ClientErrorCode) {
    super(code);
    this.name = 'V2exClientError';
  }
}

export interface V2exClientRemote {
  session(signal?: AbortSignal): Promise<AccountStatus>;
  login(token: string, signal?: AbortSignal): Promise<AccountStatus>;
  logout(clearPersonalData?: boolean, signal?: AbortSignal): Promise<AccountStatus>;
  latest(page: number, signal?: AbortSignal): Promise<Cached<TopicPage>>;
  hot(signal?: AbortSignal): Promise<Cached<TopicListItem[]>>;
  node(node: string, signal?: AbortSignal): Promise<Cached<NodeInfo>>;
  nodeTopics(node: string, page: number, signal?: AbortSignal): Promise<Cached<TopicPage>>;
  topic(id: string, signal?: AbortSignal): Promise<Cached<TopicThread>>;
  replies(id: string, page: number, signal?: AbortSignal): Promise<Cached<ReplyItem[]>>;
}

export function createV2exHttpClient(fetcher: typeof fetch = globalThis.fetch): V2exClientRemote {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (init.signal?.aborted) throw new V2exClientError('cancelled');
    let response: Response;
    try {
      response = await fetcher(`/api/v2ex${path}`, { ...init, headers: { accept: 'application/json', ...init.headers }, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw new V2exClientError(init.signal?.aborted ? 'cancelled' : 'offline');
    }
    if (init.signal?.aborted) throw new V2exClientError('cancelled');
    let envelope: ApiResult<T>;
    try { envelope = await response.json() as ApiResult<T>; }
    catch { throw new V2exClientError(init.signal?.aborted ? 'cancelled' : 'invalid_response'); }
    if (init.signal?.aborted) throw new V2exClientError('cancelled');
    if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') throw new V2exClientError('invalid_response');
    if (!envelope.ok) {
      const code = envelope.error?.code;
      throw new V2exClientError(typeof code === 'string' && codes.has(code) ? code as V2exErrorCode : 'invalid_response');
    }
    if (!response.ok || !('data' in envelope)) throw new V2exClientError('invalid_response');
    return envelope.data;
  }
  const query = (values: Record<string, string | number>) => `?${new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString()}`;
  return {
    session: signal => request('/session', { signal }),
    login: (token, signal) => request('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal }),
    logout: (clearPersonalData = false, signal) => request('/session', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearPersonalData }), signal }),
    latest: (page, signal) => request(`/latest${query({ page })}`, { signal }),
    hot: signal => request('/hot', { signal }),
    node: (node, signal) => request(`/node${query({ node })}`, { signal }),
    nodeTopics: (node, page, signal) => request(`/node/topics${query({ node, page })}`, { signal }),
    topic: (id, signal) => request(`/topic${query({ topic: id, replyPages: 0 })}`, { signal }),
    replies: (id, page, signal) => request(`/replies${query({ topic: id, page })}`, { signal }),
  };
}
