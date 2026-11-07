import assert from 'node:assert/strict';
import test from 'node:test';
import { V2exClientStore } from '../../src/client/store.js';
import type { V2exClientRemote } from '../../src/client/http.js';
import type { AccountStatus, Cached, InterestProfile, PluginSettings, PublicTopicAiSummary, RecommendationList, TopicListItem, TopicPage, TopicThread } from '../../src/contract.js';

const account = (username: string | null): AccountStatus => ({ authenticated: username !== null, writable: false, username, tokenScope: null, expiresAt: null });
const topic: TopicListItem = { id: 7, title: 'TypeScript', node: { name: 'dev', title: '开发' }, author: { username: 'alice' }, replyCount: 1,
  createdAt: '2026-11-06T00:00:00.000Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/7' };
const cached = <T>(value: T): Cached<T> => ({ value, fetchedAt: '2026-11-06T00:00:00.000Z', source: 'network', stale: false });
const profile: InterestProfile = { authorized: false, learningPaused: false, labels: [], preferredNodes: [], exclusions: [], feedback: [],
  source: 'manual', updatedAt: '2026-11-06T00:00:00.000Z' };
const settings: PluginSettings = { refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2, aiCandidateBudget: 10,
  maxModelCallsPerRefresh: 1, notificationThreshold: 0.7, quietHours: null };
const recommendations: RecommendationList = { items: [{ topic, score: 0.9, reason: '匹配 TypeScript', matchedInterests: ['TypeScript'],
  generatedAt: '2026-11-06T00:00:00.000Z', read: false, feedback: null }], generatedAt: '2026-11-06T00:00:00.000Z', stale: false, source: 'stored' };

function remote(overrides: Partial<V2exClientRemote> = {}): V2exClientRemote {
  return { session: async () => account('alice'), login: async () => account('alice'), logout: async () => account(null),
    latest: async () => cached<TopicPage>({ items: [topic], page: 1, hasMore: false, stale: false }), hot: async () => cached([topic]),
    node: async () => cached({ name: 'dev', title: '开发', topicCount: 1, url: 'https://www.v2ex.com/go/dev' }),
    nodeTopics: async () => cached<TopicPage>({ items: [topic], page: 1, hasMore: false, stale: false }),
    topic: async () => cached<TopicThread>({ topic, content: 'body', replies: [], replyPage: 0, hasMoreReplies: false, stale: false }), replies: async () => cached([]),
    summary: async (_id, mode) => ({ topicId: 7, summary: 'summary', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [1], completeDiscussion: true, mode }),
    interests: async () => profile, recommendations: async () => recommendations,
    recommendationFeedback: async () => {}, recommendationRead: async () => {},
    settings: async () => settings, updateSettings: async value => value, ...overrides };
}

test('intelligent requests publish only the latest account generation', async () => {
  let finish!: (value: RecommendationList) => void;
  const api = remote({ recommendations: async () => new Promise(resolve => { finish = resolve; }) });
  const store = new V2exClientStore(api);
  await store.loadSession();
  const pending = store.loadRecommendations();
  api.session = async () => account('bob');
  await store.loadSession();
  finish(recommendations);
  await pending;
  assert.equal(store.getSnapshot().recommendations, null);
  assert.equal(store.getSnapshot().account?.username, 'bob');
  store.dispose();
});

test('summary regeneration is explicit, mode-scoped, and aborts when detail closes', async () => {
  let signal: AbortSignal | undefined; let mode = '';
  let finish!: (value: PublicTopicAiSummary) => void;
  const store = new V2exClientStore(remote({ summary: async (_id, nextMode, _pages, nextSignal) => {
    mode = nextMode; signal = nextSignal; return new Promise(resolve => { finish = resolve; });
  } }));
  await store.loadSession(); await store.openTopic('7');
  const pending = store.generateSummary('viewpoints');
  store.closeTopic();
  assert.equal(signal?.aborted, true);
  finish({ topicId: 7, summary: 'late', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [], completeDiscussion: false, mode: 'viewpoints' });
  await pending;
  assert.equal(mode, 'viewpoints');
  assert.equal(store.getSnapshot().summary, null);
  store.dispose();
});

test('summary response must match the requested topic and mode', async () => {
  for (const mismatch of [
    { topicId: 8, mode: 'quick' as const },
    { topicId: 7, mode: 'full' as const },
  ]) {
    const store = new V2exClientStore(remote({ summary: async () => ({ ...mismatch, summary: 'wrong context', viewpoints: [], notableReplies: [],
      generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [], completeDiscussion: false }) }));
    await store.loadSession(); await store.openTopic('7'); await store.generateSummary('quick');
    assert.equal(store.getSnapshot().summary, null);
    assert.equal(store.getSnapshot().summaryError, 'invalid_response');
    store.dispose();
  }
});

