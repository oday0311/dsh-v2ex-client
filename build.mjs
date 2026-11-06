import { execFileSync } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('./dsh.plugin.json', import.meta.url), 'utf8'));
if (pkg.name !== manifest.name || pkg.version !== manifest.version ||
    manifest.entry.name !== pkg.name ||
    JSON.stringify(pkg.dsh.bundle) !== JSON.stringify(manifest.bundle)) {
  throw new Error('Bundle metadata contract does not match.');
}

await rm(new URL('./lib/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('./lib/', import.meta.url), { recursive: true });
const external = ['@deepseek-ai/*', ...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)];
await build({
  entryPoints: { index: 'src/index.ts', plugin: 'src/plugin.ts' },
  outdir: 'lib', bundle: true, splitting: true, format: 'esm', platform: 'node',
  target: 'node22', external, sourcemap: true,
});
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external, sourcemap: true,
  banner: { js: `window.__ModuleLoader__.load({ id: '${pkg.name}', factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
});
for (const project of ['tsconfig.json', 'tsconfig.client.json']) {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', project,
    '--declaration', '--emitDeclarationOnly', '--outDir', 'lib/types'], { stdio: 'inherit' });
}
