import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2exHttpRoutes } from '../src/http-routes.js';
import { V2exError } from '../src/errors.js';
import { composePlugin } from '../src/plugin.js';
import { Config } from '../src/index.js';
import { Context } from '@deepseek-ai/cordis';

const TOKEN = '00000000-0000-4000-8000-000000000000';
const PATHS = ['/session', '/latest', '/hot', '/node', '/node/topics', '/topic', '/topic/summary', '/interests',
  '/recommendations', '/recommendations/feedback', '/recommendations/read', '/replies', '/health'];

function fixture() {
  const routes = new Map<string, { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }>();
  const calls: string[] = [];
  const removed: string[] = [];
  const connection = { fetch: { register(route: (typeof routes extends Map<string, infer V> ? V : never)) {
    assert.equal(routes.has(route.path), false);
    routes.set(route.path, route);
    return () => { removed.push(route.path); routes.delete(route.path); };
  } } };
  const auth = {
    async status() { calls.push('status'); return { authenticated: false, writable: true, username: null, tokenScope: null, expiresAt: null }; },
    async login(token: string) { calls.push('login'); assert.equal(token, TOKEN); return { authenticated: true, writable: true, username: 'alice', tokenScope: null, expiresAt: null }; },
    async logout(clear: boolean) { calls.push(`logout:${clear}`); },
  };
  const content = {
    async latest(input: { page: number }) { calls.push(`latest:${input.page}`); return { value: { items: [], page: input.page, hasMore: false, stale: false }, stale: false, source: 'network', fetchedAt: 'now' }; },
    async hot() { calls.push('hot'); return { value: [], stale: false, source: 'network', fetchedAt: 'now' }; },
    async node(input: { node: string }) { calls.push(`node:${input.node}`); return { value: { name: input.node }, stale: false, source: 'network', fetchedAt: 'now' }; },
    async nodeTopics(input: { node: string; page: number }) { calls.push(`nodeTopics:${input.node}:${input.page}`); return { value: { items: [] }, stale: false, source: 'network', fetchedAt: 'now' }; },
    async topic(input: { topic: string; replyPages: number }) { calls.push(`topic:${input.topic}:${input.replyPages}`); return { value: { topic: { id: Number(input.topic) }, content: '', replies: [], replyPage: input.replyPages, hasMoreReplies: false }, stale: false, source: 'network', fetchedAt: 'now' }; },
    async replies(input: { topic: string; page: number }) { calls.push(`replies:${input.topic}:${input.page}`); return { value: [], stale: false, source: 'network', fetchedAt: 'now' }; },
  };
  const registration = registerV2exHttpRoutes(connection, { auth, credential: { async resolve() { return undefined; } }, content } as never);
  const dispose = async () => (await registration)();
  const fetch = (path: string, init?: RequestInit) => {
    const url = new URL(path, 'https://host.test');
    const route = routes.get(url.pathname);
    if (!route) throw new Error('route missing');
    return route.fetch(new Request(url, init?.body ? { ...init, headers: { 'content-type': 'application/json', ...init.headers } } : init));
  };
  return { routes, calls, removed, dispose, fetch, connection };
}

test('registers each exact path once with buffered request handling', async () => {
  const f = fixture();
  assert.deepEqual([...f.routes.keys()], PATHS.map(path => `/api/v2ex${path}`));
  assert.ok([...f.routes.values()].every(route => route.requestBody === 'buffered'));
  assert.ok([...f.routes.values()].every(route => route.methods.includes('PUT')));
  const wrong = await f.routes.get('/api/v2ex/topic')!.fetch(new Request('https://host.test/api/v2ex/topic/extra'));
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get('cache-control'), 'no-store');
  await f.dispose(); await f.dispose();
  assert.equal(f.routes.size, 0);
  assert.deepEqual(f.removed.sort(), PATHS.map(path => `/api/v2ex${path}`).sort());
});

test('session methods return safe envelopes and never reflect a token', async () => {
  const f = fixture();
  const login = await f.fetch('/api/v2ex/session', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await login.json(), { ok: true, data: { authenticated: true, writable: true, username: 'alice', tokenScope: null, expiresAt: null } });
  const status = await f.fetch('/api/v2ex/session');
  assert.equal((await status.json() as { ok: boolean }).ok, true);
  const logout = await f.fetch('/api/v2ex/session', { method: 'DELETE' });
  assert.deepEqual(await logout.json(), { ok: true, data: { authenticated: false, writable: true, username: null, tokenScope: null, expiresAt: null } });
  assert.deepEqual(f.calls, ['login', 'status', 'logout:false', 'status']);
});

