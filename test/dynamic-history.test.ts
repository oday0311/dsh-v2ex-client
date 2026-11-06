import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { composePlugin } from '../src/plugin.js';
import { Config } from '../src/index.js';

test('late and replaced sessionQuery is resolved only after stored authorization', async () => {
  const ctx = new Context();
  let global = { settings: {}, profile: null as unknown };
  const tables = { cache: new Map(), summaries: new Map(), recommendations: new Map() };
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  ctx.provide('credentials', {});
  ctx.provide('storageDomain', { async open() { return {
    global: { get: () => structuredClone(global), set: async (next: typeof global) => { global = structuredClone(next); } },
    table(name: keyof typeof tables) { const map = tables[name]; return { entries: () => map.entries(), delete: async (key: string) => map.delete(key) }; },
    async close() {},
  }; } });
  ctx.provide('tools', { register() { return () => {}; } });
  ctx.provide('connection', { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
    routes.set(route.path, route); return () => routes.delete(route.path);
  } } });
  const response = (method: string, body?: unknown) => routes.get('/api/v2ex/interests')!.fetch(
    new Request('https://host.test/api/v2ex/interests', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  let reads = 0;
  const query = (name: string) => ({ async listSessions() { reads++; return [{ id: name }]; },
    async filterEvents() { return [{ type: 'user/message', content: [{ type: 'text', text: name }] }]; } });
  const model = { async *stream() {
    const text = JSON.stringify({ labels: [{ name: 'Rust', weight: 1 }], preferredNodes: [], exclusions: [] });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  let plugin: Awaited<ReturnType<typeof composePlugin>> | undefined;
  try {
    plugin = await composePlugin(ctx, Config({}));
    assert.equal((await response('POST', { action: 'relearn' })).status, 403);
    assert.equal(reads, 0);
    await response('POST', { action: 'authorize' });
    assert.equal((await response('POST', { action: 'relearn' })).status, 403);
    const removeQuery = ctx.provide('sessionQuery', query('first'));
    const removeModel = ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
    const removeLlm = ctx.provide('llm', model);
    assert.equal((await response('POST', { action: 'relearn' })).status, 200);
    await removeQuery();
    const removeReplacement = ctx.provide('sessionQuery', query('second'));
    assert.equal((await response('POST', { action: 'relearn' })).status, 200);
    assert.equal(reads, 2);
    await response('POST', { action: 'revoke' });
    assert.equal((await response('POST', { action: 'relearn' })).status, 403);
    assert.equal(reads, 2);
    assert.equal((await routes.get('/api/v2ex/health')!.fetch(new Request('https://host.test/api/v2ex/health'))).status, 200);
    await removeReplacement(); await removeLlm(); await removeModel();
  } finally { await plugin?.dispose(); await ctx.fiber.dispose(); }
});
