import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService, DshCredentialVault, TOKEN_REF } from '../src/credentials.js';
import { V2exError } from '../src/errors.js';
import { V2exApi } from '../src/v2ex-api.js';
import { MEMBER_OK, TOKEN, TOKEN_OK } from './fixtures/v2ex.js';
import { FakeCredentialVault, jsonResponse, recordingFetch } from './helpers/fakes.js';

const apiFrom = (responses: Record<string, unknown>) => {
  const transport = recordingFetch((url) => jsonResponse(responses[url.pathname]));
  return { api: new V2exApi({ fetch: transport.fetch, timeoutMs: 100, responseLimitBytes: 100_000 }), transport };
};

test('login validates token and identity before saving and returns only browser-safe status', async () => {
  const vault = new FakeCredentialVault();
  const { api, transport } = apiFrom({ '/api/v2/token': TOKEN_OK, '/api/v2/member': MEMBER_OK });
  const auth = new AuthService(api, vault);
  const status = await auth.login(TOKEN);
  assert.deepEqual(transport.calls.map(({ url }) => new URL(url).pathname), ['/api/v2/token', '/api/v2/member']);
  assert.equal(vault.value, TOKEN);
  assert.equal(status.username, 'alice');
  assert.equal(status.authenticated, true);
  assert.equal(status.tokenScope, 'everything');
  assert.doesNotMatch(JSON.stringify(status), /00000000/);
});

test('invalid token is never stored and existing credential survives a failed replacement', async () => {
  const vault = new FakeCredentialVault();
  vault.value = 'previous-credential';
  const { api } = apiFrom({ '/api/v2/token': { success: false, message: 'Invalid token' } });
  const auth = new AuthService(api, vault);
  await assert.rejects(auth.login(TOKEN), (error: unknown) => error instanceof V2exError && error.code === 'token_invalid');
  assert.equal(vault.value, 'previous-credential');
  assert.equal(vault.setCalls.length, 0);
});

test('status resolves the stored credential and returns anonymous status when absent', async () => {
  const vault = new FakeCredentialVault();
  const { api } = apiFrom({ '/api/v2/token': TOKEN_OK, '/api/v2/member': MEMBER_OK });
  const auth = new AuthService(api, vault);
  assert.deepEqual(await auth.status(), { authenticated: false, writable: true, username: null, tokenScope: null, expiresAt: null });
  vault.value = TOKEN;
  assert.equal((await auth.status()).username, 'alice');
});

test('logout clears the credential and calls personal-data cleanup only when requested', async () => {
  const vault = new FakeCredentialVault();
  vault.value = TOKEN;
  const { api } = apiFrom({});
  let cleared = 0;
  const auth = new AuthService(api, vault, async () => { cleared++; });
  await auth.logout(false);
  assert.equal(vault.value, undefined);
  assert.equal(cleared, 0);
  vault.value = TOKEN;
  await auth.logout(true);
  assert.equal(cleared, 1);
});

test('DSH vault uses the plugin-owned reference for resolve, write, clear, and describe', async () => {
  const values = new Map<string, string>();
  const refs: string[] = [];
  const provider = {
    async resolve(ref: string) { refs.push(ref); return values.has(ref) ? { value: values.get(ref)! } : undefined; },
    async set(ref: string, value: string) { refs.push(ref); values.set(ref, value); },
    async unset(ref: string) { refs.push(ref); values.delete(ref); },
    async describe(ref: string) { refs.push(ref); return { configured: values.has(ref), writable: true }; },
  };
  const vault = new DshCredentialVault(provider);
  await vault.set(TOKEN);
  assert.equal(await vault.resolve(), TOKEN);
  assert.deepEqual(await vault.describe(), { configured: true, writable: true });
  await vault.clear();
  assert.equal(await vault.resolve(), undefined);
  assert.deepEqual(refs, Array(5).fill(TOKEN_REF));
});