test('logout accepts only a bounded personal-data choice', async () => {
  const f = fixture();
  const response = await f.fetch('/api/v2ex/session', { method: 'DELETE', body: JSON.stringify({ clearPersonalData: true }) });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, ['logout:true', 'status']);
  const invalid = await f.fetch('/api/v2ex/session', { method: 'DELETE', body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(f.calls, ['logout:true', 'status']);
});

test('invalid DELETE body is rejected before credential or auth I/O', async () => {
  const calls: string[] = [];
  let session: { fetch(request: Request): Promise<Response> } | undefined;
  registerV2exHttpRoutes({ fetch: { register(route) {
    if (route.path === '/api/v2ex/session') session = route;
    return () => {};
  } } }, { credential: { async resolve() { calls.push('credential'); return undefined; } },
    auth: { async status() { calls.push('status'); return {} as never; },
      async login() { calls.push('login'); return {} as never; }, async logout() { calls.push('logout'); } },
    content: {} } as never);
  const response = await session!.fetch(new Request('https://host.test/api/v2ex/session', { method: 'DELETE', body: '{' }));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('all paths dispatch methods with Allow and no-store', async () => {
  const f = fixture();
  for (const path of PATHS) {
    const method = path === '/session' ? 'PUT' : path === '/topic/summary' ? 'GET' : path === '/interests' ? 'PATCH' :
      path === '/recommendations' ? 'POST' : path.startsWith('/recommendations/') ? 'GET' : 'POST';
    const response = await f.fetch(`/api/v2ex${path}`, { method });
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get('allow'), path === '/session' ? 'GET, POST, DELETE' : path === '/topic/summary' ? 'POST' : path === '/interests' ? 'GET, PUT, POST, DELETE' : path.startsWith('/recommendations/') ? 'POST' : 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { ok: boolean }).ok, false);
  }
  assert.deepEqual(f.calls, []);
});

test('mutating routes reject cross-origin, cross-site, and non-JSON bodies before I/O', async () => {
  const calls: string[] = [];
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  await registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    { auth: { async login() { calls.push('login'); return {} as never; }, async logout() { calls.push('logout'); },
      async status() { calls.push('status'); return {} as never; } },
    credential: { async resolve() { calls.push('credential'); return undefined; } },
    content: { async topic() { calls.push('topic'); return {} as never; } },
    interests: { async perform() { calls.push('interests'); return {} as never; } } } as never);
  for (const [path, method, body] of [
    ['/session', 'POST', { token: 'FAKE_VALUE' }],
    ['/topic/summary', 'POST', { topic: '1', mode: 'quick' }],
    ['/interests', 'POST', { action: 'authorize' }],
  ] as const) {
    for (const headers of [
      { origin: 'https://other.test', 'content-type': 'application/json' },
      { origin: 'https://host.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      { origin: 'https://host.test', 'content-type': 'text/plain' },
    ]) {
      const response = await routes.get(`/api/v2ex${path}`)!.fetch(new Request(`https://host.test/api/v2ex${path}`,
        { method, headers, body: JSON.stringify(body) }));
      assert.equal(response.status, 400);
    }
  }
  assert.deepEqual(calls, []);
});

test('login rejects oversize, malformed and extra-key bodies before auth', async () => {
  const f = fixture();
  for (const [body, status] of [
    ['x'.repeat(4097), 413], ['{', 400], [JSON.stringify({ token: TOKEN, extra: 1 }), 400],
    [JSON.stringify({ token: 1 }), 400], [JSON.stringify([TOKEN]), 400],
  ] as const) {
    const response = await f.fetch('/api/v2ex/session', { method: 'POST', body });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /00000000/);
  }
  const declared = await f.fetch('/api/v2ex/session', { method: 'POST', headers: { 'content-length': '5000' }, body: '{}' });
  assert.equal(declared.status, 413);
  assert.deepEqual(f.calls, []);
});

