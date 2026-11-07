import assert from 'node:assert/strict';
import test from 'node:test';
import { positionScroll, type ScrollPositionAdapter } from './support/scroll-position.js';

test('settled scroll positioning waits for delayed layout before verifying the clamped target', async () => {
  let position = 40; let pending = 40; let frames = 0;
  const adapter: ScrollPositionAdapter = {
    async setScrollTop(target) { pending = target; frames = 0; },
    async readScrollMetrics() { return { position, maximum: 100 }; },
    async settleFrame() { if (++frames === 2) position = Math.max(0, Math.min(100, pending)); },
  };

  await adapter.setScrollTop(150);
  assert.equal((await adapter.readScrollMetrics()).position, 40, 'an immediate restore observes stale layout');
  const settled = await positionScroll(adapter, 150, { pollDelayMs: 0 });
  assert.deepEqual(settled, { position: 100, target: 100, maximum: 100 });
});
