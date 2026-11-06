import assert from 'node:assert/strict';
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