test('unexpected login account data cannot reflect the submitted token', async () => {
  let session: { fetch(request: Request): Promise<Response> } | undefined;
  registerV2exHttpRoutes({ fetch: { register(route) {
    if (route.path === '/api/v2ex/session') session = route;
    return () => {};
  } } }, { credential: { async resolve() { return undefined; } }, auth: {
    async login() { return { authenticated: true, writable: true, username: TOKEN, tokenScope: null, expiresAt: null }; },
    async status() { throw new Error('unused'); }, async logout() { throw new Error('unused'); },
  }, content: {} } as never);
  const response = await session!.fetch(new Request('https://host.test/api/v2ex/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
  }));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /00000000/);
});

test('GET and DELETE session use the same bounded status and stored-secret boundary', async () => {
  let session: { fetch(request: Request): Promise<Response> } | undefined;
  const stored = 'private-stored-secret-that-is-not-uuid';
  registerV2exHttpRoutes({ fetch: { register(route) {
    if (route.path === '/api/v2ex/session') session = route;
    return () => {};
  } } }, { credential: { async resolve() { return stored; } }, auth: {
    async status() { return { authenticated: true, writable: true, username: stored, tokenScope: 'everything', expiresAt: null }; },
    async login() { throw new Error('unused'); }, async logout() {},
  }, content: {} } as never);
  for (const method of ['GET', 'DELETE']) {
    const response = await session!.fetch(new Request('https://host.test/api/v2ex/session', { method }));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /private-stored-secret/);
  }
});

test('session rejects oversized or extra account fields on all methods', async () => {
  let session: { fetch(request: Request): Promise<Response> } | undefined;
  registerV2exHttpRoutes({ fetch: { register(route) {
    if (route.path === '/api/v2ex/session') session = route;
    return () => {};
  } } }, { credential: { async resolve() { return undefined; } }, auth: {
    async status() { return { authenticated: true, writable: true, username: 'x'.repeat(1000), tokenScope: null, expiresAt: null }; },
    async login() { return { authenticated: true, writable: true, username: 'alice', tokenScope: null, expiresAt: null, token: TOKEN }; },
    async logout() {},
  }, content: {} } as never);
  for (const [method, body] of [['GET', undefined], ['POST', JSON.stringify({ token: TOKEN })], ['DELETE', undefined]] as const) {
    const response = await session!.fetch(new Request('https://host.test/api/v2ex/session', { method, body,
      ...(body ? { headers: { 'content-type': 'application/json' } } : {}) }));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /00000000|x{100}/);
  }
});

test('all browsing responses stay within a valid 256 KiB JSON envelope', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const noisy = '\u0000\\\n😀'.repeat(45_000);
  const cached = { value: { content: noisy, replies: Array.from({ length: 2 }, () => ({ content: noisy })) },
    stale: false, source: 'network', fetchedAt: 'now' };
  registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } }, {
    credential: { async resolve() { return undefined; } }, auth: {} as never,
    content: Object.fromEntries(['latest', 'hot', 'node', 'nodeTopics', 'topic', 'replies'].map(name => [name, async () => cached])),
  } as never);
  for (const path of ['/latest', '/hot', '/node?node=python', '/node/topics?node=python', '/topic?topic=1&replyPages=3', '/replies?topic=1']) {
    const url = new URL(`/api/v2ex${path}`, 'https://host.test');
    const response = await routes.get(url.pathname)!.fetch(new Request(url));
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotThrow(() => JSON.parse(text), path);
  }
});

test('large topic and reply content remains usable with explicit truncation metadata', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const noisy = '\u0000\\😀'.repeat(20_000);
  const replies = Array.from({ length: 60 }, (_, id) => ({ id, author: { username: 'alice' }, content: noisy, createdAt: '2026-11-06T00:00:00Z' }));
  const base = { stale: false, source: 'network', fetchedAt: '2026-11-06T00:00:00Z' };
  registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } }, {
    credential: { async resolve() { return undefined; } }, auth: {} as never,
    content: { async topic() { return { ...base, value: { topic: { id: 1, title: 'A' }, content: noisy,
      replies, replyPage: 3, hasMoreReplies: false, stale: false } }; },
    async replies() { return { ...base, value: replies.slice(0, 20) }; } },
  } as never);
  for (const path of ['/topic?topic=1&replyPages=3', '/replies?topic=1']) {
    const url = new URL(`/api/v2ex${path}`, 'https://host.test');
    const response = await routes.get(url.pathname)!.fetch(new Request(url));
    const body = await response.json() as { ok: boolean; data: { truncated: boolean; omittedReplies: number; value: { content?: string; replies?: unknown[] } | unknown[] } };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.truncated, true);
    assert.equal(body.data.omittedReplies, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024);
    if (path.startsWith('/topic')) {
      assert.equal((body.data.value as { replies: unknown[] }).replies.length, 60);
      assert.match((body.data.value as { content: string }).content, /^\u0000/);
    } else assert.equal((body.data.value as unknown[]).length, 20);
  }
});

