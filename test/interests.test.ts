import assert from 'node:assert/strict';
import test from 'node:test';
import { InterestService } from '../src/interests.js';
import { FakeContentStore } from './helpers/fakes.js';

test('authorization precedes every history read and manual edits do not read', async () => {
  const store = new FakeContentStore();
  let reads = 0;
  const history = { async readEligibleUserText() { reads++; return 'Rust'; } };
  const model = { route: () => 'test', async completeJson() { return { labels: [{ name: 'Rust', weight: 0.8 }], preferredNodes: [], exclusions: [] }; } };
  const service = new InterestService(store, history, model as never);
  await assert.rejects(service.relearn(), { code: 'history_access_denied' });
  assert.equal(reads, 0);
  await service.update({ labels: [{ name: 'manual', weight: 1 }] });
  assert.equal(reads, 0);
  await service.authorize();
  assert.deepEqual((await service.relearn()).labels.map(item => item.name), ['manual', 'Rust']);
  assert.equal(reads, 1);
  await service.revoke();
  await assert.rejects(service.relearn(), { code: 'history_access_denied' });
  assert.equal(reads, 1);
});

test('relearning retains edits and feedback; deleted exclusion stays deleted', async () => {
  const store = new FakeContentStore();
  const history = { async readEligibleUserText() { return 'Rust'; } };
  const model = { route: () => 'test', async completeJson() { return {
    labels: [{ name: 'Rust', weight: 0.8 }], preferredNodes: [{ name: 'programming', weight: 0.7 }], exclusions: ['ads'],
  }; } };
  const service = new InterestService(store, history, model as never);
  await service.authorize();
  await service.relearn();
  await service.update({ labels: [{ name: 'Manual', weight: 1 }], exclusions: [] });
  await service.recordFeedback(42, false);
  const next = await service.relearn();
  assert.deepEqual(next.exclusions, []);
  assert.deepEqual(next.labels, [{ name: 'Manual', weight: 1 }, { name: 'Rust', weight: 0.8 }]);
  assert.deepEqual(next.feedback, [{ topicId: 42, interested: false }]);
  await service.clear();
  assert.equal(await store.getProfile(), null);
});

test('revoke during in-flight relearn prevents stale profile write', async () => {
  const store = new FakeContentStore();
  let resolve!: (value: string) => void;
  const wait = new Promise<string>(r => { resolve = r; });
  const service = new InterestService(store, { async readEligibleUserText() { return wait; } },
    { route: () => 'test', async completeJson() { return { labels: [], preferredNodes: [], exclusions: [] }; } } as never);
  await service.authorize();
  const learning = service.relearn();
  await new Promise<void>(r => setImmediate(r));
  const revoked = service.revoke();
  resolve('text');
  const [outcome] = await Promise.allSettled([learning, revoked]);
  assert.equal(outcome.status, 'rejected');
  assert.equal((await service.get()).authorized, false);
});

test('revoke queued before relearn starts prevents any history I/O', async () => {
  const store = new FakeContentStore();
  let reads = 0;
  const service = new InterestService(store, { async readEligibleUserText() { reads++; return 'text'; } },
    { async completeJson() { return { labels: [], preferredNodes: [], exclusions: [] }; } } as never);
  await service.authorize();
  const learning = service.relearn();
  const revoked = service.revoke();
  await assert.rejects(learning, { code: 'history_access_denied' });
  await revoked;
  assert.equal(reads, 0);
});

test('schema-invalid model output is rejected without raw history persistence', async () => {
  const store = new FakeContentStore();
  const history = { async readEligibleUserText() { return 'secret historical content'; } };
  const service = new InterestService(store, history,
    { async completeJson() { return { labels: [{ name: 'bad', weight: 5 }], preferredNodes: [], exclusions: [] }; } } as never);
  await service.authorize();
  await assert.rejects(service.relearn(), { code: 'invalid_response' });
  assert.doesNotMatch(JSON.stringify(store), /secret historical content/);
});

test('manual update queued during relearn wins without losing learned labels', async () => {
  const store = new FakeContentStore();
  let release!: (value: string) => void;
  const held = new Promise<string>(resolve => { release = resolve; });
  const service = new InterestService(store, { async readEligibleUserText() { return held; } },
    { async completeJson() { return { labels: [{ name: 'Rust', weight: 0.8 }], preferredNodes: [], exclusions: ['spam'] }; } } as never);
  await service.authorize();
  const learning = service.relearn();
  const edit = service.update({ labels: [{ name: 'Manual', weight: 1 }], exclusions: [] });
  release('history');
  await Promise.all([learning, edit]);
  const profile = await service.get();
  assert.deepEqual(profile.labels, [{ name: 'Manual', weight: 1 }]);
  assert.deepEqual(profile.exclusions, []);
  assert.equal(profile.authorized, true);
});
