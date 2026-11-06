import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { CacheRecord, ContentStore, InterestProfile, PluginSettings, Recommendation, TopicAiSummary } from './contract.js';
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

export const InterestProfileSchema = z.strictObject({
  labels: z.array(z.strictObject({ name: z.string().trim().min(1).max(80), weight: z.number().finite().min(-1).max(1) })).max(100),
  preferredNodes: z.array(nodeName).max(100),
  excludedTerms: z.array(z.string().trim().min(1).max(100)).max(100),
  feedback: z.array(z.strictObject({ topicId, interested: z.boolean() })).max(500),
  updatedAt: timestamp,
});

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
    schema: z.strictObject({ settings: PluginSettingsSchema, profile: InterestProfileSchema.nullable() }),
    initial: { settings: defaultSettings, profile: null as InterestProfile | null },
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
  constructor(private readonly domain: Domain<typeof v2exDomainSpec>, private readonly clock: () => Date = () => new Date()) {}

  private updateGlobal(change: (current: { settings: PluginSettings; profile: InterestProfile | null }) => { settings: PluginSettings; profile: InterestProfile | null }): Promise<void> {
    const write = this.globalWrites.then(() => this.domain.global.set(change(this.domain.global.get())));
    this.globalWrites = write.catch(() => {});
    return write;
  }

  async getCache(key: string): Promise<CacheRecord | undefined> {
    assertCacheKey(key);
    const table = this.domain.table('cache');
    const record = table.get(key);
    if (!record) return undefined;
    const accessedAt = this.clock().toISOString();
    await table.put(key, { ...record, accessedAt });
    return { ...record, accessedAt };
  }

  async putCache(key: string, record: CacheRecord): Promise<void> {
    assertCacheKey(key);
    const parsed = CacheRecordSchema.safeParse(record);
    if (!parsed.success) throw new V2exError('invalid_response');
    const table = this.domain.table('cache');
    await table.put(key, parsed.data);
    const isList = /^(latest|hot|node):/.test(key);
    const entries = [...table.entries()].filter(([entryKey]) => /^(latest|hot|node):/.test(entryKey) === isList);
    const cap = isList ? 100 : 300;
    if (entries.length > cap) {
      entries.sort((a, b) => Date.parse(a[1].accessedAt) - Date.parse(b[1].accessedAt));
      for (const [oldest] of entries.slice(0, entries.length - cap)) await table.delete(oldest);
    }
  }

  async deleteCache(key: string): Promise<void> { await this.domain.table('cache').delete(assertCacheKey(key)); }
  async getSettings(): Promise<PluginSettings> { return structuredClone(this.domain.global.get().settings); }
  async putSettings(settings: PluginSettings): Promise<void> {
    const parsed = parseWrite(PluginSettingsSchema, settings);
    await this.updateGlobal((current) => ({ ...current, settings: parsed }));
  }
  async getProfile(): Promise<InterestProfile | null> { return structuredClone(this.domain.global.get().profile); }
  async putProfile(profile: InterestProfile): Promise<void> {
    const parsed = parseWrite(InterestProfileSchema, profile);
    await this.updateGlobal((current) => ({ ...current, profile: parsed }));
  }
  async clearProfile(): Promise<void> { await this.updateGlobal((current) => ({ ...current, profile: null })); }

  async getRecommendation(key: string): Promise<Recommendation | undefined> { return this.domain.table('recommendations').get(key); }
  async putRecommendation(key: string, recommendation: Recommendation): Promise<void> {
    if (!/^[1-9]\d*$/.test(key) || Number(key) !== recommendation.topic.id) throw new V2exError('invalid_request');
    const parsed = parseWrite(RecommendationSchema, recommendation);
    const table = this.domain.table('recommendations');
    await table.put(key, parsed);
    const entries = [...table.entries()];
    if (entries.length > 500) {
      entries.sort((a, b) => Date.parse(a[1].createdAt) - Date.parse(b[1].createdAt) || Number(a[0]) - Number(b[0]));
      for (const [oldest] of entries.slice(0, entries.length - 500)) await table.delete(oldest);
    }
  }
  async markRead(key: string): Promise<void> {
    const table = this.domain.table('recommendations');
    const value = table.get(key);
    if (value && !value.read) await table.put(key, { ...value, read: true });
  }
  async listRecommendations(): Promise<Recommendation[]> { return [...this.domain.table('recommendations').entries()].map(([, value]) => value); }
  async getSummary(key: string): Promise<TopicAiSummary | undefined> { return this.domain.table('summaries').get(key); }
  async putSummary(key: string, summary: TopicAiSummary): Promise<void> {
    if (!/^[1-9]\d*$/.test(key) || Number(key) !== summary.topicId) throw new V2exError('invalid_request');
    const parsed = parseWrite(TopicAiSummarySchema, summary);
    const table = this.domain.table('summaries');
    await table.put(key, parsed);
    const entries = [...table.entries()];
    if (entries.length > 300) {
      entries.sort((a, b) => Date.parse(a[1].generatedAt) - Date.parse(b[1].generatedAt) || Number(a[0]) - Number(b[0]));
      for (const [oldest] of entries.slice(0, entries.length - 300)) await table.delete(oldest);
    }
  }
}
