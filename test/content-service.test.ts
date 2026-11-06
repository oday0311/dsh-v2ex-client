import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentCache, RequestBudget } from '../src/cache.js';
import { ContentService } from '../src/content-service.js';
import { V2exError } from '../src/errors.js';
import { createBrowsingTools } from '../src/tools.js';
import { FakeContentStore, FakeCredentialVault } from './helpers/fakes.js';
import { NODE_OK, REPLIES_OK, TOPIC } from './fixtures/v2ex.js';

function fixture() {
  const vault = new FakeCredentialVault();
  vault.value = 'fixture-token';
  const store = new FakeContentStore();
  const cache = new ContentCache(store);
  const budget = new RequestBudget();
  const calls: string[] = [];
  const api = {
    rateLimit: { limit: 100, remaining: 90, resetAt: null },
    async latest(page: number) { calls.push(`latest:${page}`); return [TOPIC]; },
    async hot() { calls.push('hot'); return [TOPIC]; },
    async node(name: string) { calls.push(`node:${name}`); return NODE_OK.result; },
    async nodeTopics(name: string, page: number) { calls.push(`nodeTopics:${name}:${page}`); return [TOPIC]; },
    async topic(id: number) { calls.push(`topic:${id}`); return TOPIC; },
    async replies(id: number, page: number) { calls.push(`replies:${id}:${page}`); return REPLIES_OK.result; },
  };
  return { vault, store, cache, budget, calls, api, service: new ContentService(api as never, vault, cache, budget) };
}

test('no credential or malformed credential fails before upstream I/O or cache disclosure', async () => {
  const f = fixture();
  await f.cache.writeSuccess('latest:1', { items: [], page: 1, hasMore: false, stale: false }, 60_000);
  f.vault.value = undefined;
  await assert.rejects(f.service.latest({ page: 1 }), { code: 'not_authenticated' });
  f.vault.value = 'bad\nheader';
  await assert.rejects(f.service.latest({ page: 1 }), { code: 'not_authenticated' });
  assert.deepEqual(f.calls, []);
});

test('fresh cache is used after authentication; concurrent misses share one reservation and request', async () => {
  const f = fixture();
  f.budget.update({ limit: 100, remaining: 20, resetAt: null });
  const [a, b] = await Promise.all([f.service.latest({ page: 2 }), f.service.latest({ page: 2 })]);
  assert.deepEqual(f.calls, ['latest:2']);
  assert.equal(f.budget.remaining, 19);
  assert.deepEqual(a, b);
  assert.equal(a.value.items[0]?.id, 123);
  assert.equal((await f.service.latest({ page: 2 })).source, 'cache');
  assert.deepEqual(f.calls, ['latest:2']);
});

test('stale cache reports refresh failure and budget exhaustion without losing content', async () => {
  const f = fixture();
  await f.cache.writeSuccess('hot:1', [], 1000);
  const record = f.store.cache.get('hot:1')!;
  record.expiresAt = '2000-01-01T00:00:00.000Z';
  f.budget.update({ limit: 1, remaining: 0, resetAt: null });
  const result = await f.service.hot();
  assert.equal(result.stale, true);
  assert.equal(result.refreshError?.code, 'budget_exhausted');
  assert.deepEqual(f.calls, []);
});

test('upstream failure returns stale cache with a public error and no replacement', async () => {
  const f = fixture();
  await f.cache.writeSuccess('latest:1', { items: [], page: 1, hasMore: false, stale: false }, 1000);
  f.store.cache.get('latest:1')!.expiresAt = '2000-01-01T00:00:00.000Z';
  f.api.latest = async () => { throw new V2exError('offline'); };
  const result = await f.service.latest({ page: 1 });
  assert.equal(result.stale, true);
  assert.equal(result.value.stale, true);
  assert.equal(result.source, 'cache');
  assert.equal(result.refreshError?.code, 'offline');
  assert.deepEqual(f.store.cache.get('latest:1')?.value, { items: [], page: 1, hasMore: false, stale: false });
});

