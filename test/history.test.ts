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

test('provenance wrappers inspect every bounded string leaf', async () => {
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [
      { type: 'user/message', source: { name: 'llm.message' }, content: [{ type: 'text', text: 'private llm' }] },
      { type: 'user/message', role: { name: 'assistant' }, content: [{ type: 'text', text: 'private role' }] },
      { type: 'user/message', author: [{ label: 'tool.call' }], content: [{ type: 'text', text: 'private tool' }] },
      { type: 'user/message', source: { name: 'user', detail: ['human'] }, content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
});

test('hostile sorting metadata is rejected before conversion or accessor invocation', async () => {
  let conversions = 0;
  let getterCalls = 0;
  const maliciousId = { toString() { conversions++; return 'x'; } };
  const getterEvent = { type: 'user/message', content: [{ type: 'text', text: 'private getter' }],
    get timestamp() { getterCalls++; return 9; } };
  const events = [
    { type: 'user/message', id: maliciousId, content: [{ type: 'text', text: 'private id' }] },
    { type: 'user/message', id: 'x'.repeat(20_000), content: [{ type: 'text', text: 'private oversized id' }] },
    { type: 'user/message', timestamp: { toString() { conversions++; return '2026-01-01'; } },
      content: [{ type: 'text', text: 'private time' }] },
    getterEvent,
    { type: 'user/message', id: 'safe', timestamp: 10, content: [{ type: 'text', text: 'safe user text' }] },
  ];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return events; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
  assert.equal(conversions, 0);
  assert.equal(getterCalls, 0);
});

test('session metadata accessors and custom IDs are never invoked', async () => {
  let conversions = 0;
  let getterCalls = 0;
  const sessions = [
    { id: { toString() { conversions++; return 'hostile'; } }, updatedAt: 10 },
    { id: 'accessor', get updatedAt() { getterCalls++; return 10; } },
    { id: 'safe', updatedAt: 1 },
  ];
  const filtered: string[] = [];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return sessions; },
    async filterEvents(id: string) { filtered.push(id); return [
      { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
  assert.deepEqual(filtered, ['safe']);
  assert.equal(conversions, 0);
  assert.equal(getterCalls, 0);
});

test('hostile provenance subtrees fail bounded plain-data validation', async () => {
  let getterCalls = 0;
  const cycle: Record<string, unknown> = { name: 'user' };
  cycle.loop = cycle;
  const getter = { get name() { getterCalls++; return 'user'; } };
  const deep = { next: { next: { next: { next: { next: { next: { name: 'user' } } } } } } };
  const events = [
    { type: 'user/message', source: cycle, content: [{ type: 'text', text: 'private cycle' }] },
    { type: 'user/message', source: getter, content: [{ type: 'text', text: 'private getter' }] },
    { type: 'user/message', source: deep, content: [{ type: 'text', text: 'private depth' }] },
    { type: 'user/message', source: Array(257).fill('user'), content: [{ type: 'text', text: 'private count' }] },
    { type: 'user/message', source: { ['x'.repeat(257)]: 'user' }, content: [{ type: 'text', text: 'private key' }] },
    { type: 'user/message', source: { name: 'x'.repeat(257) }, content: [{ type: 'text', text: 'private leaf' }] },
    { type: 'user/message', source: { name: 'user', confidence: 1 }, content: [{ type: 'text', text: 'private nontext' }] },
    { type: 'user/message', source: ['user', , 'human'], content: [{ type: 'text', text: 'private sparse' }] },
    { type: 'user/message', source: {}, content: [{ type: 'text', text: 'private empty source' }] },
    { type: 'user/message', source: [], content: [{ type: 'text', text: 'private empty array' }] },
    { type: 'user/message', source: { name: 'user' }, content: [{ type: 'text', text: 'safe user text' }] },
  ];
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return events; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
  assert.equal(getterCalls, 0);
});

test('explicit provenance wrappers reject nested non-user leaves', async () => {
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [
      { type: 'user/message', provenance: { name: 'assistant.message' }, content: [{ type: 'text', text: 'private direct' }] },
      { type: 'user/message', data: { message: { provenance: [{ detail: { label: 'llm:worker' } }],
        content: [{ type: 'text', text: 'private nested' }] } } },
      { type: 'user/message', provenance: { name: 'user', detail: ['human'] },
        content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
});

test('host-returned arrays are validated before any indexed read', async () => {
  for (const stage of ['sessions', 'events'] as const) {
    let getterCalls = 0;
    const unsafe = [{ id: 's' }, { id: 'safe' }] as unknown[];
    Object.defineProperty(unsafe, '0', { get() { getterCalls++; return { id: 's' }; }, enumerable: true });
    const reader = new DshHistoryReader(() => ({
      async listSessions() { return stage === 'sessions' ? unsafe : [{ id: 's' }]; },
      async filterEvents() { return stage === 'events' ? unsafe : []; },
    }));
    await assert.rejects(reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), { code: 'history_access_denied' });
    assert.equal(getterCalls, 0);
  }
});

test('host-returned arrays reject sparse, extra, oversized, and wrapped accessor shapes', async () => {
  for (const unsafe of [Array(2), Object.assign([{ id: 's' }], { extra: 'x' }),
    Array.from({ length: 1001 }, () => ({ id: 's' })),
    Object.setPrototypeOf([{ id: 's' }], Object.create(Array.prototype))]) {
    const reader = new DshHistoryReader(() => ({ async listSessions() { return unsafe; }, async filterEvents() { return []; } }));
    await assert.rejects(reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), { code: 'history_access_denied' });
  }
  let getterCalls = 0;
  const wrapper = { get sessions() { getterCalls++; return [{ id: 's' }]; } };
  const reader = new DshHistoryReader(() => ({ async listSessions() { return wrapper; }, async filterEvents() { return []; } }));
  await assert.rejects(reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), { code: 'history_access_denied' });
  assert.equal(getterCalls, 0);
  const eventsWrapper = { get events() { getterCalls++; return []; } };
  const eventsReader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return eventsWrapper; } }));
  await assert.rejects(eventsReader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), { code: 'history_access_denied' });
  assert.equal(getterCalls, 0);
});

