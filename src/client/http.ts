import { z } from 'zod';
import type { AccountStatus, Cached, InterestProfile, NodeInfo, PluginSettings, PublicTopicAiSummary, RecommendationList, ReplyItem, TopicListItem, TopicPage, TopicTab, TopicThread } from '../contract.js';
import type { V2exErrorCode } from '../errors.js';
import { account, cached, envelope, interestProfile, node, nodeCatalog, pluginSettings, recommendationList, reply, summary, thread, topicItem, topicPage, updated } from './schema.js';

export type ClientErrorCode = V2exErrorCode | 'cancelled' | 'plugin_unavailable';
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
  tab?(tab: TopicTab, signal?: AbortSignal): Promise<Cached<TopicPage>>;
  nodes?(signal?: AbortSignal): Promise<Cached<NodeInfo[]>>;
  node(node: string, signal?: AbortSignal): Promise<Cached<NodeInfo>>;
  nodeTopics(node: string, page: number, signal?: AbortSignal): Promise<Cached<TopicPage>>;
  topic(id: string, signal?: AbortSignal): Promise<Cached<TopicThread>>;
  replies(id: string, page: number, signal?: AbortSignal): Promise<Cached<ReplyItem[]>>;
  summary?(id: string, mode: 'quick' | 'viewpoints' | 'full', replyPages: number, signal?: AbortSignal): Promise<PublicTopicAiSummary>;
  interests?(method?: 'get' | 'authorize' | 'revoke' | 'relearn' | 'clear' | 'update', payload?: unknown, signal?: AbortSignal): Promise<InterestProfile>;
  recommendations?(signal?: AbortSignal): Promise<RecommendationList>;
  recommendationFeedback?(topicId: number, value: 'interested' | 'not_interested', signal?: AbortSignal): Promise<void>;
  recommendationRead?(topicId: number, signal?: AbortSignal): Promise<void>;
  settings?(signal?: AbortSignal): Promise<PluginSettings>;
  updateSettings?(settings: PluginSettings, signal?: AbortSignal): Promise<PluginSettings>;
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
    let raw: unknown;
    try {
      raw = await readJson(response, init.signal ?? undefined);
    } catch (error) {
      // The Host registers its V2EX routes while the plugin activates. A plain
      // 404/403 or an HTML body means the route is not there yet (or the plugin
      // failed to load), not that V2EX returned a malformed payload.
      if (error instanceof V2exClientError && error.code === 'invalid_response' &&
          (response.status === 404 || response.status === 403 || /^text\/html\b/i.test(response.headers.get('content-type') ?? ''))) {
        throw new V2exClientError('plugin_unavailable');
      }
      throw error;
    }
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
      if (!status.authenticated) throw new V2exClientError('invalid_response');
      if ([status.username, status.tokenScope, status.expiresAt].some(value => value?.includes(token))) throw new V2exClientError('invalid_response');
      return status;
    },
    logout: (clearPersonalData = false, signal) => request('/session', account, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearPersonalData }), signal }),
    latest: (page, signal) => request(`/latest${query({ page })}`, cached(topicPage), { signal }),
    hot: signal => request('/hot', cached(z.array(topicItem).max(20)), { signal }),
    tab: (tab, signal) => request(`/tab${query({ tab })}`, cached(topicPage), { signal }),
    nodes: signal => request('/nodes', cached(nodeCatalog), { signal }),
    node: (name, signal) => request(`/node${query({ node: name })}`, cached(node), { signal }),
    nodeTopics: (name, page, signal) => request(`/node/topics${query({ node: name, page })}`, cached(topicPage), { signal }),
    topic: (topicId, signal) => request(`/topic${query({ topic: topicId, replyPages: 0 })}`, cached(thread), { signal }),
    replies: (topicId, page, signal) => request(`/replies${query({ topic: topicId, page })}`, cached(z.array(reply).max(20)), { signal }),
    summary: (topicId, mode, replyPages, signal) => request('/topic/summary', summary, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: topicId, mode, replyPages }), signal }),
    interests: (method = 'get', payload, signal) => {
      if (method === 'get') return request('/interests', interestProfile, { signal });
      if (method === 'clear') return request('/interests', interestProfile, { method: 'DELETE', signal });
      if (method === 'update') return request('/interests', interestProfile, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
      return request('/interests', interestProfile, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: method }), signal });
    },
    recommendations: signal => request('/recommendations', recommendationList, { signal }),
    recommendationFeedback: async (topicId, value, signal) => { await request('/recommendations/feedback', updated,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topicId, value }), signal }); },
    recommendationRead: async (topicId, signal) => { await request('/recommendations/read', updated,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topicId }), signal }); },
    settings: signal => request('/settings', pluginSettings, { signal }),
    updateSettings: (settings, signal) => request('/settings', pluginSettings, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings), signal }),
  };
}
