import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFixtureProfile } from './memory-storage.js';

test('real Cordis loader exposes all seven V2EX tools and disposes without leaks', async () => {
  const runtime = await loadFixtureProfile();
  assert.deepEqual(runtime.toolNames().filter(name => name.startsWith('v2ex_')).sort(), [
    'v2ex_find_interesting',
    'v2ex_hot',
    'v2ex_interest_profile',
    'v2ex_latest',
    'v2ex_node_topics',
    'v2ex_summarize_topic',
    'v2ex_topic',
  ]);
  assert.ok(runtime.routePaths().includes('/api/v2ex/session'));
  const response = await runtime.fetchRoute('/api/v2ex/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'fixture-read-only-token' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.username, 'fixture-reader');
  assert.equal(runtime.externalRequests().length, 2);
  assert.ok(runtime.externalRequests().every(url => url.startsWith('https://www.v2ex.com/api/v2/')));
  await runtime.dispose();
  assert.equal(runtime.openDomainCount(), 0);
  assert.equal(runtime.toolNames().length, 0);
  assert.equal(runtime.routePaths().length, 0);
});