test('aborting one deduplicated waiter does not cancel the other', async () => {
  const f = fixture();
  let finish!: (value: typeof TOPIC[]) => void;
  f.api.latest = async () => {
    f.calls.push('pending');
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = new AbortController();
  const second = new AbortController();
  const one = f.service.latest({ page: 1 }, first.signal);
  const two = f.service.latest({ page: 1 }, second.signal);
  for (let i = 0; i < 10 && !finish; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  first.abort();
  await assert.rejects(one, { code: 'timeout' });
  finish([TOPIC]);
  assert.equal((await two).value.items[0]?.id, 123);
  assert.deepEqual(f.calls, ['pending']);
});

test('final abort detaches its flight so a new caller starts a fresh request', async () => {
  const f = fixture();
  const finishes: Array<(value: typeof TOPIC[]) => void> = [];
  f.api.latest = async () => {
    f.calls.push('latest');
    return new Promise((resolve) => { finishes.push(resolve); });
  };
  const firstSignal = new AbortController();
  const first = f.service.latest({ page: 1 }, firstSignal.signal);
  for (let i = 0; i < 10 && finishes.length < 1; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finishes.length, 1);
  firstSignal.abort();
  await assert.rejects(first, { code: 'timeout' });
  const second = f.service.latest({ page: 1 });
  void second.catch(() => {});
  try {
    for (let i = 0; i < 10 && finishes.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finishes.length, 2);
    finishes[0]!([{ ...TOPIC, title: 'old result' }]);
    await new Promise((resolve) => setImmediate(resolve));
    const third = f.service.latest({ page: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finishes.length, 2);
    finishes[1]!([{ ...TOPIC, title: 'new result' }]);
    assert.equal((await second).value.items[0]?.title, 'new result');
    assert.equal((await third).value.items[0]?.title, 'new result');
    assert.equal((await f.service.latest({ page: 1 })).value.items[0]?.title, 'new result');
  } finally {
    for (const finish of finishes) finish([TOPIC]);
  }
  assert.deepEqual(f.calls, ['latest', 'latest']);
});

test('credential and cache backend failures become stable bounded tool errors', async () => {
  const f = fixture();
  const privateDetail = 'private diagnostic marker';
  f.vault.resolve = async () => { throw new Error(privateDetail); };
  const tool = createBrowsingTools(f.service).find((entry) => entry.name === 'v2ex_hot')!;
  for (const action of [() => f.service.hot(), () => tool.execute({}, { signal: new AbortController().signal } as never)]) {
    await assert.rejects(action(), (error: unknown) => {
      assert.ok(error instanceof V2exError);
      assert.equal(error.code, 'incompatible_runtime');
      assert.doesNotMatch(error.message, /private diagnostic/);
      return true;
    });
  }
  f.vault.resolve = async () => 'fixture-token';
  f.store.getCache = async () => { throw new Error(privateDetail); };
  for (const action of [() => f.service.hot(), () => tool.execute({}, { signal: new AbortController().signal } as never)]) {
    await assert.rejects(action(), (error: unknown) => {
      assert.ok(error instanceof V2exError);
      assert.equal(error.code, 'incompatible_runtime');
      assert.doesNotMatch(error.message, /private diagnostic/);
      return true;
    });
  }
  assert.deepEqual(f.calls, []);
});

test('existing public errors remain intact and cache write errors are bounded', async () => {
  const f = fixture();
  f.vault.resolve = async () => { throw new V2exError('token_expired'); };
  await assert.rejects(f.service.hot(), { code: 'token_expired' });
  f.vault.resolve = async () => 'fixture-token';
  f.store.getCache = async () => { throw new V2exError('offline'); };
  await assert.rejects(f.service.hot(), { code: 'offline' });

  const write = fixture();
  write.store.putCache = async () => { throw new Error('private diagnostic marker'); };
  await assert.rejects(write.service.hot(), (error: unknown) => {
    assert.ok(error instanceof V2exError);
    assert.equal(error.code, 'incompatible_runtime');
    assert.doesNotMatch(error.message, /private diagnostic/);
    return true;
  });
});

test('no more than four distinct interactive requests run upstream concurrently', async () => {
  const f = fixture();
  const finishes: Array<() => void> = [];
  f.api.latest = async (page: number) => {
    f.calls.push(`latest:${page}`);
    await new Promise<void>((resolve) => { finishes.push(resolve); });
    return [TOPIC];
  };
  const requests = Array.from({ length: 5 }, (_, index) => f.service.latest({ page: index + 1 }));
  try {
    for (let i = 0; i < 10 && finishes.length < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finishes.length, 4);
    finishes.shift()!();
    for (let i = 0; i < 10 && finishes.length < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 5);
  } finally {
    for (const finish of finishes) finish();
    await Promise.allSettled(requests);
  }
});

test('topic reads requested reply pages and cancellation does not return stale content', async () => {
  const f = fixture();
  const thread = await f.service.topic({ topic: '123', replyPages: 2 });
  assert.deepEqual(f.calls, ['topic:123', 'replies:123:1', 'replies:123:2']);
  assert.equal(thread.value.replies.length, 2);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(f.service.topic({ topic: '123', replyPages: 1 }, aborted.signal));
});

test('invalid identifiers fail before upstream I/O', async () => {
  const f = fixture();
  assert.throws(() => f.service.nodeTopics({ node: '../bad', page: 1 }), { code: 'invalid_request' });
  await assert.rejects(f.service.topic({ topic: '001', replyPages: 1 }), { code: 'invalid_request' });
  assert.deepEqual(f.calls, []);
});
