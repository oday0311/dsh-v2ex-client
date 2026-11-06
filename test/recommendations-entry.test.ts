import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2exHttpRoutes } from '../src/http-routes.js';
import { createRecommendationTool } from '../src/tools.js';

function routesFixture() {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const calls: Array<[string, unknown]> = [];
  const recommendations = {
    async list() { calls.push(['list', undefined]); return { items: [], generatedAt: null, stale: true, source: 'stored' }; },
    async feedback(value: unknown) { calls.push(['feedback', value]); },
    async markRead(value: unknown) { calls.push(['read', value]); },
  };
  registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    { auth: {} as never, credential: {} as never, content: {} as never, recommendations } as never);
  return { routes, calls };
}

test('recommendation routes share list, feedback, and read behavior with no-store envelopes', async () => {
  const f = routesFixture();
  const get = await f.routes.get('/api/v2ex/recommendations')!.fetch(new Request('https://host.test/api/v2ex/recommendations'));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  const feedback = await f.routes.get('/api/v2ex/recommendations/feedback')!.fetch(new Request('https://host.test/api/v2ex/recommendations/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topicId: 7, value: 'not_interested' }),
  }));
  const read = await f.routes.get('/api/v2ex/recommendations/read')!.fetch(new Request('https://host.test/api/v2ex/recommendations/read', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topicId: 7 }),
  }));
  assert.equal(feedback.status, 200);
  assert.equal(read.status, 200);
  assert.deepEqual(f.calls, [['list', undefined], ['feedback', { topicId: 7, value: 'not_interested' }], ['read', 7]]);
});

test('recommendation mutations reject cross-origin, non-JSON, and malformed bodies before service I/O', async () => {
  const f = routesFixture();
  for (const path of ['/recommendations/feedback', '/recommendations/read']) {
    for (const request of [
      new Request(`https://host.test/api/v2ex${path}`, { method: 'POST', headers: { origin: 'https://other.test', 'content-type': 'application/json' }, body: '{}' }),
      new Request(`https://host.test/api/v2ex${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }),
      new Request(`https://host.test/api/v2ex${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topicId: '7', extra: true }) }),
    ]) assert.equal((await f.routes.get(`/api/v2ex${path}`)!.fetch(request)).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test('find-interesting Tool accepts no mutations, refreshes bounded latest candidates, and bounds output', async () => {
  const calls: unknown[] = [];
  const noisy = 'x'.repeat(10_000);
  const reader = { async latest(input: unknown) { calls.push(input); return { value: { items: [{ id: 1 }], page: 1, hasMore: false },
    fetchedAt: '2026-11-07T00:00:00.000Z', stale: false, source: 'network' }; } };
  const service = { async refreshCandidates(candidates: unknown) { calls.push(candidates); return { consideredTopicIds: [1],
    items: Array.from({ length: 100 }, (_, index) => ({ topic: { id: index + 1, title: noisy, node: { name: 'dev', title: 'Dev' }, author: { username: 'a' }, replyCount: 1, createdAt: '2026-11-07T00:00:00.000Z', lastReplyAt: null, url: `https://www.v2ex.com/t/${index + 1}` }, score: 1, reason: noisy, matchedInterests: [noisy], generatedAt: '2026-11-07T00:00:00.000Z', read: false, feedback: null })),
    generatedAt: '2026-11-07T00:00:00.000Z', stale: false, source: 'generated' }; } };
  const tool = createRecommendationTool(reader as never, service as never);
  await assert.rejects(tool.execute({ action: 'feedback' } as never, { signal: new AbortController().signal } as never), { code: 'invalid_request' });
  assert.deepEqual(calls, []);
  const result = await tool.execute({}, { signal: new AbortController().signal } as never);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: tool.output.render({}, result) })) <= 64 * 1024);
  assert.deepEqual(calls[0], { page: 1 });
  assert.deepEqual(calls[1], [{ id: 1 }]);
});

test('recommendation list route returns a useful bounded page for a large valid store', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const noisy = 'x'.repeat(500);
  const item = (id: number) => ({ topic: { id, title: noisy, node: { name: 'dev', title: noisy.slice(0, 200) },
    author: { username: 'alice' }, replyCount: 1, createdAt: '2026-11-07T00:00:00.000Z', lastReplyAt: null,
    url: `https://www.v2ex.com/t/${id}` }, score: 1, reason: noisy,
    matchedInterests: Array.from({ length: 20 }, () => 'i'.repeat(80)), generatedAt: '2026-11-07T00:00:00.000Z',
    read: false, feedback: null });
  registerV2exHttpRoutes({ fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    { auth: {} as never, credential: {} as never, content: {} as never, recommendations: {
      async list() { return { items: Array.from({ length: 500 }, (_, index) => item(index + 1)),
        generatedAt: '2026-11-07T00:00:00.000Z', stale: false, source: 'stored' }; },
    } } as never);
  const response = await routes.get('/api/v2ex/recommendations')!.fetch(new Request('https://host.test/api/v2ex/recommendations'));
  const body = await response.json() as { ok: boolean; data: { items: unknown[]; truncated: boolean; omittedItems: number } };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.data.items.length > 0 && body.data.items.length < 500);
  assert.equal(body.data.truncated, true);
  assert.equal(body.data.omittedItems, 500 - body.data.items.length);
});
