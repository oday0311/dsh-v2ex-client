import assert from 'node:assert/strict';
import { test } from 'node:test';
import { V2exClientStore } from '../../src/client/store.js';
import type { V2exClientRemote } from '../../src/client/http.js';
import type { AccountStatus, Cached, NodeInfo, TopicPage, TopicThread, ReplyItem, TopicListItem } from '../../src/contract.js';
import { createV2exHttpClient, V2exClientError } from '../../src/client/http.js';

const account = (authenticated: boolean): AccountStatus => ({ authenticated, writable: false, username: authenticated ? 'reader' : null, tokenScope: null, expiresAt: null });
const topic: TopicListItem = { id: 7, title: 'TypeScript', node: { name: 'dev', title: '开发' }, author: { username: 'alice' }, replyCount: 2, createdAt: '2026-11-06T00:00:00.000Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/7' };
const cached = <T>(value: T): Cached<T> => ({ value, fetchedAt: '2026-11-06T00:00:00.000Z', source: 'network', stale: false });
const page = (items = [topic]): Cached<TopicPage> => cached({ items, page: 1, hasMore: false, stale: false });
const reply: ReplyItem = { id: 1, author: { username: 'bob' }, content: '第 1 页回复', createdAt: '2026-11-06T00:00:00.000Z' };

function remote(overrides: Partial<V2exClientRemote> = {}): V2exClientRemote {
  return {
    session: async () => account(true), login: async () => account(true), logout: async () => account(false),
    latest: async () => page(), hot: async () => cached([topic]),
    tab: async () => page(), nodes: async () => cached<NodeInfo[]>([{ name: 'dev', title: '开发', topicCount: 1, url: 'https://www.v2ex.com/go/dev' }]),
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

test('failed token replacement keeps the prior authenticated session and topics', async () => {
  const store = new V2exClientStore(remote({ login: async () => { throw new V2exClientError('token_invalid'); } }));
  await store.loadSession();
  await store.loadLatest();
  await store.login('invalid-replacement');
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().account?.username, 'reader');
  assert.equal(store.getSnapshot().topics?.value.items[0]?.title, 'TypeScript');
  assert.equal(store.getSnapshot().error, 'token_invalid');
  assert.equal(JSON.stringify(store.getSnapshot()).includes('invalid-replacement'), false);
  store.dispose();
});

test('successful account replacement clears prior account content immediately', async () => {
  const bob: AccountStatus = { authenticated: true, writable: false, username: 'bob', tokenScope: null, expiresAt: null };
  const store = new V2exClientStore(remote({ login: async () => bob }));
  await store.loadSession(); await store.loadLatest(); await store.openTopic('7');
  assert.ok(store.getSnapshot().topics); assert.ok(store.getSnapshot().thread);
  await store.login('bob-replacement');
  assert.equal(store.getSnapshot().account?.username, 'bob');
  assert.equal(store.getSnapshot().topics, null); assert.equal(store.getSnapshot().thread, null);
  assert.equal(store.getSnapshot().recommendations, null); assert.equal(store.getSnapshot().interests, null);
  store.dispose();
});

test('unauthenticated login success envelope cannot demote an existing ready session', async () => {
  const client = createV2exHttpClient(async (_input, init) => new Response(JSON.stringify({ ok: true, data:
    init?.method === 'POST' ? account(false) : account(true),
  }), { headers: { 'content-type': 'application/json' } }));
  const store = new V2exClientStore(client);
  await store.loadSession();
  assert.equal(store.getSnapshot().phase, 'ready');
  await store.login('replacement-secret');
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().account?.username, 'reader');
  assert.equal(store.getSnapshot().error, 'invalid_response');
  assert.equal(store.getSnapshot().loading, false);
  store.dispose();
});

test('unauthenticated login success envelope leaves an initial guest with an error', async () => {
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: true, data: account(false) }),
    { headers: { 'content-type': 'application/json' } }));
  const store = new V2exClientStore(client);
  await store.loadSession();
  assert.equal(store.getSnapshot().phase, 'guest');
  await store.login('first-secret');
  assert.equal(store.getSnapshot().phase, 'guest');
  assert.equal(store.getSnapshot().error, 'invalid_response');
  assert.equal(store.getSnapshot().loading, false);
  store.dispose();
});

