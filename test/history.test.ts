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

test('rejects inherited and nested non-user provenance, cycles, tools, and attachments', async () => {
  const inherited = Object.assign(Object.create({ type: 'user/message' }),
    { content: [{ type: 'text', text: 'INHERITED_MARKER' }] });
  const cyclic: Record<string, unknown> = { type: 'user/message', content: [{ type: 'text', text: 'CYCLE_MARKER' }] };
  cyclic.metadata = cyclic;
  const events = [inherited, cyclic,
    { type: 'user/message', source: { type: 'assistant' }, content: [{ type: 'text', text: 'SOURCE_MARKER' }] },
    { type: 'user/message', role: 'bot', content: [{ type: 'text', text: 'BOT_MARKER' }] },
    { type: 'user/message', data: { message: { actor: { kind: 'plugin' }, content: [{ type: 'text', text: 'PLUGIN_MARKER' }] } } },
    { type: 'user/message', content: [{ type: 'text', text: 'TOOL_MARKER' }], metadata: { toolCall: {} } },
    { type: 'user/message', content: [{ type: 'text', text: 'ATTACHMENT_MARKER' }], attachment: {} },
    ...(['origin', 'author', 'sender', 'kind'] as const).map(key =>
      ({ type: 'user/message', [key]: { type: 'model' }, content: [{ type: 'text', text: 'PROVENANCE_MARKER' }] })),
    { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
  ];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return events; } }));
  const result = await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 500 });
  assert.equal(result, 'safe user text');
});

test('drops whole credential-bearing messages before text accumulation', async () => {
  const messages = [
    'private context V2EX_PERSONAL_ACCESS_TOKEN=FAKE_LONG_VALUE_12345678',
    'private context Authorization: Bearer FAKE_LONG_VALUE_12345678',
    'private context api_key: FAKE_LONG_VALUE_12345678',
    'private context password=FAKE_LONG_VALUE_12345678',
    'private context secret=FAKE_LONG_VALUE_12345678',
    'private context password="FAKE LONG VALUE PHRASE"',
    'private context token=00000000-1111-2222-3333-444444444444',
    'safe user text',
  ];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return messages.map(text => ({ type: 'user/message', content: [{ type: 'text', text }] })); } }));
  const result = await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 20 });
  assert.ok(!result.includes('private context'));
  assert.ok(result.includes('safe user text'));
  assert.ok(Buffer.byteLength(result) <= 20);
});

test('credentials after the text cap or block limit cannot leave a partial message', async () => {
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [
      { type: 'user/message', content: [
        { type: 'text', text: 'private context '.repeat(400) },
        { type: 'text', text: 'token=FAKE_LONG_VALUE_12345678' },
      ] },
      { type: 'user/message', content: Array.from({ length: 33 }, () => ({ type: 'text', text: 'private context' })) },
      { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  const result = await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 });
  assert.ok(!result.includes('private context'));
  assert.ok(result.includes('safe user text'));
});
