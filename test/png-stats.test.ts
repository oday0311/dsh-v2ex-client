import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { analyzePng, informativeImageFailures } from './support/png-stats.js';

function image(draw?: (png: PNG) => void): Buffer {
  const png = new PNG({ width: 1_440, height: 900, colorType: 6 });
  png.data.fill(255); draw?.(png); return PNG.sync.write(png);
}

function rectangle(png: PNG, left: number, top: number, width: number, height: number): void {
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const offset = (y * png.width + x) * 4;
    png.data[offset] = 25; png.data[offset + 1] = 45; png.data[offset + 2] = 40; png.data[offset + 3] = 255;
  }
}

test('decoded PNG information thresholds reject blank and single-square images', () => {
  assert.notDeepEqual(informativeImageFailures(analyzePng(image())), []);
  assert.notDeepEqual(informativeImageFailures(analyzePng(image(png => rectangle(png, 694, 424, 52, 52)))), []);
});

test('decoded PNG information thresholds accept sparse but spatially distributed content', () => {
  const buffer = image(png => {
    for (let row = 0; row < 8; row++) rectangle(png, 520, 85 + row * 19, 400, 4);
    rectangle(png, 520, 105, 4, 120); rectangle(png, 916, 105, 4, 120);
  });
  assert.deepEqual(informativeImageFailures(analyzePng(buffer)), []);
});
