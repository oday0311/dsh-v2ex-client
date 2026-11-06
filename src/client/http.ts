import { z } from 'zod';
import type { AccountStatus, Cached, NodeInfo, ReplyItem, TopicListItem, TopicPage, TopicThread } from '../contract.js';
import type { V2exErrorCode } from '../errors.js';
import { account, cached, envelope, node, reply, thread, topicItem, topicPage } from './schema.js';

export type ClientErrorCode = V2exErrorCode | 'cancelled';
const MAX_RESPONSE_BYTES = 256 * 1024;

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

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw new V2exClientError('invalid_response');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new V2exClientError('invalid_response');
  const reader = response.body?.getReader();
  if (!reader) throw new V2exClientError('invalid_response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new V2exClientError('cancelled');
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new V2exClientError('invalid_response');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof V2exClientError && !signal?.aborted) throw error;
    throw new V2exClientError(signal?.aborted ? 'cancelled' : 'invalid_response');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new V2exClientError(signal?.aborted ? 'cancelled' : 'invalid_response'); }
}

export function createV2exHttpClient(fetcher: typeof fetch = globalThis.fetch): V2exClientRemote {
  async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    if (init.signal?.aborted) throw new V2exClientError('cancelled');
    let response: Response;
    try {
      response = await fetcher(`/api/v2ex${path}`, { ...init, headers: { accept: 'application/json', ...init.headers }, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw new V2exClientError(init.signal?.aborted ? 'cancelled' : 'offline');
    }
    if (init.signal?.aborted) throw new V2exClientError('cancelled');
    const raw = await readJson(response, init.signal ?? undefined);
    if (init.signal?.aborted) throw new V2exClientError('cancelled');
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) throw new V2exClientError('invalid_response');
    if (!parsed.data.ok) throw new V2exClientError(parsed.data.error.code);
    if (!response.ok) throw new V2exClientError('invalid_response');
    const data = schema.safeParse(parsed.data.data);
    if (!data.success) throw new V2exClientError('invalid_response');
    return data.data;
  }
  const query = (values: Record<string, string | number>) => `?${new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString()}`;
  return {
    session: signal => request('/session', account, { signal }),
    login: async (token, signal) => {
      const status = await request('/session', account, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal });
      if ([status.username, status.tokenScope, status.expiresAt].some(value => value?.includes(token))) throw new V2exClientError('invalid_response');
      return status;
    },
    logout: (clearPersonalData = false, signal) => request('/session', account, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearPersonalData }), signal }),
    latest: (page, signal) => request(`/latest${query({ page })}`, cached(topicPage), { signal }),
    hot: signal => request('/hot', cached(z.array(topicItem).max(20)), { signal }),
    node: (name, signal) => request(`/node${query({ node: name })}`, cached(node), { signal }),
    nodeTopics: (name, page, signal) => request(`/node/topics${query({ node: name, page })}`, cached(topicPage), { signal }),
    topic: (topicId, signal) => request(`/topic${query({ topic: topicId, replyPages: 0 })}`, cached(thread), { signal }),
    replies: (topicId, page, signal) => request(`/replies${query({ topic: topicId, page })}`, cached(z.array(reply).max(20)), { signal }),
  };
}