test('store rejects an anonymous login result from a non-HTTP remote', async () => {
  const store = new V2exClientStore(remote({ login: async () => account(false) }));
  await store.loadSession();
  await store.login('replacement-secret');
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().account?.username, 'reader');
  assert.equal(store.getSnapshot().error, 'invalid_response');
  store.dispose();
});

test('view navigation clears detail and reply work across latest, hot, and node', async () => {
  let replySignal: AbortSignal | undefined;
  let finishReplies!: (value: Cached<ReplyItem[]>) => void;
  const store = new V2exClientStore(remote({ replies: (_id, _page, signal) => {
    replySignal = signal;
    return new Promise(resolve => { finishReplies = resolve; });
  } }));
  await store.loadSession();
  await store.loadLatest();
  await store.openTopic('7');
  const pending = store.loadMoreReplies();
  store.selectView('hot');
  assert.equal(replySignal?.aborted, true);
  assert.equal(store.getSnapshot().repliesLoading, false);
  assert.equal(store.getSnapshot().detailLoading, false);
  assert.equal(store.getSnapshot().thread, null);
  finishReplies(cached([reply]));
  await pending;
  assert.equal(store.getSnapshot().thread, null);
  store.selectView('node');
  assert.equal(store.getSnapshot().view, 'node');
  store.selectView('latest');
  assert.equal(store.getSnapshot().view, 'latest');
  store.dispose();
});

test('new node clears previous node and detail before request, including failed replacement', async () => {
  let finish!: (value: Cached<TopicPage>) => void;
  let oldSignal: AbortSignal | undefined;
  const store = new V2exClientStore(remote({
    node: async name => cached({ name, title: name, topicCount: 1, url: `https://www.v2ex.com/go/${name}` }),
    nodeTopics: (name, _page, signal) => name === 'second'
      ? new Promise((_resolve, reject) => { oldSignal = signal; reject(new V2exClientError('offline')); })
      : name === 'third' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(page()),
  }));
  await store.loadSession();
  await store.loadNode('first');
  await store.openTopic('7');
  const replacement = store.loadNode('third');
  assert.equal(store.getSnapshot().nodeInfo, null);
  assert.equal(store.getSnapshot().topics, null);
  assert.equal(store.getSnapshot().thread, null);
  assert.equal(store.getSnapshot().detailLoading, false);
  finish(page([]));
  await replacement;
  await store.loadNode('second');
  assert.equal(oldSignal?.aborted, false);
  assert.equal(store.getSnapshot().nodeName, 'second');
  assert.equal(store.getSnapshot().topics, null);
  assert.equal(store.getSnapshot().nodeInfo, null);
  assert.equal(store.getSnapshot().error, 'offline');
  store.dispose();
});

test('a late topic result cannot reopen detail after switching views or nodes', async () => {
  let finishTopic!: (value: Cached<TopicThread>) => void;
  let topicSignal: AbortSignal | undefined;
  const store = new V2exClientStore(remote({ topic: (_id, signal) => {
    topicSignal = signal;
    return new Promise(resolve => { finishTopic = resolve; });
  } }));
  await store.loadSession();
  const pending = store.openTopic('7');
  await store.loadNode('dev');
  assert.equal(topicSignal?.aborted, true);
  assert.equal(store.getSnapshot().detailLoading, false);
  finishTopic(cached({ topic, content: 'old', replies: [], replyPage: 0, hasMoreReplies: false, stale: false }));
  await pending;
  assert.equal(store.getSnapshot().thread, null);
  store.dispose();
});

