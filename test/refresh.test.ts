import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestBudget } from '../src/cache.js';
import { AuthService, type IdentityLease, type IdentityLeaseProvider } from '../src/credentials.js';
import { RefreshService, isQuietTime, type RefreshClock } from '../src/refresh.js';
import { FakeContentStore, FakeCredentialVault } from './helpers/fakes.js';
import type { PendingReminderNotice, Recommendation, TopicListItem } from '../src/contract.js';
import { accountScope } from '../src/account-scope.js';
import { V2exError } from '../src/errors.js';
import { Context } from '@deepseek-ai/cordis';
import { DshReminderSink } from '../src/reminders.js';

const at = '2026-11-07T02:00:00.000Z';

function topic(id: number, node = 'typescript'): TopicListItem {
  return { id, title: `Topic ${id}`, node: { name: node, title: node }, author: { username: 'user' },
    replyCount: 0, createdAt: at, lastReplyAt: at, url: `https://www.v2ex.com/t/${id}` };
}

function recommendation(id: number, score = 0.9, read = false): Recommendation {
  return { topic: topic(id), score, reason: `Reason ${id}`, matchedInterests: ['TypeScript'],
    generatedAt: at, read, feedback: null };
}

function pending(id: number): PendingReminderNotice {
  return { noticeId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, topicId: id,
    title: `Topic ${id}`, node: 'tech', reason: 'Relevant', createdAt: at };
}

class MutableIdentity implements IdentityLeaseProvider {
  account = 'alice'; generation = 1; cached = true; readCalls = 0; mutationCalls = 0; cachedMutationCalls = 0;
  private controller = new AbortController();
  lease(): IdentityLease { return { account: this.account, scope: accountScope(this.account),
    credentialFingerprint: `${this.account}-credential`, generation: this.generation,
    signal: this.controller.signal } as IdentityLease; }
  switch(account: string) { this.controller.abort(); this.controller = new AbortController();
    this.account = account; this.generation++; this.cached = true; }
  logout() { this.controller.abort(); this.controller = new AbortController(); this.generation++; this.cached = false; }
  private same(a: IdentityLease, b: IdentityLease) { return a.account === b.account && a.scope === b.scope &&
    a.credentialFingerprint === b.credentialFingerprint && a.generation === b.generation; }
  async withRead<T>(operation: (lease: IdentityLease) => Promise<T>): Promise<T> {
    this.readCalls++;
    const lease = this.lease(); const value = await operation(lease);
    if (!this.same(lease, this.lease())) throw new V2exError('not_authenticated');
    return value;
  }
  async withMutation<T>(operation: (lease: IdentityLease, guard: never) => Promise<T>, expected?: IdentityLease): Promise<T> {
    this.mutationCalls++;
    const lease = this.lease();
    if (expected && !this.same(expected, lease)) throw new V2exError('not_authenticated');
    return operation(lease, undefined as never);
  }
  async withCachedMutation<T>(operation: (lease: IdentityLease, guard: never) => Promise<T>,
    expected?: IdentityLease): Promise<T | undefined> {
    this.cachedMutationCalls++; if (!this.cached) return undefined;
    const lease = this.lease();
    if (expected && !this.same(expected, lease)) throw new V2exError('not_authenticated');
    return operation(lease, undefined as never);
  }
}

class ManualClock implements RefreshClock {
  task?: () => void; disposed = 0;
  constructor(public value = new Date(at)) {}
  now() { return this.value; }
  every(_ms: number, task: () => void) { this.task = task; return () => { this.disposed++; this.task = undefined; }; }
}

