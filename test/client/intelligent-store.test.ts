import assert from 'node:assert/strict';
import test from 'node:test';
import { V2exClientStore } from '../../src/client/store.js';
import type { V2exClientRemote } from '../../src/client/http.js';
import type { AccountStatus, Cached, InterestProfile, PluginSettings, RecommendationList, TopicAiSummary, TopicListItem, TopicPage, TopicThread } from '../../src/contract.js';

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
    summary: async () => ({ topicId: 7, summary: 'summary', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [1], completeDiscussion: true }),
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
  let finish!: (value: TopicAiSummary) => void;
  const store = new V2exClientStore(remote({ summary: async (_id, nextMode, _pages, nextSignal) => {
    mode = nextMode; signal = nextSignal; return new Promise(resolve => { finish = resolve; });
  } }));
  await store.loadSession(); await store.openTopic('7');
  const pending = store.generateSummary('viewpoints');
  store.closeTopic();
  assert.equal(signal?.aborted, true);
  finish({ topicId: 7, summary: 'late', viewpoints: [], notableReplies: [], generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [], completeDiscussion: false });
  await pending;
  assert.equal(mode, 'viewpoints');
  assert.equal(store.getSnapshot().summary, null);
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
