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
const weight = z.object({ name: label(80), weight: z.number().min(0).max(1) }).strict();
export const summary = z.object({ topicId: id, summary: label(20_000), viewpoints: z.array(label(2_000)).max(100),
  notableReplies: z.array(id).max(100), generatedAt: date, coveredReplyPages: z.array(z.number().int().min(1).max(1_000)).max(1_000),
  completeDiscussion: z.boolean(), coverage: z.object({ loadedReplyPages: z.number().int().nonnegative(), totalReplyPages: z.number().int().nonnegative(),
    complete: z.boolean(), includedReplies: z.number().int().nonnegative().optional(), omittedReplies: z.number().int().nonnegative().optional(),
    contentTruncated: z.boolean().optional() }).strict().optional(), mode: z.enum(['quick', 'viewpoints', 'full']).optional(),
  modelRoute: label(512).optional(), topicUpdatedAt: date.optional() }).strict();
export const interestProfile = z.object({ authorized: z.boolean(), learningPaused: z.boolean(), labels: z.array(weight).max(100),
  preferredNodes: z.array(weight.extend({ name: nodeName })).max(100), exclusions: z.array(label(100)).max(100),
  feedback: z.array(z.object({ topicId: id, interested: z.boolean() }).strict()).max(500), updatedAt: date,
  source: z.enum(['manual', 'history', 'mixed']) }).strict();
export const recommendation = z.object({ topic: topicItem, score: z.number().min(0).max(1), reason: label(2_000),
  matchedInterests: z.array(label(80)).max(100), generatedAt: date, read: z.boolean(),
  feedback: z.enum(['interested', 'not_interested']).nullable() }).strict();
export const recommendationList = z.object({ items: z.array(recommendation).max(100), generatedAt: date.nullable(), stale: z.boolean(),
  source: z.enum(['generated', 'stored']), truncated: z.boolean().optional(), omittedItems: z.number().int().nonnegative().optional() });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const pluginSettings = z.object({ refreshIntervalMinutes: z.number().int().min(1).max(1440),
  scannedNodes: z.array(nodeName).max(100), pagesPerNode: z.number().int().min(1).max(1000),
  aiCandidateBudget: z.number().int().min(0).max(100), maxModelCallsPerRefresh: z.number().int().min(0).max(10),
  notificationThreshold: z.number().min(0).max(1), quietHours: z.object({ start: time, end: time,
    timeZone: label(100).refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; } }) }).strict().nullable() }).strict();
export const updated = z.object({ updated: z.literal(true) }).strict();
export const envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: publicError }),
]);
