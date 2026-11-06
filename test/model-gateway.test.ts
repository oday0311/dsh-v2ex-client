import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { DshModelGateway } from '../src/model-gateway.js';

const schema = z.strictObject({ answer: z.string().min(1) });
const request = { system: 'fixed', userData: '{"topic":"data"}', schema, maxInputBytes: 100, maxOutputTokens: 50, tools: [] as [] };

function fixture(chunks: unknown[]) {
  let selection = { provider: 'provider-a', model: 'model-a' };
  const calls: unknown[] = [];
  const gateway = new DshModelGateway({
    agentDefaultModel: { currentSelection: () => selection },
    llm: { async *stream(options: unknown) { calls.push(options); for (const chunk of chunks) yield chunk; } },
  } as never);
  return { gateway, calls, select(value: { provider: string; model: string }) { selection = value; } };
}

const textChunks = (value: string): unknown[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];

test('resolves the selected route on each operation and sends only data in a user message', async () => {
  const f = fixture(textChunks('{"answer":"yes"}'));
  assert.deepEqual(await f.gateway.completeJson(request), { answer: 'yes' });
  f.select({ provider: 'provider-b', model: 'model-b' });
  await f.gateway.completeJson(request);
  assert.deepEqual((f.calls as Array<{ provider: string; model: string }>).map(({ provider, model }) => [provider, model]),
    [['provider-a', 'model-a'], ['provider-b', 'model-b']]);
  const call = f.calls[0] as { system: string; messages: Array<{ content: unknown }>; tools: unknown[]; maxTokens: number };
  assert.equal(call.system, 'fixed');
  assert.deepEqual(call.messages, [{ role: 'user', content: [{ type: 'text', text: request.userData }] }]);
  assert.deepEqual(call.tools, []);
  assert.equal(call.maxTokens, 50);
});

test('rejects non-text blocks, multiple JSON values, prose, schema errors and output overflow', async () => {
  for (const chunks of [
    [{ type: 'block-start', index: 0, blockType: 'tool-call' }, ...textChunks('{"answer":"yes"}')],
    textChunks('{"answer":"yes"}{"answer":"no"}'), textChunks('Here: {"answer":"yes"}'),
    textChunks('{"answer":1}'), textChunks('{"answer":"' + 'x'.repeat(100_000) + '"}'),
    textChunks('{"answer":"\ud800"}'),
  ]) await assert.rejects(fixture(chunks).gateway.completeJson(request), { code: 'invalid_response' });
});

test('joins sequential documented text blocks', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '{"answer":' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '{"answer":' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '"yes"}' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '"yes"}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  assert.deepEqual(await fixture(chunks).gateway.completeJson(request), { answer: 'yes' });
});

test('assembles interleaved text blocks in block-index order', async () => {
  const chunks = [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '"yes"}' },
    { type: 'text-delta', index: 0, text: '{"answer":' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '"yes"}' } },
    { type: 'block-end', index: 0, block: { type: 'text', text: '{"answer":' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  assert.deepEqual(await fixture(chunks).gateway.completeJson(request), { answer: 'yes' });
});

test('rejects malformed interleaved block lifecycles', async () => {
  const start = { type: 'block-start', index: 0, blockType: 'text' };
  const end = { type: 'block-end', index: 0, block: { type: 'text', text: '{"answer":"yes"}' } };
  const delta = { type: 'text-delta', index: 0, text: '{"answer":"yes"}' };
  const finish = { type: 'finish', reason: { kind: 'stop' } };
  for (const chunks of [
    [start, start, delta, end, finish], [delta, start, end, finish],
    [start, delta, { ...end, block: { type: 'text', text: 'wrong' } }, finish],
    [start, delta, finish], [start, delta, end, start, finish],
    [start, delta, end, finish, delta],
  ]) await assert.rejects(fixture(chunks).gateway.completeJson(request), { code: 'invalid_response' });
});

test('rejects escaped lone surrogates in parsed strings, keys and schema transforms', async () => {
  const nested = z.strictObject({ nested: z.record(z.string(), z.string()) });
  for (const value of ['{"nested":{"key":"\\ud800"}}', '{"nested":{"\\ud800":"ok"}}']) {
    await assert.rejects(fixture(textChunks(value)).gateway.completeJson({ ...request, schema: nested }), { code: 'invalid_response' });
  }
  const transformed = z.strictObject({ answer: z.string() }).transform(() => ({ answer: '\ud800' }));
  await assert.rejects(fixture(textChunks('{"answer":"ok"}')).gateway.completeJson({ ...request, schema: transformed }), { code: 'invalid_response' });
});

test('deep parsed JSON fails with a stable error instead of overflowing Unicode validation', async () => {
  const deep = '['.repeat(3000) + '0' + ']'.repeat(3000);
  await assert.rejects(fixture(textChunks(deep)).gateway.completeJson({ ...request,
    schema: z.unknown() }), { code: 'invalid_response' });
});

test('maps missing services/provider failures and abort without leaking details', async () => {
  await assert.rejects(new DshModelGateway({} as never).completeJson(request), { code: 'ai_unavailable' });
  await assert.rejects(fixture([{ type: 'finish', reason: { kind: 'error', failure: { message: 'secret' } } }]).gateway.completeJson(request),
    (error: unknown) => (error as Error).message.includes('secret') === false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture(textChunks('{"answer":"yes"}')).gateway.completeJson({ ...request, signal: controller.signal }), { code: 'timeout' });
});
