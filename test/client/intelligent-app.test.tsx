import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { V2exApp } from '../../src/client/V2exApp.js';
import { V2exClientStore } from '../../src/client/store.js';
import type { V2exClientRemote } from '../../src/client/http.js';
import type { AccountStatus, Cached, InterestProfile, PluginSettings, RecommendationList, TopicListItem, TopicPage, TopicThread } from '../../src/contract.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://host.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
afterEach(cleanup);

const account: AccountStatus = { authenticated: true, writable: false, username: 'alice', tokenScope: null, expiresAt: null };
const topic: TopicListItem = { id: 7, title: 'TypeScript 类型体操', node: { name: 'dev', title: '开发' }, author: { username: 'alice' }, replyCount: 1,
  createdAt: '2026-11-06T00:00:00.000Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/7' };
const cached = <T,>(value: T): Cached<T> => ({ value, fetchedAt: '2026-11-06T00:00:00.000Z', source: 'network', stale: false });
const profile: InterestProfile = { authorized: false, learningPaused: false, labels: [], preferredNodes: [], exclusions: [], feedback: [], source: 'manual', updatedAt: '2026-11-06T00:00:00.000Z' };
const settings: PluginSettings = { refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2, aiCandidateBudget: 10, maxModelCallsPerRefresh: 1, notificationThreshold: 0.7, quietHours: null };

function fixture() {
  const feedback: string[] = [];
  let recommendationLoads = 0;
  const recommendations: RecommendationList = { items: [{ topic, score: 0.9, reason: '匹配 TypeScript 兴趣', matchedInterests: ['TypeScript'],
    generatedAt: '2026-11-06T00:00:00.000Z', read: false, feedback: null }], generatedAt: '2026-11-06T00:00:00.000Z', stale: false, source: 'stored' };
  const remote: V2exClientRemote = { session: async () => account, login: async () => account, logout: async () => ({ ...account, authenticated: false, username: null }),
    latest: async () => cached<TopicPage>({ items: [topic], page: 1, hasMore: false, stale: false }), hot: async () => cached([topic]),
    node: async () => cached({ name: 'dev', title: '开发', topicCount: 1, url: 'https://www.v2ex.com/go/dev' }),
    nodeTopics: async () => cached<TopicPage>({ items: [topic], page: 1, hasMore: false, stale: false }),
    topic: async () => cached<TopicThread>({ topic, content: '正文', replies: [], replyPage: 0, hasMoreReplies: false, stale: false }), replies: async () => cached([]),
    summary: async (_id, mode) => ({ topicId: 7, summary: '总结结果', viewpoints: ['观点'], notableReplies: [], generatedAt: '2026-11-06T00:00:00.000Z',
      coveredReplyPages: [1], completeDiscussion: false, coverage: { loadedReplyPages: 1, totalReplyPages: 2, complete: false }, mode }),
    interests: async () => profile, recommendations: async () => { recommendationLoads += 1; return recommendations; },
    recommendationFeedback: async (_id, value) => { feedback.push(value); }, recommendationRead: async () => {},
    settings: async () => settings, updateSettings: async value => value };
  return { store: new V2exClientStore(remote), feedback, recommendationLoads: () => recommendationLoads };
}

test('loads the unread recommendation badge once the account is ready', async () => {
  const f = fixture(); await f.store.loadSession(); render(<V2exApp store={f.store} />);
  assert.ok(await screen.findByRole('tab', { name: /1 条未读/ }));
  assert.equal(f.recommendationLoads(), 1);
  f.store.dispose();
});

test('smart recommendations disclose unread, source and freshness and accept feedback', async () => {
  const f = fixture(); await f.store.loadSession(); render(<V2exApp store={f.store} />);
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /智能推荐/ })); });
  assert.ok(screen.getByRole('tab', { name: /1 条未读/ }));
  assert.ok(screen.getByText('匹配 TypeScript 兴趣'));
  assert.ok(screen.getByText(/来源：已保存/));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '感兴趣' })); });
  assert.deepEqual(f.feedback, ['interested']);
  f.store.dispose();
});

test('main tabs support arrow navigation and expose one associated tabpanel', async () => {
  const f = fixture(); await f.store.loadSession(); render(<V2exApp store={f.store} />);
  const latest = screen.getByRole('tab', { name: '最新' });
  latest.focus();
  await act(async () => { fireEvent.keyDown(latest, { key: 'ArrowRight' }); });
  assert.equal(screen.getByRole('tab', { name: '热门' }).getAttribute('aria-selected'), 'true');
  assert.equal(screen.getAllByRole('tabpanel').length, 1);
  f.store.dispose();
});

test('topic detail connects explicit summary generation and incomplete disclosure', async () => {
  const f = fixture(); await f.store.loadSession(); await f.store.openTopic('7'); render(<V2exApp store={f.store} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成总结' })); });
  assert.ok(screen.getByText('总结结果'));
  assert.ok(screen.getByText('内容并非完整讨论归纳'));
  f.store.dispose();
});
