import { z } from 'zod';
import { toPublicError, V2EX_ERROR_CODES, V2exError } from '../errors.js';

const errorCode = z.enum(V2EX_ERROR_CODES);
export const publicError = z.object({ code: errorCode, message: z.string().max(512), retryable: z.boolean() }).strict()
  .transform(({ code }) => toPublicError(new V2exError(code)));
const date = z.string().max(40).refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const label = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const secretShape = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|(?:bearer|token)[=: ]+[A-Za-z0-9_-]{8,})/i;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nodeName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const officialUrl = z.string().max(512).refine(value => {
  try { return new URL(value).origin === 'https://www.v2ex.com'; } catch { return false; }
});
export const account = z.object({ authenticated: z.boolean(), writable: z.boolean(), username: label(100).nullable(),
  tokenScope: label(128).nullable(), expiresAt: date.nullable() }).strict()
  .refine(value => value.authenticated || value.username === null)
  .refine(value => [value.username, value.tokenScope, value.expiresAt].every(field => !field || !secretShape.test(field)));
export const topicItem = z.object({ id, title: label(10_000), node: z.object({ name: nodeName, title: label(500) }),
  author: z.object({ username: label(100) }), replyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: date, lastReplyAt: date.nullable(), url: officialUrl });
export const topicPage = z.object({ items: z.array(topicItem).max(20), page: z.number().int().min(1).max(1_000),
  hasMore: z.boolean(), stale: z.boolean() });
export const node = z.object({ name: nodeName, title: label(500), topicCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), url: officialUrl });
export const reply = z.object({ id, author: z.object({ username: label(100) }), content: z.string().max(256), createdAt: date });
export const thread = z.object({ topic: topicItem, content: z.string().max(4_000), replies: z.array(reply).max(60),
  replyPage: z.number().int().min(0).max(3), hasMoreReplies: z.boolean(), stale: z.boolean() });
export const cached = <T extends z.ZodType>(value: T) => z.object({ value, fetchedAt: date, stale: z.boolean(),
  source: z.enum(['network', 'cache']), refreshError: publicError.optional() });
export const envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: publicError }),
]);
