import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distRoot = path.join(sourceRoot, 'dist');
export const digestFileName = '.command-center-digest.json';
let latestBuildReceipt;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function safeRelative(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) {
    throw new Error('Asset path must be a non-empty relative path');
  }
  const normalized = path.normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`Asset path escapes its root: ${relative}`);
  return normalized;
}

async function rejectSymlinks(root, relative = '') {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) throw new Error(`Symlinked asset is not allowed: ${childRelative}`);
    if (stat.isDirectory()) await rejectSymlinks(root, childRelative);
  }
}

async function digestTree(root) {
  await rejectSymlinks(root);
  const entries = [];
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (next === digestFileName) continue;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(root, next));
        entries.push({ path: next.split(path.sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') });
      } else throw new Error(`Unsupported built asset: ${next}`);
    }
  }
  await visit();
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { formatVersion: 1, files: entries, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

function freezeReceipt(manifest) {
  return Object.freeze({
    formatVersion: manifest.formatVersion,
    files: Object.freeze(manifest.files.map((entry) => Object.freeze({ ...entry }))),
    digest: manifest.digest
  });
}

function sameReceipt(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function build() {
  await rejectSymlinks(path.join(sourceRoot, 'src'));
  const existing = await lstat(distRoot).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error('The dist root must not be a symlink');
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await cp(path.join(sourceRoot, 'src', 'plugin.mjs'), path.join(distRoot, 'plugin.mjs'));
  await cp(path.join(sourceRoot, 'src', 'plugin-service.mjs'), path.join(distRoot, 'plugin-service.mjs'));
  await cp(path.join(sourceRoot, 'src', 'gateway-request-worker.mjs'), path.join(distRoot, 'gateway-request-worker.mjs'));
  await cp(path.join(sourceRoot, 'src', 'asset-handler.mjs'), path.join(distRoot, 'asset-handler.mjs'));
  await cp(path.join(sourceRoot, 'src', 'metadata'), path.join(distRoot, 'metadata'), { recursive: true, verbatimSymlinks: true });
  for (const directory of ['sources', 'bridge', 'activity', 'maintenance', 'migration', 'attention', 'search', 'topics', 'dashboard', 'notifications', 'http']) {
    await cp(path.join(sourceRoot, 'src', directory), path.join(distRoot, directory), { recursive: true, verbatimSymlinks: true });
  }
  await cp(path.join(sourceRoot, 'src', 'compatibility-tuple.json'), path.join(distRoot, 'compatibility-tuple.json'));
  await cp(path.join(sourceRoot, 'src', 'ui'), path.join(distRoot, 'ui'), { recursive: true, verbatimSymlinks: true });
  const receipt = freezeReceipt(await digestTree(distRoot));
  await writeFile(path.join(distRoot, digestFileName), `${JSON.stringify(receipt, null, 2)}\n`);
  latestBuildReceipt = receipt;
  return receipt;
}

export async function assertBuiltDigest(receipt = latestBuildReceipt) {
  if (!receipt || typeof receipt !== 'object') throw new Error('Built output receipt is unavailable');
  const rootStat = await lstat(distRoot).catch(() => undefined);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Built output is missing or unsafe');
  const canonicalRoot = await realpath(distRoot);
  if (!inside(sourceRoot, canonicalRoot)) throw new Error('Built output escapes the candidate root');
  const declared = JSON.parse(await readFile(path.join(distRoot, digestFileName), 'utf8'));
  const actual = await digestTree(distRoot);
  if (!sameReceipt(receipt, declared) || !sameReceipt(receipt, actual)) throw new Error('Built output digest drift detected');
  return actual;
}