test('changing summary mode clears and cancels a delayed old-mode result', async () => {
  let finish!: (value: PublicTopicAiSummary) => void; let signal!: AbortSignal;
  const store = new V2exClientStore(remote({ summary: async (_id, _mode, _pages, nextSignal) => {
    signal = nextSignal!; return new Promise(resolve => { finish = resolve; });
  } }));
  await store.loadSession(); await store.openTopic('7');
  const pending = store.generateSummary('quick');
  store.setSummaryMode('full');
  assert.equal(signal.aborted, true);
  assert.equal(store.getSnapshot().summary, null);
  finish({ topicId: 7, mode: 'quick', summary: 'old mode', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [], completeDiscussion: false });
  await pending;
  assert.equal(store.getSnapshot().summary, null);
  assert.equal(store.getSnapshot().summaryMode, 'full');
  store.dispose();
});

test('recommendation actions update unread and feedback state without waiting for refresh', async () => {
  const store = new V2exClientStore(remote());
  await store.loadSession(); await store.loadRecommendations();
  assert.equal(store.getSnapshot().recommendations?.items.filter(item => !item.read).length, 1);
  await store.markRecommendationRead(7);
  assert.equal(store.getSnapshot().recommendations?.items[0]?.read, true);
  await store.setRecommendationFeedback(7, 'interested');
  assert.equal(store.getSnapshot().recommendations?.items[0]?.feedback, 'interested');
  store.dispose();
});

test('read and feedback for the same topic complete independently and merge fields', async () => {
  let finishRead!: () => void; let finishFeedback!: () => void;
  const store = new V2exClientStore(remote({
    recommendationRead: async () => new Promise<void>(resolve => { finishRead = resolve; }),
    recommendationFeedback: async () => new Promise<void>(resolve => { finishFeedback = resolve; }),
  }));
  await store.loadSession(); await store.loadRecommendations();
  const read = store.markRecommendationRead(7);
  const feedback = store.setRecommendationFeedback(7, 'interested');
  finishFeedback(); await feedback; finishRead(); await read;
  assert.equal(store.getSnapshot().recommendations?.items[0]?.read, true);
  assert.equal(store.getSnapshot().recommendations?.items[0]?.feedback, 'interested');
  store.dispose();
});

test('recommendation actions are isolated per topic and stale account completions are ignored', async () => {
  const topic8 = { ...topic, id: 8, title: 'Rust', url: 'https://www.v2ex.com/t/8' };
  const list = { ...recommendations, items: [recommendations.items[0]!, { ...recommendations.items[0]!, topic: topic8 }] };
  const finishes = new Map<number, () => void>();
  const api = remote({ recommendations: async () => list,
    recommendationFeedback: async id => new Promise<void>(resolve => { finishes.set(id, resolve); }) });
  const store = new V2exClientStore(api);
  await store.loadSession(); await store.loadRecommendations();
  const first = store.setRecommendationFeedback(7, 'interested');
  const second = store.setRecommendationFeedback(8, 'not_interested');
  finishes.get(8)!(); await second; finishes.get(7)!(); await first;
  assert.deepEqual(store.getSnapshot().recommendations?.items.map(item => item.feedback), ['interested', 'not_interested']);
  const stale = store.setRecommendationFeedback(7, 'not_interested');
  api.session = async () => account('bob'); await store.loadSession();
  finishes.get(7)!(); await stale;
  assert.equal(store.getSnapshot().account?.username, 'bob');
  assert.equal(store.getSnapshot().recommendations, null);
  store.dispose();
});

test('repeating the same recommendation action supersedes only that topic action', async () => {
  const signals: AbortSignal[] = []; const finishes: Array<() => void> = [];
  const store = new V2exClientStore(remote({ recommendationRead: async (_id, signal) => {
    signals.push(signal!); return new Promise<void>(resolve => { finishes.push(resolve); });
  } }));
  await store.loadSession(); await store.loadRecommendations();
  const first = store.markRecommendationRead(7); const second = store.markRecommendationRead(7);
  assert.equal(signals[0]?.aborted, true); assert.equal(signals[1]?.aborted, false);
  finishes[0]!(); await first; finishes[1]!(); await second;
  assert.equal(store.getSnapshot().recommendations?.items[0]?.read, true);
  store.dispose();
});