function fixture(options: { budget?: boolean; now?: Date; items?: Recommendation[] } = {}) {
  const store = new FakeContentStore(); const identity = new MutableIdentity(); const clock = new ManualClock(options.now ?? new Date(at));
  store.accountProfiles.set(accountScope('alice'), { profile: { authorized: true, learningPaused: false,
    labels: [{ name: 'TypeScript', weight: 1 }], preferredNodes: [{ name: 'typescript', weight: 1 }],
    exclusions: [], feedback: [], updatedAt: at, source: 'history' }, edits: { labels: false, preferredNodes: false, exclusions: false } });
  const budget = new RequestBudget({ reserveForInteractive: 2 });
  budget.update({ limit: 100, remaining: options.budget === false ? 2 : 90, resetAt: Date.parse('2026-11-08T00:00:00Z') });
  const contentCalls: Array<[string, number?]> = [];
  const content = {
    async latest(_input: { page: number }, _signal?: AbortSignal, kind?: string) {
      contentCalls.push(['latest']); assert.equal(kind, 'background');
      return { value: { items: [topic(1), topic(2)], page: 1, hasMore: false, stale: false } };
    },
    async nodeTopics(input: { node: string; page: number }, _signal?: AbortSignal, kind?: string) {
      contentCalls.push([input.node, input.page]); assert.equal(kind, 'background');
      return { value: { items: [topic(2, input.node), topic(input.page + 2, input.node)], page: input.page, hasMore: false, stale: false } };
    },
  };
  let refreshCalls = 0; let release: (() => void) | undefined;
  const recommender = {
    hold: false,
    async refreshCandidates(_candidates: TopicListItem[], signal?: AbortSignal, expected?: IdentityLease) {
      refreshCalls++; assert.equal(expected?.account, 'alice');
      if (this.hold) await new Promise<void>((resolve, reject) => {
        release = resolve; signal?.addEventListener('abort', () => reject(new V2exError('timeout')), { once: true });
      });
      return { items: options.items ?? [recommendation(1)], consideredTopicIds: [1], generatedAt: at,
        stale: false, source: 'generated' as const };
    },
  };
  const notices: PendingReminderNotice[][] = [];
  const reminders = { deliver: true, async notify(items: readonly PendingReminderNotice[]) {
    notices.push([...items]); return this.deliver ? items.map(item => item.noticeId) : [];
  } };
  const service = new RefreshService({ store, content, recommendations: recommender, budget, identity, reminders, clock });
  return { service, store, identity, clock, budget, contentCalls, recommender, reminders, notices,
    get refreshCalls() { return refreshCalls; }, release: () => release?.() };
}

test('timer skips all content and model work near the V2EX rate limit', async () => {
  const f = fixture({ budget: false });
  await f.service.runNow('timer');
  assert.deepEqual(f.contentCalls, []);
  assert.equal(f.refreshCalls, 0);
});

test('budget exhaustion drains cached-account pending before returning and never duplicates later', async () => {
  for (const reason of ['timer', 'manual'] as const) {
    const f = fixture({ budget: false, items: [] }); const scope = accountScope('alice');
    await f.store.enqueuePendingNotifications(scope, [{ noticeId: '00000000-0000-4000-8000-000000000081',
      topicId: 81, title: 'Cached topic', node: 'tech', reason: 'Relevant', createdAt: at }]);
    await f.service.runNow(reason);
    assert.deepEqual(f.notices.map(batch => batch.map(value => value.topicId)), [[81]]);
    assert.equal(f.identity.cachedMutationCalls, 2); assert.equal(f.identity.readCalls, 0);
    assert.deepEqual(f.contentCalls, []); assert.equal(f.refreshCalls, 0);
    f.budget.update({ limit: 100, remaining: 90, resetAt: Date.parse('2026-11-08T00:00:00Z') });
    await f.service.runNow(reason === 'timer' ? 'manual' : 'timer');
    assert.deepEqual(f.notices.map(batch => batch.map(value => value.topicId)), [[81]]);
  }
});

