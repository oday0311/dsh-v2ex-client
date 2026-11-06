import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2exHttpRoutes } from '../src/http-routes.js';
import { V2exError } from '../src/errors.js';
import { composePlugin } from '../src/plugin.js';
import { Config } from '../src/index.js';

const TOKEN = '00000000-0000-4000-8000-000000000000';
const PATHS = ['/session', '/latest', '/hot', '/node', '/node/topics', '/topic', '/replies', '/health'];

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
    async topic(input: { topic: string; replyPages: number }) { calls.push(`topic:${input.topic}:${input.replyPages}`); return { value: { topic: { id: Number(input.topic) } }, stale: false, source: 'network', fetchedAt: 'now' }; },
    async replies(input: { topic: string; page: number }) { calls.push(`replies:${input.topic}:${input.page}`); return { value: [], stale: false, source: 'network', fetchedAt: 'now' }; },
  };
  const dispose = registerV2exHttpRoutes(connection, { auth, content } as never);
  const fetch = (path: string, init?: RequestInit) => {
    const url = new URL(path, 'https://host.test');
    const route = routes.get(url.pathname);
    if (!route) throw new Error('route missing');
    return route.fetch(new Request(url, init));
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
  f.dispose(); f.dispose();
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

test('all paths dispatch methods with Allow and no-store', async () => {
  const f = fixture();
  for (const path of PATHS) {
    const method = path === '/session' ? 'PUT' : 'POST';
    const response = await f.fetch(`/api/v2ex${path}`, { method });
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get('allow'), path === '/session' ? 'GET, POST, DELETE' : 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { ok: boolean }).ok, false);
  }
  assert.deepEqual(f.calls, []);
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
  } } }, { auth: {
    async login() { return { authenticated: true, writable: true, username: TOKEN, tokenScope: null, expiresAt: null }; },
    async status() { throw new Error('unused'); }, async logout() { throw new Error('unused'); },
  }, content: {} } as never);
  const response = await session!.fetch(new Request('https://host.test/api/v2ex/session', {
    method: 'POST', body: JSON.stringify({ token: TOKEN }),
  }));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /00000000/);
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
    registerV2exHttpRoutes(local, { auth, content: {} } as never);
    const response = await route.fetch(new Request('https://host.test/api/v2ex/session'));
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.doesNotMatch(text, /private|00000000/);
  }
});

test('registration rolls back when the carrier throws', () => {
  const f = fixture(); f.dispose();
  const registered: string[] = []; const removed: string[] = [];
  const connection = { fetch: { register(route: { path: string }) {
    if (registered.length === 3) throw new Error('registration failure');
    registered.push(route.path); return () => removed.push(route.path);
  } } };
  assert.throws(() => registerV2exHttpRoutes(connection as never, {} as never));
  assert.deepEqual(removed, registered.slice().reverse());
});

test('composition uses connection injection and releases routes with tools and domain', async () => {
  const f = fixture(); f.dispose();
  const closed: string[] = [];
  const host = {
    credentials: {}, storageDomain: { async open() { return { async close() { closed.push('domain'); } }; } },
    tools: { register() { return () => closed.push('tool'); } },
    inject(_deps: string[], callback: (ctx: { get(name: string): unknown }) => void | (() => void)) {
      const release = callback({ get: () => f.connection });
      return { dispose: async () => { release?.(); closed.push('fiber'); } };
    },
  };
  const plugin = await composePlugin(host as never, Config({}));
  assert.equal(f.routes.size, PATHS.length);
  plugin.dispose(); plugin.dispose();
  await new Promise(resolve => setImmediate(resolve));
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
  };
  const plugin = await composePlugin(host as never, Config({}));
  const response = await routes.get('/api/v2ex/session')!.fetch(new Request('https://host.test/api/v2ex/session', {
    method: 'DELETE', body: JSON.stringify({ clearPersonalData: true }),
  }));
  assert.equal(response.status, 200);
  assert.equal(global.profile, null);
  assert.equal(recommendations.size, 0);
  plugin.dispose();
});
