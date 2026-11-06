import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { DshReminderSink, createReminderNotice } from '../src/reminders.js';
import type { Recommendation } from '../src/contract.js';

const item: Recommendation = {
  topic: { id: 1, title: 'A useful topic', node: { name: 'typescript', title: 'TypeScript' },
    author: { username: 'author' }, replyCount: 1, createdAt: '2026-11-07T00:00:00.000Z',
    lastReplyAt: null, url: 'https://www.v2ex.com/t/1' },
  score: 0.9, reason: 'Matches your TypeScript interests', matchedInterests: [],
  generatedAt: '2026-11-07T00:00:00.000Z', read: false, feedback: null,
};

function agent(input: { root?: boolean; status?: string; fail?: number } = {}) {
  const messages: unknown[] = []; const ids = new Set<string>(); let failures = input.fail ?? 0;
  return { root: input.root ?? true, status: input.status ?? 'idle', messages,
    async followup(value: unknown) {
      if (failures-- > 0) throw new Error('private provider failure');
      const id = (value as { id?: unknown }).id;
      if (typeof id === 'string' && !ids.has(id)) { ids.add(id); messages.push(value); }
    } };
}

function emit(ctx: Context, name: 'agent/status' | 'agent/disposed', payload: unknown) {
  (ctx.emit as (name: string, payload: unknown) => void)(name, payload);
}

test('bind consumes official DSH payload.agent status events rather than the Cordis this carrier', async () => {
  const ctx = new Context(); const sink = new DshReminderSink(); let wakes = 0;
  const removeWake = sink.onIdle(async () => { wakes++; }); const dispose = sink.bind(ctx as never);
  const target = agent({ status: 'running' });
  emit(ctx, 'agent/status', { agent: target, status: 'running' });
  target.status = 'idle'; emit(ctx, 'agent/status', { agent: target, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wakes, 1);
  removeWake(); dispose(); dispose();
  emit(ctx, 'agent/status', { agent: target, status: 'idle' });
  emit(ctx, 'agent/disposed', { agent: target });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wakes, 1); await ctx.fiber.dispose();
});

test('latest top-level Agent receives a stable-id notice and failed followup stays retryable', async () => {
  const ctx = new Context(); const sink = new DshReminderSink(); const target = agent({ fail: 1 });
  sink.bind(ctx as never); emit(ctx, 'agent/status', { agent: target, status: 'running' }); target.status = 'idle';
  const notice = createReminderNotice(item);
  assert.deepEqual(await sink.notify([notice]), []);
  assert.deepEqual(await sink.notify([notice]), [notice.noticeId]);
  assert.equal(target.messages.length, 1);
  const serialized = JSON.stringify(target.messages[0]);
  assert.match(serialized, /A useful topic/); assert.match(serialized, /"kind":"plugin"/);
  assert.equal((target.messages[0] as { id: string }).id, notice.noticeId);
  await ctx.fiber.dispose();
});

test('children and disposed or stale Agents are never followed up', async () => {
  const ctx = new Context(); const sink = new DshReminderSink(); sink.bind(ctx as never);
  const child = agent({ root: false }); const stale = agent();
  emit(ctx, 'agent/status', { agent: child, status: 'running' });
  assert.deepEqual(await sink.notify([createReminderNotice(item)]), []);
  emit(ctx, 'agent/status', { agent: stale, status: 'running' });
  emit(ctx, 'agent/disposed', { agent: stale });
  assert.deepEqual(await sink.notify([createReminderNotice(item)]), []);
  assert.equal(stale.messages.length, 0); await ctx.fiber.dispose();
});