test('budget exhaustion keeps cached pending during quiet hours', async () => {
  const f = fixture({ budget: false, now: new Date('2026-11-06T15:00:00Z') }); const scope = accountScope('alice');
  await f.store.putSettings({ ...f.store.settings,
    quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Shanghai' } }, scope);
  await f.store.enqueuePendingNotifications(scope, [{ noticeId: '00000000-0000-4000-8000-000000000082',
    topicId: 82, title: 'Quiet topic', node: 'tech', reason: 'Relevant', createdAt: at }]);
  await f.service.runNow('timer');
  assert.deepEqual(f.notices, []); assert.equal(f.identity.cachedMutationCalls, 1); assert.equal(f.identity.readCalls, 0);
  assert.deepEqual((await f.store.getPendingNotifications(scope)).map(value => value.topicId), [82]);
});

test('budget exhaustion without cached identity does no identity or network work', async () => {
  const f = fixture({ budget: false }); const scope = accountScope('alice'); f.identity.logout();
  await f.store.enqueuePendingNotifications(scope, [{ noticeId: '00000000-0000-4000-8000-000000000083',
    topicId: 83, title: 'Logged out topic', node: 'tech', reason: 'Relevant', createdAt: at }]);
  await f.service.runNow('manual');
  assert.deepEqual(f.notices, []); assert.equal(f.identity.cachedMutationCalls, 1); assert.equal(f.identity.readCalls, 0);
  assert.deepEqual(f.contentCalls, []); assert.equal(f.refreshCalls, 0);
  assert.deepEqual((await f.store.getPendingNotifications(scope)).map(value => value.topicId), [83]);
});

test('pre-budget cached drain respects account switch, logout, and dispose', async () => {
  const f = fixture({ budget: false }); const alice = accountScope('alice');
  await f.store.enqueuePendingNotifications(alice, [{ noticeId: '00000000-0000-4000-8000-000000000084',
    topicId: 84, title: 'Alice topic', node: 'tech', reason: 'Relevant', createdAt: at }]);
  f.identity.switch('bob'); await f.service.runNow('timer'); assert.deepEqual(f.notices, []);
  f.identity.logout(); await f.service.runNow('timer'); assert.deepEqual(f.notices, []);
  assert.equal(f.identity.cachedMutationCalls, 2); assert.equal(f.identity.readCalls, 0);
  await f.service.dispose(); f.identity.switch('alice');
  await assert.rejects(f.service.runNow('manual'), { code: 'timeout' });
  assert.deepEqual((await f.store.getPendingNotifications(alice)).map(value => value.topicId), [84]);
});

test('concurrent timer and manual triggers join one serialized run', async () => {
  const f = fixture(); f.recommender.hold = true;
  const first = f.service.runNow('timer');
  while (!f.refreshCalls) await Promise.resolve();
  const second = f.service.runNow('manual');
  assert.strictEqual(second, first);
  f.release(); await Promise.all([first, second]);
  assert.equal(f.refreshCalls, 1);
});

test('refresh scans latest and no more than two bounded pages per deduped preferred node', async () => {
  const f = fixture();
  f.store.settings = { ...f.store.settings, scannedNodes: ['typescript', 'rust'], pagesPerNode: 1000 };
  await f.service.runNow('manual');
  assert.deepEqual(f.contentCalls, [['latest'], ['typescript', 1], ['typescript', 2], ['rust', 1], ['rust', 2]]);
});

test('quiet hours use the configured timezone and work across midnight', () => {
  const quiet = { start: '22:30', end: '07:15', timeZone: 'Asia/Shanghai' };
  assert.equal(isQuietTime(new Date('2026-11-06T15:00:00Z'), quiet), true);
  assert.equal(isQuietTime(new Date('2026-11-06T22:30:00Z'), quiet), true);
  assert.equal(isQuietTime(new Date('2026-11-07T04:00:00Z'), quiet), false);
  assert.equal(isQuietTime(new Date('2026-11-07T04:00:00Z'), { start: '10:00', end: '10:00', timeZone: 'UTC' }), false);
});

test('only new unread recommendations above threshold are claimed and notified once durably', async () => {
  const f = fixture({ items: [recommendation(1, 0.9), recommendation(2, 0.6), recommendation(3, 1, true)] });
  f.store.settings = { ...f.store.settings, notificationThreshold: 0.7 };
  await f.service.runNow('timer'); await f.service.runNow('timer');
  assert.deepEqual(f.notices.map(batch => batch.map(item => item.topicId)), [[1]]);
  assert.deepEqual(await f.store.enqueuePendingNotifications(accountScope('alice'), [f.notices[0]![0]!]), []);
});

test('quiet hours still refresh recommendations but suppress notices', async () => {
  const f = fixture({ now: new Date('2026-11-06T15:00:00Z') });
  f.store.settings = { ...f.store.settings, quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Shanghai' } };
  await f.service.runNow('timer');
  assert.equal(f.refreshCalls, 1); assert.deepEqual(f.notices, []);
});

test('account replacement before publication prevents stale notification', async () => {
  const f = fixture(); f.recommender.hold = true;
  const running = f.service.runNow('timer'); while (!f.refreshCalls) await Promise.resolve();
  f.identity.switch('bob'); f.release();
  await assert.rejects(running, { code: 'not_authenticated' });
  assert.deepEqual(f.notices, []);
});

test('clear and dispose abort active work, remove account refresh state, and are idempotent', async () => {
  const f = fixture(); f.recommender.hold = true;
  await f.store.enqueuePendingNotifications(accountScope('alice'), [{ noticeId: '00000000-0000-4000-8000-000000000099',
    topicId: 99, title: 'Topic', node: 'tech', reason: 'Relevant', createdAt: at }]);
  const running = f.service.runNow('timer'); while (!f.refreshCalls) await Promise.resolve();
  await f.service.clear('alice');
  await assert.rejects(running, { code: 'timeout' });
  assert.deepEqual(await f.store.getPendingNotifications(accountScope('alice')), []);
  await f.service.start();
  const first = f.service.dispose(); const second = f.service.dispose();
  assert.strictEqual(first, second); await first; assert.equal(f.clock.disposed, 1);
});

test('clear immediately after scheduling prevents later content or model work', async () => {
  const f = fixture();
  const running = f.service.runNow('timer');
  await f.service.clear('alice');
  await assert.rejects(running, { code: 'timeout' });
  assert.deepEqual(f.contentCalls, []); assert.equal(f.refreshCalls, 0);
});

test('timer callbacks contain rejected refreshes without an unhandled promise', async () => {
  const f = fixture();
  f.store.getSettings = async () => { throw new Error('private storage detail'); };
  await f.service.start();
  assert.doesNotThrow(() => f.clock.task?.());
  await new Promise(resolve => setImmediate(resolve));
  await f.service.dispose();
});

test('undelivered notice survives service restart and successful retry marks it sent once', async () => {
  const f = fixture(); f.reminders.deliver = false;
  await f.service.runNow('timer');
  assert.deepEqual((await f.store.getPendingNotifications(accountScope('alice'))).map(value => value.topicId), [1]);
  const restartedNotices: PendingReminderNotice[][] = [];
  const restarted = new RefreshService({ store: f.store, content: {} as never, recommendations: {} as never,
    budget: f.budget, identity: f.identity, reminders: { async notify(items) {
      restartedNotices.push([...items]); return items.map(item => item.noticeId);
    } }, clock: f.clock });
  await restarted.drainPending(); await restarted.drainPending();
  assert.deepEqual(restartedNotices.map(batch => batch.map(value => value.topicId)), [[1]]);
  assert.deepEqual(await f.store.getPendingNotifications(accountScope('alice')), []);
});

test('busy notice survives restart and drains from the official idle event', async () => {
  const f = fixture(); f.reminders.deliver = false; await f.service.runNow('timer'); await f.service.dispose();
  const ctx = new Context(); const sink = new DshReminderSink(); sink.bind(ctx as never);
  const messages: unknown[] = []; const agent = { status: 'running', async followup(message: unknown) { messages.push(message); } };
  const restarted = new RefreshService({ store: f.store, content: {} as never, recommendations: {} as never,
    budget: f.budget, identity: f.identity, reminders: sink, clock: f.clock });
  sink.onIdle(() => restarted.drainPending());
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'running' });
  agent.status = 'idle';
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert.deepEqual(await f.store.getPendingNotifications(accountScope('alice')), []);
  await restarted.dispose(); await ctx.fiber.dispose();
});

test('restart idle drain keeps pending notices through quiet hours and delivers once later', async () => {
  const f = fixture({ now: new Date('2026-11-07T04:00:00Z') });
  f.reminders.deliver = false; await f.service.runNow('timer'); await f.service.dispose();
  const scope = accountScope('alice');
  await f.store.putSettings({ ...f.store.settings,
    quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Shanghai' } }, scope);
  f.clock.value = new Date('2026-11-06T15:00:00Z');
  const ctx = new Context(); const sink = new DshReminderSink(); const unbind = sink.bind(ctx as never);
  const messages: unknown[] = []; const agent = { status: 'running', async followup(message: unknown) { messages.push(message); } };
  const restarted = new RefreshService({ store: f.store, content: {} as never, recommendations: {} as never,
    budget: f.budget, identity: f.identity, reminders: sink, clock: f.clock });
  const removeIdle = sink.onIdle(() => restarted.handleReminderIdle());
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'running' });
  agent.status = 'idle';
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 0);
  assert.deepEqual((await f.store.getPendingNotifications(scope)).map(value => value.topicId), [1]);

  f.identity.switch('bob'); f.clock.value = new Date('2026-11-07T04:00:00Z');
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(messages.length, 0);
  f.identity.switch('alice');
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert.deepEqual(await f.store.getPendingNotifications(scope), []);
  await restarted.dispose();
  (ctx.emit as (name: string, payload: unknown) => void)('agent/status', { agent, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(messages.length, 1);
  removeIdle(); unbind(); await ctx.fiber.dispose();
});

test('manual refresh drains an existing notice even when ranking returns no new items', async () => {
  const f = fixture({ items: [] }); const scope = accountScope('alice');
  await f.store.enqueuePendingNotifications(scope, [{ noticeId: '00000000-0000-4000-8000-000000000077',
    topicId: 77, title: 'Existing topic', node: 'tech', reason: 'Relevant', createdAt: at }]);
  await f.service.runNow('manual');
  assert.deepEqual(f.notices.map(batch => batch.map(value => value.topicId)), [[77]]);
  assert.deepEqual(await f.store.getPendingNotifications(scope), []);
});

test('Unicode-safe notice truncation does not make repeated refresh fail', async () => {
  const boundary = { ...recommendation(1), topic: { ...recommendation(1).topic,
    title: `${'x'.repeat(199)}😀\ud800ignored` } };
  const f = fixture({ items: [boundary] });
  await f.service.runNow('timer'); await f.service.runNow('timer');
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0]![0]!.title.isWellFormed(), true);
  assert.equal(Array.from(f.notices[0]![0]!.title).length, 200);
  assert.equal(f.notices[0]![0]!.title.endsWith('😀'), true);
});

