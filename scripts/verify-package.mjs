import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = new Set([
  'package.json', 'README.md', 'README_ZH.md', 'LICENSE', 'cordis.patch.yml',
  'dsh.plugin.json', 'lib/index.js', 'lib/client.js', 'lib/plugin.js', 'lib/types/index.d.ts',
]);
const TOP_LEVEL = new Set(['package.json', 'README.md', 'README_ZH.md', 'LICENSE', 'cordis.patch.yml', 'dsh.plugin.json']);
const LIB_FILE = /^lib\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.(?:js|js\.map|d\.ts)$/;
const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const STATIC_BEARER = /(?:authorization\s*[:=]\s*)?(?:bearer\s+)[a-z0-9._~+\/-]{12,}/i;
const STATIC_TOKEN_ASSIGNMENT = /(?:token|secret|credential)\s*[:=]\s*["'][a-z0-9._~+\/-]{20,}["']/i;
const MAX_FILE_BYTES = 5_000_000;
const MAX_PACKAGE_BYTES = 25_000_000;

function fail(code) { throw new Error(code); }

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 &&
    !path.startsWith('/') && !path.startsWith('\\') && !path.includes('\\') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function inspectText(path, text) {
  if (UUID_TOKEN.test(text) || STATIC_BEARER.test(text) || STATIC_TOKEN_ASSIGNMENT.test(text)) {
    fail(`credential_value_forbidden:${path}`);
  }
  if (path.endsWith('.map')) {
    let map;
    try { map = JSON.parse(text); } catch { fail(`source_map_invalid:${path}`); }
    if (!map || typeof map !== 'object' || !Array.isArray(map.sources)) fail(`source_map_invalid:${path}`);
    const sourceRoot = map.sourceRoot;
    if (typeof sourceRoot === 'string' && (sourceRoot.startsWith('/') || /^[a-z]:[\\/]/i.test(sourceRoot) || /^file:/i.test(sourceRoot))) {
      fail(`absolute_source_path:${path}`);
    }
    for (const source of map.sources) {
      if (typeof source !== 'string' || source.startsWith('/') || /^[a-z]:[\\/]/i.test(source) || /^file:/i.test(source)) {
        fail(`absolute_source_path:${path}`);
      }
    }
  }
}

export async function inspectPackageEntries(entries, read = undefined) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 2_000) fail('pack_metadata_invalid');
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    const path = entry?.path;
    const size = entry?.size;
    if (!safePath(path) || (!TOP_LEVEL.has(path) && !LIB_FILE.test(path)) || seen.has(path)) {
      fail(`package_file_forbidden:${String(path)}`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail(`package_size_invalid:${path}`);
    total += size;
    if (total > MAX_PACKAGE_BYTES) fail('package_size_invalid:total');
    seen.add(path);
  }
  for (const path of REQUIRED) if (!seen.has(path)) fail(`package_file_missing:${path}`);

  const readEntry = read ?? (async path => {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) fail(`package_file_forbidden:${path}`);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) fail(`package_file_forbidden:${path}`);
    return readFile(absolute, 'utf8');
  });
  for (const path of seen) {
    if (path === 'LICENSE' || /\.(?:js|map|ts|json|md|yml)$/.test(path)) {
      inspectText(path, await readEntry(path));
    }
  }
  return [...seen].sort();
}

export function parsePackOutput(output, expectedName = 'v2ex-dsh-client', expectedVersion = '0.1.0') {
  let parsed;
  try { parsed = JSON.parse(output); } catch { fail('pack_metadata_invalid'); }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail('pack_metadata_invalid');
  const metadata = parsed[0];
  const expectedFilename = `${expectedName.replace(/^@/, '').replace('/', '-')}-${expectedVersion}.tgz`;
  if (!metadata || metadata.name !== expectedName || metadata.version !== expectedVersion ||
      metadata.id !== `${expectedName}@${expectedVersion}` || metadata.filename !== expectedFilename ||
      !Array.isArray(metadata.files)) fail('pack_metadata_invalid');
  return metadata;
}

export function validateReleaseMetadata(pkg, manifest) {
  const exactFiles = ['lib', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README_ZH.md', 'LICENSE'];
  if (!pkg || !manifest || pkg.name !== 'v2ex-dsh-client' || pkg.version !== manifest.version ||
      pkg.name !== manifest.name || pkg.license !== 'MIT' || manifest.license !== pkg.license ||
      pkg.main !== './lib/index.js' || pkg.types !== './lib/types/index.d.ts' ||
      JSON.stringify(pkg.files) !== JSON.stringify(exactFiles) ||
      pkg.exports?.['.']?.default !== pkg.main || pkg.exports?.['.']?.types !== pkg.types ||
      pkg.exports?.['./client']?.default !== './lib/client.js' ||
      pkg.exports?.['./client']?.types !== './lib/types/client/index.d.ts' ||
      pkg.exports?.['./package.json'] !== './package.json' ||
      pkg.engines?.node !== '>=22' || pkg.engines?.dsh !== '>=0.2.1-rc.5 <0.3.0' ||
      manifest.entry?.name !== pkg.name || manifest.client?.platform !== 'web' ||
      JSON.stringify(manifest.bundle) !== JSON.stringify(pkg.dsh?.bundle)) {
    fail('package_metadata_invalid');
  }
}

export async function verifyPackagePreview() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(root, 'dsh.plugin.json'), 'utf8'));
  validateReleaseMetadata(pkg, manifest);
  const cache = await mkdtemp(resolve(tmpdir(), 'v2ex-dsh-npm-cache-'));
  let output;
  try {
    output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_loglevel: 'silent', npm_config_cache: cache },
    });
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
  const metadata = parsePackOutput(output, pkg.name, pkg.version);
  const files = await inspectPackageEntries(metadata.files);
  return { ok: true, name: pkg.name, version: pkg.version, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await verifyPackagePreview())}\n`); }
  catch { process.stderr.write('{"ok":false,"code":"package_verification_failed"}\n'); process.exitCode = 1; }
}
