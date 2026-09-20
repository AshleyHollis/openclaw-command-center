import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_LIVE_FEATURES } from './release-scope.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRequire = createRequire(path.join(process.cwd(), 'package.json'));
export const distRoot = path.join(sourceRoot, 'dist');
export const digestFileName = '.command-center-digest.json';
let latestBuildReceipt;
let buildQueue = Promise.resolve();

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function installedPackageRoot(packageName) {
  // Isolated build tests import a copied source tree but intentionally keep
  // the caller's installed, lockfile-resolved dependency set. Resolve from
  // that build environment instead of relying on a node_modules copy beside
  // every temporary source snapshot.
  return path.resolve(path.dirname(buildRequire.resolve(packageName)), '..');
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

const TEXT_ASSET_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt']);

async function normalizeTextAssets(root, relative = '') {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) await normalizeTextAssets(root, next);
    else if (entry.isFile() && next !== 'plugin-manifest.json' && TEXT_ASSET_EXTENSIONS.has(path.extname(entry.name))) {
      const file = path.join(root, next);
      const source = await readFile(file, 'utf8');
      const normalized = source.replace(/\r\n?/gu, '\n');
      if (normalized !== source) await writeFile(file, normalized);
    }
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

async function writePdfResourceBundle(pdfjs, destination) {
  const resources = {};
  for (const directory of ['cmaps', 'standard_fonts']) {
    const entries = await readdir(path.join(pdfjs, directory), { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      resources[`${directory}/${entry.name}`] = (await readFile(path.join(pdfjs, directory, entry.name))).toString('base64');
    }
  }
  await writeFile(destination, `// Generated from the lockfile-resolved PDF.js resources.\nexport const pdfResources = Object.freeze(${JSON.stringify(resources)});\n`);
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

async function buildUnlocked() {
  await rejectSymlinks(path.join(sourceRoot, 'src'));
  const existing = await lstat(distRoot).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error('The dist root must not be a symlink');
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await cp(path.join(sourceRoot, 'src', 'plugin.mjs'), path.join(distRoot, 'plugin.mjs'));
  // Resolve the single authored schema at build time. Built modules never read
  // mutable package-root configuration outside their verified dist receipt.
  const pluginManifest = JSON.parse(await readFile(path.join(sourceRoot, 'openclaw.plugin.json'), 'utf8'));
  // Host-consumed declarations (native UI, CLI and route contracts) are part
  // of the same sealed build, not mutable package-root packaging inputs.
  await cp(path.join(sourceRoot, 'openclaw.plugin.json'), path.join(distRoot, 'plugin-manifest.json'));
  await writeFile(path.join(distRoot, 'plugin-config.mjs'), `export const pluginConfigSchema = ${JSON.stringify(pluginManifest.configSchema)};\n`);
  await cp(path.join(sourceRoot, 'src', 'plugin-service.mjs'), path.join(distRoot, 'plugin-service.mjs'));
  await cp(path.join(sourceRoot, 'src', 'release-scope.mjs'), path.join(distRoot, 'release-scope.mjs'));
  await cp(path.join(sourceRoot, 'src', 'compatibility.mjs'), path.join(distRoot, 'compatibility.mjs'));
  await cp(path.join(sourceRoot, 'src', 'asset-handler.mjs'), path.join(distRoot, 'asset-handler.mjs'));
  await cp(path.join(sourceRoot, 'src', 'metadata'), path.join(distRoot, 'metadata'), { recursive: true, verbatimSymlinks: true });
  for (const directory of ['sources', 'bridge', 'activity', 'maintenance', 'migration', 'attention', 'open-loops', 'search', 'topics', 'dashboard', 'notifications', 'http', 'native-ui', 'documents']) {
    await cp(path.join(sourceRoot, 'src', directory), path.join(distRoot, directory), { recursive: true, verbatimSymlinks: true });
  }
  // Native Control UI assets are served from one declared directory. Project
  // the root build-owned policy into that directory instead of making the
  // browser resolve a parent asset outside the host's immutable asset set.
  await writeFile(path.join(distRoot, 'native-ui', 'release-scope.mjs'), `export const FIRST_LIVE_FEATURES = Object.freeze(${JSON.stringify(FIRST_LIVE_FEATURES)});\n`);
  await cp(path.join(sourceRoot, 'src', 'compatibility-tuple.json'), path.join(distRoot, 'compatibility-tuple.json'));
  // These two browser-only modules are deliberately copied from the pinned
  // package tree into the sealed native asset set. Native Control UI assets
  // cannot resolve the build machine's node_modules directory at runtime.
  await mkdir(path.join(distRoot, 'native-ui', 'vendor'), { recursive: true });
  const markdownIt = installedPackageRoot('markdown-it');
  const dompurify = installedPackageRoot('dompurify');
  await cp(path.join(markdownIt, 'dist', 'browser', 'markdown-it.esm.min.mjs'), path.join(distRoot, 'native-ui', 'vendor', 'markdown-it.mjs'));
  await cp(path.join(dompurify, 'dist', 'purify.es.mjs'), path.join(distRoot, 'native-ui', 'vendor', 'purify.es.mjs'));
  await cp(path.join(markdownIt, 'LICENSE'), path.join(distRoot, 'native-ui', 'vendor', 'markdown-it-LICENSE.txt'));
    await cp(path.join(dompurify, 'LICENSE'), path.join(distRoot, 'native-ui', 'vendor', 'dompurify-LICENSE.txt'));
    const pdfjs = installedPackageRoot('pdfjs-dist');
    await cp(path.join(pdfjs, 'build', 'pdf.mjs'), path.join(distRoot, 'native-ui', 'vendor', 'pdf.mjs'));
    await cp(path.join(pdfjs, 'build', 'pdf.worker.mjs'), path.join(distRoot, 'native-ui', 'vendor', 'pdf.worker.mjs'));
    await writePdfResourceBundle(pdfjs, path.join(distRoot, 'native-ui', 'vendor', 'pdf-resources.mjs'));
    await cp(path.join(pdfjs, 'LICENSE'), path.join(distRoot, 'native-ui', 'vendor', 'pdfjs-LICENSE.txt'));
  await cp(path.join(sourceRoot, 'src', 'ui'), path.join(distRoot, 'ui'), { recursive: true, verbatimSymlinks: true });
  // Git may materialize authored text with platform-native line endings. Seal
  // one byte-identical plugin on Windows and Linux so the release baseline,
  // package receipt and deployment evidence all name the same build digest.
  await normalizeTextAssets(distRoot);
  const receipt = freezeReceipt(await digestTree(distRoot));
  await writeFile(path.join(distRoot, digestFileName), `${JSON.stringify(receipt, null, 2)}\n`);
  latestBuildReceipt = receipt;
  return receipt;
}

// Focused contract and harness tests may request the build concurrently. Keep
// the generated tree whole between callers so one build cannot remove files
// while another imports its receipt.
export function build() {
  const next = buildQueue.then(() => buildUnlocked());
  buildQueue = next.catch(() => {});
  return next;
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

/** Consume a previously sealed artifact without rebuilding or writing its tree. */
export async function readBuiltReceipt() {
  const receipt = JSON.parse(await readFile(path.join(distRoot, digestFileName), 'utf8'));
  await assertBuiltDigest(receipt);
  return freezeReceipt(receipt);
}
