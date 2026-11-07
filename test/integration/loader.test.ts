import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryDomain, loadFixtureProfile } from './memory-storage.js';

const expectedRoutes = [
  { path: '/api/v2ex/health', methods: ['GET'] },
  { path: '/api/v2ex/hot', methods: ['GET'] },
  { path: '/api/v2ex/interests', methods: ['GET', 'PUT', 'POST', 'DELETE'] },
  { path: '/api/v2ex/latest', methods: ['GET'] },
  { path: '/api/v2ex/node', methods: ['GET'] },
  { path: '/api/v2ex/node/topics', methods: ['GET'] },
  { path: '/api/v2ex/nodes', methods: ['GET'] },
  { path: '/api/v2ex/recommendations', methods: ['GET'] },
  { path: '/api/v2ex/recommendations/feedback', methods: ['POST'] },
  { path: '/api/v2ex/recommendations/read', methods: ['POST'] },
  { path: '/api/v2ex/replies', methods: ['GET'] },
  { path: '/api/v2ex/session', methods: ['GET', 'POST', 'DELETE'] },
  { path: '/api/v2ex/settings', methods: ['GET', 'PUT'] },
  { path: '/api/v2ex/tab', methods: ['GET'] },
  { path: '/api/v2ex/topic', methods: ['GET'] },
  { path: '/api/v2ex/topic/summary', methods: ['POST'] },
];
const carrierMethods = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'];

test('real Cordis loader exposes all seven V2EX tools and disposes without leaks', async () => {
  const runtime = await loadFixtureProfile();
  try {
    assert.deepEqual(runtime.toolNames().filter(name => name.startsWith('v2ex_')).sort(), [
      'v2ex_find_interesting',
      'v2ex_hot',
      'v2ex_interest_profile',
      'v2ex_latest',
      'v2ex_node_topics',
      'v2ex_summarize_topic',
      'v2ex_topic',
    ]);
    assert.deepEqual(runtime.routes(), expectedRoutes.map(({ path }) => ({ path, methods: carrierMethods })));
    for (const { path, methods } of expectedRoutes) {
      const rejected = await runtime.fetchRoute(path, { method: 'OPTIONS' });
      assert.equal(rejected.status, 405, `${path} must reject an unsupported carrier method`);
      assert.equal(rejected.headers.get('allow'), methods.join(', '), `${path} must expose its exact method contract`);
    }
    assert.deepEqual(runtime.clientRegistrations(), [
      { injection: 'sidebar.panellist', name: 'sidebar.panellist', id: 'v2ex', order: 27 },
      { injection: 'main', name: 'main', key: 'v2ex' },
    ]);
    assert.deepEqual(runtime.clientInjectionNames(), ['sidebar.panellist', 'main']);
    assert.deepEqual(runtime.clientEffectLabels(), [
      'v2ex: store', 'v2ex: styles', 'v2ex: locale', 'v2ex: sidebar entry', 'v2ex: main panel',
    ]);
    assert.deepEqual(runtime.leaks(), { domains: 1, tools: 7, routes: 16, clientSlots: 2,
      clientEffects: 5, clientStyles: 1, clientLocales: 1, clientMounts: 2,
      hostListeners: 2, postCloseAttempts: 0, lateMutations: 0 });
    const response = await runtime.fetchRoute('/api/v2ex/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'fixture-read-only-token' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.username, 'fixture-reader');
    assert.equal(runtime.externalRequests().length, 2);
    assert.ok(runtime.externalRequests().every(url => url.startsWith('https://www.v2ex.com/api/v2/')));
    await runtime.dispose();
    assert.deepEqual(runtime.leaks(), { domains: 0, tools: 0, routes: 0, clientSlots: 0,
      clientEffects: 0, clientStyles: 0, clientLocales: 0, clientMounts: 0,
      hostListeners: 0, postCloseAttempts: 0, lateMutations: 0 });
  } finally {
    await runtime.dispose();
  }
});

test('memory domain serializes tables and close drains accepted writes then rejects every handle', async () => {
  const domain = createMemoryDomain();
  const cache = domain.table('cache'); const summaries = domain.table('summaries');
  let release!: () => void;
  domain.blockNextWrite(new Promise<void>(resolve => { release = resolve; }));
  const accepted = cache.put('one', { value: 1 });
  const later = summaries.put('two', { value: 2 });
  const close = domain.close();
  await assert.rejects(cache.put('three', { value: 3 }), /closing/);
  assert.throws(() => cache.get('one'), /closing/);
  let closed = false; void close.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(closed, false);
  release(); await Promise.all([accepted, later, close]);
  assert.equal(domain.acceptedMutationCount(), 2);
  assert.equal(domain.lateMutationCount(), 0);
  assert.throws(() => cache.entries(), /closed/);
  await assert.rejects(summaries.delete('two'), /closed/);
});
