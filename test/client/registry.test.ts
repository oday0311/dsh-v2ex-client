import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { JSDOM } from 'jsdom';
import { apply, inject } from '../../src/client/index.js';

const require = createRequire(import.meta.url);

function publishedSlotRegistry(): new (ctx: Context) => { register: (...args: unknown[]) => unknown; entries: (key: string) => readonly unknown[] } {
  const source = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', 'utf8');
  let exports: Record<string, unknown> = {};
  runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: NodeRequire) => Record<string, unknown> }) => { exports = factory(require); } } } });
  return exports.SlotRegistry as ReturnType<typeof publishedSlotRegistry>;
}

test('published Cordis slot registry mounts and unloads the v2ex panel', async () => {
  assert.deepEqual(inject, ['slots', 'locale']);
  const ctx = new Context();
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const oldDocument = globalThis.document;
  Object.assign(globalThis, { document: dom.window.document });
  const SlotRegistry = publishedSlotRegistry();
  new SlotRegistry(ctx);
  const snapshot = { active: 'zh' };
  ctx.reflect.provide('locale', { register: () => () => {}, bind: () => () => 'V2EX', getSnapshot: () => snapshot, subscribe: () => () => {} });
  const declare = ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } }, () => null);
  try {
    const fiber = await ctx.plugin({ name: 'v2ex-test', inject, apply });
    assert.equal(ctx.slots.entries('main').length, 1);
    assert.equal(ctx.slots.entries('sidebar.panellist').length, 1);
    assert.equal(ctx.slots.entries('sidebar.panellist')[0]?.options.id, 'v2ex');
    assert.equal(ctx.slots.entries('main')[0]?.options.key, 'v2ex');
    await fiber.dispose();
    assert.equal(ctx.slots.entries('main').length, 0);
    assert.equal(ctx.slots.entries('sidebar.panellist').length, 0);
  } finally {
    declare();
    Object.assign(globalThis, { document: oldDocument });
    dom.window.close();
  }
});

test('browser package bundles icons and validation without unknown loader imports', () => {
  const source = readFileSync('lib/client.js', 'utf8');
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(requires)].sort(), ['react']);
});
