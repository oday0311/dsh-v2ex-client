import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowsingTools } from '../src/tools.js';
import { V2exError } from '../src/errors.js';
import { composePlugin } from '../src/plugin.js';
import { Config } from '../src/index.js';

const item = { id: 123, title: 'A'.repeat(20_000), node: { name: 'python', title: 'Python' },
  author: { username: 'alice' }, replyCount: 1, createdAt: '2026-11-06T00:00:00Z',
  lastReplyAt: null, url: 'https://www.v2ex.com/t/123' };

function fixture() {
  const calls: string[] = [];
  const source = { value: { items: Array.from({ length: 100 }, () => item), page: 1, hasMore: false, stale: false },
    fetchedAt: '2026-11-06T00:00:00Z', stale: false, source: 'network' as const };
  const reader = {
    async latest(input: { page: number }) { calls.push(`latest:${input.page}`); return source; },
    async hot() { calls.push('hot'); return { ...source, value: source.value.items }; },
    async nodeTopics(input: { node: string; page: number }) { calls.push(`node:${input.node}:${input.page}`); return source; },
    async topic(input: { topic: string; replyPages: number }) {
      calls.push(`topic:${input.topic}:${input.replyPages}`);
      return { ...source, value: { topic: item, content: 'x'.repeat(1_000_000),
        replies: Array.from({ length: 100 }, (_, id) => ({ id: id + 1, author: { username: 'alice' },
          content: 'r'.repeat(100_000), createdAt: '2026-11-06T00:00:00Z' })),
        replyPage: 1, hasMoreReplies: true, stale: false } };
    },
  };
  const tools = createBrowsingTools(reader as never);
  const run = async (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name)!;
    return tool.execute(args as never, { signal: new AbortController().signal } as never);
  };
  return { calls, tools, run };
}

test('registers exactly four read-only browsing tools', () => {
  assert.deepEqual(fixture().tools.map((tool) => tool.name).sort(),
    ['v2ex_hot', 'v2ex_latest', 'v2ex_node_topics', 'v2ex_topic']);
});

test('plugin composition registers and unregisters browsing and summary tools', async () => {
  const names: string[] = [];
  const removed: string[] = [];
  let closed = false;
  const host = {
    credentials: {},
    storageDomain: { async open() { return { async close() { closed = true; } }; } },
    tools: { register(tool: { name: string }) { names.push(tool.name); return () => { removed.push(tool.name); }; } },
    get(name: string) { assert.equal(name, 'connection'); return { fetch: { register() { return () => {}; } } }; },
  };
  const plugin = await composePlugin(host as never, Config({}));
  assert.deepEqual(names.sort(), ['v2ex_hot', 'v2ex_interest_profile', 'v2ex_latest', 'v2ex_node_topics', 'v2ex_summarize_topic', 'v2ex_topic']);
  await plugin.dispose();
  await plugin.dispose();
  assert.deepEqual(removed.sort(), names);
  assert.equal(closed, true);
});

test('topic output truncates body and replies with metadata within 64 KiB', async () => {
  const f = fixture();
  const result = await f.run('v2ex_topic', { topic: '123', replyPages: 1000 }) as { topic: { contentTruncated: boolean }; truncated: boolean };
  assert.equal(result.topic.contentTruncated, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.deepEqual(f.calls, ['topic:123:3']);
});

test('list tools clamp pages and bound total output', async () => {
  const f = fixture();
  const result = await f.run('v2ex_latest', { page: 5000 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.deepEqual(f.calls, ['latest:1000']);
});

test('topic output stays bounded when a reader returns an extreme metadata field', async () => {
  const reader = {
    async topic() { return { value: { topic: { ...item, url: 'u'.repeat(1_000_000) }, content: '',
      replies: [], replyPage: 1, hasMoreReplies: false, stale: false },
      fetchedAt: '2026-11-06T00:00:00Z', stale: false, source: 'network' as const }; },
  };
  const tool = createBrowsingTools(reader as never).find((candidate) => candidate.name === 'v2ex_topic')!;
  const result = await tool.execute({ topic: '123' }, { signal: new AbortController().signal } as never);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
});

test('every tool bounds serialized model content with control characters and Unicode', async () => {
  const noisy = '\u0000\n\\\u2028😀'.repeat(10_000);
  const noisyItem = { ...item, title: noisy, node: { name: noisy, title: noisy },
    author: { username: noisy }, createdAt: noisy, lastReplyAt: noisy, url: noisy };
  const cached = { fetchedAt: '2026-11-06T00:00:00Z', stale: false, source: 'network' as const };
  const reader = {
    async latest() { return { ...cached, value: { items: Array(30).fill(noisyItem), page: 1, hasMore: true, stale: false } }; },
    async hot() { return { ...cached, value: Array(30).fill(noisyItem) }; },
    async nodeTopics() { return { ...cached, value: { items: Array(30).fill(noisyItem), page: 1, hasMore: true, stale: false } }; },
    async topic() { return { ...cached, value: { topic: noisyItem, content: noisy,
      replies: Array.from({ length: 30 }, (_, id) => ({ id: id + 1,
        author: { username: noisy }, content: noisy, createdAt: noisy })),
      replyPage: 1, hasMoreReplies: true, stale: false } }; },
  };
  for (const tool of createBrowsingTools(reader as never)) {
    const args = tool.name === 'v2ex_node_topics' ? { node: 'python' } :
      tool.name === 'v2ex_topic' ? { topic: '123' } : {};
    const result = await tool.execute(args, { signal: new AbortController().signal } as never);
    const content = tool.output.render(args, result);
    assert.ok(Buffer.byteLength(JSON.stringify({ role: 'tool', name: tool.name, content })) <= 64 * 1024, tool.name);
    assert.equal((result as { truncated: boolean }).truncated, true);
  }
});

test('invalid node and topic identifiers are rejected before reader calls', async () => {
  const f = fixture();
  await assert.rejects(f.run('v2ex_node_topics', { node: '../bad', page: 1 }), (error: unknown) =>
    error instanceof V2exError && error.code === 'invalid_request');
  await assert.rejects(f.run('v2ex_topic', { topic: '001' }), { code: 'invalid_request' });
  assert.deepEqual(f.calls, []);
});