test('sanitization normalizes controls before scanning the exact outbound notice', async () => {
  const unsafe = { ...item, topic: { ...item.topic, title: `token=\u0000FAKE_LONG_VALUE_12345678 ${'x'.repeat(2000)}` },
    reason: `private\u0000provider\u0000error ${'y'.repeat(4000)}` };
  const notice = createReminderNotice(unsafe);
  const serializedNotice = JSON.stringify(notice);
  assert.doesNotMatch(serializedNotice, /FAKE_LONG_VALUE|private.*provider.*error/i);
  assert.doesNotMatch(serializedNotice, /[\u0000-\u001f\u007f]/);
  const ctx = new Context(); const sink = new DshReminderSink(); const target = agent(); sink.bind(ctx as never);
  emit(ctx, 'agent/status', { agent: target, status: 'running' });
  assert.deepEqual(await sink.notify([notice]), [notice.noticeId]);
  const outbound = JSON.stringify(target.messages[0]);
  assert.ok(Buffer.byteLength(outbound) < 5000);
  assert.doesNotMatch(outbound, /FAKE_LONG_VALUE|private.*provider.*error/i);
  await ctx.fiber.dispose();
});

test('sanitization detects credential labels split across normalized outbound fields', () => {
  const split = createReminderNotice({ ...item, topic: { ...item.topic, title: 'token=' },
    reason: 'FAKE_LONG_VALUE_12345678' });
  assert.equal(split.title, 'V2EX topic'); assert.equal(split.reason, 'Relevant to your V2EX interests');
  assert.doesNotMatch(JSON.stringify(split), /FAKE_LONG_VALUE/);
});

test('canonical outbound scan catches split secret and provider shapes', () => {
  const variants: Recommendation[] = [
    { ...item, topic: { ...item.topic, title: 'to\u0000ken=FAKE_LONG_VALUE_12345678' } },
    { ...item, reason: 'pro\u0000vider error detail' },
    { ...item, topic: { ...item.topic, title: 'tok', node: { ...item.topic.node, name: 'en' } },
      reason: '= FAKE_LONG_VALUE_12345678' },
    { ...item, topic: { ...item.topic, title: 'bea', node: { ...item.topic.node, name: 'rer' } },
      reason: 'FAKE_LONG_VALUE_12345678' },
    { ...item, reason: 'a\u0000pi-key: FAKE_LONG_VALUE_12345678' },
    { ...item, topic: { ...item.topic, title: '12345678-1234', node: { ...item.topic.node, name: '5678' } },
      reason: '90ab-cdef12345678' },
  ];
  for (const variant of variants) {
    const notice = createReminderNotice(variant); const serialized = JSON.stringify(notice);
    assert.equal(notice.title, 'V2EX topic'); assert.equal(notice.node, 'unknown');
    assert.equal(notice.reason, 'Relevant to your V2EX interests');
    assert.doesNotMatch(serialized, /FAKE_LONG_VALUE|provider error|12345678-1234/i);
  }
});

test('notice truncation is Unicode-safe after malformed input repair', async () => {
  const notice = createReminderNotice({ ...item, topic: { ...item.topic,
    title: `${'x'.repeat(199)}😀\ud800ignored` }, reason: 'safe\udc00reason' });
  assert.equal(notice.title.isWellFormed(), true); assert.equal(notice.reason.isWellFormed(), true);
  assert.equal(Array.from(notice.title).length, 200); assert.equal(notice.title.endsWith('😀'), true);
  const ctx = new Context(); const sink = new DshReminderSink(); const target = agent(); sink.bind(ctx as never);
  emit(ctx, 'agent/status', { agent: target, status: 'running' });
  assert.deepEqual(await sink.notify([notice]), [notice.noticeId]);
  assert.match(JSON.stringify(target.messages[0]), /😀/); await ctx.fiber.dispose();
});

test('abort while followup is pending stops the batch without reporting delivery', async () => {
  const ctx = new Context(); const sink = new DshReminderSink(); let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const target = { status: 'idle', root: true, async followup() { calls++; await gate; } };
  sink.bind(ctx as never); emit(ctx, 'agent/status', { agent: target, status: 'running' });
  const controller = new AbortController();
  const delivery = sink.notify([createReminderNotice(item), createReminderNotice({ ...item,
    topic: { ...item.topic, id: 2 } })], controller.signal);
  while (!calls) await Promise.resolve(); controller.abort(); release();
  assert.deepEqual(await delivery, []); assert.equal(calls, 1); await ctx.fiber.dispose();
});
