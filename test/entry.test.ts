import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { apply, Config } from '../src/index.js';

test('guarded entry contains incompatible runtime failure and exposes an idempotent disposer', async () => {
  const warnings: string[] = [];
  const effects: Array<Promise<void>> = [];
  let cleanup: (() => void) | undefined;
  const ctx = {
    logger: () => ({ warn: (message: string) => warnings.push(message) }),
    effect(callback: () => Promise<() => void>) {
      effects.push(Promise.resolve().then(callback).then((dispose) => { cleanup = dispose; }));
      return () => cleanup?.();
    },
  };
  const dispose = apply(ctx as never, Config({}));
  await Promise.all(effects);
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(warnings, ['incompatible_runtime']);
  assert.doesNotThrow(() => { dispose(); dispose(); });
});

test('guarded entry contains effect registration failure', () => {
  const warnings: string[] = [];
  const ctx = {
    logger: () => ({ warn: (message: string) => warnings.push(message) }),
    effect() { throw new Error('private diagnostic detail'); },
  };
  const dispose = apply(ctx as never, Config({}));
  assert.deepEqual(warnings, ['incompatible_runtime']);
  assert.doesNotThrow(() => { dispose(); dispose(); });
});

test('guarded entry contains a missing effect service', () => {
  const warnings: string[] = [];
  const ctx = { logger: () => ({ warn: (message: string) => warnings.push(message) }) };
  const dispose = apply(ctx as never, Config({}));
  assert.deepEqual(warnings, ['incompatible_runtime']);
  assert.doesNotThrow(() => { dispose(); dispose(); });
});

test('guarded entry contains a real dynamic import failure without exposing its detail', () => {
  const script = `
    import { registerHooks } from 'node:module';
    let importBlocked = false;
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === './plugin.js') {
        importBlocked = true;
        throw new Error('private diagnostic detail');
      }
      return nextResolve(specifier, context);
    }});
    const { apply, Config } = await import('./src/index.ts');
    const warnings = [];
    const effects = [];
    let cleanup;
    const ctx = {
      logger: () => ({ warn: (message) => warnings.push(message) }),
      effect(callback) {
        effects.push(Promise.resolve().then(callback).then((dispose) => { cleanup = dispose; }));
        return () => cleanup?.();
      },
    };
    const dispose = apply(ctx, Config({}));
    await Promise.all(effects);
    dispose();
    dispose();
    console.log(JSON.stringify({ importBlocked, warnings, disposerType: typeof dispose }));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), {
    importBlocked: true, warnings: ['incompatible_runtime'], disposerType: 'function',
  });
});
