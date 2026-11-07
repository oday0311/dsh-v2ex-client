import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { CacheRecord, ContentStore, InterestEditFlags, InterestProfile, PendingReminderNotice, PluginSettings, Recommendation, RecommendationBatch, RecommendationSnapshot, TopicAiSummary } from './contract.js';
import { V2exError } from './errors.js';
import { assertPage, assertTopicId } from './validation.js';
import { isUnsafeReminder, validReminderField } from './reminder-safety.js';

const timestamp = z.iso.datetime({ offset: true });
const nodeName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const topicId = z.number().int().positive().safe();
const NOTIFICATION_BYTES = 2048;
const NOTIFICATION_BITS = BigInt(NOTIFICATION_BYTES * 8);

function notificationPositions(id: number): number[] {
  const value = BigInt(id);
  return [0x9e3779b1n, 0x85ebca6bn, 0xc2b2ae35n].map((seed, index) =>
    Number((value * seed + BigInt(index + 1) * 0x27d4eb2fn) % NOTIFICATION_BITS));
}

function encodeNotificationIds(ids: readonly number[]): string {
  const bits = Buffer.alloc(NOTIFICATION_BYTES);
  for (const id of ids) for (const position of notificationPositions(id)) bits[position >> 3] |= 1 << (position & 7);
  return bits.toString('base64');
}

function notificationSeen(bitmap: Buffer, id: number): boolean {
  return notificationPositions(id).every(position => (bitmap[position >> 3]! & (1 << (position & 7))) !== 0);
}

function markNotification(bitmap: Buffer, id: number): void {
  for (const position of notificationPositions(id)) bitmap[position >> 3] |= 1 << (position & 7);
}

export const PluginSettingsSchema = z.strictObject({
  refreshIntervalMinutes: z.number().int().min(1).max(1440),
  scannedNodes: z.array(nodeName).max(100),
  pagesPerNode: z.number().int().min(1).max(1000),
  aiCandidateBudget: z.number().int().min(0).max(100),
  maxModelCallsPerRefresh: z.number().int().min(0).max(10).default(1),
  notificationThreshold: z.number().min(0).max(1),
  quietHours: z.strictObject({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().min(1).max(100).refine(value => {
      try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
    }).default('UTC') }).nullable(),
});

const WeightedLabelSchema = z.strictObject({ name: z.string().trim().min(1).max(80), weight: z.number().finite().min(0).max(1) });
const WeightedNodeSchema = z.strictObject({ name: nodeName, weight: z.number().finite().min(0).max(1) });
export const InterestProfileSchema = z.strictObject({
  authorized: z.boolean(), learningPaused: z.boolean(),
  labels: z.array(WeightedLabelSchema).max(100),
  preferredNodes: z.array(WeightedNodeSchema).max(100),
  exclusions: z.array(z.string().trim().min(1).max(100)).max(100),
  feedback: z.array(z.strictObject({ topicId, interested: z.boolean() })).max(500),
  updatedAt: timestamp, source: z.enum(['manual', 'history', 'mixed']),
});
export const InterestEditFlagsSchema = z.strictObject({
  labels: z.boolean(), preferredNodes: z.boolean(), exclusions: z.boolean(), legacyManual: z.boolean().optional(),
});
const noInterestEdits: InterestEditFlags = { labels: false, preferredNodes: false, exclusions: false };
const accountScope = z.string().regex(/^[0-9a-f]{64}:$/);

const LegacyProfileSchema = z.strictObject({
  labels: z.array(z.strictObject({ name: z.string().trim().min(1).max(80), weight: z.number().finite().min(-1).max(1) })).max(100),
  preferredNodes: z.array(nodeName).max(100),
  excludedTerms: z.array(z.string().trim().min(1).max(100)).max(100),
  feedback: z.array(z.strictObject({ topicId, interested: z.boolean() })).max(500), updatedAt: timestamp,
}).transform((old): InterestProfile => ({ authorized: false, learningPaused: false,
  labels: old.labels.map(item => ({ ...item, weight: Math.max(0, item.weight) })),
  preferredNodes: old.preferredNodes.map(name => ({ name, weight: 1 })),
  exclusions: old.excludedTerms, feedback: old.feedback, updatedAt: old.updatedAt, source: 'manual' }));

