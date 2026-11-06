import assert from 'node:assert/strict';
import test from 'node:test';
import { DshHistoryReader } from '../src/history.js';

test('reads only bounded user-authored plain text in newest order', async () => {
  const calls: unknown[] = [];
  const query = {
    async listSessions() { calls.push('list'); return [{ id: 'old', updatedAt: '2026-01-01' }, { id: 'new', updatedAt: '2026-02-01' }]; },
    async filterEvents(id: string, filters: unknown) {
      calls.push([id, filters]);
      return id === 'new' ? [
        { type: 'user/message', timestamp: 3, content: [{ type: 'text', text: 'Rust 😀' }] },
        { type: 'user/message', timestamp: 2, role: 'assistant', content: [{ type: 'text', text: 'secret' }] },
        { type: 'user/message', timestamp: 1, content: [{ type: 'image', text: 'attachment' }] },
        { type: 'user/message', source: { kind: 'tool' }, content: [{ type: 'text', text: 'token' }] },
      ] : [{ type: 'user/message', content: [{ type: 'text', text: 'old' }] }];
    },
  };
  const result = await new DshHistoryReader(() => query).readEligibleUserText({ maxSessions: 1, maxBytes: 100 });
  assert.equal(result, 'Rust 😀');
  assert.deepEqual(calls, ['list', ['new', [{ kind: 'type', values: ['user/message'] }]]]);
});

test('caps UTF-8 per message and total; late service and abort are handled', async () => {
  let query: unknown;
  const reader = new DshHistoryReader(() => query);
  await assert.rejects(reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), { code: 'history_access_denied' });
  query = { async listSessions() { return [{ id: 's' }]; }, async filterEvents() {
    return Array.from({ length: 1000 }, () => ({ type: 'user/message', content: [{ type: 'text', text: '😀'.repeat(1000) }] }));
  } };
  const result = await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 });
  assert.ok(Buffer.byteLength(result) <= 100);
  assert.ok(!result.includes('\uFFFD'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }, controller.signal), { code: 'timeout' });
});

test('abort after session listing prevents event access', async () => {
  const controller = new AbortController();
  let filtered = 0;
  const reader = new DshHistoryReader(() => ({ async listSessions() { controller.abort(); return [{ id: 's' }]; },
    async filterEvents() { filtered++; return []; } }));
  await assert.rejects(reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }, controller.signal), { code: 'timeout' });
  assert.equal(filtered, 0);
});

test('numeric event timestamps sort newest first and duplicate text is omitted', async () => {
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [
      { type: 'user/message', timestamp: 2, content: [{ type: 'text', text: 'older' }] },
      { type: 'user/message', timestamp: 10, content: [{ type: 'text', text: 'newer' }] },
      { type: 'user/message', timestamp: 1, content: [{ type: 'text', text: 'newer' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'newer\nolder');
});
