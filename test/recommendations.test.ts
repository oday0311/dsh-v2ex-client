import assert from 'node:assert/strict';
import test from 'node:test';
import { RecommendationService } from '../src/recommendations.js';
import { V2exError } from '../src/errors.js';
import { FakeContentStore } from './helpers/fakes.js';
import type { InterestProfile, TopicListItem } from '../src/contract.js';

const at = '2026-11-07T00:00:00.000Z';
const topic = (id: number, title: string, node = 'dev', updated = at): TopicListItem => ({
  id, title, node: { name: node, title: node }, author: { username: 'alice' }, replyCount: 1,
  createdAt: at, lastReplyAt: updated, url: `https://www.v2ex.com/t/${id}`,
});
const profile = (change: Partial<InterestProfile> = {}): InterestProfile => ({
  authorized: true, learningPaused: false, labels: [{ name: 'TypeScript', weight: 1 }],
  preferredNodes: [{ name: 'dev', weight: 0.8 }], exclusions: [], feedback: [],
  updatedAt: at, source: 'history', ...change,
});

class RecordingModel {
  requests: Array<{ userData: string; tools: unknown[]; maxInputBytes: number }> = [];
  constructor(private readonly answer: unknown) {}
  async rankRecommendationCandidates(input: unknown) {
    const request = { userData: JSON.stringify(input), tools: [], maxInputBytes: 32 * 1024 };
    this.requests.push(request);
    return this.answer as never;
  }
}

function service(options: { store?: FakeContentStore; interest?: InterestProfile | null; model?: RecordingModel; account?: string } = {}) {
  const store = options.store ?? new FakeContentStore();
  store.profile = options.interest === undefined ? profile() : options.interest;
  const model = options.model ?? new RecordingModel({ items: [] });
  return { store, model, recommender: new RecommendationService(store, model as never,
    async () => options.account ?? 'alice', () => new Date(at)) };
}

test('local exclusions and negative feedback remove candidates before the single model call', async () => {
  const model = new RecordingModel({ items: [{ topicId: 2, score: 0.9, reason: 'Matches TypeScript', matchedInterests: ['TypeScript'] }] });
  const f = service({ model, interest: profile({ exclusions: ['crypto'], feedback: [{ topicId: 3, interested: false }] }) });
  const result = await f.recommender.refreshCandidates([
    topic(1, 'crypto promotion'), topic(2, 'TypeScript 6'), topic(3, 'TypeScript spam'),
  ]);
  assert.deepEqual(result.consideredTopicIds, [2]);
  assert.deepEqual(result.items.map(item => item.topic.id), [2]);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(JSON.parse(model.requests[0]!.userData).candidates.map((item: { id: number }) => item.id), [2]);
  assert.deepEqual(model.requests[0]!.tools, []);
});

test('deduplicates candidates, applies a bounded cheap pre-rank, and sorts ties deterministically', async () => {
  const model = new RecordingModel({ items: [
    { topicId: 3, score: 0.8, reason: 'C', matchedInterests: ['TypeScript'] },
    { topicId: 2, score: 0.8, reason: 'B', matchedInterests: ['TypeScript'] },
  ] });
  const f = service({ model });
  f.store.settings = { ...f.store.settings, aiCandidateBudget: 2 };
  const result = await f.recommender.refreshCandidates([
    topic(1, 'unrelated'), topic(2, 'TypeScript older', 'dev', '2026-11-07T01:00:00.000Z'),
    topic(2, 'duplicate'), topic(3, 'TypeScript newer', 'dev', '2026-11-07T02:00:00.000Z'),
    ...Array.from({ length: 200 }, (_, index) => topic(index + 10, `other ${index}`, 'other')),
  ]);
  assert.deepEqual(result.consideredTopicIds, [3, 2]);
  assert.deepEqual(result.items.map(item => item.topic.id), [3, 2]);
  assert.equal(model.requests.length, 1);
  assert.ok(Buffer.byteLength(model.requests[0]!.userData) <= model.requests[0]!.maxInputBytes);
});

test('rejects malformed, duplicate, unknown, or out-of-range model rankings without storing them', async () => {
  for (const answer of [
    { items: [{ topicId: 1, score: 2, reason: 'bad', matchedInterests: [] }] },
    { items: [{ topicId: 999, score: 0.5, reason: 'bad', matchedInterests: [] }] },
    { items: [{ topicId: 1, score: 0.5, reason: 'a', matchedInterests: [] }, { topicId: 1, score: 0.4, reason: 'b', matchedInterests: [] }] },
    { items: [{ topicId: 1, score: 0.5, reason: 'token=FAKE_LONG_SECRET_12345678', matchedInterests: [] }] },
  ]) {
    const f = service({ model: new RecordingModel(answer) });
    await assert.rejects(f.recommender.refreshCandidates([topic(1, 'TypeScript')]), { code: 'invalid_response' });
    assert.equal(f.store.recommendations.size, 0);
  }
});

test('refresh preserves existing read and feedback state for the same topic', async () => {
  const f = service({ model: new RecordingModel({ items: [{ topicId: 1, score: 0.9, reason: 'new', matchedInterests: ['TypeScript'] }] }) });
  await f.store.putRecommendation('2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90:1', {
    topic: topic(1, 'old'), score: 0.2, reason: 'old', matchedInterests: [], generatedAt: at,
    read: true, feedback: 'interested',
  });
  const result = await f.recommender.refreshCandidates([topic(1, 'TypeScript')]);
  assert.equal(result.items[0]?.read, true);
  assert.equal(result.items[0]?.feedback, 'interested');
});

