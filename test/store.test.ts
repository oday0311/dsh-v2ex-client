import assert from 'node:assert/strict';
import test from 'node:test';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { DomainContentStore, v2exDomainSpec } from '../src/store.js';
import type { Recommendation, TopicListItem } from '../src/contract.js';
import { InterestService } from '../src/interests.js';
import { accountScope } from '../src/account-scope.js';

type TableName = 'cache' | 'summaries' | 'recommendations';
function memoryDomain() {
  const tables = {
    cache: new Map<string, unknown>(), summaries: new Map<string, unknown>(), recommendations: new Map<string, unknown>(),
  };
  let global = structuredClone(v2exDomainSpec.global.initial);
  let failedPut: [TableName, string] | null = null;
  let failedDelete: [TableName, string] | null = null;
  let heldPut: { name: TableName; key: string; started: () => void; release: Promise<void> } | null = null;
  let failGlobalSet = false;
  const domain = {
    global: { get: () => structuredClone(global), set: async (next: typeof global) => {
      if (failGlobalSet) { failGlobalSet = false; throw new Error('global set failed'); }
      global = structuredClone(v2exDomainSpec.global.schema.parse(next));
    } },
    table: (name: TableName) => ({
      get: (key: string) => structuredClone(tables[name].get(key)),
      entries: () => tables[name].entries(),
      keys: () => tables[name].keys(),
      get size() { return tables[name].size; },
      put: async (key: string, value: unknown) => {
        if (heldPut?.name === name && heldPut.key === key) {
          const held = heldPut;
          heldPut = null;
          held.started();
          await held.release;
        }
        if (failedPut?.[0] === name && failedPut[1] === key) {
          failedPut = null;
          throw new Error('medium put failed');
        }
        tables[name].set(key, structuredClone(value));
      },
      delete: async (key: string) => {
        if (failedDelete?.[0] === name && failedDelete[1] === key) {
          failedDelete = null;
          throw new Error('medium delete failed');
        }
        return tables[name].delete(key);
      },
      update: async (key: string, fn: (value: unknown) => unknown) => {
        const next = fn(tables[name].get(key)); tables[name].set(key, structuredClone(next)); return next;
      },
    }),
  } as unknown as Domain<typeof v2exDomainSpec>;
  return { domain, tables, readGlobal: () => global,
    failNextGlobalSet: () => { failGlobalSet = true; },
    failNextPut: (name: TableName, key: string) => { failedPut = [name, key]; },
    failNextDelete: (name: TableName, key: string) => { failedDelete = [name, key]; },
    holdNextPut: (name: TableName, key: string) => {
      let signalStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      heldPut = { name, key, started: signalStarted, release: wait };
      return { started, release };
    } };
}

const topic: TopicListItem = {
  id: 1, title: 'One', node: { name: 'tech', title: 'Tech' }, author: { username: 'alice' },
  replyCount: 2, createdAt: '2026-11-06T00:00:00Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/1',
};
const recommendation: Recommendation = { topic, score: 0.8, reason: 'Relevant', matchedInterests: ['tech'],
  generatedAt: '2026-11-06T00:00:00Z', read: false, feedback: null };

test('versioned domain contains only content tables and an initialized settings/profile global', () => {
  assert.equal(v2exDomainSpec.version, 1);
  assert.deepEqual(Object.keys(v2exDomainSpec.tables).sort(), ['cache', 'recommendations', 'summaries']);
  assert.equal(v2exDomainSpec.global.initial.profile, null);
  assert.deepEqual(v2exDomainSpec.global.initial.profileEdits, { labels: false, preferredNodes: false, exclusions: false });
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

test('failed cache eviction prevents new durable record and never exceeds the cap', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const record = { value: [], fetchedAt: '2026-11-06T00:00:00Z', expiresAt: '2026-11-06T00:01:00Z', accessedAt: '2026-11-06T00:00:00Z' };
  for (let i = 1; i <= 100; i++) await store.putCache(`latest:${i}`, record);
  memory.failNextDelete('cache', 'latest:1');
  await assert.rejects(store.putCache('hot:1', record), /medium delete failed/);
  assert.equal(memory.tables.cache.size, 100);
  assert.equal(await store.getCache('hot:1'), undefined);
  assert.ok(await store.getCache('latest:1'));
});

test('failed cache put restores the entry evicted to make room', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const record = { value: [], fetchedAt: '2026-11-06T00:00:00Z', expiresAt: '2026-11-06T00:01:00Z', accessedAt: '2026-11-06T00:00:00Z' };
  for (let i = 1; i <= 100; i++) await store.putCache(`latest:${i}`, record);
  memory.failNextPut('cache', 'hot:1');
  await assert.rejects(store.putCache('hot:1', record), /medium put failed/);
  assert.equal(memory.tables.cache.size, 100);
  assert.ok(await store.getCache('latest:1'));
  assert.equal(await store.getCache('hot:1'), undefined);
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
  const profileWrite = store.putProfile({ authorized: false, learningPaused: false, labels: [],
    preferredNodes: [{ name: 'tech', weight: 1 }], exclusions: [], feedback: [],
    updatedAt: '2026-11-06T00:00:00Z', source: 'manual' });
  releaseFirst();
  await Promise.all([settingsWrite, profileWrite]);
  assert.equal((await store.getSettings()).refreshIntervalMinutes, 15);
  assert.deepEqual((await store.getProfile())?.preferredNodes, [{ name: 'tech', weight: 1 }]);
});