const TopicListItemSchema = z.strictObject({
  id: topicId, title: z.string().min(1).max(500),
  node: z.strictObject({ name: nodeName, title: z.string().max(200) }),
  author: z.strictObject({ username: z.string().min(1).max(100) }),
  replyCount: z.number().int().nonnegative(), createdAt: timestamp,
  lastReplyAt: timestamp.nullable(), url: z.url().refine((value) => value.startsWith('https://www.v2ex.com/')),
});

export const CacheRecordSchema = z.strictObject({
  value: z.json(), fetchedAt: timestamp, expiresAt: timestamp, accessedAt: timestamp,
}).refine((record) => Date.parse(record.expiresAt) >= Date.parse(record.fetchedAt));

export const TopicAiSummarySchema = z.strictObject({
  topicId, summary: z.string().min(1).max(5000), viewpoints: z.array(z.string().max(1000)).max(30),
  notableReplies: z.array(topicId).max(100), generatedAt: timestamp,
  coveredReplyPages: z.array(z.number().int().positive().max(1000)).max(100), completeDiscussion: z.boolean(),
  coverage: z.strictObject({ loadedReplyPages: z.number().int().nonnegative().safe(),
    totalReplyPages: z.number().int().nonnegative().safe(), complete: z.boolean(),
    includedReplies: z.number().int().nonnegative().safe().optional(),
    omittedReplies: z.number().int().nonnegative().safe().optional(),
    contentTruncated: z.boolean().optional() }).optional(),
  mode: z.enum(['quick', 'viewpoints', 'full']).optional(), modelRoute: z.string().min(1).max(500).optional(),
  topicUpdatedAt: timestamp.optional(),
});

export const RecommendationSchema = z.strictObject({
  topic: TopicListItemSchema, score: z.number().finite().min(0).max(1), reason: z.string().min(1).max(1000),
  matchedInterests: z.array(z.string().trim().min(1).max(80)).max(20), generatedAt: timestamp,
  read: z.boolean(), feedback: z.enum(['interested', 'not_interested']).nullable(),
});
const LegacyRecommendationSchema = z.strictObject({
  topic: TopicListItemSchema, score: z.number().finite().min(0).max(1), reason: z.string().min(1).max(1000),
  read: z.boolean(), createdAt: timestamp,
}).transform((old): Recommendation => ({ ...old, matchedInterests: [], generatedAt: old.createdAt, feedback: null }));
const RecommendationBatchSchema = z.strictObject({ generatedAt: timestamp, topicIds: z.array(topicId).max(500),
  generation: z.number().int().nonnegative().optional() });
const RecommendationSnapshotSchema = z.strictObject({ batch: RecommendationBatchSchema,
  items: z.array(RecommendationSchema).max(500) });
const AccountInterestStateSchema = z.strictObject({ profile: InterestProfileSchema, edits: InterestEditFlagsSchema });
const AccountProfilesSchema = z.record(accountScope, AccountInterestStateSchema)
  .refine(value => Object.keys(value).length <= 20);
const RecommendationBatchesSchema = z.record(accountScope, RecommendationBatchSchema)
  .refine(value => Object.keys(value).length <= 20);
const RecommendationSnapshotsSchema = z.record(accountScope, RecommendationSnapshotSchema)
  .refine(value => Object.keys(value).length <= 20);
const MigratedRecommendationScopesSchema = z.record(accountScope, z.literal(true))
  .refine(value => Object.keys(value).length <= 20);
const AccountSettingsSchema = z.record(accountScope, PluginSettingsSchema)
  .refine(value => Object.keys(value).length <= 20);