test('topic reply coverage never advances past replies the browser received', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const calls: string[] = [];
  const reply = (id: number) => ({ id, author: { username: 'alice' }, content: '\u0000\\😀'.repeat(10_000), createdAt: '2026-11-06T00:00:00Z' });
  const cached = { stale: false, source: 'network', fetchedAt: '2026-11-06T00:00:00Z' };
  registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } }, {
    credential: { async resolve() { return undefined; } }, auth: {} as never,
    content: {
      async topic(input: { replyPages: number }) {
        calls.push(`topic:${input.replyPages}`);
        return { ...cached, value: { topic: { id: 1 }, content: 'body',
          replies: Array.from({ length: input.replyPages * 20 }, (_, index) => reply(index + 1)),
          replyPage: input.replyPages, hasMoreReplies: true, stale: false } };
      },
      async replies(input: { page: number }) {
        calls.push(`replies:${input.page}`);
        return { ...cached, value: Array.from({ length: 20 }, (_, index) => reply((input.page - 1) * 20 + index + 1)) };
      },
    },
  } as never);
  const topicRoute = routes.get('/api/v2ex/topic')!;
  const invalid = await topicRoute.fetch(new Request('https://host.test/api/v2ex/topic?topic=1&replyPages=10'));
  assert.equal(invalid.status, 400);
  assert.deepEqual(calls, []);
  const response = await topicRoute.fetch(new Request('https://host.test/api/v2ex/topic?topic=1&replyPages=3'));
  const body = await response.json() as { ok: boolean; data: { value: { replies: Array<{ id: number }>; replyPage: number; hasMoreReplies: boolean }; truncated: boolean; omittedReplies: number } };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.value.replyPage, 3);
  assert.deepEqual(body.data.value.replies.map(reply => reply.id), Array.from({ length: 60 }, (_, index) => index + 1));
  assert.equal(body.data.omittedReplies, 0);
  assert.equal(body.data.truncated, true);
  assert.equal(body.data.value.hasMoreReplies, true);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024);
  const next = await routes.get('/api/v2ex/replies')!.fetch(new Request('https://host.test/api/v2ex/replies?topic=1&page=4'));
  const nextBody = await next.json() as { data: { value: Array<{ id: number }> } };
  assert.equal(next.status, 200);
  assert.deepEqual(nextBody.data.value.map(reply => reply.id), Array.from({ length: 20 }, (_, index) => index + 61));
  assert.deepEqual(calls, ['topic:3', 'replies:4']);
});

test('large valid topic lists return bounded success and truthful omission metadata', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const noisy = '\u0000\\😀'.repeat(125);
  const item = { id: 1, title: noisy, node: { name: 'python', title: '\u0000'.repeat(200) },
    author: { username: '\u0000'.repeat(64) }, replyCount: 2, createdAt: '2026-11-06T00:00:00Z',
    lastReplyAt: null, url: 'https://www.v2ex.com/t/1' };
  const items = Array.from({ length: 100 }, (_, index) => ({ ...item, id: index + 1 }));
  const cached = { stale: false, source: 'network', fetchedAt: '2026-11-06T00:00:00Z' };
  registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } }, {
    credential: { async resolve() { return undefined; } }, auth: {} as never,
    content: { async latest() { return { ...cached, value: { items, page: 1, hasMore: false, stale: false } }; },
      async hot() { return { ...cached, value: items }; },
      async nodeTopics() { return { ...cached, value: { items, page: 1, hasMore: false, stale: false } }; } },
  } as never);
  for (const path of ['/latest', '/hot', '/node/topics?node=python']) {
    const url = new URL(`/api/v2ex${path}`, 'https://host.test');
    const response = await routes.get(url.pathname)!.fetch(new Request(url));
    const text = await response.text();
    const body = JSON.parse(text) as { ok: boolean; data: { value: { items: typeof items; hasMore: boolean } | typeof items; truncated: boolean; omittedItems: number } };
    assert.equal(response.status, 200, path);
    assert.equal(body.ok, true, path);
    const visible = Array.isArray(body.data.value) ? body.data.value : body.data.value.items;
    assert.ok(visible.length > 0 && visible.length < items.length, path);
    assert.equal(body.data.omittedItems, items.length - visible.length, path);
    assert.equal(body.data.truncated, true, path);
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, path);
    if (!Array.isArray(body.data.value)) assert.equal(body.data.value.hasMore, true, path);
  }
});