test('refresh settings and notification claims are durable and isolated by account', async () => {
  const memory = memoryDomain(); const alice = accountScope('alice'); const bob = accountScope('bob');
  const first = new DomainContentStore(memory.domain);
  await first.putSettings({ ...(await first.getSettings(alice)), refreshIntervalMinutes: 15,
    quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Shanghai' } }, alice);
  assert.equal((await first.getSettings(bob)).refreshIntervalMinutes, 30);
  const notice = (id: number) => ({ noticeId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    topicId: id, title: `Topic ${id}`, node: 'tech', reason: 'Relevant', createdAt: '2026-11-07T00:00:00.000Z' });
  const [one, two] = await Promise.all([
    first.enqueuePendingNotifications(alice, [notice(1), notice(2)]),
    first.enqueuePendingNotifications(alice, [notice(2), notice(3)]),
  ]);
  assert.deepEqual([...one, ...two].map(value => value.topicId).sort(), [1, 2, 3]);
  const reloaded = new DomainContentStore(memory.domain);
  assert.equal((await reloaded.getSettings(alice)).refreshIntervalMinutes, 15);
  assert.deepEqual((await reloaded.getPendingNotifications(alice)).map(value => value.topicId).sort(), [1, 2, 3]);
  await reloaded.markNotificationSent(alice, { ...one[0]!, reason: 'Changed after prepare' });
  assert.equal((await reloaded.getPendingNotifications(alice)).some(value => value.noticeId === one[0]!.noticeId), true);
  await reloaded.markNotificationSent(alice, one[0]!);
  assert.deepEqual(await reloaded.enqueuePendingNotifications(alice, [notice(one[0]!.topicId)]), []);
  assert.deepEqual((await reloaded.enqueuePendingNotifications(bob, [notice(1)])).map(value => value.topicId), [1]);
  await reloaded.clearRefreshState(alice);
  assert.equal((await reloaded.getSettings(alice)).refreshIntervalMinutes, 30);
  assert.deepEqual((await reloaded.enqueuePendingNotifications(alice, [notice(1)])).map(value => value.topicId), [1]);
  assert.deepEqual(await reloaded.enqueuePendingNotifications(bob, [notice(1)]), []);
});

test('failed durable notification claim is not reported as claimed', async () => {
  const memory = memoryDomain(); const store = new DomainContentStore(memory.domain); const scope = accountScope('alice');
  const notice = { noticeId: '00000000-0000-4000-8000-000000000001', topicId: 1, title: 'Topic', node: 'tech',
    reason: 'Relevant', createdAt: '2026-11-07T00:00:00.000Z' };
  memory.failNextGlobalSet();
  await assert.rejects(store.enqueuePendingNotifications(scope, [notice]), /global set failed/);
  assert.deepEqual((await store.enqueuePendingNotifications(scope, [notice])).map(value => value.topicId), [1]);
});

test('pending reminder storage is bounded, deterministic, and rejects unsafe content', async () => {
  const memory = memoryDomain(); const store = new DomainContentStore(memory.domain); const scope = accountScope('alice');
  const notice = (id: number) => ({ noticeId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    topicId: id, title: `Topic ${id}`, node: 'tech', reason: 'Relevant', createdAt: '2026-11-07T00:00:00.000Z' });
  const accepted = await store.enqueuePendingNotifications(scope, Array.from({ length: 25 }, (_, index) => notice(index + 1)));
  assert.deepEqual(accepted.map(value => value.topicId), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual((await store.getPendingNotifications(scope)).map(value => value.topicId), accepted.map(value => value.topicId));
  await assert.rejects(store.enqueuePendingNotifications(scope, [{ ...notice(30), title: 'token=\u0000FAKE_LONG_VALUE_12345678' }]),
    { code: 'invalid_request' });
  await assert.rejects(store.enqueuePendingNotifications(scope, [{ ...notice(31), title: 'tok', node: 'en',
    reason: '= FAKE_LONG_VALUE_12345678' }]), { code: 'invalid_request' });
  const unicodeScope = accountScope('unicode'); const unicode = { ...notice(32), title: `${'x'.repeat(199)}😀` };
  assert.deepEqual(await store.enqueuePendingNotifications(unicodeScope, [unicode]), [unicode]);
  assert.equal((await store.getPendingNotifications(unicodeScope))[0]!.title.isWellFormed(), true);
});

test('legacy profile is read as unauthorized structured data without changing domain version', async () => {
  const memory = memoryDomain();
  await memory.domain.global.set({ settings: memory.readGlobal().settings,
    profile: { labels: [{ name: 'Rust', weight: -0.4 }], preferredNodes: ['tech'],
      excludedTerms: ['ads'], feedback: [{ topicId: 42, interested: false }],
      updatedAt: '2026-11-06T00:00:00Z' } } as never);
  const profile = await new DomainContentStore(memory.domain).getProfile();
  assert.deepEqual(profile, { authorized: false, learningPaused: false,
    labels: [{ name: 'Rust', weight: 0 }], preferredNodes: [{ name: 'tech', weight: 1 }],
    exclusions: ['ads'], feedback: [{ topicId: 42, interested: false }],
    updatedAt: '2026-11-06T00:00:00Z', source: 'manual' });
  assert.equal(v2exDomainSpec.version, 1);
  const store = new DomainContentStore(memory.domain);
  const service = new InterestService(store, { async readEligibleUserText() { return 'interest'; } },
    { async completeJson() { return { labels: [{ name: 'Learned', weight: 1 }],
      preferredNodes: [], exclusions: ['new'] }; } } as never);
  await service.authorize();
  const relearned = await service.relearn();
  assert.deepEqual(relearned.labels, profile?.labels);
  assert.deepEqual(relearned.preferredNodes, profile?.preferredNodes);
  assert.deepEqual(relearned.exclusions, profile?.exclusions);
});

test('legacy mixed profiles preserve edits conservatively and clear resets private flags', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const profile = { authorized: true, learningPaused: false, labels: [], preferredNodes: [], exclusions: [],
    feedback: [], updatedAt: '2026-11-06T00:00:00Z', source: 'mixed' as const };
  await memory.domain.global.set({ settings: memory.readGlobal().settings, profile } as never);
  assert.deepEqual(await store.getProfileEdits(), { labels: true, preferredNodes: true, exclusions: true });
  await store.putInterestState(profile, { labels: true, preferredNodes: false, exclusions: true });
  assert.deepEqual(await store.getProfileEdits(), { labels: true, preferredNodes: false, exclusions: true });
  assert.equal('profileEdits' in (await store.getProfile() as object), false);
  await store.clearProfile();
  assert.deepEqual(await store.getProfileEdits(), { labels: false, preferredNodes: false, exclusions: false });
  assert.equal(await store.getProfile(), null);
});

test('legacy manual profile without edit metadata retains human fields after restart and relearn', async () => {
  const memory = memoryDomain();
  const oldProfile = { authorized: true, learningPaused: false,
    labels: [{ name: 'Manual', weight: 1 }], preferredNodes: [{ name: 'manual-node', weight: 1 }], exclusions: [],
    feedback: [], updatedAt: '2026-11-06T00:00:00Z', source: 'manual' as const };
  await memory.domain.global.set({ settings: memory.readGlobal().settings, profile: oldProfile } as never);
  const store = new DomainContentStore(memory.domain);
  const service = new InterestService(store, { async readEligibleUserText() { return 'interest'; } },
    { async completeJson() { return { labels: [{ name: 'Learned', weight: 1 }],
      preferredNodes: [{ name: 'learned-node', weight: 1 }], exclusions: ['learned-exclusion'] }; } } as never);
  const learned = await service.relearn();
  assert.deepEqual(learned.labels, oldProfile.labels);
  assert.deepEqual(learned.preferredNodes, oldProfile.preferredNodes);
  assert.deepEqual(learned.exclusions, []);
  const restarted = new InterestService(store, { async readEligibleUserText() { return 'interest'; } },
    { async completeJson() { return { labels: [{ name: 'New', weight: 1 }], preferredNodes: [], exclusions: [] }; } } as never);
  assert.deepEqual((await restarted.relearn()).labels, oldProfile.labels);
  assert.equal('profileEdits' in (await store.getProfile() as object), false);
});

test('legacy provenance survives pause, feedback, consent, and explicit empty edits across restart', async () => {
  for (const source of ['manual', 'source-less'] as const) for (const edit of ['pause', 'empty'] as const) {
    const memory = memoryDomain();
    const labels = [{ name: 'Manual', weight: 1 }];
    const preferredNodes = [{ name: 'manual-node', weight: 1 }];
    const exclusions = ['manual-exclusion'];
    const oldProfile = source === 'manual'
      ? { authorized: true, learningPaused: false, labels, preferredNodes, exclusions,
        feedback: [], updatedAt: '2026-11-06T00:00:00Z', source: 'manual' as const }
      : { labels, preferredNodes: ['manual-node'], excludedTerms: exclusions,
        feedback: [], updatedAt: '2026-11-06T00:00:00Z' };
    await memory.domain.global.set({ settings: memory.readGlobal().settings, profile: oldProfile } as never);
    const store = new DomainContentStore(memory.domain);
    const model = { async completeJson() { return { labels: [{ name: 'Learned', weight: 1 }],
      preferredNodes: [{ name: 'learned-node', weight: 1 }], exclusions: ['learned-exclusion'] }; } } as never;
    const history = { async readEligibleUserText() { return 'interest'; } };
    const service = new InterestService(store, history, model);
    await service.update(edit === 'pause' ? { learningPaused: true } :
      { labels: [], preferredNodes: [], exclusions: [] });
    await service.recordFeedback(9, true);
    await service.revoke();
    await service.authorize();
    const relearned = await new InterestService(store, history, model).relearn();
    assert.deepEqual(relearned.labels, edit === 'pause' ? labels : []);
    assert.deepEqual(relearned.preferredNodes, edit === 'pause' ? preferredNodes : []);
    assert.deepEqual(relearned.exclusions, edit === 'pause' ? exclusions : []);
    assert.deepEqual(relearned.feedback, [{ topicId: 9, interested: true }]);
    assert.equal('profileEdits' in relearned, false);
  }
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

test('summary and recommendation eviction failures do not create over-cap records', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  const summary = { topicId: 1, summary: 'Summary', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00Z', coveredReplyPages: [1], completeDiscussion: false };
  for (let i = 1; i <= 300; i++) await store.putSummary(String(i), { ...summary, topicId: i });
  memory.failNextDelete('summaries', '1');
  await assert.rejects(store.putSummary('301', { ...summary, topicId: 301 }), /medium delete failed/);
  assert.equal(memory.tables.summaries.size, 300);
  assert.equal(await store.getSummary('301'), undefined);

  for (let i = 1; i <= 500; i++) await store.putRecommendation(String(i), { ...recommendation, topic: { ...topic, id: i } });
  memory.failNextDelete('recommendations', '1');
  await assert.rejects(store.putRecommendation('501', { ...recommendation, topic: { ...topic, id: 501 } }), /medium delete failed/);
  assert.equal(memory.tables.recommendations.size, 500);
  assert.equal(await store.getRecommendation('501'), undefined);
});

test('recommendations persist read state and enforce the table cap', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  await store.putRecommendation('1', recommendation);
  await store.markRead('1');
  await store.setRecommendationFeedback('1', 'interested');
  await store.putRecommendation('1', { ...recommendation, reason: 'refreshed' });
  assert.deepEqual({ read: (await store.getRecommendation('1'))?.read,
    feedback: (await store.getRecommendation('1'))?.feedback,
    reason: (await store.getRecommendation('1'))?.reason },
  { read: true, feedback: 'interested', reason: 'refreshed' });
  for (let i = 2; i <= 501; i++) await store.putRecommendation(String(i), { ...recommendation, topic: { ...topic, id: i } });
  assert.equal(memory.tables.recommendations.size, 500);
  assert.equal(await store.getRecommendation('1'), undefined);
});

test('a delayed mark-read write cannot restore an evicted recommendation', async () => {
  const memory = memoryDomain();
  const store = new DomainContentStore(memory.domain);
  for (let i = 1; i <= 500; i++) await store.putRecommendation(String(i), { ...recommendation, topic: { ...topic, id: i } });
  const held = memory.holdNextPut('recommendations', '1');
  const read = store.markRead('1');
  await held.started;
  const insert = store.putRecommendation('501', { ...recommendation, topic: { ...topic, id: 501 } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  held.release();
  await Promise.all([read, insert]);
  assert.equal(memory.tables.recommendations.size, 500);
});

test('account-scoped interests and recommendation batches survive reload without exposing legacy state', async () => {
  const memory = memoryDomain();
  const first = new DomainContentStore(memory.domain);
  const alice = 'a'.repeat(64) + ':'; const bob = 'b'.repeat(64) + ':';
  const legacy = { authorized: true, learningPaused: false, labels: [{ name: 'legacy', weight: 1 }],
    preferredNodes: [], exclusions: [], feedback: [], updatedAt: '2026-11-07T00:00:00Z', source: 'manual' as const };
  await first.putProfile(legacy);
  assert.equal(await first.getProfile(alice), null);
  await first.putInterestState({ ...legacy, labels: [{ name: 'Alice', weight: 1 }] },
    { labels: true, preferredNodes: false, exclusions: true }, alice);
  await first.putInterestState({ ...legacy, labels: [{ name: 'Bob', weight: 1 }] },
    { labels: false, preferredNodes: true, exclusions: false }, bob);
  await first.putRecommendationBatch(alice, { generatedAt: '2026-11-07T00:00:00Z', topicIds: [1] });
  const reloaded = new DomainContentStore(memory.domain);
  assert.deepEqual((await reloaded.getProfile(alice))?.labels.map(value => value.name), ['Alice']);
  assert.deepEqual((await reloaded.getProfile(bob))?.labels.map(value => value.name), ['Bob']);
  assert.equal((await reloaded.getProfile())?.labels[0]?.name, 'legacy');
  assert.deepEqual(await reloaded.getProfileEdits(alice), { labels: true, preferredNodes: false, exclusions: true });
  assert.deepEqual(await reloaded.getRecommendationBatch(alice), { generatedAt: '2026-11-07T00:00:00Z', topicIds: [1] });
  await reloaded.clearProfile(bob);
  assert.equal(await reloaded.getProfile(bob), null);
  assert.equal((await reloaded.getProfile(alice))?.labels[0]?.name, 'Alice');
});

test('recommendation snapshot replacement is atomic, preserves actions, and survives reload', async () => {
  const memory = memoryDomain(); const scope = 'a'.repeat(64) + ':';
  const first = new DomainContentStore(memory.domain);
  await first.replaceRecommendationBatch(scope, { generatedAt: '2026-11-06T00:00:00Z', topicIds: [1], generation: 1 },
    [{ ...recommendation, read: true, feedback: 'interested' }]);
  memory.failNextGlobalSet();
  await assert.rejects(first.replaceRecommendationBatch(scope, { generatedAt: '2026-11-07T00:00:00Z', topicIds: [2], generation: 2 },
    [{ ...recommendation, topic: { ...topic, id: 2 }, reason: 'new', generatedAt: '2026-11-07T00:00:00Z' }]));
  const afterFailure = await new DomainContentStore(memory.domain).getRecommendationSnapshot(scope);
  assert.deepEqual(afterFailure?.batch.topicIds, [1]);
  assert.deepEqual(afterFailure?.items.map(item => [item.topic.id, item.read, item.feedback]), [[1, true, 'interested']]);
  const replaced = await first.replaceRecommendationBatch(scope,
    { generatedAt: '2026-11-07T00:00:00Z', topicIds: [1], generation: 3 },
    [{ ...recommendation, reason: 'updated', generatedAt: '2026-11-07T00:00:00Z' }]);
  assert.deepEqual(replaced.items.map(item => [item.reason, item.read, item.feedback]), [['updated', true, 'interested']]);
  await first.replaceRecommendationBatch(scope, { generatedAt: '2026-11-07T01:00:00Z', topicIds: [], generation: 4 }, []);
  const empty = await new DomainContentStore(memory.domain).getRecommendationSnapshot(scope);
  assert.deepEqual(empty, { batch: { generatedAt: '2026-11-07T01:00:00Z', topicIds: [], generation: 4 }, items: [] });
});

test('published snapshot is a one-way migration barrier for hidden legacy recommendation rows', async () => {
  const memory = memoryDomain(); const scope = 'a'.repeat(64) + ':'; const key = `${scope}1`;
  const first = new DomainContentStore(memory.domain); await first.putRecommendation(key, recommendation);
  await first.replaceRecommendationBatch(scope, { generatedAt: '2026-11-07T00:00:00Z', topicIds: [], generation: 1 }, []);
  const reloaded = new DomainContentStore(memory.domain);
  assert.equal(await reloaded.getRecommendation(key), undefined);
  await reloaded.markRead(key);
  await assert.rejects(reloaded.setRecommendationFeedback(key, 'not_interested'), { code: 'not_found' });
  assert.equal((memory.tables.recommendations.get(key) as Recommendation).read, false);
  assert.equal((memory.tables.recommendations.get(key) as Recommendation).feedback, null);
  assert.deepEqual(await reloaded.listRecommendations(scope), []);
});

test('clearing a pre-marker snapshot persists the migration barrier before legacy cleanup', async () => {
  const memory = memoryDomain(); const scope = 'a'.repeat(64) + ':'; const key = `${scope}1`;
  const store = new DomainContentStore(memory.domain); await store.putRecommendation(key, recommendation);
  await store.replaceRecommendationBatch(scope, { generatedAt: '2026-11-07T00:00:00Z', topicIds: [], generation: 1 }, []);
  const oldGlobal = structuredClone(memory.readGlobal()) as typeof v2exDomainSpec.global.initial;
  delete (oldGlobal as { migratedRecommendationScopes?: unknown }).migratedRecommendationScopes;
  await memory.domain.global.set(oldGlobal);
  memory.failNextDelete('recommendations', key);
  await assert.rejects(store.clearRecommendations(scope));
  const reloaded = new DomainContentStore(memory.domain);
  assert.equal(await reloaded.getRecommendation(key), undefined);
  assert.deepEqual(await reloaded.listRecommendations(scope), []);
});

test('legacy-only clear persists its barrier before a failed table deletion and reload stays closed', async () => {
  const memory = memoryDomain(); const scope = 'c'.repeat(64) + ':'; const key = `${scope}1`;
  const store = new DomainContentStore(memory.domain); await store.putRecommendation(key, recommendation);
  memory.failNextDelete('recommendations', key);
  await assert.rejects(store.clearRecommendations(scope), /medium delete failed/);
  assert.equal(memory.readGlobal().migratedRecommendationScopes?.[scope], true);
  const reloaded = new DomainContentStore(memory.domain);
  assert.equal(await reloaded.getRecommendation(key), undefined);
  assert.deepEqual(await reloaded.listRecommendations(scope), []);
  await assert.rejects(reloaded.setRecommendationFeedback(key, 'not_interested'), { code: 'not_found' });
  await reloaded.markRead(key);
  const hidden = memory.tables.recommendations.get(key) as Recommendation;
  assert.equal(hidden.feedback, null);
  assert.equal(hidden.read, false);
});

test('migration barrier capacity failure happens before legacy table cleanup', async () => {
  const memory = memoryDomain(); const store = new DomainContentStore(memory.domain);
  const current = structuredClone(memory.readGlobal());
  current.migratedRecommendationScopes = Object.fromEntries(Array.from({ length: 20 }, (_, index) =>
    [`${index.toString(16).padStart(64, '0')}:`, true as const]));
  await memory.domain.global.set(current);
  const scope = 'f'.repeat(64) + ':'; const key = `${scope}1`;
  await store.putRecommendation(key, recommendation);
  await assert.rejects(store.clearRecommendations(scope));
  assert.notEqual(memory.tables.recommendations.get(key), undefined);
  assert.deepEqual(await new DomainContentStore(memory.domain).getRecommendation(key), recommendation);
});
