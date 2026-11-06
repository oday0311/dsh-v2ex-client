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

test('punctuated provenance and credentials split across text blocks are omitted', async () => {
  const events = [
    { type: 'user/message', source: 'assistant.message', content: [{ type: 'text', text: 'private context' }] },
    { type: 'user/message', role: 'system:prompt', content: [{ type: 'text', text: 'private context' }] },
    { type: 'user/message', origin: 'bot@worker', content: [{ type: 'text', text: 'private context' }] },
    { type: 'user/message', content: [
      { type: 'text', text: 'private context token' }, { type: 'text', text: '=' },
      { type: 'text', text: 'FAKE_LONG_VALUE_12345678' },
    ] },
    { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
  ];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return events; } }));
  const result = await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 });
  assert.ok(!result.includes('private context'));
  assert.ok(result.includes('safe user text'));
});

test('oversized blocks and aggregate message bytes are rejected rather than truncated', async () => {
  const events = [
    { type: 'user/message', content: [{ type: 'text', text: 'private context' + 'x'.repeat(5000) }] },
    { type: 'user/message', content: [{ type: 'text', text: 'private context' + 'x'.repeat(2500) },
      { type: 'text', text: 'y'.repeat(2500) }] },
    { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
  ];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return events; } }));
  const result = await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 });
  assert.ok(!result.includes('private context'));
  assert.ok(result.includes('safe user text'));
});

test('unlabeled canonical UUID-shaped credentials discard the entire message', async () => {
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [
      { type: 'user/message', content: [{ type: 'text', text: 'private context 11111111-2222-4333-8444-555555555555' }] },
      { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
});

test('oversized strings are rejected before UTF-8 byte scanning', async () => {
  const oversized = 'x'.repeat(20_000);
  const original = Buffer.byteLength;
  let scannedOversized = false;
  Buffer.byteLength = ((value: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    if (value === oversized) scannedOversized = true;
    return original(value as string, ...(rest as [BufferEncoding]));
  }) as typeof Buffer.byteLength;
  try {
    const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
      async filterEvents() { return [
        { type: 'user/message', content: [{ type: 'text', text: oversized }] },
        { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
      ]; } }));
    assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
    assert.equal(scannedOversized, false);
  } finally { Buffer.byteLength = original; }
});

test('llm provenance aliases are excluded at direct and nested punctuation boundaries', async () => {
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [
      { type: 'user/message', role: 'llm', content: [{ type: 'text', text: 'private direct' }] },
      { type: 'user/message', source: { type: 'llm.message' }, content: [{ type: 'text', text: 'private nested' }] },
      { type: 'user/message', origin: 'worker:llm@host', content: [{ type: 'text', text: 'private punctuated' }] },
      { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
});

test('oversized provenance is rejected before regex scanning', async () => {
  const oversized = 'x'.repeat(20_000);
  const original = RegExp.prototype.test;
  let scannedOversized = false;
  RegExp.prototype.test = function (value: string) {
    if (value === oversized) scannedOversized = true;
    return original.call(this, value);
  };
  try {
    const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
      async filterEvents() { return [
        { type: 'user/message', role: oversized, content: [{ type: 'text', text: 'private context' }] },
        { type: 'user/message', source: { type: oversized }, content: [{ type: 'text', text: 'private nested' }] },
        { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
      ]; } }));
    assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
    assert.equal(scannedOversized, false);
  } finally { RegExp.prototype.test = original; }
});
