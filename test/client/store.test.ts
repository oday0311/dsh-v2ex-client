import assert from 'node:assert/strict';
import { test } from 'node:test';
import { V2exClientStore } from '../../src/client/store.js';
import type { V2exClientRemote } from '../../src/client/http.js';
import type { AccountStatus, Cached, TopicPage, TopicThread, ReplyItem, TopicListItem } from '../../src/contract.js';
import { V2exClientError } from '../../src/client/http.js';

const account = (authenticated: boolean): AccountStatus => ({ authenticated, writable: false, username: authenticated ? 'reader' : null, tokenScope: null, expiresAt: null });
const topic: TopicListItem = { id: 7, title: 'TypeScript', node: { name: 'dev', title: '开发' }, author: { username: 'alice' }, replyCount: 2, createdAt: '2026-11-06T00:00:00.000Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/7' };
const cached = <T>(value: T): Cached<T> => ({ value, fetchedAt: '2026-11-06T00:00:00.000Z', source: 'network', stale: false });
const page = (items = [topic]): Cached<TopicPage> => cached({ items, page: 1, hasMore: false, stale: false });
const reply: ReplyItem = { id: 1, author: { username: 'bob' }, content: '第 1 页回复', createdAt: '2026-11-06T00:00:00.000Z' };

function remote(overrides: Partial<V2exClientRemote> = {}): V2exClientRemote {
  return {
    session: async () => account(true), login: async () => account(true), logout: async () => account(false),
    latest: async () => page(), hot: async () => cached([topic]),
    node: async () => cached({ name: 'dev', title: '开发', topicCount: 1, url: 'https://www.v2ex.com/go/dev' }),
    nodeTopics: async () => page(), topic: async () => cached<TopicThread>({ topic, content: '正文', replies: [], replyPage: 0, hasMoreReplies: true, stale: false }),
    replies: async () => cached([reply]), ...overrides,
  };
}

test('login discards token and browsing opens detail with replies', async () => {
  let submitted = '';
  const store = new V2exClientStore(remote({ login: async token => { submitted = token; return account(true); } }));
  await store.login('test-secret-value');
  assert.equal(submitted, 'test-secret-value');
  assert.equal(JSON.stringify(store.getSnapshot()).includes('test-secret-value'), false);
  await store.loadLatest();
  await store.openTopic('7');
  await store.loadMoreReplies();
  assert.equal(store.getSnapshot().thread?.value.replies[0]?.content, '第 1 页回复');
  store.dispose();
});

test('replacement aborts prior list request and suppresses stale completion', async () => {
  let firstSignal: AbortSignal | undefined;
  let resolveFirst!: (value: Cached<TopicPage>) => void;
  let count = 0;
  const store = new V2exClientStore(remote({ latest: (_page, signal) => {
    count++;
    if (count === 1) { firstSignal = signal; return new Promise(resolve => { resolveFirst = resolve; }); }
    return Promise.resolve(page([]));
  } }));
  await store.loadSession();
  const first = store.loadLatest();
  await store.loadLatest();
  assert.equal(firstSignal?.aborted, true);
  resolveFirst(page());
  await first;
  assert.deepEqual(store.getSnapshot().topics?.value.items, []);
  store.dispose();
});

test('dispose aborts pending work and prevents late state changes', async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (value: Cached<TopicPage>) => void;
  const store = new V2exClientStore(remote({ latest: (_page, nextSignal) => {
    signal = nextSignal;
    return new Promise(done => { resolve = done; });
  } }));
  await store.loadSession();
  const pending = store.loadLatest();
  store.dispose();
  const snapshot = store.getSnapshot();
  assert.equal(signal?.aborted, true);
  resolve(page());
  await pending;
  assert.equal(store.getSnapshot(), snapshot);
});

test('retry preserves cached topics and recovers from a failed refresh', async () => {
  let count = 0;
  const store = new V2exClientStore(remote({ latest: async () => {
    count++;
    if (count === 2) throw new V2exClientError('offline');
    return page();
  } }));
  await store.loadSession();
  await store.loadLatest();
  await store.loadLatest();
  assert.equal(store.getSnapshot().error, 'offline');
  assert.equal(store.getSnapshot().topics?.value.items[0]?.title, 'TypeScript');
  store.retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().error, null);
  assert.equal(count, 3);
  store.dispose();
});

test('expired token returns to login and hides previous content', async () => {
  const store = new V2exClientStore(remote({ latest: async () => { throw new V2exClientError('token_expired'); } }));
  await store.loadSession();
  await store.loadLatest();
  assert.equal(store.getSnapshot().phase, 'guest');
  assert.equal(store.getSnapshot().topics, null);
  assert.equal(store.getSnapshot().error, 'token_expired');
  store.dispose();
});
