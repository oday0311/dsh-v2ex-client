import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { V2exApp } from '../../src/client/V2exApp.js';
import { V2exClientStore } from '../../src/client/store.js';
import type { V2exClientRemote } from '../../src/client/http.js';
import type { AccountStatus, Cached, TopicListItem, TopicPage, TopicThread } from '../../src/contract.js';
import { apply } from '../../src/client/index.js';
import { CSS } from '../../src/client/styles.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
afterEach(cleanup);

const account = (authenticated: boolean): AccountStatus => ({ authenticated, writable: false, username: authenticated ? 'reader' : null, tokenScope: null, expiresAt: null });
const item: TopicListItem = { id: 7, title: 'TypeScript', node: { name: 'dev', title: '开发' }, author: { username: 'alice' }, replyCount: 1, createdAt: '2026-11-06T00:00:00.000Z', lastReplyAt: null, url: 'https://www.v2ex.com/t/7' };
const cached = <T,>(value: T): Cached<T> => ({ value, fetchedAt: '2026-11-06T00:00:00.000Z', stale: false, source: 'network' });
function remote(authenticated: boolean): V2exClientRemote {
  return { session: async () => account(authenticated), login: async () => account(true), logout: async () => account(false),
    latest: async () => cached<TopicPage>({ items: [item], page: 1, hasMore: false, stale: false }),
    hot: async () => cached([item]), node: async () => cached({ name: 'dev', title: '开发', topicCount: 1, url: 'https://www.v2ex.com/go/dev' }),
    nodeTopics: async () => cached<TopicPage>({ items: [item], page: 1, hasMore: false, stale: false }),
    topic: async () => cached<TopicThread>({ topic: item, content: '正文', replies: [], replyPage: 0, hasMoreReplies: true, stale: false }),
    replies: async () => cached([{ id: 1, author: { username: 'bob' }, content: '第 1 页回复', createdAt: '2026-11-06T00:00:00.000Z' }]),
  };
}

test('unauthenticated state exposes only token login', async () => {
  const store = new V2exClientStore(remote(false));
  await store.loadSession();
  render(<V2exApp store={store} />);
  assert.ok(screen.getByLabelText('V2EX Personal Access Token'));
  assert.equal(screen.queryByRole('tab', { name: '最新' }), null);
  assert.equal(screen.queryByRole('button', { name: '退出登录' }), null);
  store.dispose();
});

test('login submission clears the input and unlocks browsing', async () => {
  const api = remote(false);
  let submitted = '';
  api.login = async token => { submitted = token; return account(true); };
  const store = new V2exClientStore(api);
  await store.loadSession();
  render(<V2exApp store={store} />);
  const input = screen.getByLabelText('V2EX Personal Access Token') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'example-token' } });
  await act(async () => { fireEvent.submit(input.closest('form')!); });
  assert.equal(submitted, 'example-token');
  assert.equal(input.value, '');
  assert.ok(await screen.findByRole('tab', { name: '最新' }));
  assert.equal(JSON.stringify(store.getSnapshot()).includes('example-token'), false);
  store.dispose();
});

test('authenticated browsing opens a topic and loads replies', async () => {
  const store = new V2exClientStore(remote(true));
  await store.loadSession();
  render(<V2exApp store={store} />);
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '最新' })); });
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /TypeScript/ })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加载更多回复' })); });
  assert.ok(screen.getAllByText('第 1 页回复').length >= 1);
  assert.ok(document.querySelector('.v2ex-layout'));
  assert.match(CSS, /container-type:inline-size/);
  assert.match(CSS, /@container\(min-width:760px\)/);
  store.dispose();
});

test('hot and node views remain usable without AI controls', async () => {
  const store = new V2exClientStore(remote(true));
  await store.loadSession();
  render(<V2exApp store={store} />);
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '热门' })); });
  assert.ok(screen.getByRole('button', { name: /TypeScript/ }));
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '节点' })); });
  fireEvent.change(screen.getByLabelText('节点名称'), { target: { value: 'dev' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('节点名称').closest('form')!); });
  assert.ok(screen.getByText('开发', { selector: 'h2' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /TypeScript/ })); });
  assert.equal((screen.getByRole('button', { name: '生成总结' }) as HTMLButtonElement).disabled, true);
  store.dispose();
});

