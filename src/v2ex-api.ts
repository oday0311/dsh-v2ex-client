import { z } from 'zod';
import type { RateLimitState } from './contract.js';
import { V2exError } from './errors.js';
import { assertNodeName, assertPage, assertTopicId } from './validation.js';

const ORIGIN = 'https://www.v2ex.com';
const API_PREFIX = '/api/v2/';

const tokenSchema = z.object({
  scope: z.string().min(1).max(100),
  expiration: z.number().int().nonnegative().max(8_640_000_000_000).nullable().optional(),
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
    return this.requestJson(`topics/latest?p=${assertPage(page)}`, token, z.array(topicSchema), signal);
  }

  async hot(token: string, signal?: AbortSignal): Promise<V2exTopic[]> {
    return this.requestJson('topics/hot', token, z.array(topicSchema), signal);
  }

  async node(name: string, token: string, signal?: AbortSignal): Promise<V2exNode> {
    return this.requestJson(`nodes/${assertNodeName(name)}`, token, nodeSchema, signal);
  }

  async nodeTopics(name: string, page: number, token: string, signal?: AbortSignal): Promise<V2exTopic[]> {
    return this.requestJson(`nodes/${assertNodeName(name)}/topics?p=${assertPage(page)}`, token, z.array(topicSchema), signal);
  }

  async topic(id: number | string, token: string, signal?: AbortSignal): Promise<V2exTopic> {
    return this.requestJson(`topics/${assertTopicId(id)}`, token, topicSchema, signal);
  }

  async replies(id: number | string, page: number, token: string, signal?: AbortSignal): Promise<V2exReply[]> {
    return this.requestJson(`topics/${assertTopicId(id)}/replies?p=${assertPage(page)}`, token, z.array(replySchema), signal);
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

  private async requestJson<T>(path: string, token: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new V2exError('not_authenticated');
    const url = new URL(API_PREFIX + path, ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || !url.pathname.startsWith(API_PREFIX)) {
      throw new V2exError('invalid_request');
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
    try {
      const response = await this.options.fetch(url.toString(), {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: combined, redirect: 'error', cache: 'no-store',
      });
      this.observeRateLimit(response.headers);
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
      let json: unknown;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw new V2exError('invalid_response'); }
      const envelope = z.object({ success: z.boolean(), message: z.unknown().optional(), result: z.unknown().optional() }).safeParse(json);
      if (!envelope.success) throw new V2exError('invalid_response');
      if (!response.ok || !envelope.data.success) {
        throw responseCode(response.status, envelope.data.message);
      }
      const parsed = schema.safeParse(envelope.data.result);
      if (!parsed.success) throw new V2exError('invalid_response');
      return parsed.data;
    } catch (error) {
      if (error instanceof V2exError) throw error;
      if (timeout.signal.aborted || signal?.aborted) throw new V2exError('timeout');
      throw new V2exError('offline');
    } finally {
      clearTimeout(timer);
    }
  }
}