test('unknown hidden and symbol metadata is ignored without reading it', async () => {
  let getterCalls = 0;
  const block = { type: 'text', text: 'safe user text' };
  Object.defineProperty(block, 'metadata', { get() { getterCalls++; return { note: 'hidden' }; } });
  Object.defineProperty(block, Symbol('extra'), { get() { getterCalls++; return 'hidden'; } });
  const sessions = [{ id: 's' }];
  Object.defineProperty(sessions, Symbol('extra'), { get() { getterCalls++; return 'hidden'; } });
  const reader = new DshHistoryReader(() => ({ async listSessions() { return sessions; },
    async filterEvents() { return [{ type: 'user/message', content: [block] }]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
  assert.equal(getterCalls, 0);
});

test('known hidden provenance and consumed fields are rejected without invoking getters', async () => {
  let getterCalls = 0;
  const hiddenSource = { type: 'user/message', content: [{ type: 'text', text: 'private source' }] };
  Object.defineProperty(hiddenSource, 'provenance', { get() { getterCalls++; return { name: 'assistant' }; } });
  const hiddenText = { type: 'text' };
  Object.defineProperty(hiddenText, 'text', { get() { getterCalls++; return 'private text'; } });
  const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
    async filterEvents() { return [hiddenSource,
      { type: 'user/message', content: [hiddenText] },
      { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
    ]; } }));
  assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
  assert.equal(getterCalls, 0);
});

test('too-wide objects are rejected without whole-key materialization', async () => {
  const wide = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field${index}`, 'user']));
  const original = Reflect.ownKeys;
  let wideMaterialized = false;
  Reflect.ownKeys = function (value: object) {
    if (value === wide) wideMaterialized = true;
    return original(value);
  };
  try {
    const reader = new DshHistoryReader(() => ({ async listSessions() { return [{ id: 's' }]; },
      async filterEvents() { return [
        { type: 'user/message', provenance: wide, content: [{ type: 'text', text: 'private context' }] },
        { type: 'user/message', content: [{ type: 'text', text: 'safe user text' }] },
      ]; } }));
    assert.equal(await reader.readEligibleUserText({ maxSessions: 1, maxBytes: 100 }), 'safe user text');
    assert.equal(wideMaterialized, false);
  } finally { Reflect.ownKeys = original; }
});
