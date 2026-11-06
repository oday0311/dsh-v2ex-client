import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { composePlugin } from '../src/plugin.js';
import { Config } from '../src/index.js';
import { REPLIES_OK, TOPIC_OK } from './fixtures/v2ex.js';

test('real Cordis Context resolves late, replaced and removed AI services without restarting browsing', async () => {
  const ctx = new Context();
  const previousFetch = globalThis.fetch;
  const tools = new Map<string, { execute(args: unknown, context: unknown): Promise<unknown> }>();
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const tables = { cache: new Map<string, unknown>(), summaries: new Map<string, unknown>(), recommendations: new Map<string, unknown>() };
  const domain = { global: { get: () => ({ settings: {}, profile: null }), set: async () => {} },
    table(name: keyof typeof tables) { const map = tables[name]; return {
      get: (key: string) => map.get(key), put: async (key: string, value: unknown) => { map.set(key, value); },
      delete: async (key: string) => { map.delete(key); }, entries: () => map.entries(),
    }; }, async close() {} };
  ctx.provide('credentials', { async resolve() { return { value: 'test-token' }; },
    async describe() { return { configured: true, writable: true }; }, async set() {}, async unset() {} });
  ctx.provide('storageDomain', { async open() { return domain; } });
  ctx.provide('tools', { register(tool: { name: string; execute(args: unknown, context: unknown): Promise<unknown> }) {
    tools.set(tool.name, tool); return () => { tools.delete(tool.name); };
  } });
  ctx.provide('connection', { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
    routes.set(route.path, route); return () => { routes.delete(route.path); };
  } } });
  globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).includes('/replies?') ? REPLIES_OK : TOPIC_OK),
    { headers: { 'content-type': 'application/json' } });
  let plugin: Awaited<ReturnType<typeof composePlugin>> | undefined;
  const model = (answer: string, calls: string[]) => ({ async *stream(options: { provider: string; model: string }) {
    calls.push(`${options.provider}/${options.model}`);
    const text = JSON.stringify({ summary: answer, viewpoints: [], notableReplies: [] });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  const calls: string[] = [];
  try {
    plugin = await composePlugin(ctx, Config({}));
    const summary = tools.get('v2ex_summarize_topic')!;
    const call = (mode: string) => summary.execute({ topic: '123', replyPages: 1, mode },
      { signal: new AbortController().signal });
    const browse = async () => (await routes.get('/api/v2ex/topic')!.fetch(
      new Request('https://host.test/api/v2ex/topic?topic=123&replyPages=1'))).status;
    assert.equal(await browse(), 200);
    await assert.rejects(call('quick'), { code: 'ai_unavailable' });
    const removeSelection = ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'a' }) });
    const removeLlm = ctx.provide('llm', model('one', calls));
    assert.equal((await call('quick') as { summary: string }).summary, 'one');
    assert.equal(await browse(), 200);
    await removeLlm();
    await assert.rejects(call('quick'), { code: 'ai_unavailable' });
    assert.equal(await browse(), 200);
    const removeLlm2 = ctx.provide('llm', model('two', calls));
    assert.equal((await call('viewpoints') as { summary: string }).summary, 'two');
    await removeSelection();
    await assert.rejects(call('full'), { code: 'ai_unavailable' });
    const removeSelection2 = ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'b' }) });
    assert.equal((await call('full') as { summary: string }).summary, 'two');
    assert.deepEqual(calls, ['p/a', 'p/a', 'p/b']);
    assert.equal(await browse(), 200);
    await removeSelection2(); await removeLlm2();
  } finally {
    await plugin?.dispose();
    await ctx.fiber.dispose();
    globalThis.fetch = previousFetch;
  }
});
