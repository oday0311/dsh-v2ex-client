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
  assert.deepEqual(next.labels, [{ name: 'Manual', weight: 1 }]);
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

test('mixed edits preserve exact label, node, and exclusion deletions on repeated relearn', async () => {
  const store = new FakeContentStore();
  const service = new InterestService(store, { async readEligibleUserText() { return 'interests'; } },
    { async completeJson() { return { labels: [{ name: 'Rust', weight: 1 }],
      preferredNodes: [{ name: 'tech', weight: 1 }], exclusions: ['ads'] }; } } as never);
  await service.authorize();
  await service.relearn();
  await service.update({ labels: [], preferredNodes: [], exclusions: [] });
  for (let i = 0; i < 2; i++) {
    const next = await service.relearn();
    assert.deepEqual([next.labels, next.preferredNodes, next.exclusions], [[], [], []]);
  }
});

test('pause-only edit preserves source, manual relearn works, and feedback mixes history', async () => {
  const store = new FakeContentStore();
  const service = new InterestService(store, { async readEligibleUserText() { return 'interest'; } },
    { async completeJson() { return { labels: [], preferredNodes: [], exclusions: [] }; } } as never);
  await service.authorize();
  await service.relearn();
  const paused = await service.update({ learningPaused: true });
  assert.equal(paused.source, 'history');
  assert.equal((await service.relearn()).source, 'history');
  assert.equal((await service.recordFeedback(1, true)).source, 'mixed');
});

test('clear and revoke settle promptly while history or model ignore abort', async () => {
  for (const stage of ['history', 'model'] as const) for (const action of ['clear', 'revoke'] as const) {
    const store = new FakeContentStore();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const service = new InterestService(store,
      { async readEligibleUserText() { if (stage === 'history') { entered(); await held; } return 'interest'; } },
      { async completeJson() { if (stage === 'model') { entered(); await held; }
        return { labels: [], preferredNodes: [], exclusions: [] }; } } as never);
    await service.authorize();
    const learning = service.relearn();
    await started;
    const mutation = action === 'clear' ? service.clear() : service.revoke();
    const settled = await Promise.race([mutation.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))]);
    release();
    assert.equal(settled, true);
    await assert.rejects(learning, { code: 'timeout' });
    const profile = await store.getProfile();
    if (action === 'clear') assert.equal(profile, null);
    else assert.equal(profile?.authorized, false);
  }
});

test('durable edit flags preserve only edited fields and feedback-only profiles keep learning', async () => {
  const store = new FakeContentStore();
  let revision = 1;
  const history = { async readEligibleUserText() { return 'interest'; } };
  const model = { async completeJson() { return {
    labels: [{ name: `label${revision}`, weight: 1 }],
    preferredNodes: [{ name: `node${revision}`, weight: 1 }], exclusions: [`exclude${revision}`],
  }; } } as never;
  const first = new InterestService(store, history, model);
  await first.authorize();
  await first.relearn();
  await first.update({ labels: [] });
  revision = 2;
  const restarted = new InterestService(store, history, model);
  const edited = await restarted.relearn();
  assert.deepEqual(edited.labels, []);
  assert.deepEqual(edited.preferredNodes.map(item => item.name), ['node2']);
  assert.deepEqual(edited.exclusions, ['exclude2']);
  await restarted.recordFeedback(1, true);
  revision = 3;
  const feedback = await new InterestService(store, history, model).relearn();
  assert.deepEqual(feedback.preferredNodes.map(item => item.name), ['node3']);
  assert.deepEqual(feedback.feedback, [{ topicId: 1, interested: true }]);
});
