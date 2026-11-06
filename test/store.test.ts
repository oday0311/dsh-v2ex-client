import assert from 'node:assert/strict';
import test from 'node:test';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { DomainContentStore, v2exDomainSpec } from '../src/store.js';
import type { Recommendation, TopicListItem } from '../src/contract.js';

type TableName = 'cache' | 'summaries' | 'recommendations';
function memoryDomain() {
  const tables = {
    cache: new Map<string, unknown>(), summaries: new Map<string, unknown>(), recommendations: new Map<string, unknown>(),
  };
  let global = structuredClone(v2exDomainSpec.global.initial);
  const domain = {
    global: { get: () => structuredClone(global), set: async (next: typeof global) => { global = structuredClone(next); } },
    table: (name: TableName) => ({
      get: (key: string) => structuredClone(tables[name].get(key)),
      entries: () => tables[name].entries(),
      keys: () => tables[name].keys(),
      get size() { return tables[name].size; },
      put: async (key: string, value: unknown) => { tables[name].set(key, structuredClone(value)); },
      delete: async (key: string) => tables[name].delete(key),
      update: async (key: string, fn: (value: unknown) => unknown) => {
        const next = fn(tables[name].get(key)); tables[name].set(key, structuredClone(next)); return next;
      },
    }),
  } as unknown as Domain<typeof v2exDomainSpec>;
  return { domain, tables, readGlobal: () => global };
}

const topic: TopicListItem = {
  id: 1, title: 'One', node: { name: 'tech', title: 'Tech' }, author: { username: 'alice' },
  replyCount: 2, createdAt: '2026-11-06T00:00:00Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/1',
};
const recommendation: Recommendation = { topic, score: 0.8, reason: 'Relevant', read: false, createdAt: '2026-11-06T00:00:00Z' };

test('versioned domain contains only content tables and an initialized settings/profile global', () => {
  assert.equal(v2exDomainSpec.version, 1);
  assert.deepEqual(Object.keys(v2exDomainSpec.tables).sort(), ['cache', 'recommendations', 'summaries']);
  assert.equal(v2exDomainSpec.global.initial.profile, null);
  assert.equal(v2exDomainSpec.global.initial.settings.refreshIntervalMinutes, 30);
});

test('invalid cache replacement leaves the last durable record intact', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain, () => new Date('2026-11-06T00:00:00Z'));
  await store.putCache('latest:1', { value: [1], fetchedAt: '2026-11-06T00:00:00Z', expiresAt: '2026-11-06T00:01:00Z', accessedAt: '2026-11-06T00:00:00Z' });
  await assert.rejects(store.putCache('latest:1', { value: [2], fetchedAt: 'invalid', expiresAt: 'invalid', accessedAt: 'invalid' }), { code: 'invalid_response' });
  assert.deepEqual((await store.getCache('latest:1'))?.value, [1]);
  assert.deepEqual((memory.tables.cache.get('latest:1') as { value: number[] }).value, [1]);
});

test('cache LRU bounds list and thread entries independently', async () => {
  const memory = memoryDomain();
  let tick = 0;
  const store = new DomainContentStore(memory.domain, () => new Date(1_800_000_000_000 + tick++));
  const record = { value: [], fetchedAt: '2026-11-06T00:00:00Z', expiresAt: '2026-11-06T00:01:00Z', accessedAt: '2026-11-06T00:00:00Z' };
  for (let i = 1; i <= 100; i++) await store.putCache(`latest:${i}`, record);
  await store.getCache('latest:1');
  await store.putCache('hot:1', record);
  assert.equal(memory.tables.cache.size, 100);
  assert.equal(await store.getCache('latest:2'), undefined);
  assert.ok(await store.getCache('latest:1'));
  for (let i = 1; i <= 301; i++) await store.putCache(`topic:${i}`, record);
  assert.equal(memory.tables.cache.size, 400);
  assert.equal(await store.getCache('topic:1'), undefined);
});

test('settings and profile reject invalid writes before replacing durable global', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const original = await store.getSettings();
  await assert.rejects(store.putSettings({ ...original, refreshIntervalMinutes: 0 }), { code: 'invalid_request' });
  assert.deepEqual(memory.readGlobal().settings, original);
  await assert.rejects(store.putProfile({ labels: [{ name: 'bad', weight: Number.NaN }], preferredNodes: [], excludedTerms: [], feedback: [], updatedAt: '2026-11-06T00:00:00Z' }), { code: 'invalid_request' });
  assert.equal(await store.getProfile(), null);
});

test('concurrent settings and profile writes preserve both global fields', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const originalSet = memory.domain.global.set;
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  memory.domain.global.set = async (value) => {
    if (++writes === 1) await firstWrite;
    await originalSet(value);
  };
  const settingsWrite = store.putSettings({ ...(await store.getSettings()), refreshIntervalMinutes: 15 });
  const profileWrite = store.putProfile({ labels: [], preferredNodes: ['tech'], excludedTerms: [], feedback: [], updatedAt: '2026-11-06T00:00:00Z' });
  releaseFirst();
  await Promise.all([settingsWrite, profileWrite]);
  assert.equal((await store.getSettings()).refreshIntervalMinutes, 15);
  assert.deepEqual((await store.getProfile())?.preferredNodes, ['tech']);
});

test('summary writes validate before replacement and evict oldest beyond 300', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const summary = { topicId: 1, summary: 'Summary', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00Z', coveredReplyPages: [1], completeDiscussion: false };
  await store.putSummary('1', summary);
  await assert.rejects(store.putSummary('1', { ...summary, summary: '' }), { code: 'invalid_request' });
  assert.equal((await store.getSummary('1'))?.summary, 'Summary');
  for (let i = 2; i <= 301; i++) await store.putSummary(String(i), { ...summary, topicId: i });
  assert.equal(memory.tables.summaries.size, 300);
  assert.equal(await store.getSummary('1'), undefined);
});

test('recommendations persist read state and enforce the table cap', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  await store.putRecommendation('1', recommendation);
  await store.markRead('1');
  assert.equal((await store.getRecommendation('1'))?.read, true);
  for (let i = 2; i <= 501; i++) await store.putRecommendation(String(i), { ...recommendation, topic: { ...topic, id: i } });
  assert.equal(memory.tables.recommendations.size, 500);
  assert.equal(await store.getRecommendation('1'), undefined);
});