test('delivery storage failure keeps stable-id pending notice retryable without duplicate followup', async () => {
  const f = fixture(); let fail = true; const delivered = new Set<string>(); let userVisible = 0;
  f.reminders.notify = async (items) => { for (const item of items) if (!delivered.has(item.noticeId)) {
    delivered.add(item.noticeId); userVisible++;
  } return items.map(item => item.noticeId); };
  f.store.beforeNotificationSent = async () => { if (fail) { fail = false; throw new Error('storage failed'); } };
  await assert.rejects(f.service.runNow('timer'), /storage failed/);
  await f.service.drainPending();
  assert.equal(userVisible, 1); assert.deepEqual(await f.store.getPendingNotifications(accountScope('alice')), []);
});

test('pending delivery stays account-scoped across switches and dispose leaves retryable state', async () => {
  const f = fixture(); f.reminders.deliver = false; await f.service.runNow('timer');
  f.identity.switch('bob'); await f.service.drainPending(); assert.equal(f.notices.length, 1);
  f.identity.switch('alice');
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.reminders.notify = (items, signal) => new Promise(resolve => {
    entered(); signal?.addEventListener('abort', () => resolve([]), { once: true });
  });
  const draining = f.service.drainPending(); await started; const disposing = f.service.dispose();
  await Promise.all([draining.catch(() => {}), disposing]);
  assert.deepEqual((await f.store.getPendingNotifications(accountScope('alice'))).map(value => value.topicId), [1]);
});

