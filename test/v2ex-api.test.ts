import assert from 'node:assert/strict';
import test from 'node:test';
import { V2exError } from '../src/errors.js';
import { V2exApi } from '../src/v2ex-api.js';
import { MEMBER_OK, NODE_OK, REPLIES_OK, TAB_HTML, TOKEN, TOKEN_OK, TOPIC, TOPIC_OK } from './fixtures/v2ex.js';
import { jsonResponse, recordingFetch } from './helpers/fakes.js';

const options = (fetch: typeof globalThis.fetch) => ({ fetch, timeoutMs: 100, responseLimitBytes: 100_000 });
const errorCode = (code: string) => (error: unknown) => error instanceof V2exError && error.code === code;
const feed = (count: number, start = 100) =>
  Array.from({ length: count }, (_, index) => ({ ...TOPIC, id: start + index, deleted: 0 }));

test('all read methods send authenticated GET requests to official API paths', async () => {
  const latestFeed = feed(25);
  const fixtureByPath: Record<string, unknown> = {
    '/api/v2/token': TOKEN_OK,
    '/api/v2/member': MEMBER_OK,
    '/api/topics/latest.json': latestFeed,
    '/api/topics/hot.json': feed(3, 300),
    '/api/v2/nodes/python': NODE_OK,
    '/api/topics/show.json?node_name=python': feed(4, 400),
    '/api/v2/topics/123': TOPIC_OK,
    '/api/v2/topics/123/replies?p=2': REPLIES_OK,
  };
  const transport = recordingFetch((url) => jsonResponse(fixtureByPath[url.pathname + url.search]));
  const api = new V2exApi(options(transport.fetch));
  const signal = AbortSignal.timeout(1000);
  assert.equal((await api.readToken(TOKEN, signal)).scope, 'everything');
  assert.equal((await api.readMember(TOKEN, signal)).username, 'alice');
  assert.equal((await api.latest(2, TOKEN, signal))[0]?.id, 120);
  assert.equal((await api.hot(TOKEN, signal))[0]?.id, 300);
  assert.equal((await api.node('python', TOKEN, signal)).name, 'python');
  assert.equal((await api.nodeTopics('python', 1, TOKEN, signal))[0]?.id, 400);
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

test('list feeds use the public endpoints because API 2.0 exposes no latest or hot list', async () => {
  const topics = feed(25, 200);
  const transport = recordingFetch((url) => {
    const path = url.pathname + url.search;
    if (path === '/api/topics/latest.json') return jsonResponse(topics);
    if (path === '/api/topics/hot.json') return jsonResponse(topics.slice(0, 10));
    if (path === '/api/topics/show.json?node_name=python') return jsonResponse(topics.slice(0, 10));
    return jsonResponse({ success: false, message: 'unexpected' }, 404);
  });
  const api = new V2exApi(options(transport.fetch));

  assert.deepEqual((await api.latest(1, TOKEN)).map((value) => value.id), topics.slice(0, 20).map((value) => value.id));
  assert.deepEqual((await api.latest(2, TOKEN)).map((value) => value.id), topics.slice(20).map((value) => value.id));
  assert.deepEqual(await api.latest(3, TOKEN), []);
  assert.equal((await api.hot(TOKEN)).length, 10);
  assert.equal((await api.nodeTopics('python', 1, TOKEN)).length, 10);
  assert.deepEqual(await api.nodeTopics('python', 2, TOKEN), []);

  const paths = transport.calls.map(({ url }) => new URL(url).pathname + new URL(url).search);
  assert.deepEqual(paths, [
    '/api/topics/latest.json', '/api/topics/latest.json', '/api/topics/latest.json',
    '/api/topics/hot.json', '/api/topics/show.json?node_name=python',
  ]);
  assert.ok(paths.every((path) => !path.startsWith('/api/v2/topics/latest') && !path.startsWith('/api/v2/topics/hot')));
});

test('deleted feed topics never reach the panel', async () => {
  const topics = [{ ...TOPIC, id: 1, deleted: 0 }, { ...TOPIC, id: 2, deleted: 1 }];
  const transport = recordingFetch(jsonResponse(topics));
  const api = new V2exApi(options(transport.fetch));
  assert.deepEqual((await api.hot(TOKEN)).map((value) => value.id), [1]);
  assert.deepEqual((await api.latest(1, TOKEN)).map((value) => value.id), [1]);
});

test('feed failures keep stable error codes', async () => {
  for (const [response, code] of [
    [jsonResponse({ success: false, message: 'secret payload' }, 401), 'token_invalid'],
    [jsonResponse({ success: false, message: 'secret payload' }, 429), 'rate_limited'],
    [new Response('<html>secret payload</html>'), 'invalid_response'],
  ] as const) {
    const api = new V2exApi(options(recordingFetch(response).fetch));
    await assert.rejects(api.hot(TOKEN), (error: unknown) =>
      errorCode(code)(error) && !JSON.stringify(error).includes('secret payload'));
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

test('topic and replies accept decimal string IDs and request canonical official paths', async () => {
  const transport = recordingFetch((url) => jsonResponse(
    url.pathname.endsWith('/replies') ? REPLIES_OK : TOPIC_OK,
  ));
  const api = new V2exApi(options(transport.fetch));
  assert.equal((await api.topic('123', TOKEN)).id, 123);
  assert.equal((await api.replies('123', 2, TOKEN))[0]?.id, 12);
  assert.deepEqual(transport.calls.map(({ url }) => new URL(url).pathname + new URL(url).search), [
    '/api/v2/topics/123', '/api/v2/topics/123/replies?p=2',
  ]);
});

test('topic and replies reject malformed string IDs before any request', async () => {
  const transport = recordingFetch(jsonResponse(TOPIC_OK));
  const api = new V2exApi(options(transport.fetch));
  for (const id of ['+123', '-123', '1.5', '123/../../token', '9007199254740992']) {
    await assert.rejects(api.topic(id, TOKEN), errorCode('invalid_request'));
    await assert.rejects(api.replies(id, 2, TOKEN), errorCode('invalid_request'));
  }
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

test('tab topics are read from the official tab page', async () => {
  const transport = recordingFetch((url) => url.pathname === '/' && url.search === '?tab=tech'
    ? new Response(TAB_HTML, { headers: { 'content-type': 'text/html; charset=UTF-8' } })
    : jsonResponse({ success: false, message: 'unexpected' }, 404));
  const api = new V2exApi(options(transport.fetch));
  assert.deepEqual(await api.tabTopics('tech', TOKEN), [
    { id: 101, title: 'TypeScript & Node <guide>', node: { name: 'python', title: 'Python' },
      author: 'alice', replyCount: 3, activityAt: '2026-11-07T06:36:28.000Z' },
    { id: 102, title: 'A fresh topic', node: { name: 'dev', title: 'Dev' },
      author: 'carol', replyCount: 0, activityAt: '2026-11-07T05:00:00.000Z' },
  ]);
  const [{ url, init }] = transport.calls;
  assert.equal(new URL(url).origin, 'https://www.v2ex.com');
  assert.equal(new URL(url).pathname + new URL(url).search, '/?tab=tech');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${TOKEN}`);
  assert.equal(new Headers(init.headers).get('Accept'), 'text/html');
});

test('tab pages fail closed for unsupported tabs, non-HTML responses, and empty markup', async () => {
  const api = new V2exApi(options(recordingFetch(new Response(TAB_HTML, {
    headers: { 'content-type': 'text/html; charset=UTF-8' } })).fetch));
  await assert.rejects(api.tabTopics('xna', TOKEN), errorCode('invalid_request'));
  const wrongType = new V2exApi(options(recordingFetch(new Response(TAB_HTML, {
    headers: { 'content-type': 'application/json' } })).fetch));
  await assert.rejects(wrongType.tabTopics('tech', TOKEN), errorCode('invalid_response'));
  const empty = new V2exApi(options(recordingFetch(new Response('<html><body>maintenance</body></html>', {
    headers: { 'content-type': 'text/html' } })).fetch));
  await assert.rejects(empty.tabTopics('tech', TOKEN), errorCode('invalid_response'));
});

test('HTML pages never overwrite the rate-limit state learned from the JSON API', async () => {
  const transport = recordingFetch((url) => url.pathname === '/api/v2/token'
    ? jsonResponse(TOKEN_OK, 200, { 'x-rate-limit-limit': '600', 'x-rate-limit-remaining': '12' })
    : new Response(TAB_HTML, { headers: { 'content-type': 'text/html' } }));
  const api = new V2exApi(options(transport.fetch));
  await api.readToken(TOKEN);
  await api.tabTopics('creative', TOKEN);
  assert.deepEqual(api.rateLimit, { limit: 600, remaining: 12, resetAt: null });
});

test('the node catalog uses the public all-nodes feed', async () => {
  const transport = recordingFetch(jsonResponse([NODE_OK.result, { ...NODE_OK.result, id: 2, name: 'dev', title: 'Dev' }]));
  const api = new V2exApi(options(transport.fetch));
  assert.deepEqual((await api.allNodes(TOKEN)).map((node) => node.name), ['python', 'dev']);
  const [{ url, init }] = transport.calls;
  assert.equal(new URL(url).pathname, '/api/nodes/all.json');
  assert.equal(init.method, 'GET');
  assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${TOKEN}`);
});