test('real Cordis Context registers routes through get and rejects absent transport', async () => {
  const create = (withConnection: boolean) => {
    const ctx = new Context(); let routes = 0; let closed = 0;
    ctx.provide('credentials', {});
    ctx.provide('storageDomain', { async open() { return { async close() { closed++; } }; } });
    ctx.provide('tools', { register() { return () => {}; } });
    if (withConnection) ctx.provide('connection', { fetch: { register() { routes++; return () => { routes--; }; } } });
    return { ctx, routes: () => routes, closed: () => closed };
  };
  const present = create(true);
  const plugin = await composePlugin(present.ctx, Config({}));
  assert.equal(present.routes(), 13);
  await plugin.dispose();
  assert.equal(present.routes(), 0);
  assert.equal(present.closed(), 1);
  await present.ctx.fiber.dispose();
  const absent = create(false);
  await assert.rejects(composePlugin(absent.ctx, Config({})), { code: 'incompatible_runtime' });
  assert.equal(absent.closed(), 0);
  await absent.ctx.fiber.dispose();
});

test('async route cleanup completes before domain close and disposal is idempotent', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const host = {
    credentials: {}, storageDomain: { async open() { return { async close() { events.push('close'); } }; } },
    tools: { register() { return () => { events.push('tool'); }; } },
    get(name: string) { assert.equal(name, 'connection'); return { fetch: { register() {
      return async () => { events.push('route-start'); await gate; events.push('route-end'); };
    } } }; },
  };
  const plugin = await composePlugin(host as never, Config({}));
  const first = plugin.dispose();
  const second = plugin.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes('close'), false);
  release();
  await Promise.all([first, second]);
  assert.equal(events.at(-1), 'close');
  assert.equal(events.filter(value => value === 'close').length, 1);
});

