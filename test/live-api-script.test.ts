import assert from 'node:assert/strict';
import test from 'node:test';
import { runLiveVerification } from '../scripts/verify-live-api.js';
import { MEMBER_OK, REPLIES_OK, TOKEN_OK, TOPIC, TOPIC_OK } from './fixtures/v2ex.js';
import { jsonResponse, recordingFetch } from './helpers/fakes.js';

const PLACEHOLDER_TOKEN = 'fixture-token-for-live-verifier';

test('live verifier refuses to run without an environment token', async () => {
  const result = await runLiveVerification({}, async () => { throw new Error('must not fetch'); });
  assert.deepEqual(result, { exitCode: 2, stdout: '', stderr: 'V2EX_TEST_TOKEN is required\n' });
});

test('live verifier performs only the approved bounded GET sequence', async () => {
  const fixtureByPath: Record<string, unknown> = {
    '/api/v2/token': TOKEN_OK,
    '/api/v2/member': MEMBER_OK,
    '/api/topics/latest.json': [TOPIC],
    '/api/v2/topics/123': TOPIC_OK,
    '/api/v2/topics/123/replies?p=1': REPLIES_OK,
  };
  const transport = recordingFetch((url) => jsonResponse(fixtureByPath[url.pathname + url.search]));
  const result = await runLiveVerification({ V2EX_TEST_TOKEN: PLACEHOLDER_TOKEN }, transport.fetch);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, code: 'ok', tokenValid: true, memberValid: true,
    latestCount: 1, topicValid: true, repliesCount: 1,
  });
  assert.deepEqual(transport.calls.map(call => new URL(call.url).pathname + new URL(call.url).search),
    Object.keys(fixtureByPath));
  for (const call of transport.calls) {
    assert.equal(new URL(call.url).origin, 'https://www.v2ex.com');
    assert.equal(call.init.method, 'GET');
  }
  assert.equal(result.stdout.includes(PLACEHOLDER_TOKEN), false);
});

test('live verifier emits only a stable code when a provider error contains secrets', async () => {
  const result = await runLiveVerification({ V2EX_TEST_TOKEN: PLACEHOLDER_TOKEN }, async () => {
    throw new Error(`provider leaked ${PLACEHOLDER_TOKEN}`);
  });
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: '',
    stderr: '{"ok":false,"code":"offline"}\n',
  });
});

test('live verifier rejects an empty latest page without making arbitrary reads', async () => {
  const fixtureByPath: Record<string, unknown> = {
    '/api/v2/token': TOKEN_OK,
    '/api/v2/member': MEMBER_OK,
    '/api/topics/latest.json': [],
  };
  const transport = recordingFetch((url) => jsonResponse(fixtureByPath[url.pathname + url.search]));
  const result = await runLiveVerification({ V2EX_TEST_TOKEN: PLACEHOLDER_TOKEN }, transport.fetch);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '{"ok":false,"code":"empty_latest"}\n');
  assert.equal(transport.calls.length, 3);
});