const NotificationBitmapSchema = z.string().refine(value => {
  try { const decoded = Buffer.from(value, 'base64'); return decoded.length === NOTIFICATION_BYTES && decoded.toString('base64') === value; }
  catch { return false; }
});
const PendingReminderNoticeSchema = z.strictObject({
  noticeId: z.uuid(), topicId, title: z.string().refine(value => validReminderField(value, 200)),
  node: z.string().refine(value => validReminderField(value, 64)),
  reason: z.string().refine(value => validReminderField(value, 500)), createdAt: timestamp,
}).refine(value => !isUnsafeReminder(value));
function sameReminderNotice(left: PendingReminderNotice, right: PendingReminderNotice): boolean {
  return left.noticeId === right.noticeId && left.topicId === right.topicId && left.title === right.title &&
    left.node === right.node && left.reason === right.reason && left.createdAt === right.createdAt;
}
const NotificationStateSchema = z.strictObject({ sent: NotificationBitmapSchema,
  pending: z.array(PendingReminderNoticeSchema).max(20) });
const NotificationStatesSchema = z.record(accountScope, z.union([
  NotificationStateSchema,
  NotificationBitmapSchema.transform(sent => ({ sent, pending: [] as PendingReminderNotice[] })),
  z.array(topicId).max(500).transform(ids => ({ sent: encodeNotificationIds(ids), pending: [] as PendingReminderNotice[] })),
]))
  .refine(value => Object.keys(value).length <= 20);

export const defaultSettings: PluginSettings = {
  refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2,
  aiCandidateBudget: 10, maxModelCallsPerRefresh: 1, notificationThreshold: 0.7, quietHours: null,
};

export const v2exDomainSpec = defineDomain({
  name: 'v2ex_client', version: 1,
  global: {
    schema: z.strictObject({ settings: PluginSettingsSchema, profile: z.union([InterestProfileSchema, LegacyProfileSchema]).nullable(),
      profileEdits: InterestEditFlagsSchema.optional(), accountProfiles: AccountProfilesSchema.optional(),
      recommendationBatches: RecommendationBatchesSchema.optional(), recommendationSnapshots: RecommendationSnapshotsSchema.optional(),
      migratedRecommendationScopes: MigratedRecommendationScopesSchema.optional(), accountSettings: AccountSettingsSchema.optional(),
      notificationStates: NotificationStatesSchema.optional() }),
    initial: { settings: defaultSettings, profile: null as InterestProfile | null, profileEdits: noInterestEdits,
      accountProfiles: {}, recommendationBatches: {}, recommendationSnapshots: {}, migratedRecommendationScopes: {},
      accountSettings: {}, notificationStates: {} },
  },
  tables: {
    cache: domainTable<string, CacheRecord>(CacheRecordSchema),
    summaries: domainTable<string, TopicAiSummary>(TopicAiSummarySchema),
    recommendations: domainTable<string, Recommendation>(z.union([RecommendationSchema, LegacyRecommendationSchema])),
  },
});

const cacheKeyPattern = /^(?:(?:latest|hot):[1-9]\d{0,3}|node:[A-Za-z0-9_-]{1,64}:[1-9]\d{0,3}|node-info:[A-Za-z0-9_-]{1,64}|topic:[1-9]\d*|replies:[1-9]\d*:[1-9]\d{0,3})$/;
export function assertCacheKey(key: string): string {
  if (!cacheKeyPattern.test(key) || key.length > 100) throw new V2exError('invalid_request');
  const [kind, id, page] = key.split(':');
  if (kind === 'topic' || kind === 'replies') assertTopicId(id);
  if (kind !== 'topic' && kind !== 'node-info') assertPage(Number(page ?? id));
  return key;
}

function parseWrite<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new V2exError('invalid_request');
  return parsed.data;
}

function assertAccountScope(scope: string): string {
  if (!accountScope.safeParse(scope).success) throw new V2exError('invalid_request');
  return scope;
}

