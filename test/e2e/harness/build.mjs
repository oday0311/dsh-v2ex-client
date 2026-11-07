import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const outdir = new URL('./dist/', import.meta.url);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./host.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./harness.js', outdir)),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
});