test('concurrent refresh cannot overwrite a later read or not-interested action', async () => {
  const store = new FakeContentStore();
  store.profile = profile();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = { async rankRecommendationCandidates() {
    await gate; return { items: [{ topicId: 1, score: 0.9, reason: 'ranked', matchedInterests: ['TypeScript'] }] };
  } };
  const recommender = new RecommendationService(store, model as never, async () => 'alice', () => new Date(at));
  await store.putRecommendation('2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90:1', {
    topic: topic(1, 'old'), score: 0.1, reason: 'old', matchedInterests: [], generatedAt: at,
    read: false, feedback: null,
  });
  const refresh = recommender.refreshCandidates([topic(1, 'TypeScript')]);
  await new Promise(resolve => setImmediate(resolve));
  await recommender.markRead(1);
  await recommender.feedback({ topicId: 1, value: 'not_interested' });
  release();
  await refresh;
  const stored = [...store.recommendations.values()][0]!;
  assert.equal(stored.read, true);
  assert.equal(stored.feedback, 'not_interested');
  assert.deepEqual((await recommender.list()).items, []);
});

test('recommendations are account-scoped while manual interests work without history authorization', async () => {
  const shared = new FakeContentStore();
  shared.profile = profile();
  const alice = service({ store: shared, account: 'alice', model: new RecordingModel({ items: [{ topicId: 1, score: 0.9, reason: 'A', matchedInterests: [] }] }) }).recommender;
  await alice.refreshCandidates([topic(1, 'TypeScript')]);
  const bob = service({ store: shared, account: 'bob' }).recommender;
  assert.deepEqual((await bob.list()).items, []);
  const manual = service({ interest: profile({ authorized: false }),
    model: new RecordingModel({ items: [{ topicId: 1, score: 0.5, reason: 'manual', matchedInterests: [] }] }) }).recommender;
  assert.deepEqual((await manual.refreshCandidates([topic(1, 'TypeScript')])).items.map(item => item.topic.id), [1]);
  const unauthenticated = new RecommendationService(shared, new RecordingModel({ items: [] }) as never,
    async () => { throw new V2exError('not_authenticated'); });
  await assert.rejects(unauthenticated.list(), { code: 'not_authenticated' });
});

test('credential-shaped profile values and topics never reach the model, and large valid input shrinks to fit', async () => {
  const model = new RecordingModel({ items: [] });
  const f = service({ model, interest: profile({ labels: [
    { name: 'token=FAKE_LONG_SECRET_12345678', weight: 1 }, { name: 'TypeScript', weight: 0.9 },
  ] }) });
  f.store.settings = { ...f.store.settings, aiCandidateBudget: 100 };
  const result = await f.recommender.refreshCandidates([
    topic(1, 'token=FAKE_LONG_SECRET_12345678'),
    ...Array.from({ length: 99 }, (_, index) => topic(index + 2, `TypeScript ${'x'.repeat(470)} ${index}`)),
  ]);
  assert.equal(model.requests.length, 1);
  assert.doesNotMatch(model.requests[0]!.userData, /FAKE_LONG_SECRET/);
  assert.ok(Buffer.byteLength(model.requests[0]!.userData) <= model.requests[0]!.maxInputBytes - 1500);
  assert.ok(result.consideredTopicIds.length > 0 && result.consideredTopicIds.length < 100);
});

test('a slower older refresh cannot overwrite a newer ranking', async () => {
  const store = new FakeContentStore(); store.profile = profile();
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let call = 0;
  const model = { async rankRecommendationCandidates() {
    if (++call === 1) { entered(); await gate; return { items: [{ topicId: 1, score: 0.1, reason: 'old', matchedInterests: [] }] }; }
    return { items: [{ topicId: 1, score: 0.9, reason: 'new', matchedInterests: [] }] };
  } };
  const recommender = new RecommendationService(store, model as never, async () => 'alice', () => new Date(at));
  const older = recommender.refreshCandidates([topic(1, 'TypeScript')]);
  await started;
  await recommender.refreshCandidates([topic(1, 'TypeScript')]);
  release();
  await assert.rejects(older, { code: 'timeout' });
  assert.equal((await recommender.list()).items[0]?.reason, 'new');
  assert.equal((await recommender.list()).stale, false);
});

test('empty candidates or a missing profile degrade without a model call', async () => {
  const model = new RecordingModel({ items: [] });
  const missing = service({ interest: null, model });
  assert.deepEqual((await missing.recommender.refreshCandidates([topic(1, 'TypeScript')])).items, []);
  assert.deepEqual((await service({ model }).recommender.refreshCandidates([])).items, []);
  assert.equal(model.requests.length, 0);
});

test('profile feedback suppresses stored items even if the recommendation write lagged', async () => {
  const f = service({ interest: profile({ feedback: [{ topicId: 1, interested: false }] }) });
  await f.store.putRecommendation('2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90:1', {
    topic: topic(1, 'TypeScript'), score: 0.8, reason: 'old', matchedInterests: [], generatedAt: at,
    read: false, feedback: null,
  });
  assert.deepEqual((await f.recommender.list()).items, []);
});
