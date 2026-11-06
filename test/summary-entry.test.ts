import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2exHttpRoutes } from '../src/http-routes.js';
import { createSummaryTool } from '../src/tools.js';
import { V2exError } from '../src/errors.js';

const summary = { topicId: 1, summary: 'Summary', viewpoints: [], notableReplies: [],
  generatedAt: '2026-11-06T00:00:00Z', coveredReplyPages: [1], completeDiscussion: false };

test('Host route and Tool share content-first summary behavior and provenance', async () => {
  const calls: string[] = [];
  const content = { async topic(input: { topic: string; replyPages: number }) {
    calls.push(`content:${input.topic}:${input.replyPages}`);
    return { value: { topic: { id: 1 }, content: '', replies: [], replyPage: input.replyPages,
      hasMoreReplies: true }, stale: false, source: 'network', fetchedAt: 'now' };
  } };
  const intelligence = { async summarizeTopic(input: { mode: string }) { calls.push(`ai:${input.mode}`); return summary; } };
  let route: { fetch(request: Request): Promise<Response> } | undefined;
  registerV2exHttpRoutes({ fetch: { register(value) {
    if (value.path === '/api/v2ex/topic/summary') route = value;
    return () => {};
  } } }, { auth: {} as never, credential: {} as never, content, intelligence } as never);
  const response = await route!.fetch(new Request('https://host.test/api/v2ex/topic/summary', {
    method: 'POST', body: JSON.stringify({ topic: '1', mode: 'quick', replyPages: 1 }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json() as { data: unknown }).data, summary);
  const tool = createSummaryTool(content as never, intelligence as never);
  const result = await tool.execute({ topic: '1', mode: 'quick', replyPages: 1 }, { signal: new AbortController().signal } as never);
  assert.equal((result as { summary: string }).summary, 'Summary');
  assert.deepEqual(calls, ['content:1:1', 'ai:quick', 'content:1:1', 'ai:quick']);
});

test('summary route rejects query/body/method errors before content access', async () => {
  let calls = 0;
  let route: { fetch(request: Request): Promise<Response> } | undefined;
  registerV2exHttpRoutes({ fetch: { register(value) {
    if (value.path === '/api/v2ex/topic/summary') route = value;
    return () => {};
  } } }, { auth: {} as never, credential: {} as never,
    content: { async topic() { calls++; throw new Error('unused'); } }, intelligence: {} } as never);
  for (const [path, init, status] of [
    ['/api/v2ex/topic/summary?bad=1', { method: 'POST', body: '{}' }, 400],
    ['/api/v2ex/topic/summary', { method: 'GET' }, 405],
    ['/api/v2ex/topic/summary', { method: 'POST', body: JSON.stringify({ topic: '1', mode: 'quick', extra: 1 }) }, 400],
    ['/api/v2ex/topic/summary', { method: 'POST', body: JSON.stringify({ topic: 1, mode: 'quick' }) }, 400],
    ['/api/v2ex/topic/summary', { method: 'POST', body: '{' }, 400],
    ['/api/v2ex/topic/summary', { method: 'POST', body: 'x'.repeat(4097) }, 413],
  ] as const) {
    const response = await route!.fetch(new Request(`https://host.test${path}`, init));
    assert.equal(response.status, status);
  }
  assert.equal(calls, 0);
});

test('missing AI services return ai_unavailable after authenticated content retrieval', async () => {
  const calls: string[] = [];
  let route: { fetch(request: Request): Promise<Response> } | undefined;
  registerV2exHttpRoutes({ fetch: { register(value) {
    if (value.path === '/api/v2ex/topic/summary') route = value;
    return () => {};
  } } }, { auth: {} as never, credential: {} as never,
    content: { async topic() { calls.push('content'); return { value: {}, stale: false, source: 'network', fetchedAt: 'now' }; } },
  } as never);
  const response = await route!.fetch(new Request('https://host.test/api/v2ex/topic/summary', {
    method: 'POST', body: JSON.stringify({ topic: '1', mode: 'quick' }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'ai_unavailable');
  assert.deepEqual(calls, ['content']);
});

test('Tool output remains bounded under extreme stored summary and unavailable AI', async () => {
  const content = { async topic() { return { value: {}, stale: false, source: 'network', fetchedAt: 'now' }; } };
  const tool = createSummaryTool(content as never, { async summarizeTopic() {
    return { ...summary, summary: '\u0000😀'.repeat(100_000), viewpoints: Array(30).fill('x'.repeat(1000)) };
  } } as never);
  const args = { topic: '1', mode: 'full', replyPages: 1 };
  const result = await tool.execute(args, { signal: new AbortController().signal } as never);
  assert.ok(Buffer.byteLength(JSON.stringify({ role: 'tool', name: tool.name,
    content: tool.output.render(args, result) })) <= 64 * 1024);
  const unavailable = createSummaryTool(content as never, { async summarizeTopic() { throw new V2exError('ai_unavailable'); } } as never);
  await assert.rejects(unavailable.execute(args, { signal: new AbortController().signal } as never), { code: 'ai_unavailable' });
});
