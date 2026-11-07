import { PNG } from 'pngjs';

export interface PngStats {
  width: number;
  height: number;
  nonBackgroundRatio: number;
  luminanceVariance: number;
  populatedRowRatio: number;
  populatedColumnRatio: number;
  occupiedGridCells: number;
}

export function analyzePng(buffer: Buffer): PngStats {
  const png = PNG.sync.read(buffer);
  const populatedRows = new Set<number>();
  const populatedColumns = new Set<number>();
  const occupiedCells = new Set<number>();
  let nonBackground = 0; let sum = 0; let sumSquares = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const offset = (y * png.width + x) * 4;
    const luminance = (png.data[offset]! + png.data[offset + 1]! + png.data[offset + 2]!) / 3;
    sum += luminance; sumSquares += luminance * luminance;
    if (luminance >= 245 || png.data[offset + 3] === 0) continue;
    nonBackground++; populatedRows.add(y); populatedColumns.add(x);
    const column = Math.min(7, Math.floor(x * 8 / png.width));
    const row = Math.min(5, Math.floor(y * 6 / png.height));
    occupiedCells.add(row * 8 + column);
  }
  const pixels = png.width * png.height; const mean = sum / pixels;
  return {
    width: png.width, height: png.height,
    nonBackgroundRatio: nonBackground / pixels,
    luminanceVariance: sumSquares / pixels - mean * mean,
    populatedRowRatio: populatedRows.size / png.height,
    populatedColumnRatio: populatedColumns.size / png.width,
    occupiedGridCells: occupiedCells.size,
  };
}

export function informativeImageFailures(stats: PngStats): string[] {
  const failures: string[] = [];
  if (stats.width < 200 || stats.height < 200) failures.push('image dimensions are too small');
  if (stats.nonBackgroundRatio < 0.0025) failures.push('non-background ratio is too low');
  if (stats.luminanceVariance < 5) failures.push('luminance variance is too low');
  if (stats.populatedRowRatio < 0.035) failures.push('populated row coverage is too low');
  if (stats.populatedColumnRatio < 0.06) failures.push('populated column coverage is too low');
  if (stats.occupiedGridCells < 5) failures.push('spatial grid coverage is too low');
  return failures;
}