interface GlobalState {
  settings: PluginSettings;
  profile: InterestProfile | null;
  profileEdits?: InterestEditFlags;
  accountProfiles?: Record<string, { profile: InterestProfile; edits: InterestEditFlags }>;
  recommendationBatches?: Record<string, RecommendationBatch>;
  recommendationSnapshots?: Record<string, RecommendationSnapshot>;
  migratedRecommendationScopes?: Record<string, true>;
  accountSettings?: Record<string, PluginSettings>;
  notificationStates?: Record<string, { sent: string; pending: PendingReminderNotice[] }>;
}

function scopedRecommendationKey(key: string): { scope: string; topicId: number } | null {
  const match = /^([0-9a-f]{64}:)([1-9]\d*)$/.exec(key);
  return match ? { scope: match[1]!, topicId: Number(match[2]) } : null;
}

export class DomainContentStore implements ContentStore {
  private globalWrites: Promise<void> = Promise.resolve();
  private readonly tableWrites = new Map<string, Promise<void>>();
  constructor(private readonly domain: Domain<typeof v2exDomainSpec>, private readonly clock: () => Date = () => new Date()) {}

  private serialize<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const write = (this.tableWrites.get(name) ?? Promise.resolve()).then(operation);
    this.tableWrites.set(name, write.then(() => {}, () => {}));
    return write;
  }

  private boundedPut<T>(
    name: string, table: KvTable<string, T>, key: string, value: T, cap: number,
    inScope: (key: string) => boolean, age: (value: T) => number,
  ): Promise<void> {
    return this.serialize(name, async () => {
      const entries = [...table.entries()].filter(([entryKey]) => inScope(entryKey));
      const additional = table.get(key) === undefined ? 1 : 0;
      const excess = Math.max(0, entries.length + additional - cap);
      const victims = entries.filter(([entryKey]) => entryKey !== key)
        .sort((a, b) => age(a[1]) - age(b[1]))
        .slice(0, excess);
      const removed: Array<[string, T]> = [];
      try {
        for (const [entryKey, record] of victims) {
          await table.delete(entryKey);
          removed.push([entryKey, record]);
        }
        await table.put(key, value);
      } catch (error) {
        for (const [entryKey, record] of removed) await table.put(entryKey, record);
        throw error;
      }
    });
  }

  private updateGlobal(change: (current: GlobalState) => GlobalState): Promise<void> {
    const write = this.globalWrites.then(() => this.domain.global.set(change(this.domain.global.get())));
    this.globalWrites = write.catch(() => {});
    return write;
  }

  async getCache(key: string): Promise<CacheRecord | undefined> {
    assertCacheKey(key);
    const table = this.domain.table('cache');
    return this.serialize('cache', async () => {
      const record = table.get(key);
      if (!record) return undefined;
      const accessedAt = this.clock().toISOString();
      const touched = { ...record, accessedAt };
      await table.put(key, touched);
      return touched;
    });
  }

  async putCache(key: string, record: CacheRecord): Promise<void> {
    assertCacheKey(key);
    const parsed = CacheRecordSchema.safeParse(record);
    if (!parsed.success) throw new V2exError('invalid_response');
    const table = this.domain.table('cache');
    const isList = /^(latest|hot|node):/.test(key);
    const cap = isList ? 100 : 300;
    await this.boundedPut('cache', table, key, parsed.data, cap,
      (entryKey) => /^(latest|hot|node):/.test(entryKey) === isList,
      (entry) => Date.parse(entry.accessedAt));
  }

  async deleteCache(key: string): Promise<void> {
    await this.serialize('cache', () => this.domain.table('cache').delete(assertCacheKey(key)));
  }
  async getSettings(scope?: string): Promise<PluginSettings> {
    const current = this.domain.global.get() as GlobalState;
    return structuredClone(scope === undefined ? current.settings : current.accountSettings?.[assertAccountScope(scope)] ?? defaultSettings);
  }
  async putSettings(settings: PluginSettings, scope?: string): Promise<void> {
    const parsed = parseWrite(PluginSettingsSchema, settings);
    if (scope === undefined) { await this.updateGlobal((current) => ({ ...current, settings: parsed })); return; }
    const key = assertAccountScope(scope);
    await this.updateGlobal((current) => ({ ...current, accountSettings: { ...(current.accountSettings ?? {}), [key]: parsed } }));
  }
  async enqueuePendingNotifications(scope: string, notices: PendingReminderNotice[]): Promise<PendingReminderNotice[]> {
    const key = assertAccountScope(scope);
    if (!Array.isArray(notices) || notices.length > 100) throw new V2exError('invalid_request');
    const parsed = notices.map(value => parseWrite(PendingReminderNoticeSchema, value));
    let accepted: PendingReminderNotice[] = [];
    await this.updateGlobal((current) => {
      const state = current.notificationStates?.[key] ?? { sent: Buffer.alloc(NOTIFICATION_BYTES).toString('base64'), pending: [] };
      const sent = Buffer.from(state.sent, 'base64'); const pending = [...state.pending];
      const topics = new Set(pending.map(value => value.topicId)); const ids = new Set(pending.map(value => value.noticeId));
      accepted = [];
      for (const notice of parsed) {
        if (pending.length >= 20 || topics.has(notice.topicId) || ids.has(notice.noticeId) || notificationSeen(sent, notice.topicId)) continue;
        pending.push(notice); accepted.push(notice); topics.add(notice.topicId); ids.add(notice.noticeId);
      }
      return { ...current, notificationStates: { ...(current.notificationStates ?? {}), [key]: { sent: state.sent, pending } } };
    });
    return structuredClone(accepted);
  }
  async getPendingNotifications(scope: string): Promise<PendingReminderNotice[]> {
    const state = (this.domain.global.get() as GlobalState).notificationStates?.[assertAccountScope(scope)];
    return structuredClone(state?.pending ?? []);
  }
  async markNotificationSent(scope: string, value: PendingReminderNotice): Promise<void> {
    const key = assertAccountScope(scope);
    const expected = parseWrite(PendingReminderNoticeSchema, value);
    await this.updateGlobal((current) => {
      const state = current.notificationStates?.[key]; if (!state) return current;
      const notice = state.pending.find(notice => sameReminderNotice(notice, expected)); if (!notice) return current;
      const sent = Buffer.from(state.sent, 'base64'); markNotification(sent, expected.topicId);
      return { ...current, notificationStates: { ...(current.notificationStates ?? {}),
        [key]: { sent: sent.toString('base64'), pending: state.pending.filter(value => value.noticeId !== expected.noticeId) } } };
    });
  }
  async clearRefreshState(scope: string): Promise<void> {
    const key = assertAccountScope(scope);
    await this.updateGlobal((current) => {
      const accountSettings = { ...(current.accountSettings ?? {}) }; delete accountSettings[key];
      const notificationStates = { ...(current.notificationStates ?? {}) }; delete notificationStates[key];
      return { ...current, accountSettings, notificationStates };
    });
  }
  async getProfile(scope?: string): Promise<InterestProfile | null> {
    if (scope !== undefined) {
      const state = (this.domain.global.get() as GlobalState).accountProfiles?.[assertAccountScope(scope)];
      return state ? structuredClone(state.profile) : null;
    }
    const profile = this.domain.global.get().profile;
    if (profile === null) return null;
    const parsed = z.union([InterestProfileSchema, LegacyProfileSchema]).safeParse(profile);
    if (!parsed.success) throw new V2exError('invalid_response');
    return structuredClone(parsed.data);
  }
  async putProfile(profile: InterestProfile, scope?: string): Promise<void> {
    const parsed = parseWrite(InterestProfileSchema, profile);
    if (scope !== undefined) {
      const key = assertAccountScope(scope);
      await this.updateGlobal((current) => ({ ...current, accountProfiles: { ...(current.accountProfiles ?? {}),
        [key]: { profile: parsed, edits: current.accountProfiles?.[key]?.edits ?? { ...noInterestEdits } } } }));
      return;
    }
    await this.updateGlobal((current) => ({ ...current, profile: parsed }));
  }
  async getProfileEdits(scope?: string): Promise<InterestEditFlags> {
    const current = this.domain.global.get() as GlobalState;
    if (scope !== undefined) return structuredClone(current.accountProfiles?.[assertAccountScope(scope)]?.edits ?? noInterestEdits);
    const parsed = InterestEditFlagsSchema.safeParse(current.profileEdits);
    if (parsed.success) return structuredClone(parsed.data);
    if (current.profileEdits !== undefined) throw new V2exError('invalid_response');
    if (current.profile && (current.profile.source === 'manual' || !Object.hasOwn(current.profile, 'source'))) {
      return { labels: true, preferredNodes: true, exclusions: true, legacyManual: true };
    }
    return current.profile?.source === 'mixed' ? { labels: true, preferredNodes: true, exclusions: true } : { ...noInterestEdits };
  }
  async putInterestState(profile: InterestProfile, edits: InterestEditFlags, scope?: string): Promise<void> {
    const parsedProfile = parseWrite(InterestProfileSchema, profile);
    const parsedEdits = parseWrite(InterestEditFlagsSchema, edits);
    if (scope !== undefined) {
      const key = assertAccountScope(scope);
      await this.updateGlobal((current) => ({ ...current, accountProfiles: { ...(current.accountProfiles ?? {}),
        [key]: { profile: parsedProfile, edits: parsedEdits } } }));
      return;
    }
    await this.updateGlobal((current) => ({ ...current, profile: parsedProfile, profileEdits: parsedEdits }));
  }
  async clearProfile(scope?: string): Promise<void> {
    if (scope !== undefined) {
      const key = assertAccountScope(scope);
      await this.updateGlobal((current) => {
        const profiles = { ...(current.accountProfiles ?? {}) }; delete profiles[key];
        return { ...current, accountProfiles: profiles };
      });
      return;
    }
    await this.updateGlobal((current) => ({ ...current, profile: null, profileEdits: { ...noInterestEdits } }));
  }

  async getRecommendation(key: string): Promise<Recommendation | undefined> {
    const scoped = scopedRecommendationKey(key);
    if (scoped) {
      const current = this.domain.global.get() as GlobalState; const snapshot = current.recommendationSnapshots?.[scoped.scope];
      if (snapshot) return structuredClone(snapshot.items.find(value => value.topic.id === scoped.topicId));
      if (current.migratedRecommendationScopes?.[scoped.scope]) return undefined;
    }
    return this.domain.table('recommendations').get(key);
  }
  async putRecommendation(key: string, recommendation: Recommendation): Promise<void> {
    const match = /^(?:[0-9a-f]{64}:)?([1-9]\d*)$/.exec(key);
    if (!match || Number(match[1]) !== recommendation.topic.id) throw new V2exError('invalid_request');
    const parsed = parseWrite(RecommendationSchema, recommendation);
    const table = this.domain.table('recommendations');
    await this.serialize('recommendations', async () => {
      const previous = table.get(key);
      const value = previous ? { ...parsed, read: previous.read || parsed.read,
        feedback: previous.feedback ?? parsed.feedback } : parsed;
      const entries = [...table.entries()];
      const victim = previous || entries.length < 500 ? undefined : entries
        .filter(([entryKey]) => entryKey !== key)
        .sort((a, b) => Date.parse(a[1].generatedAt) - Date.parse(b[1].generatedAt))[0];
      if (victim) await table.delete(victim[0]);
      try { await table.put(key, value); }
      catch (error) {
        if (victim) await table.put(victim[0], victim[1]);
        throw error;
      }
    });
  }
  async markRead(key: string): Promise<void> {
    const scoped = scopedRecommendationKey(key);
    if (scoped) {
      let barrier = false;
      await this.updateGlobal((current) => {
        const snapshot = current.recommendationSnapshots?.[scoped.scope];
        if (!snapshot) { barrier = current.migratedRecommendationScopes?.[scoped.scope] === true; return current; }
        barrier = true;
        if (!snapshot.items.some(item => item.topic.id === scoped.topicId)) return current;
        return { ...current, recommendationSnapshots: { ...(current.recommendationSnapshots ?? {}),
          [scoped.scope]: { ...snapshot, items: snapshot.items.map(item => item.topic.id === scoped.topicId ?
            { ...item, read: true } : item) } } };
      });
      if (barrier) return;
    }
    const table = this.domain.table('recommendations');
    await this.serialize('recommendations', async () => {
      const value = table.get(key);
      if (value && !value.read) await table.put(key, { ...value, read: true });
    });
  }
  async setRecommendationFeedback(key: string, feedback: Recommendation['feedback']): Promise<void> {
    if (feedback !== null && feedback !== 'interested' && feedback !== 'not_interested') throw new V2exError('invalid_request');
    const scoped = scopedRecommendationKey(key);
    if (scoped) {
      let barrier = false; let found = false;
      await this.updateGlobal((current) => {
        const snapshot = current.recommendationSnapshots?.[scoped.scope];
        if (!snapshot) { barrier = current.migratedRecommendationScopes?.[scoped.scope] === true; return current; }
        barrier = true;
        if (!snapshot.items.some(item => item.topic.id === scoped.topicId)) return current;
        found = true;
        return { ...current, recommendationSnapshots: { ...(current.recommendationSnapshots ?? {}),
          [scoped.scope]: { ...snapshot, items: snapshot.items.map(item => item.topic.id === scoped.topicId ?
            { ...item, feedback } : item) } } };
      });
      if (barrier) { if (!found) throw new V2exError('not_found'); return; }
    }
    const table = this.domain.table('recommendations');
    await this.serialize('recommendations', async () => {
      const value = table.get(key);
      if (!value) throw new V2exError('not_found');
      await table.put(key, { ...value, feedback });
    });
  }
  async deleteRecommendation(key: string): Promise<void> {
    await this.serialize('recommendations', () => this.domain.table('recommendations').delete(key));
  }
  async getRecommendationBatch(scope: string): Promise<RecommendationBatch | null> {
    const key = assertAccountScope(scope); const current = this.domain.global.get() as GlobalState;
    return structuredClone(current.recommendationSnapshots?.[key]?.batch ?? current.recommendationBatches?.[key] ?? null);
  }
  async putRecommendationBatch(scope: string, batch: RecommendationBatch): Promise<void> {
    const key = assertAccountScope(scope); const parsed = parseWrite(RecommendationBatchSchema, batch);
    await this.updateGlobal((current) => ({ ...current,
      recommendationBatches: { ...(current.recommendationBatches ?? {}), [key]: parsed } }));
  }
  async getRecommendationSnapshot(scope: string): Promise<RecommendationSnapshot | null> {
    const key = assertAccountScope(scope); const current = this.domain.global.get() as GlobalState;
    const snapshot = current.recommendationSnapshots?.[key];
    if (snapshot) return structuredClone(snapshot);
    if (current.migratedRecommendationScopes?.[key]) return null;
    const batch = current.recommendationBatches?.[key];
    if (!batch) return null;
    const ids = new Set(batch.topicIds);
    const items = [...this.domain.table('recommendations').entries()]
      .filter(([entryKey, value]) => entryKey.startsWith(key) && ids.has(value.topic.id)).map(([, value]) => value);
    return { batch: structuredClone(batch), items: structuredClone(items) };
  }
  async replaceRecommendationBatch(scope: string, batch: RecommendationBatch, items: Recommendation[]): Promise<RecommendationSnapshot> {
    const key = assertAccountScope(scope); const parsedBatch = parseWrite(RecommendationBatchSchema, batch);
    const parsedItems = items.map(item => parseWrite(RecommendationSchema, item));
    const ids = parsedItems.map(item => item.topic.id);
    if (new Set(ids).size !== ids.length || parsedBatch.topicIds.length !== ids.length ||
      parsedBatch.topicIds.some((id, index) => id !== ids[index])) throw new V2exError('invalid_request');
    const legacy = new Map([...this.domain.table('recommendations').entries()]
      .filter(([entryKey]) => entryKey.startsWith(key)).map(([, item]) => [item.topic.id, item]));
    let published!: RecommendationSnapshot;
    await this.updateGlobal((current) => {
      const previous = new Map((current.recommendationSnapshots?.[key]?.items ?? [...legacy.values()])
        .map(item => [item.topic.id, item]));
      const next = parsedItems.map(item => { const old = previous.get(item.topic.id); return old ?
        { ...item, read: old.read || item.read, feedback: old.feedback ?? item.feedback } : item; });
      published = parseWrite(RecommendationSnapshotSchema, { batch: parsedBatch, items: next });
      return { ...current, recommendationSnapshots: { ...(current.recommendationSnapshots ?? {}), [key]: published },
        recommendationBatches: { ...(current.recommendationBatches ?? {}), [key]: parsedBatch },
        migratedRecommendationScopes: { ...(current.migratedRecommendationScopes ?? {}), [key]: true } };
    });
    return structuredClone(published);
  }
  async discardRecommendationBatch(scope: string, generation: number): Promise<void> {
    const key = assertAccountScope(scope);
    await this.updateGlobal((current) => {
      if (current.recommendationSnapshots?.[key]?.batch.generation !== generation) return current;
      const snapshots = { ...(current.recommendationSnapshots ?? {}) }; delete snapshots[key];
      const batches = { ...(current.recommendationBatches ?? {}) }; delete batches[key];
      return { ...current, recommendationSnapshots: snapshots, recommendationBatches: batches,
        migratedRecommendationScopes: { ...(current.migratedRecommendationScopes ?? {}), [key]: true } };
    });
  }
  async clearRecommendations(scope: string): Promise<void> {
    const key = assertAccountScope(scope);
    await this.updateGlobal((current) => {
      const snapshots = { ...(current.recommendationSnapshots ?? {}) }; delete snapshots[key];
      const batches = { ...(current.recommendationBatches ?? {}) }; delete batches[key];
      return { ...current, recommendationSnapshots: snapshots, recommendationBatches: batches,
        migratedRecommendationScopes: { ...(current.migratedRecommendationScopes ?? {}), [key]: true } };
    });
    await this.serialize('recommendations', async () => {
      const table = this.domain.table('recommendations');
      for (const [entryKey] of table.entries()) if (entryKey.startsWith(key)) await table.delete(entryKey);
    });
  }
  async clearLegacyRecommendations(): Promise<void> {
    await this.serialize('recommendations', async () => {
      const table = this.domain.table('recommendations');
      for (const [key] of table.entries()) if (/^[1-9]\d*$/.test(key)) await table.delete(key);
    });
  }
  async listRecommendations(scope?: string): Promise<Recommendation[]> {
    if (scope !== undefined && !/^[0-9a-f]{64}:$/.test(scope)) throw new V2exError('invalid_request');
    if (scope !== undefined) {
      const current = this.domain.global.get() as GlobalState; const snapshot = current.recommendationSnapshots?.[scope];
      if (snapshot) return structuredClone(snapshot.items);
      if (current.migratedRecommendationScopes?.[scope]) return [];
    }
    return [...this.domain.table('recommendations').entries()]
      .filter(([key]) => scope === undefined || key.startsWith(scope)).map(([, value]) => value);
  }
  async getSummary(key: string): Promise<TopicAiSummary | undefined> { return this.domain.table('summaries').get(key); }
  async putSummary(key: string, summary: TopicAiSummary): Promise<void> {
    if (!/^[1-9]\d*(?::[0-9a-f]{64})?$/.test(key) || Number(key.split(':')[0]) !== summary.topicId) throw new V2exError('invalid_request');
    const parsed = parseWrite(TopicAiSummarySchema, summary);
    const table = this.domain.table('summaries');
    await this.boundedPut('summaries', table, key, parsed, 300,
      () => true, (entry) => Date.parse(entry.generatedAt));
  }
}
