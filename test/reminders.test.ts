import assert from 'node:assert/strict';
import test from 'node:test';
import { DshReminderSink } from '../src/reminders.js';
import type { Recommendation } from '../src/contract.js';

const item: Recommendation = {
  topic: { id: 1, title: 'A useful topic', node: { name: 'typescript', title: 'TypeScript' },
    author: { username: 'author' }, replyCount: 1, createdAt: '2026-11-07T00:00:00.000Z',
    lastReplyAt: null, url: 'https://www.v2ex.com/t/1' },
  score: 0.9, reason: 'Matches your TypeScript interests', matchedInterests: [],
  generatedAt: '2026-11-07T00:00:00.000Z', read: false, feedback: null,
};

function agent(input: { root?: boolean; status?: string } = {}) {
  const messages: unknown[] = [];
  return { root: input.root ?? true, status: input.status ?? 'idle', messages,
    createUserMessage(value: unknown) { return { kind: 'user', value }; },
    async followup(value: unknown) { messages.push(value); } };
}

test('missing agent retains sidebar-only unread state without throwing', async () => {
  const sink = new DshReminderSink();
  await sink.notify([item]);
});

test('latest root agent entering running receives one bounded notice after becoming idle', async () => {
  const sink = new DshReminderSink(); const first = agent(); const latest = agent({ status: 'running' });
  sink.observe(first, 'running'); sink.observe(latest, 'running'); latest.status = 'idle';
  await sink.notify([item]);
  assert.equal(first.messages.length, 0); assert.equal(latest.messages.length, 1);
  const serialized = JSON.stringify(latest.messages[0]);
  assert.match(serialized, /A useful topic/); assert.match(serialized, /typescript/);
  assert.match(serialized, /Matches your TypeScript interests/);
  assert.match(serialized, /"kind":"plugin"/); assert.match(serialized, /"plugin":"v2ex"/);
  assert.match(serialized, /"form":"notice"/);
  assert.doesNotMatch(serialized, /author|matchedInterests|generatedAt/);
});

test('children, busy agents, and malformed structural agents are ignored safely', async () => {
  const sink = new DshReminderSink(); const child = agent({ root: false }); const busy = agent({ status: 'running' });
  sink.observe(child, 'running'); await sink.notify([item]); assert.equal(child.messages.length, 0);
  sink.observe(busy, 'running'); await sink.notify([item]); assert.equal(busy.messages.length, 0);
  busy.status = 'idle'; sink.observe(busy, 'idle'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(busy.messages.length, 1);
  sink.observe({ root: true, status: 'idle', createUserMessage: 'bad', followup: () => {} }, 'running');
  await sink.notify([item]);
});

test('notice content is bounded and contains no provider errors or credential-shaped text', async () => {
  const sink = new DshReminderSink(); const target = agent(); sink.observe(target, 'running');
  const unsafe = { ...item, topic: { ...item.topic, title: `token=FAKE_LONG_VALUE_12345678 ${'x'.repeat(2000)}` },
    reason: `private provider error ${'y'.repeat(4000)}` };
  await sink.notify([unsafe]);
  const serialized = JSON.stringify(target.messages[0]);
  assert.ok(Buffer.byteLength(serialized) < 5000);
  assert.doesNotMatch(serialized, /FAKE_LONG_VALUE|private provider error/);
});