test('same-mode drains coalesce but cached and normal modes never join in either order', async () => {
  for (const firstMode of ['normal', 'cached'] as const) {
    const f = fixture({ budget: false, items: [] }); const scope = accountScope('alice');
    await f.store.enqueuePendingNotifications(scope, [pending(firstMode === 'normal' ? 91 : 92)]);
    let enter!: () => void; let release!: () => void; let calls = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.reminders.notify = async items => { calls++; enter(); await gate; return items.map(value => value.noticeId); };
    const first = firstMode === 'normal' ? f.service.drainPending() : f.service.runNow('timer');
    await entered;
    const second = firstMode === 'normal' ? f.service.runNow('timer') : f.service.drainPending();
    await new Promise(resolve => setImmediate(resolve));
    const incompatiblePrepared = firstMode === 'normal' ? f.identity.cachedMutationCalls === 1 : f.identity.mutationCalls === 1;
    release(); await Promise.all([first, second]);
    assert.equal(incompatiblePrepared, true, firstMode);
    assert.equal(calls, 1); assert.deepEqual(await f.store.getPendingNotifications(scope), []);
  }

  const f = fixture({ items: [] }); const scope = accountScope('alice'); await f.store.enqueuePendingNotifications(scope, [pending(93)]);
  let enter!: () => void; let release!: () => void; let calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.reminders.notify = async items => { calls++; enter(); await gate; return items.map(value => value.noticeId); };
  const one = f.service.drainPending(); await entered; const two = f.service.drainPending(); release();
  await Promise.all([one, two]); assert.equal(calls, 1);
});

