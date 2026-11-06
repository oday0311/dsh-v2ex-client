import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2exHttpRoutes } from '../src/http-routes.js';
import { createInterestTool } from '../src/tools.js';
import { InterestService } from '../src/interests.js';
import { FakeContentStore } from './helpers/fakes.js';

test('interest route and Tool share actions, no-store, and bounded output', async () => {
  const calls: Array<[string, unknown]> = [];
  const profile = { authorized: false, learningPaused: false, labels: [], preferredNodes: [],
    exclusions: [], feedback: [], updatedAt: '2026-11-07T00:00:00Z', source: 'manual' };
  const service = { async perform(action: string, payload?: unknown) { calls.push([action, payload]); return profile; } };
  let route: { fetch(request: Request): Promise<Response> } | undefined;
  await registerV2exHttpRoutes({ fetch: { register(value) {
    if (value.path === '/api/v2ex/interests') route = value;
    return () => {};
  } } }, { auth: {} as never, credential: {} as never, content: {} as never, interests: service } as never);
  const request = (method: string, body?: unknown) => route!.fetch(new Request('https://host.test/api/v2ex/interests',
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  assert.deepEqual((await (await request('GET')).json() as { data: unknown }).data, profile);
  assert.equal((await request('POST', { action: 'authorize' })).headers.get('cache-control'), 'no-store');
  assert.equal((await request('PUT', { exclusions: [] })).status, 200);
  assert.equal((await request('POST', { action: 'feedback', topicId: 1, interested: false })).status, 200);
  assert.equal((await request('DELETE')).status, 200);
  const tool = createInterestTool(service as never);
  const result = await tool.execute({ action: 'get' }, { signal: new AbortController().signal } as never);
  assert.deepEqual(result, profile);
  assert.ok(Buffer.byteLength(JSON.stringify({ role: 'tool', name: tool.name,
    content: tool.output.render({ action: 'get' }, result) })) <= 64 * 1024);
  assert.deepEqual(calls, [['get', undefined], ['authorize', undefined], ['update', { exclusions: [] }],
    ['feedback', { topicId: 1, interested: false }], ['clear', undefined], ['get', undefined]]);
});

test('interest entry points reject invalid actions and nonleaking errors', async () => {
  let calls = 0;
  const service = { async perform() { calls++; throw new Error('private model token'); } };
  let route: { fetch(request: Request): Promise<Response> } | undefined;
  await registerV2exHttpRoutes({ fetch: { register(value) {
    if (value.path === '/api/v2ex/interests') route = value;
    return () => {};
  } } }, { auth: {} as never, credential: {} as never, content: {} as never, interests: service } as never);
  for (const [method, body] of [['POST', { action: 'bad' }], ['POST', { action: 'relearn', extra: 1 }],
    ['POST', { action: 'feedback', topicId: 1 }], ['PUT', { labels: 'bad' }]] as const) {
    const response = await route!.fetch(new Request('https://host.test/api/v2ex/interests',
      { method, body: JSON.stringify(body) }));
    assert.doesNotMatch(await response.text(), /private model token/);
  }
  assert.equal(calls, 1);
  const oversized = await route!.fetch(new Request('https://host.test/api/v2ex/interests',
    { method: 'POST', body: 'x'.repeat(4097) }));
  assert.equal(oversized.status, 413);
  const tool = createInterestTool(service as never);
  await assert.rejects(tool.execute({ action: 'get' }, { signal: new AbortController().signal } as never),
    { code: 'ai_unavailable' });
});

test('Agent Tool exposes get only and rejects every mutation before service access', async () => {
  const calls: string[] = [];
  const service = { async perform(action: string) { calls.push(action); return { authorized: false }; } };
  const tool = createInterestTool(service as never);
  for (const action of ['authorize', 'relearn', 'update', 'feedback', 'revoke', 'clear']) {
    await assert.rejects(tool.execute({ action, payload: '{}' } as never,
      { signal: new AbortController().signal } as never), { code: 'invalid_request' });
  }
  assert.deepEqual(calls, []);
  await tool.execute({ action: 'get' }, { signal: new AbortController().signal } as never);
  assert.deepEqual(calls, ['get']);
});

test('Host revoke and clear abort active learning before stale profile writes', async () => {
  for (const action of ['revoke', 'clear'] as const) {
    const store = new FakeContentStore();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const service = new InterestService(store, { async readEligibleUserText() { return 'interest'; } },
      { async completeJson() { entered(); await held; return { labels: [{ name: 'Rust', weight: 1 }],
        preferredNodes: [], exclusions: [] }; } } as never);
    let route: { fetch(request: Request): Promise<Response> } | undefined;
    await registerV2exHttpRoutes({ fetch: { register(value) {
      if (value.path === '/api/v2ex/interests') route = value;
      return () => {};
    } } }, { auth: {} as never, credential: {} as never, content: {} as never, interests: service } as never);
    const request = (method: string, body?: unknown) => route!.fetch(new Request('https://host.test/api/v2ex/interests',
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    await request('POST', { action: 'authorize' });
    const learning = request('POST', { action: 'relearn' });
    await started;
    const mutation = action === 'clear' ? request('DELETE') : request('POST', { action: 'revoke' });
    await new Promise<void>(resolve => setImmediate(resolve));
    release();
    await Promise.all([learning, mutation]);
    const profile = await store.getProfile();
    if (action === 'clear') assert.equal(profile, null);
    else assert.equal(profile?.authorized, false);
  }
});
