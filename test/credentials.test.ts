import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService, DshCredentialVault, TOKEN_REF, type IdentityMutationGuard } from '../src/credentials.js';
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

test('verified account scope remains available offline in memory and clears on logout', async () => {
  const vault = new FakeCredentialVault();
  const { api, transport } = apiFrom({ '/api/v2/token': TOKEN_OK, '/api/v2/member': MEMBER_OK });
  const auth = new AuthService(api, vault);
  await auth.login(TOKEN);
  const calls = transport.calls.length;
  assert.equal(await auth.account(), 'alice');
  assert.equal(transport.calls.length, calls);
  vault.value = 'replacement-credential';
  assert.equal(await auth.account(), 'alice');
  assert.equal(transport.calls.length, calls + 2);
  await auth.logout(false);
  await assert.rejects(auth.account(), { code: 'not_authenticated' });
});

test('logout revalidates an externally replaced credential before choosing the cleanup account', async () => {
  const vault = new FakeCredentialVault(); const cleaned: Array<string | null> = [];
  const api = { async readToken() { return { scope: 'everything' }; },
    async readMember(token: string) { return { username: token === 'ALICE_FAKE_VALUE' ? 'alice' : 'bob' }; } };
  const auth = new AuthService(api as never, vault, async account => { cleaned.push(account); });
  await auth.login('ALICE_FAKE_VALUE');
  vault.value = 'BOB_FAKE_VALUE';
  await auth.logout(true);
  assert.deepEqual(cleaned, ['bob']);
});

test('identity leases are invalidated by external A to B to A credential replacement', async () => {
  const vault = new FakeCredentialVault();
  const api = { async readToken() { return { scope: 'everything' }; },
    async readMember(token: string) { return { username: token === 'ALICE_FAKE_VALUE' ? 'alice' : 'bob' }; } };
  const auth = new AuthService(api as never, vault);
  await auth.login('ALICE_FAKE_VALUE');
  const firstAlice = await auth.lease();
  vault.value = 'BOB_FAKE_VALUE';
  const bob = await auth.lease();
  await assert.rejects(auth.assertLease(firstAlice), { code: 'not_authenticated' });
  vault.value = 'ALICE_FAKE_VALUE';
  const secondAlice = await auth.lease();
  assert.equal(firstAlice.scope, secondAlice.scope);
  assert.notEqual(firstAlice.generation, secondAlice.generation);
  assert.notEqual(firstAlice.credentialFingerprint, bob.credentialFingerprint);
  await assert.rejects(auth.assertLease(firstAlice), { code: 'not_authenticated' });
  await auth.assertLease(secondAlice);
});

test('login rejects when the credential changes between validation and identity publication', async () => {
  const vault = new FakeCredentialVault();
  vault.set = async () => { vault.value = 'BOB_FAKE_VALUE'; };
  const api = { async readToken() { return { scope: 'everything' }; },
    async readMember(token: string) { return { username: token === 'ALICE_FAKE_VALUE' ? 'alice' : 'bob' }; } };
  const auth = new AuthService(api as never, vault);
  await assert.rejects(auth.login('ALICE_FAKE_VALUE'), { code: 'not_authenticated' });
  assert.equal(vault.value, 'BOB_FAKE_VALUE');
  assert.equal(await auth.account(), 'bob');
});

test('logout cleanup serializes a later login so the old transition cannot erase or overlap it', async () => {
  const vault = new FakeCredentialVault(); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const api = { async readToken() { return { scope: 'everything' }; },
    async readMember(token: string) { return { username: token === 'ALICE_FAKE_VALUE' ? 'alice' : 'bob' }; } };
  const cleaned: string[] = [];
  const auth = new AuthService(api as never, vault, async account => { cleaned.push(account!); entered(); await gate; });
  await auth.login('ALICE_FAKE_VALUE');
  const logout = auth.logout(true); await started;
  let loginSettled = false;
  const login = auth.login('BOB_FAKE_VALUE').finally(() => { loginSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loginSettled, false);
  assert.equal(vault.value, undefined);
  release(); await logout; await login;
  assert.equal(await auth.account(), 'bob');
  assert.deepEqual(cleaned, ['alice']);
});

test('overlapping logins publish in invocation order and a failed transition releases the queue', async () => {
  const vault = new FakeCredentialVault(); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const api = { async readToken(token: string) { if (token === 'ALICE_FAKE_VALUE') { entered(); await gate; }
      if (token === 'INVALID_FAKE_VALUE') throw new V2exError('token_invalid'); return { scope: 'everything' }; },
    async readMember(token: string) { return { username: token === 'ALICE_FAKE_VALUE' ? 'alice' : 'bob' }; } };
  const auth = new AuthService(api as never, vault);
  const alice = auth.login('ALICE_FAKE_VALUE'); await started;
  const bob = auth.login('BOB_FAKE_VALUE'); release(); await alice; await bob;
  assert.equal(await auth.account(), 'bob');
  await assert.rejects(auth.login('INVALID_FAKE_VALUE'), { code: 'token_invalid' });
  await auth.login('ALICE_FAKE_VALUE');
  assert.equal(await auth.account(), 'alice');
});

test('overlapping logouts stay ordered and cleanup failure does not poison later transitions', async () => {
  const vault = new FakeCredentialVault(); let release!: () => void; let entered!: () => void; let failCleanup = false;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const api = { async readToken() { return { scope: 'everything' }; }, async readMember() { return { username: 'alice' }; } };
  const auth = new AuthService(api as never, vault, async () => { entered(); await gate; if (failCleanup) throw new Error('cleanup failed'); });
  await auth.login('ALICE_FAKE_VALUE');
  const first = auth.logout(true); await started; const second = auth.logout(false); release(); await first; await second;
  await assert.rejects(auth.account(), { code: 'not_authenticated' });
  await auth.login('ALICE_FAKE_VALUE'); failCleanup = true;
  await assert.rejects(auth.logout(true), /cleanup failed/);
  failCleanup = false; await auth.login('ALICE_FAKE_VALUE'); assert.equal(await auth.account(), 'alice');
});

test('nested mutation capability expires when the outer identity fence exits', async () => {
  const vault = new FakeCredentialVault(); const { api } = apiFrom({ '/api/v2/token': TOKEN_OK, '/api/v2/member': MEMBER_OK });
  const auth = new AuthService(api, vault); await auth.login(TOKEN); let saved!: IdentityMutationGuard;
  await auth.withMutation(async (_lease, guard) => { saved = guard; await guard.run(async lease => lease.account); });
  await assert.rejects(saved.run(async lease => lease.account), { code: 'not_authenticated' });
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
