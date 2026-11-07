import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { dirname, posix, resolve, sep, win32 } from 'node:path';
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

function safeSourceLayer(value, allowEmpty) {
  if (typeof value !== 'string' || value.length > 2_048 || (!allowEmpty && value.length === 0)) return false;
  if (value === '') return allowEmpty;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:/i.test(value) ||
      posix.isAbsolute(value) || win32.isAbsolute(value) || value.includes('\\') || value.startsWith('//')) return false;
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..') || posix.normalize(value) !== value) return false;
  return true;
}

function safeSourcePath(value, allowEmpty = false) {
  let current = value;
  for (let depth = 0; depth <= 5; depth++) {
    if (!safeSourceLayer(current, allowEmpty)) return false;
    let decoded;
    try { decoded = decodeURIComponent(current); } catch { return false; }
    if (decoded === current) return true;
    if (depth === 5) return false;
    current = decoded;
  }
  return false;
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
    if (sourceRoot !== undefined && !safeSourcePath(sourceRoot, true)) {
      fail(`absolute_source_path:${path}`);
    }
    for (const source of map.sources) {
      if (!safeSourcePath(source)) {
        fail(`absolute_source_path:${path}`);
      }
    }
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function openWithoutFollowing(absolute, path) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  try {
    return await open(absolute, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (noFollow !== 0 && error && typeof error === 'object' &&
        (error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP')) {
      try { return await open(absolute, constants.O_RDONLY); }
      catch { fail(`package_file_forbidden:${path}`); }
    }
    fail(`package_file_forbidden:${path}`);
  }
}

export async function readStablePackageFile(baseDirectory, path, expectedSize, hooks = {}) {
  if (!safePath(path) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_FILE_BYTES) {
    fail(`package_size_invalid:${path}`);
  }
  const absolute = resolve(baseDirectory, path);
  if (!absolute.startsWith(`${resolve(baseDirectory)}${sep}`)) fail(`package_file_forbidden:${path}`);
  let beforePath;
  try { beforePath = await lstat(absolute, { bigint: true }); }
  catch { fail(`package_file_forbidden:${path}`); }
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) fail(`package_file_forbidden:${path}`);

  const handle = await openWithoutFollowing(absolute, path);
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || !sameSnapshot(beforePath, initial)) fail(`package_file_changed:${path}`);
    if (initial.size > BigInt(MAX_FILE_BYTES)) fail(`package_size_invalid:${path}`);
    if (initial.size !== BigInt(expectedSize)) fail(`package_size_mismatch:${path}`);
    if (typeof hooks.afterInitialStat === 'function') await hooks.afterInitialStat();

    const chunks = [];
    let total = 0;
    while (total <= expectedSize) {
      const requestSize = Math.min(64 * 1024, expectedSize + 1 - total, MAX_FILE_BYTES + 1 - total);
      if (requestSize <= 0) break;
      const chunk = Buffer.allocUnsafe(requestSize);
      const { bytesRead } = await handle.read(chunk, 0, requestSize, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expectedSize || total > MAX_FILE_BYTES) fail(`package_size_mismatch:${path}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total !== expectedSize) fail(`package_size_mismatch:${path}`);

    const finalDescriptor = await handle.stat({ bigint: true });
    if (!finalDescriptor.isFile() || !sameSnapshot(initial, finalDescriptor)) fail(`package_file_changed:${path}`);
    let finalPath;
    try { finalPath = await lstat(absolute, { bigint: true }); }
    catch { fail(`package_file_changed:${path}`); }
    if (!finalPath.isFile() || finalPath.isSymbolicLink() || !sameSnapshot(finalDescriptor, finalPath)) {
      fail(`package_file_changed:${path}`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function inspectPackageEntries(entries, read = undefined) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 2_000) fail('pack_metadata_invalid');
  const seen = new Set();
  const sizes = new Map();
  for (const entry of entries) {
    const path = entry?.path;
    const size = entry?.size;
    if (!safePath(path) || (!TOP_LEVEL.has(path) && !LIB_FILE.test(path)) || seen.has(path)) {
      fail(`package_file_forbidden:${String(path)}`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail(`package_size_invalid:${path}`);
    seen.add(path);
    sizes.set(path, size);
  }
  for (const path of REQUIRED) if (!seen.has(path)) fail(`package_file_missing:${path}`);

  const readEntry = read ?? ((path, expectedSize) => readStablePackageFile(root, path, expectedSize));
  let actualTotal = 0;
  for (const path of seen) {
    const bytes = await readEntry(path, sizes.get(path));
    if (!Buffer.isBuffer(bytes)) fail(`package_content_invalid:${path}`);
    if (bytes.byteLength > MAX_FILE_BYTES) fail(`package_size_invalid:${path}`);
    if (bytes.byteLength !== sizes.get(path)) fail(`package_size_mismatch:${path}`);
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_PACKAGE_BYTES) fail('package_size_invalid:total');
    if (path === 'LICENSE' || /\.(?:js|map|ts|json|md|yml)$/.test(path)) {
      inspectText(path, bytes.toString('utf8'));
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

function collectLocalTargets(value, targets, depth = 0) {
  if (depth > 12) fail('package_metadata_invalid');
  if (typeof value === 'string') {
    if (!value.startsWith('./')) fail('package_metadata_invalid');
    const target = value.slice(2);
    if (!safePath(target) || (!TOP_LEVEL.has(target) && !LIB_FILE.test(target))) fail('package_metadata_invalid');
    targets.add(target);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLocalTargets(item, targets, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') fail('package_metadata_invalid');
  for (const nested of Object.values(value)) collectLocalTargets(nested, targets, depth + 1);
}

export function validateReleaseMetadata(pkg, manifest, patchText, packageFiles) {
  const exactFiles = ['lib', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README_ZH.md', 'LICENSE'];
  if (!pkg || !manifest || pkg.name !== 'v2ex-dsh-client' || pkg.version !== manifest.version ||
      pkg.name !== manifest.name || pkg.license !== 'MIT' || manifest.license !== pkg.license ||
      pkg.description !== manifest.description ||
      pkg.main !== './lib/index.js' || pkg.types !== './lib/types/index.d.ts' ||
      JSON.stringify(pkg.files) !== JSON.stringify(exactFiles) ||
      pkg.exports?.['.']?.default !== pkg.main || pkg.exports?.['.']?.types !== pkg.types ||
      pkg.exports?.['./client']?.default !== './lib/client.js' ||
      pkg.exports?.['./client']?.types !== './lib/types/client/index.d.ts' ||
      pkg.exports?.['./package.json'] !== './package.json' ||
      pkg.engines?.node !== '>=22' || pkg.engines?.dsh !== '>=0.2.1-rc.5 <0.3.0' ||
      manifest.entry?.name !== pkg.name || manifest.client?.platform !== 'web' ||
      pkg.dsh?.client?.platform !== manifest.client.platform ||
      JSON.stringify(manifest.bundle) !== JSON.stringify(pkg.dsh?.bundle) ||
      typeof patchText !== 'string' || !Array.isArray(packageFiles)) {
    fail('package_metadata_invalid');
  }
  const expectedPatch = `- insert:\n    - id: ${pkg.name}\n      name: ${pkg.name}\n`;
  if (patchText.replace(/\r\n/g, '\n') !== expectedPatch) fail('package_metadata_invalid');
  const targets = new Set(['dsh.plugin.json', 'README.md', 'README_ZH.md', 'LICENSE', 'lib/plugin.js']);
  collectLocalTargets(pkg.main, targets);
  collectLocalTargets(pkg.types, targets);
  collectLocalTargets(pkg.exports, targets);
  collectLocalTargets(pkg.dsh.bundle, targets);
  collectLocalTargets(manifest.bundle, targets);
  const files = new Set(packageFiles);
  for (const target of targets) if (!files.has(target)) fail(`package_file_missing:${target}`);
}

export async function verifyPackagePreview() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(root, 'dsh.plugin.json'), 'utf8'));
  const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8');
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
  validateReleaseMetadata(pkg, manifest, patch, metadata.files.map(entry => entry.path));
  const files = await inspectPackageEntries(metadata.files);
  return { ok: true, name: pkg.name, version: pkg.version, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await verifyPackagePreview())}\n`); }
  catch { process.stderr.write('{"ok":false,"code":"package_verification_failed"}\n'); process.exitCode = 1; }
}