test('stale cached content stays visible with its refresh failure', async () => {
  const api = remote(true);
  api.latest = async () => ({ ...cached<TopicPage>({ items: [item], page: 1, hasMore: false, stale: true }), stale: true,
    refreshError: { code: 'offline', message: 'internal detail', retryable: true } });
  const store = new V2exClientStore(api);
  await store.loadSession();
  await store.loadLatest();
  render(<V2exApp store={store} />);
  assert.ok(screen.getByRole('button', { name: /TypeScript/ }));
  assert.ok(screen.getByText('显示缓存内容，数据可能已过期'));
  assert.ok(screen.getByText('网络不可用，请检查连接。'));
  assert.equal(document.body.textContent?.includes('internal detail'), false);
  store.dispose();
});

test('sidebar registration uses v2ex panel id and disposes pending work', async () => {
  const registrations: Array<{ entry: Record<string, unknown>; component: React.ComponentType }> = [];
  const cleanups: Array<() => void> = [];
  const localeSnapshot = { active: 'zh' };
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  };
  const ctx = {
    effect: (factory: () => unknown) => { const value = factory(); if (typeof value === 'function') cleanups.push(value as () => void); },
    locale: { register: () => () => {}, bind: () => () => 'V2EX', getSnapshot: () => localeSnapshot, subscribe: () => () => {} },
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: (entry: Record<string, unknown>, component: React.ComponentType) => { registrations.push({ entry, component }); return () => {}; } },
  };
  try {
    apply(ctx as never);
    assert.ok(registrations.some(({ entry }) => entry.name === 'sidebar.panellist' && entry.id === 'v2ex'));
    const panel = registrations.find(({ entry }) => entry.name === 'main' && entry.key === 'v2ex');
    assert.ok(panel);
    render(React.createElement(panel.component));
    await waitFor(() => assert.ok(signal));
    cleanups.forEach(cleanup => cleanup());
    assert.equal(signal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account status and token replacement stay visible without retaining the new token', async () => {
  const api = remote(true);
  api.session = async () => ({ ...account(true), tokenScope: 'read', expiresAt: '2027-01-01T00:00:00.000Z' });
  let finishLogin!: (value: AccountStatus) => void;
  api.login = async () => new Promise(resolve => { finishLogin = resolve; });
  const store = new V2exClientStore(api);
  await store.loadSession();
  render(<V2exApp store={store} />);
  assert.ok(screen.getByText(/令牌权限: read/));
  assert.ok(screen.getByText(/2027/));
  fireEvent.click(screen.getByRole('button', { name: '更换令牌' }));
  const input = screen.getByLabelText('V2EX Personal Access Token') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'replacement-secret' } });
  fireEvent.submit(input.closest('form')!);
  assert.equal(input.value, '');
  assert.equal(JSON.stringify(store.getSnapshot()).includes('replacement-secret'), false);
  await act(async () => { finishLogin(account(true)); });
  store.dispose();
});

test('latest view filters fetched topics by local keyword and node', async () => {
  const api = remote(true);
  const other = { ...item, id: 8, title: 'Rust', node: { name: 'rust', title: 'Rust' } };
  api.latest = async () => cached<TopicPage>({ items: [item, other], page: 1, hasMore: false, stale: false });
  const store = new V2exClientStore(api);
  await store.loadSession();
  await store.loadLatest();
  render(<V2exApp store={store} />);
  fireEvent.change(screen.getByLabelText('关键词'), { target: { value: 'Rust' } });
  assert.equal(screen.queryByRole('button', { name: /TypeScript/ }), null);
  assert.ok(screen.getByRole('button', { name: /Rust/ }));
  fireEvent.change(screen.getByLabelText('筛选节点'), { target: { value: 'dev' } });
  assert.equal(screen.queryByRole('button', { name: /Rust/ }), null);
  store.dispose();
});

test('English copy follows the supplied DSH locale snapshot', async () => {
  const store = new V2exClientStore(remote(true));
  await store.loadSession();
  const snapshot = { active: 'en' };
  const locale = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  render(<V2exApp store={store} locale={locale} />);
  assert.ok(screen.getByRole('tab', { name: 'Latest' }));
  assert.ok(screen.getByRole('button', { name: 'Log out' }));
  store.dispose();
});

test('DSH locale changes update the mounted UI without resetting browsing state', async () => {
  const store = new V2exClientStore(remote(true));
  await store.loadSession();
  await store.loadLatest();
  let snapshot = { active: 'zh' };
  let notify = () => {};
  const locale = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {}; }; } };
  render(<V2exApp store={store} locale={locale} />);
  assert.ok(screen.getByRole('tab', { name: '最新' }));
  await act(async () => { snapshot = { active: 'en' }; notify(); });
  assert.ok(screen.getByRole('tab', { name: 'Latest' }));
  assert.ok(screen.getByRole('button', { name: /TypeScript/ }));
  store.dispose();
});