test('different accounts rerun after an incompatible flight and late old delivery cannot mark sent', async () => {
  const f = fixture({ items: [] }); const alice = accountScope('alice'); const bob = accountScope('bob');
  await f.store.enqueuePendingNotifications(alice, [pending(94)]);
  let enter!: () => void; let release!: () => void; let calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.reminders.notify = async items => { calls++; if (calls === 1) { enter(); await gate; } return items.map(value => value.noticeId); };
  const old = f.service.drainPending().catch(() => {}); await entered; f.identity.switch('bob');
  await f.store.enqueuePendingNotifications(bob, [pending(95)]); let nextSettled = false;
  const next = f.service.drainPending().then(() => { nextSettled = true; });
  await new Promise(resolve => setImmediate(resolve)); const settledBeforeOldHost = nextSettled;
  release(); await Promise.all([old, next]);
  assert.equal(settledBeforeOldHost, true); assert.equal(calls, 2);
  assert.deepEqual((await f.store.getPendingNotifications(alice)).map(value => value.topicId), [94]);
  assert.deepEqual(await f.store.getPendingNotifications(bob), []);
});

test('stale expected lease never joins an active delivery for another generation', async () => {
  const f = fixture({ items: [] }); const stale = f.identity.lease(); f.identity.switch('bob');
  await f.store.enqueuePendingNotifications(accountScope('bob'), [pending(96)]);
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.reminders.notify = async items => { enter(); await gate; return items.map(value => value.noticeId); };
  const active = f.service.drainPending(); await entered; let staleRejected = false;
  const staleCall = f.service.drainPending(stale).catch(() => { staleRejected = true; });
  await new Promise(resolve => setImmediate(resolve)); const rejectedBeforeRelease = staleRejected;
  release(); await Promise.all([active, staleCall]); assert.equal(rejectedBeforeRelease, true);
});

test('logout and account switch are not blocked by noncooperative cached or normal Host delivery', async () => {
  for (const deliveryMode of ['cached', 'normal'] as const) for (const transition of ['logout', 'switch'] as const) {
    const vault = new FakeCredentialVault();
    const api = { async readToken() { return { scope: 'everything' }; },
      async readMember(token: string) { return { username: token.startsWith('ALICE') ? 'alice' : 'bob' }; } };
    let service!: RefreshService;
    const auth = new AuthService(api as never, vault, async account => { if (account) await service.clear(account); });
    await auth.login('ALICE_FAKE_VALUE'); const store = new FakeContentStore(); const scope = accountScope('alice');
    const topicId = deliveryMode === 'cached' ? 97 : 98; await store.enqueuePendingNotifications(scope, [pending(topicId)]);
    const budget = new RequestBudget({ reserveForInteractive: 2 }); budget.update({ limit: 100,
      remaining: deliveryMode === 'cached' ? 2 : 90, resetAt: Date.parse('2026-11-08T00:00:00Z') });
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    service = new RefreshService({ store, content: {} as never, recommendations: {} as never, budget, identity: auth,
      reminders: { async notify() { enter(); return new Promise<string[]>(() => {}); } }, clock: new ManualClock() });
    const delivery = (deliveryMode === 'cached' ? service.runNow('timer') : service.drainPending()).catch(() => {}); await entered;
    const change = transition === 'logout' ? auth.logout(true) : auth.login('BOB_FAKE_VALUE').then(() => {});
    let changed = false; void change.then(() => { changed = true; }); await new Promise(resolve => setImmediate(resolve));
    const changedPromptly = changed; await service.dispose(); await change; await delivery;
    assert.equal(changedPromptly, true, `${deliveryMode}/${transition}`);
    if (transition === 'logout') assert.deepEqual(await store.getPendingNotifications(scope), []);
    else assert.deepEqual((await store.getPendingNotifications(scope)).map(value => value.topicId), [topicId]);
  }
});

test('clear and dispose settle noncooperative delivery and late rejection is handled', async () => {
  for (const action of ['clear', 'dispose'] as const) {
    const f = fixture({ items: [] }); const scope = accountScope('alice'); await f.store.enqueuePendingNotifications(scope, [pending(99)]);
    let enter!: () => void; let rejectHost!: (error: Error) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.reminders.notify = async () => { enter(); return new Promise<string[]>((_resolve, reject) => { rejectHost = reject; }); };
    const delivery = f.service.drainPending().catch(() => {}); await entered;
    if (action === 'clear') await f.service.clear('alice'); else await f.service.dispose();
    await delivery; rejectHost(new Error('late private Host rejection'));
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'clear') assert.deepEqual(await f.store.getPendingNotifications(scope), []);
    else assert.deepEqual((await f.store.getPendingNotifications(scope)).map(value => value.topicId), [99]);
  }
});
