import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createV2exHttpClient, V2exClientError } from '../../src/client/http.js';

test('transport uses same-origin routes and typed envelopes', async () => {
  const calls: string[] = [];
  const client = createV2exHttpClient(async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, data: { authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null } }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  });
  assert.equal((await client.session()).authenticated, false);
  assert.deepEqual(calls, ['/api/v2ex/session']);
});

test('transport exposes only stable public errors and supports cancellation', async () => {
  const client = createV2exHttpClient(async (_input, init) => {
    assert.equal(init?.signal?.aborted, false);
    return new Response(JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'upstream secret', retryable: true } }), { status: 429, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(client.latest(1, new AbortController().signal), (error: unknown) =>
    error instanceof V2exClientError && error.code === 'rate_limited' && !error.message.includes('secret'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.latest(1, controller.signal), (error: unknown) =>
    error instanceof V2exClientError && error.code === 'cancelled');
});

test('transport never exposes response messages from malformed errors', async () => {
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: false, error: { code: 'unknown', message: 'sensitive upstream payload' } }), { status: 502, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.hot(), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response' && !error.message.includes('sensitive'));
});

test('abort during response decoding remains a cancellation', async () => {
  const controller = new AbortController();
  const client = createV2exHttpClient(async () => new Response(new ReadableStream({
    pull() { controller.abort(); throw new Error('read stopped'); },
  }), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.hot(controller.signal), (error: unknown) => error instanceof V2exClientError && error.code === 'cancelled');
});

test('transport rejects JSON behind an HTML content type', async () => {
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: true, data: { authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null } }), { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(client.session(), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response');
});

test('transport rejects an oversized streamed envelope before exposing data', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, data: { authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null }, padding: 'x'.repeat(257 * 1024) }));
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 100)); controller.enqueue(bytes.subarray(100)); controller.close(); } });
  const client = createV2exHttpClient(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.session(), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response');
});

test('transport rejects malformed nested topic, node, and reply DTOs', async () => {
  const fake = (data: unknown) => createV2exHttpClient(async () => new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } }));
  const freshness = { fetchedAt: '2026-11-06T00:00:00.000Z', stale: false, source: 'network' };
  await assert.rejects(fake({ ...freshness, value: { items: [{ id: 'wrong' }], page: 1, hasMore: false, stale: false } }).latest(1), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response');
  await assert.rejects(fake({ ...freshness, value: { name: 'dev', title: '开发', topicCount: -1, url: 'https://www.v2ex.com/go/dev' } }).node('dev'), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response');
  await assert.rejects(fake({ ...freshness, value: [{ id: 1, author: { username: 'alice' }, content: 123, createdAt: 'invalid' }] }).replies('7', 1), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response');
  await assert.rejects(fake({ authenticated: true, writable: false, username: 'reader', tokenScope: 'read', expiresAt: 'invalid' }).session(), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response');
});

test('transport validates error envelope fields without returning server text', async () => {
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: false, error: { code: 'offline', message: 'secret', retryable: 'yes' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.hot(), (error: unknown) => error instanceof V2exClientError && error.code === 'invalid_response' && !error.message.includes('secret'));
});

test('successful login cannot echo the submitted token into account state', async () => {
  const secret = 'replacement-secret';
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: true, data: {
    authenticated: true, writable: false, username: `reader-${secret}`, tokenScope: 'read', expiresAt: null,
  } }), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.login(secret), (error: unknown) =>
    error instanceof V2exClientError && error.code === 'invalid_response' && !error.message.includes(secret));
});

test('login rejects an unauthenticated account inside a successful envelope', async () => {
  const client = createV2exHttpClient(async () => new Response(JSON.stringify({ ok: true, data: {
    authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null,
  } }), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.login('test-secret'), (error: unknown) =>
    error instanceof V2exClientError && error.code === 'invalid_response');
});
