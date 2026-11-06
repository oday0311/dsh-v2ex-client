import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentCache, RequestBudget } from '../src/cache.js';
import { V2exError } from '../src/errors.js';
import { FakeContentStore } from './helpers/fakes.js';

test('TTL expires a successful value without deleting offline fallback', async () => {
  const store = new FakeContentStore();
  let now = Date.parse('2026-11-06T00:00:00Z');
  const cache = new ContentCache(store, () => new Date(now));
  await cache.writeSuccess('latest:1', [{ id: 1 }], 60_000);
  assert.deepEqual(await cache.read('latest:1'), {
    value: [{ id: 1 }], fetchedAt: '2026-11-06T00:00:00.000Z', stale: false, source: 'cache',
  });
  now += 60_000;
  assert.equal((await cache.read('latest:1'))?.stale, true);
});

test('failed refresh retains last success and returns bounded stale fallback', async () => {
  const store = new FakeContentStore();
  let now = Date.parse('2026-11-06T00:00:00Z');
  const cache = new ContentCache(store, () => new Date(now));
  await cache.writeSuccess('latest:1', [{ id: 1 }], 60_000);
  now += 60_000;
  await assert.rejects(cache.refresh('latest:1', async () => { throw new V2exError('invalid_response'); }, 60_000), { code: 'invalid_response' });
  assert.deepEqual((await cache.read('latest:1'))?.value, [{ id: 1 }]);
  assert.deepEqual(await cache.readOrRefresh('latest:1', async () => { throw new V2exError('offline'); }, 60_000), {
    value: [{ id: 1 }], fetchedAt: '2026-11-06T00:00:00.000Z', stale: true,
    source: 'cache', refreshError: { code: 'offline', message: 'V2EX is unavailable. Try again when connected.', retryable: true },
  });
});

test('concurrent refreshes of the same resource share one upstream request', async () => {
  const cache = new ContentCache(new FakeContentStore(), () => new Date('2026-11-06T00:00:00Z'));
  let calls = 0;
  const fetcher = async () => { calls++; await Promise.resolve(); return [1]; };
  const [a, b] = await Promise.all([cache.refresh('hot:1', fetcher, 1000), cache.refresh('hot:1', fetcher, 1000)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { value: [1], fetchedAt: '2026-11-06T00:00:00.000Z', stale: false, source: 'network' });
  assert.deepEqual(b, a);
});

test('cache keys reject credential-shaped and unnormalized identifiers', async () => {
  const cache = new ContentCache(new FakeContentStore());
  await assert.rejects(cache.writeSuccess('latest:1?token=secret', [], 1000), { code: 'invalid_request' });
  await assert.rejects(cache.writeSuccess('node:../../secret:1', [], 1000), { code: 'invalid_request' });
  await assert.rejects(cache.writeSuccess('topic:001', [], 1000), { code: 'invalid_request' });
  await assert.rejects(cache.writeSuccess('topic:9007199254740992', [], 1000), { code: 'invalid_request' });
  await assert.rejects(cache.writeSuccess('latest:1001', [], 1000), { code: 'invalid_request' });
});

test('background reservations stop at the interactive reserve', () => {
  const budget = new RequestBudget({ reserveForInteractive: 10 });
  budget.update({ limit: 120, remaining: 11, resetAt: '2030-03-17T17:46:40.000Z' });
  assert.equal(budget.reserve('background'), true);
  assert.equal(budget.reserve('background'), false);
  assert.equal(budget.reserve('interactive'), true);
  assert.equal(budget.remaining, 9);
});

test('request budget resumes after reset and remains conservative without rate headers', () => {
  const budget = new RequestBudget({ reserveForInteractive: 2 });
  assert.equal(budget.canRunBackground(new Date('2026-11-06T00:00:00Z')), false);
  budget.update({ limit: 5, remaining: 2, resetAt: '2026-11-06T00:01:00Z' });
  assert.equal(budget.canRunBackground(new Date('2026-11-06T00:00:00Z')), false);
  assert.equal(budget.canRunBackground(new Date('2026-11-06T00:01:00Z')), true);
  assert.equal(budget.reserve('background'), true);
});
