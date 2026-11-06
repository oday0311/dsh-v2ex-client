import assert from 'node:assert/strict';
import test from 'node:test';
import { V2exError } from '../src/errors.js';
import { V2exApi } from '../src/v2ex-api.js';
import { MEMBER_OK, NODE_OK, REPLIES_OK, TOKEN, TOKEN_OK, TOPIC_OK, TOPICS_OK } from './fixtures/v2ex.js';
import { jsonResponse, recordingFetch } from './helpers/fakes.js';

const options = (fetch: typeof globalThis.fetch) => ({ fetch, timeoutMs: 100, responseLimitBytes: 100_000 });
const errorCode = (code: string) => (error: unknown) => error instanceof V2exError && error.code === code;

test('all read methods send authenticated GET requests to official API paths', async () => {
  const fixtureByPath: Record<string, unknown> = {
    '/api/v2/token': TOKEN_OK,
    '/api/v2/member': MEMBER_OK,
    '/api/v2/topics/latest?p=2': TOPICS_OK,
    '/api/v2/topics/hot': TOPICS_OK,
    '/api/v2/nodes/python': NODE_OK,
    '/api/v2/nodes/python/topics?p=2': TOPICS_OK,
    '/api/v2/topics/123': TOPIC_OK,
    '/api/v2/topics/123/replies?p=2': REPLIES_OK,
  };
  const transport = recordingFetch((url) => jsonResponse(fixtureByPath[url.pathname + url.search]));
  const api = new V2exApi(options(transport.fetch));
  const signal = AbortSignal.timeout(1000);
  assert.equal((await api.readToken(TOKEN, signal)).scope, 'everything');
  assert.equal((await api.readMember(TOKEN, signal)).username, 'alice');
  assert.equal((await api.latest(2, TOKEN, signal))[0]?.id, 123);
  assert.equal((await api.hot(TOKEN, signal))[0]?.id, 123);
  assert.equal((await api.node('python', TOKEN, signal)).name, 'python');
  assert.equal((await api.nodeTopics('python', 2, TOKEN, signal))[0]?.id, 123);
  assert.equal((await api.topic(123, TOKEN, signal)).id, 123);
  assert.equal((await api.replies(123, 2, TOKEN, signal))[0]?.id, 12);
  assert.deepEqual(transport.calls.map(({ url }) => new URL(url).pathname + new URL(url).search), Object.keys(fixtureByPath));
  for (const { url, init } of transport.calls) {
    assert.equal(new URL(url).origin, 'https://www.v2ex.com');
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(init.redirect, 'error');
  }
});

test('path validation rejects traversal and malformed pagination before fetch', async () => {
  const transport = recordingFetch(jsonResponse(TOPIC_OK));
  const api = new V2exApi(options(transport.fetch));
  await assert.rejects(api.node('../token', TOKEN), errorCode('invalid_request'));
  await assert.rejects(api.topic('123/../../token', TOKEN), errorCode('invalid_request'));
  await assert.rejects(api.latest(0, TOKEN), errorCode('invalid_request'));
  assert.equal(transport.calls.length, 0);
});

test('malformed JSON and malformed API envelopes fail without returning raw data', async () => {
  for (const response of [new Response('{secret payload'), jsonResponse({ result: { surprise: 'secret payload' } })]) {
    const api = new V2exApi(options(recordingFetch(response).fetch));
    await assert.rejects(api.topic(123, TOKEN), (error: unknown) =>
      errorCode('invalid_response')(error) && !JSON.stringify(error).includes('secret payload'));
  }
});

test('oversized streaming responses are rejected before JSON parsing', async () => {
  const api = new V2exApi({ ...options(async () => new Response('x'.repeat(101))), responseLimitBytes: 100 });
  await assert.rejects(api.topic(123, TOKEN), errorCode('invalid_response'));
});

test('HTTP errors map to stable codes without echoing upstream messages', async () => {
  const cases: Array<[number, unknown, string]> = [
    [200, { success: false, message: 'Token expired: secret payload' }, 'token_expired'],
    [200, { success: false, message: 'Invalid token: secret payload' }, 'token_invalid'],
    [401, { success: false, message: 'Token expired: secret payload' }, 'token_expired'],
    [401, { success: false, message: 'Invalid token: secret payload' }, 'token_invalid'],
    [404, { success: false, message: 'secret payload' }, 'not_found'],
    [429, { success: false, message: 'secret payload' }, 'rate_limited'],
    [503, { success: false, message: 'secret payload' }, 'upstream'],
  ];
  for (const [status, body, code] of cases) {
    const api = new V2exApi(options(recordingFetch(jsonResponse(body, status)).fetch));
    await assert.rejects(api.topic(123, TOKEN), (error: unknown) =>
      errorCode(code)(error) && !JSON.stringify(error).includes('secret payload'));
  }
});

test('a successful token envelope without token metadata cannot authenticate', async () => {
  const api = new V2exApi(options(recordingFetch(jsonResponse({ success: true, result: {} })).fetch));
  await assert.rejects(api.readToken(TOKEN), errorCode('invalid_response'));
});

test('an impossible token expiration is rejected before account status conversion', async () => {
  const api = new V2exApi(options(recordingFetch(jsonResponse({
    success: true, result: { scope: 'everything', expiration: 9_007_199_254_740_991 },
  })).fetch));
  await assert.rejects(api.readToken(TOKEN), errorCode('invalid_response'));
});

test('non-JSON rate-limit and missing-resource responses preserve their HTTP error codes', async () => {
  for (const [status, code] of [[429, 'rate_limited'], [404, 'not_found']] as const) {
    const api = new V2exApi(options(recordingFetch(new Response('<html>secret payload</html>', { status })).fetch));
    await assert.rejects(api.topic(123, TOKEN), (error: unknown) =>
      errorCode(code)(error) && !JSON.stringify(error).includes('secret payload'));
  }
});

test('response headers update the observed rate limit state', async () => {
  const transport = recordingFetch(jsonResponse(TOPIC_OK, 200, {
    'x-rate-limit-limit': '600', 'x-rate-limit-remaining': '37', 'x-rate-limit-reset': '1900000000',
  }));
  const api = new V2exApi(options(transport.fetch));
  await api.topic(123, TOKEN);
  assert.deepEqual(api.rateLimit, { limit: 600, remaining: 37, resetAt: '2030-03-17T17:46:40.000Z' });
});

test('out-of-range rate-limit reset leaves reset time unknown', async () => {
  const transport = recordingFetch(jsonResponse(TOPIC_OK, 200, {
    'x-rate-limit-limit': '600', 'x-rate-limit-remaining': '37',
    'x-rate-limit-reset': '9007199254740991',
  }));
  const api = new V2exApi(options(transport.fetch));
  await api.topic(123, TOKEN);
  assert.deepEqual(api.rateLimit, { limit: 600, remaining: 37, resetAt: null });
});

test('timeout aborts the request and reports a stable timeout code', async () => {
  const api = new V2exApi({ ...options((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })), timeoutMs: 5 });
  await assert.rejects(api.topic(123, TOKEN), errorCode('timeout'));
});
