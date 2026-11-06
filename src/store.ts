import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { CacheRecord, ContentStore, InterestEditFlags, InterestProfile, PluginSettings, Recommendation, TopicAiSummary } from './contract.js';
import { V2exError } from './errors.js';
import { assertPage, assertTopicId } from './validation.js';

const timestamp = z.iso.datetime({ offset: true });
const nodeName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const topicId = z.number().int().positive().safe();

export const PluginSettingsSchema = z.strictObject({
  refreshIntervalMinutes: z.number().int().min(1).max(1440),
  scannedNodes: z.array(nodeName).max(100),
  pagesPerNode: z.number().int().min(1).max(1000),
  aiCandidateBudget: z.number().int().min(0).max(100),
  notificationThreshold: z.number().min(0).max(1),
  quietHours: z.strictObject({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).nullable(),
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
  labels: z.boolean(), preferredNodes: z.boolean(), exclusions: z.boolean(),
});
const noInterestEdits: InterestEditFlags = { labels: false, preferredNodes: false, exclusions: false };

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
  read: z.boolean(), createdAt: timestamp,
});

export const defaultSettings: PluginSettings = {
  refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2,
  aiCandidateBudget: 10, notificationThreshold: 0.7, quietHours: null,
};

export const v2exDomainSpec = defineDomain({
  name: 'v2ex_client', version: 1,
  global: {
    schema: z.strictObject({ settings: PluginSettingsSchema, profile: z.union([InterestProfileSchema, LegacyProfileSchema]).nullable(),
      profileEdits: InterestEditFlagsSchema.optional() }),
    initial: { settings: defaultSettings, profile: null as InterestProfile | null, profileEdits: noInterestEdits },
  },
  tables: {
    cache: domainTable<string, CacheRecord>(CacheRecordSchema),
    summaries: domainTable<string, TopicAiSummary>(TopicAiSummarySchema),
    recommendations: domainTable<string, Recommendation>(RecommendationSchema),
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

  private updateGlobal(change: (current: { settings: PluginSettings; profile: InterestProfile | null; profileEdits?: InterestEditFlags }) =>
    { settings: PluginSettings; profile: InterestProfile | null; profileEdits?: InterestEditFlags }): Promise<void> {
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
  async getSettings(): Promise<PluginSettings> { return structuredClone(this.domain.global.get().settings); }
  async putSettings(settings: PluginSettings): Promise<void> {
    const parsed = parseWrite(PluginSettingsSchema, settings);
    await this.updateGlobal((current) => ({ ...current, settings: parsed }));
  }
  async getProfile(): Promise<InterestProfile | null> {
    const profile = this.domain.global.get().profile;
    if (profile === null) return null;
    const parsed = z.union([InterestProfileSchema, LegacyProfileSchema]).safeParse(profile);
    if (!parsed.success) throw new V2exError('invalid_response');
    return structuredClone(parsed.data);
  }
  async putProfile(profile: InterestProfile): Promise<void> {
    const parsed = parseWrite(InterestProfileSchema, profile);
    await this.updateGlobal((current) => ({ ...current, profile: parsed }));
  }
  async getProfileEdits(): Promise<InterestEditFlags> {
    const current = this.domain.global.get();
    const parsed = InterestEditFlagsSchema.safeParse(current.profileEdits);
    if (parsed.success) return structuredClone(parsed.data);
    if (current.profileEdits !== undefined) throw new V2exError('invalid_response');
    return current.profile?.source === 'mixed' ? { labels: true, preferredNodes: true, exclusions: true } : { ...noInterestEdits };
  }
  async putInterestState(profile: InterestProfile, edits: InterestEditFlags): Promise<void> {
    const parsedProfile = parseWrite(InterestProfileSchema, profile);
    const parsedEdits = parseWrite(InterestEditFlagsSchema, edits);
    await this.updateGlobal((current) => ({ ...current, profile: parsedProfile, profileEdits: parsedEdits }));
  }
  async clearProfile(): Promise<void> {
    await this.updateGlobal((current) => ({ ...current, profile: null, profileEdits: { ...noInterestEdits } }));
  }

  async getRecommendation(key: string): Promise<Recommendation | undefined> { return this.domain.table('recommendations').get(key); }
  async putRecommendation(key: string, recommendation: Recommendation): Promise<void> {
    if (!/^[1-9]\d*$/.test(key) || Number(key) !== recommendation.topic.id) throw new V2exError('invalid_request');
    const parsed = parseWrite(RecommendationSchema, recommendation);
    const table = this.domain.table('recommendations');
    await this.boundedPut('recommendations', table, key, parsed, 500,
      () => true, (entry) => Date.parse(entry.createdAt));
  }
  async markRead(key: string): Promise<void> {
    const table = this.domain.table('recommendations');
    await this.serialize('recommendations', async () => {
      const value = table.get(key);
      if (value && !value.read) await table.put(key, { ...value, read: true });
    });
  }
  async listRecommendations(): Promise<Recommendation[]> { return [...this.domain.table('recommendations').entries()].map(([, value]) => value); }
  async getSummary(key: string): Promise<TopicAiSummary | undefined> { return this.domain.table('summaries').get(key); }
  async putSummary(key: string, summary: TopicAiSummary): Promise<void> {
    if (!/^[1-9]\d*(?::[0-9a-f]{64})?$/.test(key) || Number(key.split(':')[0]) !== summary.topicId) throw new V2exError('invalid_request');
    const parsed = parseWrite(TopicAiSummarySchema, summary);
    const table = this.domain.table('summaries');
    await this.boundedPut('summaries', table, key, parsed, 300,
      () => true, (entry) => Date.parse(entry.generatedAt));
  }
}