test('selecting a tab loads that section and clears detail work', async () => {
  const calls: string[] = [];
  const store = new V2exClientStore(remote({ tab: async (tab) => {
    calls.push(tab);
    return page([{ ...topic, id: 11, title: `Tab ${tab}` }]);
  } }));
  await store.loadSession();
  await store.openTopic('7');
  store.selectTab('jobs');
  assert.equal(store.getSnapshot().view, 'tabs');
  assert.equal(store.getSnapshot().tab, 'jobs');
  assert.equal(store.getSnapshot().thread, null);
  assert.equal(store.getSnapshot().detailLoading, false);
  for (let i = 0; i < 10 && store.getSnapshot().loading; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['jobs']);
  assert.equal(store.getSnapshot().topics?.value.items[0]?.title, 'Tab jobs');
  store.selectView('tabs');
  assert.equal(store.getSnapshot().view, 'tabs');
  for (let i = 0; i < 10 && store.getSnapshot().loading; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['jobs', 'jobs']);
  store.selectTab('nope' as never);
  assert.equal(store.getSnapshot().error, 'invalid_request');
  store.dispose();
});

test('a replaced tab request is aborted and cannot overwrite the newer section', async () => {
  let finishFirst!: (value: Cached<TopicPage>) => void;
  let firstSignal: AbortSignal | undefined;
  let count = 0;
  const store = new V2exClientStore(remote({ tab: (_tab, signal) => {
    count++;
    if (count === 1) { firstSignal = signal; return new Promise(resolve => { finishFirst = resolve; }); }
    return Promise.resolve(page([{ ...topic, id: 12, title: 'Second tab' }]));
  } }));
  await store.loadSession();
  const first = store.loadTab('tech');
  const second = store.loadTab('play');
  assert.equal(firstSignal?.aborted, true);
  finishFirst(page([{ ...topic, id: 13, title: 'First tab' }]));
  await Promise.allSettled([first, second]);
  assert.equal(store.getSnapshot().tab, 'play');
  assert.equal(store.getSnapshot().topics?.value.items[0]?.title, 'Second tab');
  store.dispose();
});

test('node catalog loads for the node view and retries after a failure', async () => {
  let count = 0;
  const nodes: NodeInfo[] = [
    { name: 'dev', title: '开发', topicCount: 12, url: 'https://www.v2ex.com/go/dev' },
    { name: 'python', title: 'Python', topicCount: 30, url: 'https://www.v2ex.com/go/python' },
  ];
  const store = new V2exClientStore(remote({ nodes: async () => {
    count++;
    if (count === 1) throw new V2exClientError('offline');
    return cached(nodes);
  } }));
  await store.loadSession();
  store.selectView('node');
  for (let i = 0; i < 10 && store.getSnapshot().nodesLoading; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().nodesError, 'offline');
  assert.equal(store.getSnapshot().nodes, null);
  store.retry();
  for (let i = 0; i < 10 && store.getSnapshot().nodesLoading; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().nodesError, null);
  assert.deepEqual(store.getSnapshot().nodes?.value.map(node => node.name), ['dev', 'python']);
  await store.loadNodes();
  assert.equal(count, 3);
  await store.login('replacement');
  assert.equal(store.getSnapshot().nodes, null);
  store.dispose();
});

test('boot probe retries one transient invalid response and recovers', async () => {
  let count = 0;
  const store = new V2exClientStore(remote({ session: async () => {
    count++;
    if (count === 1) throw new V2exClientError('invalid_response');
    return account(true);
  } }));
  await store.loadSession();
  assert.equal(count, 2);
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().error, null);
  store.dispose();
});

test('boot probe hides a missing Host route behind a clean login form', async () => {
  const store = new V2exClientStore(remote({ session: async () => { throw new V2exClientError('plugin_unavailable'); } }));
  await store.loadSession();
  assert.equal(store.getSnapshot().phase, 'guest');
  assert.equal(store.getSnapshot().error, null);
  store.dispose();
});

test('login retries one transient invalid response and succeeds', async () => {
  let count = 0;
  const store = new V2exClientStore(remote({ session: async () => account(false), login: async () => {
    count++;
    if (count === 1) throw new V2exClientError('invalid_response');
    return account(true);
  } }));
  await store.loadSession();
  await store.login('test-secret-value');
  assert.equal(count, 2);
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().error, null);
  store.dispose();
});
