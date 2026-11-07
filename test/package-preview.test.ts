import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  inspectPackageEntries,
  parsePackOutput,
  validateReleaseMetadata,
  verifyPackagePreview,
} from '../scripts/verify-package.mjs';

const validEntries = [
  { path: 'package.json', size: 100 },
  { path: 'README.md', size: 100 },
  { path: 'README_ZH.md', size: 100 },
  { path: 'LICENSE', size: 100 },
  { path: 'cordis.patch.yml', size: 10 },
  { path: 'dsh.plugin.json', size: 100 },
  { path: 'lib/index.js', size: 100 },
  { path: 'lib/client.js', size: 100 },
  { path: 'lib/plugin.js', size: 100 },
  { path: 'lib/types/index.d.ts', size: 100 },
];

test('package entry policy accepts only the documented runtime allowlist', async () => {
  await assert.doesNotReject(inspectPackageEntries(validEntries));
  for (const path of [
    'test/fixtures/secret.txt', 'src/plugin.ts', '.env', 'docs/private.md',
    'lib/private.pem', 'lib/token.txt', '../outside', '/absolute/path',
  ]) {
    await assert.rejects(inspectPackageEntries([...validEntries, { path, size: 10 }]), /package_file_forbidden/);
  }
});

test('package metadata parser rejects malformed or ambiguous npm pack output', () => {
  const good = [{ id: 'v2ex-dsh-client@0.1.0', name: 'v2ex-dsh-client', version: '0.1.0',
    filename: 'v2ex-dsh-client-0.1.0.tgz', files: validEntries }];
  assert.equal(parsePackOutput(JSON.stringify(good)).files.length, validEntries.length);
  for (const value of [{}, [], [good[0], good[0]], [{ ...good[0], name: 'other' }]]) {
    assert.throws(() => parsePackOutput(JSON.stringify(value)), /pack_metadata_invalid/);
  }
});

test('release metadata ties package exports, allowlist, engine and license to the manifest', () => {
  const pkg = {
    name: 'v2ex-dsh-client', version: '0.1.0', license: 'MIT',
    main: './lib/index.js', types: './lib/types/index.d.ts',
    files: ['lib', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README_ZH.md', 'LICENSE'],
    exports: {
      '.': { default: './lib/index.js', types: './lib/types/index.d.ts' },
      './client': { default: './lib/client.js', types: './lib/types/client/index.d.ts' },
      './package.json': './package.json',
    },
    engines: { node: '>=22', dsh: '>=0.2.1-rc.5 <0.3.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  };
  const manifest = { name: 'v2ex-dsh-client', version: '0.1.0', license: 'MIT',
    entry: { name: 'v2ex-dsh-client' }, client: { platform: 'web' },
    bundle: { patch: './cordis.patch.yml' } };
  assert.doesNotThrow(() => validateReleaseMetadata(pkg, manifest));
  assert.throws(() => validateReleaseMetadata({ ...pkg, license: 'UNLICENSED' }, manifest), /package_metadata_invalid/);
  assert.throws(() => validateReleaseMetadata({ ...pkg, files: [...pkg.files, 'src'] }, manifest), /package_metadata_invalid/);
});

test('package scanner rejects static credentials', async () => {
  await assert.rejects(inspectPackageEntries(
    [...validEntries, { path: 'lib/index.js.map', size: 100 }],
    async path => path === 'README.md'
      ? 'Authorization: Bearer STATIC_PLACEHOLDER_SECRET_123456789'
      : path.endsWith('.map') ? '{"version":3,"sources":["../src/index.ts"]}' : 'safe content',
  ), /credential_value_forbidden/);
});

test('package scanner rejects absolute source-map paths', async () => {
  await assert.rejects(inspectPackageEntries(
    [...validEntries, { path: 'lib/index.js.map', size: 100 }],
    async path => path.endsWith('.map')
      ? JSON.stringify({ version: 3, sources: ['/Users/example/project/src/index.ts'] })
      : 'safe content',
  ), /absolute_source_path/);
});

test('package scanner rejects token-shaped values even when unlabeled', async () => {
  await assert.rejects(inspectPackageEntries(validEntries, async path => path === 'README.md'
    ? '00000000-1111-4222-8333-444444444444'
    : 'safe content'), /credential_value_forbidden/);
});

test('package preview contains required artifacts and excludes fixtures', async () => {
  const result = await verifyPackagePreview();
  assert.ok(result.files.includes('lib/index.js'));
  assert.ok(result.files.includes('lib/client.js'));
  assert.ok(result.files.includes('README_ZH.md'));
  assert.equal(result.files.some(file => file.startsWith('test/')), false);
});

test('release verifier is deterministic and never invokes the live verifier', async () => {
  const source = await readFile(new URL('../scripts/verify-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /verify:live-api|verify-live-api/);
  for (const command of ['typecheck', 'build', 'test', 'test:integration', 'test:e2e', 'verify:package']) {
    assert.match(source, new RegExp(JSON.stringify(command).slice(1, -1)));
  }
});
