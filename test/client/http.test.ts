import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createV2exHttpClient, V2exClientError } from '../../src/client/http.js';

test('transport uses same-origin routes and typed envelopes', async () => {
  const calls: string[] = [];
  const client = createV2exHttpClient(async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, data: { authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null } }));
  });
  assert.equal((await client.session()).authenticated, false);
  assert.deepEqual(calls, ['/api/v2ex/session']);
});

test('transport exposes only stable public errors and supports cancellation', async () => {
  const client = createV2exHttpClient(async (_input, init) => {
    assert.equal(init?.signal?.aborted, false);
    return new Response(JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'upstream secret', retryable: true } }), { status: 429 });
  });
  await assert.rejects(client.latest(1, new AbortController().signal), (error: unknown) =>
    error instanceof V2exClientError && error.code === 'rate_limited' && !error.message.includes('secret'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.latest(1, controller.signal), (error: unknown) =>
    error instanceof V2exClientError && error.code === 'cancelled');
});

test('transport never exposes response messages from malformed errors', async () => {
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: false, error: { code: 'unknown', message: 'sensitive upstream payload' } }), { status: 502 }));
  await assert.rejects(client.hot(), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response' && !error.message.includes('sensitive'));
});

test('abort during response decoding remains a cancellation', async () => {
  const controller = new AbortController();
  const client = createV2exHttpClient(async () => ({
    ok: true,
    json: async () => { controller.abort(); throw new Error('read stopped'); },
  }) as Response);
  await assert.rejects(client.hot(controller.signal), (error: unknown) => error instanceof V2exClientError && error.code === 'cancelled');
});