test('composition rollback awaits partial route cleanup before tools and storage', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let registrations = 0;
  const host = {
    credentials: {}, storageDomain: { async open() { return { async close() { events.push('close'); } }; } },
    tools: { register() { return () => { events.push('tool'); }; } },
    get() { return { fetch: { register() {
      if (++registrations === 3) throw new Error('private carrier detail');
      return async () => { events.push('route-start'); await gate; events.push('route-end'); };
    } } }; },
  };
  let settled = false;
  const loading = composePlugin(host as never, Config({})).catch(error => { settled = true; throw error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(events.includes('close'), false);
  release();
  await assert.rejects(loading, { code: 'incompatible_runtime' });
  assert.equal(events.at(-1), 'close');
  assert.equal(events.filter(value => value === 'tool').length, 7);
});

test('connection lookup failures are bounded before opening storage', async () => {
  let opened = false;
  const host = {
    credentials: {}, storageDomain: { async open() { opened = true; } }, tools: { register() { return () => {}; } },
    get() { throw new Error(`private carrier detail ${TOKEN}`); },
  };
  await assert.rejects(composePlugin(host as never, Config({})), (error: unknown) =>
    error instanceof V2exError && error.code === 'incompatible_runtime' && !error.message.includes(TOKEN));
  assert.equal(opened, false);
});

test('browsing routes validate query before invoking services', async () => {
  const f = fixture();
  for (const path of ['/latest?page=0', '/node?node=../bad', '/node/topics?node=ok&page=x',
    '/topic?topic=01', '/replies?topic=2&page=1001', '/hot?extra=1']) {
    const response = await f.fetch(`/api/v2ex${path}`);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'invalid_request');
  }
  assert.deepEqual(f.calls, []);
  for (const path of ['/latest?page=2', '/hot', '/node?node=python', '/node/topics?node=python&page=3',
    '/topic?topic=123&replyPages=2', '/replies?topic=123&page=2', '/health']) {
    const response = await f.fetch(`/api/v2ex${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { ok: boolean }).ok, true);
  }
  assert.deepEqual(f.calls, ['latest:2', 'hot', 'node:python', 'nodeTopics:python:3', 'topic:123:2', 'replies:123:2']);
});

test('service errors use bounded public messages and stable statuses', async () => {
  const f = fixture();
  for (const [error, status, code] of [
    [new V2exError('not_authenticated'), 401, 'not_authenticated'],
    [new V2exError('rate_limited'), 429, 'rate_limited'],
    [new V2exError('not_found'), 404, 'not_found'],
    [new Error(`private ${TOKEN}`), 502, 'upstream'],
  ] as const) {
    const route = f.routes.get('/api/v2ex/hot')!;
    const original = route.fetch;
    route.fetch = async () => { throw error; };
    // The response boundary is tested through a service replacement in the next request.
    route.fetch = original;
    const auth = { status: async () => { throw error; }, login: async () => { throw error; }, logout: async () => { throw error; } };
    const local = { fetch: { register: (r: typeof route) => r.path === '/api/v2ex/session' ? (route.fetch = r.fetch, () => {}) : () => {} } };
    registerV2exHttpRoutes(local, { auth, credential: { async resolve() { return undefined; } }, content: {} } as never);
    const response = await route.fetch(new Request('https://host.test/api/v2ex/session'));
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.doesNotMatch(text, /private|00000000/);
  }
});

test('registration rolls back when the carrier throws', async () => {
  const f = fixture(); await f.dispose();
  const registered: string[] = []; const removed: string[] = [];
  const connection = { fetch: { register(route: { path: string }) {
    if (registered.length === 3) throw new Error('registration failure');
    registered.push(route.path); return () => removed.push(route.path);
  } } };
  await assert.rejects(registerV2exHttpRoutes(connection as never, {} as never), { code: 'incompatible_runtime' });
  assert.deepEqual(removed, registered.slice().reverse());
});

test('partial route registration awaits asynchronous rollback before rejecting', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const connection = { fetch: { register(route: { path: string }) {
    if (route.path.endsWith('/hot')) throw new Error('private carrier detail');
    return async () => { events.push(`start:${route.path}`); await gate; events.push(`end:${route.path}`); };
  } } };
  let settled = false;
  const registration = registerV2exHttpRoutes(connection as never, {} as never).catch(error => {
    settled = true; throw error;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(events, ['start:/api/v2ex/latest']);
  release();
  await assert.rejects(registration, { code: 'incompatible_runtime' });
  assert.deepEqual(events, ['start:/api/v2ex/latest', 'end:/api/v2ex/latest', 'start:/api/v2ex/session', 'end:/api/v2ex/session']);
});

test('composition uses the connection service and releases routes with tools and domain', async () => {
  const f = fixture(); await f.dispose();
  const closed: string[] = [];
  const host = {
    credentials: {}, storageDomain: { async open() { return { async close() { closed.push('domain'); } }; } },
    tools: { register() { return () => closed.push('tool'); } },
    get(name: string) { assert.equal(name, 'connection'); return f.connection; },
  };
  const plugin = await composePlugin(host as never, Config({}));
  assert.equal(f.routes.size, PATHS.length);
  await plugin.dispose(); await plugin.dispose();
  assert.equal(f.routes.size, 0);
  assert.equal(closed.filter(value => value === 'domain').length, 1);
});

test('composed logout can clear personal profile and recommendations', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const recommendations = new Map([['123', { topic: { id: 123 } }]]);
  let global = { settings: {}, profile: { labels: [{ name: 'private', weight: 1 }] } };
  const host = {
    credentials: {
      async resolve() { return undefined; }, async describe() { return { configured: false, writable: true }; },
      async unset() {}, async set() {},
    },
    storageDomain: { async open() { return {
      global: { get: () => global, async set(value: typeof global) { global = value; } },
      table(name: string) { assert.equal(name, 'recommendations'); return {
        entries: () => recommendations.entries(), async delete(key: string) { recommendations.delete(key); },
      }; },
      async close() {},
    }; } },
    tools: { register() { return () => {}; } },
    connection: { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
      routes.set(route.path, route); return () => { routes.delete(route.path); };
    } } },
    get(name: string) { assert.equal(name, 'connection'); return this.connection; },
  };
  const plugin = await composePlugin(host as never, Config({}));
  const response = await routes.get('/api/v2ex/session')!.fetch(new Request('https://host.test/api/v2ex/session', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearPersonalData: true }),
  }));
  assert.equal(response.status, 200);
  assert.equal(global.profile, null);
  assert.equal(recommendations.size, 0);
  await plugin.dispose();
});
