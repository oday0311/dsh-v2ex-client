import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  inspectPackageEntries,
  parsePackOutput,
  readStablePackageFile,
  validateReleaseMetadata,
  verifyPackagePreview,
} from '../scripts/verify-package.mjs';

const validEntries = [
  { path: 'package.json', size: 100 },
  { path: 'README.md', size: 100 },
  { path: 'README_ZH.md', size: 100 },
  { path: 'LICENSE', size: 100 },
  { path: 'cordis.patch.yml', size: 100 },
  { path: 'dsh.plugin.json', size: 100 },
  { path: 'lib/index.js', size: 100 },
  { path: 'lib/client.js', size: 100 },
  { path: 'lib/plugin.js', size: 100 },
  { path: 'lib/types/index.d.ts', size: 100 },
  { path: 'lib/types/client/index.d.ts', size: 100 },
];

const fixtureReader = (entries = validEntries, overrides: Readonly<Record<string, Buffer>> = {}) =>
  async (path: string) => overrides[path] ?? Buffer.alloc(entries.find(entry => entry.path === path)?.size ?? 0, 0x20);

test('package entry policy accepts only the documented runtime allowlist', async () => {
  await assert.doesNotReject(inspectPackageEntries(validEntries, fixtureReader()));
  for (const path of [
    'test/fixtures/secret.txt', 'src/plugin.ts', '.env', 'docs/private.md',
    'lib/private.pem', 'lib/token.txt', '../outside', '/absolute/path',
  ]) {
    const entries = [...validEntries, { path, size: 10 }];
    await assert.rejects(inspectPackageEntries(entries, fixtureReader(entries)), /package_file_forbidden/);
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
    description: 'Read-only V2EX browsing and discovery for DeepSeek Harness',
    main: './lib/index.js', types: './lib/types/index.d.ts',
    files: ['lib', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README_ZH.md', 'LICENSE'],
    exports: {
      '.': { default: './lib/index.js', types: './lib/types/index.d.ts' },
      './client': { default: './lib/client.js', types: './lib/types/client/index.d.ts' },
      './package.json': './package.json',
    },
    engines: { node: '>=22', dsh: '>=0.2.1-rc.5 <0.3.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  };
  const manifest = { name: 'v2ex-dsh-client', version: '0.1.0', license: 'MIT',
    description: 'Read-only V2EX browsing and discovery for DeepSeek Harness',
    entry: { name: 'v2ex-dsh-client' }, client: { platform: 'web' },
    bundle: { patch: './cordis.patch.yml' } };
  const patch = '- insert:\n    - id: v2ex-dsh-client\n      name: v2ex-dsh-client\n';
  const files = validEntries.map(entry => entry.path);
  assert.doesNotThrow(() => validateReleaseMetadata(pkg, manifest, patch, files));
  assert.throws(() => validateReleaseMetadata({ ...pkg, license: 'UNLICENSED' }, manifest, patch, files), /package_metadata_invalid/);
  assert.throws(() => validateReleaseMetadata({ ...pkg, files: [...pkg.files, 'src'] }, manifest, patch, files), /package_metadata_invalid/);
  assert.throws(() => validateReleaseMetadata(pkg, { ...manifest, description: 'mismatch' }, patch, files), /package_metadata_invalid/);
  assert.throws(() => validateReleaseMetadata(pkg, manifest, patch.replace(/name:.+/, 'name: other'), files), /package_metadata_invalid/);
  for (const target of ['lib/index.js', 'lib/types/index.d.ts', 'lib/client.js',
    'lib/types/client/index.d.ts', 'package.json', 'cordis.patch.yml']) {
    assert.throws(() => validateReleaseMetadata(pkg, manifest, patch, files.filter(path => path !== target)),
      new RegExp(`package_file_missing:${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('package scanner bounds actual bytes before decoding and rejects metadata mismatch', async () => {
  const oversized = Buffer.alloc(5_000_001, 0x20) as Buffer & { toString: () => string };
  oversized.toString = () => { throw new Error('must not decode oversized input'); };
  await assert.rejects(inspectPackageEntries(validEntries.map(entry => ({ ...entry, size: 1 })), async path =>
    path === 'lib/index.js' ? oversized : Buffer.alloc(1, 0x20)), /package_size_invalid:lib\/index\.js/);
  await assert.rejects(inspectPackageEntries(validEntries, async path =>
    path === 'lib/index.js' ? Buffer.alloc(101, 0x20) : Buffer.alloc(100, 0x20)),
  /package_size_mismatch:lib\/index\.js/);
});

test('descriptor reader rejects growth, truncation, replacement, and initial symlinks', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'v2ex-package-reader-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(resolve(directory, 'growth.js'), 'safe');
  await assert.rejects(readStablePackageFile(directory, 'growth.js', 4, {
    afterInitialStat: () => appendFile(resolve(directory, 'growth.js'), 'x'),
  }), /package_size_mismatch|package_file_changed/);

  await writeFile(resolve(directory, 'truncated.js'), 'safe');
  await assert.rejects(readStablePackageFile(directory, 'truncated.js', 4, {
    afterInitialStat: () => truncate(resolve(directory, 'truncated.js'), 2),
  }), /package_size_mismatch|package_file_changed/);

  await writeFile(resolve(directory, 'replaced.js'), 'safe');
  await assert.rejects(readStablePackageFile(directory, 'replaced.js', 4, {
    afterInitialStat: async () => {
      await rename(resolve(directory, 'replaced.js'), resolve(directory, 'original.js'));
      await writeFile(resolve(directory, 'replaced.js'), 'safe');
    },
  }), /package_file_changed/);

  await writeFile(resolve(directory, 'target.js'), 'safe');
  await symlink(resolve(directory, 'target.js'), resolve(directory, 'linked.js'));
  await assert.rejects(readStablePackageFile(directory, 'linked.js', 4), /package_file_forbidden/);
});

test('descriptor reader rejects a same-size symlink swap and an oversized file before allocation', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'v2ex-package-swap-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, 'victim.js'), 'safe');
  await writeFile(resolve(directory, 'other.js'), 'same');
  await assert.rejects(readStablePackageFile(directory, 'victim.js', 4, {
    afterInitialStat: async () => {
      await rename(resolve(directory, 'victim.js'), resolve(directory, 'saved.js'));
      await symlink(resolve(directory, 'other.js'), resolve(directory, 'victim.js'));
    },
  }), /package_file_changed|package_file_forbidden/);

  await writeFile(resolve(directory, 'oversized.js'), Buffer.alloc(5_000_001, 0x20));
  await assert.rejects(readStablePackageFile(directory, 'oversized.js', 1), /package_size_invalid/);
});

test('package scanner enforces total actual bytes rather than trusting only metadata totals', async () => {
  const entries = [...validEntries, ...Array.from({ length: 7 }, (_, index) => ({
    path: `lib/extra-${index}.js`, size: 4_000_000,
  }))].map(entry => ({ ...entry, size: entry.path.startsWith('lib/extra-') ? entry.size : 100 }));
  const shared = Buffer.alloc(4_000_000, 0x20);
  await assert.rejects(inspectPackageEntries(entries, async path =>
    path.startsWith('lib/extra-') ? shared : Buffer.alloc(100, 0x20)), /package_size_invalid:total/);
});

test('package scanner rejects static credentials', async () => {
  const credential = Buffer.from('Authorization: Bearer STATIC_PLACEHOLDER_SECRET_123456789');
  const map = Buffer.from('{"version":3,"sources":["src/index.ts"]}');
  const entries = [...validEntries.map(entry => entry.path === 'README.md' ? { ...entry, size: credential.byteLength } : entry),
    { path: 'lib/index.js.map', size: map.byteLength }];
  await assert.rejects(inspectPackageEntries(
    entries, fixtureReader(entries, { 'README.md': credential, 'lib/index.js.map': map }),
  ), /credential_value_forbidden/);
});

test('package scanner rejects absolute source-map paths', async () => {
  let overEncoded = '../src/index.ts';
  for (let depth = 0; depth < 7; depth++) overEncoded = encodeURIComponent(overEncoded);
  const unsafe = ['/root/index.ts', 'C:\\root\\index.ts', 'C:/root/index.ts',
    '\\\\server\\share\\index.ts', '\\rooted\\index.ts', '//server/share/index.ts',
    'file:///root/index.ts', 'https://example.test/index.ts', '../src/index.ts',
    '%252e%252e%252fsrc%252findex.ts', '%25252froot%252findex.ts',
    'file%25253A%252f%252f%252froot%252findex.ts', '%25255croot%25255cindex.ts', '%not-hex',
    overEncoded];
  for (const source of unsafe) {
    const map = Buffer.from(JSON.stringify({ version: 3, sources: [source] }));
    const entries = [...validEntries, { path: 'lib/index.js.map', size: map.byteLength }];
    await assert.rejects(inspectPackageEntries(entries, fixtureReader(entries, { 'lib/index.js.map': map })),
      /absolute_source_path/);
    const rooted = Buffer.from(JSON.stringify({ version: 3, sourceRoot: source, sources: ['src/index.ts'] }));
    const rootedEntries = [...validEntries, { path: 'lib/index.js.map', size: rooted.byteLength }];
    await assert.rejects(inspectPackageEntries(rootedEntries,
      fixtureReader(rootedEntries, { 'lib/index.js.map': rooted })), /absolute_source_path/);
  }
});

test('package scanner rejects token-shaped values even when unlabeled', async () => {
  const token = Buffer.from('00000000-1111-4222-8333-444444444444');
  const entries = validEntries.map(entry => entry.path === 'README.md' ? { ...entry, size: token.byteLength } : entry);
  await assert.rejects(inspectPackageEntries(entries, fixtureReader(entries, { 'README.md': token })),
    /credential_value_forbidden/);
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
