import { lstat, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const prohibited = [
  /-----BEGIN(?: [A-Z0-9][A-Z0-9 -]*)? PRIVATE KEY-----/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/=:-]{12,}/i,
  /(?:\b(?:set-cookie|cookie)\b|["'](?:set-cookie|cookie)["'])\s*[:=]\s*['\"]?[^\s'\";,]{8,}/i,
  /(?:\b(?:token|password|secret|api[_-]?key)\b|["'](?:token|password|secret|api[_-]?key)["'])\s*[=:]\s*['\"]?[^\s'\";,]+/i,
  /\b(?:ghp_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{4,}\b/,
  /(?:\/(?:Users|home)\/[A-Za-z0-9_.-]+\/|\/root\/|[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/])/i
];

function gitText(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error('Git path discovery failed')));
  });
}

async function gitPaths(root, args) {
  return (await gitText(root, args)).split('\0').filter(Boolean);
}

export async function repositoryPaths(root, generated = []) {
  const [tracked, staged, untracked] = await Promise.all([
    gitPaths(root, ['ls-files', '-z']), gitPaths(root, ['diff', '--cached', '--name-only', '-z']), gitPaths(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  return [...new Set([...tracked, ...staged, ...untracked, ...generated])].map((value) => path.resolve(root, value));
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * CI can locate its temporary or package/compiler caches beneath a copied
 * candidate. Those directories are not repository content, even when their
 * physical path happens to be below the candidate root.
 */
function excludedControllerRoots(candidateRoot, additionalRoots = []) {
  const values = [
    os.tmpdir(),
    process.env.npm_config_cache,
    process.env.NPM_CONFIG_CACHE,
    process.env.pnpm_config_store_dir,
    process.env.PNPM_STORE_PATH,
    process.env.YARN_CACHE_FOLDER,
    process.env.XDG_CACHE_HOME,
    process.env.NODE_COMPILE_CACHE,
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.BABEL_CACHE_PATH,
    process.env.TS_BUILD_INFO_FILE,
    ...additionalRoots
  ];
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => path.resolve(value))
    // A candidate can itself live below the system temp directory. Exclude
    // only controller roots nested within it; never exclude the candidate.
    .filter((value) => within(candidateRoot, value)))];
}

function isExcludedControllerPath(filename, roots) {
  return roots.some((root) => filename === root || within(root, filename));
}

function inspectContent(findings, relative, content) {
  const matched = prohibited.findIndex((pattern) => pattern.test(content));
  if (matched >= 0) findings.push({ path: relative, rule: `content-${matched + 1}` });
}

async function scanPath(root, filename, findings, read, visited, excludedRoots) {
  const relative = path.relative(root, filename);
  if (!within(root, filename) || isExcludedControllerPath(filename, excludedRoots) || visited.has(filename)) return;
  visited.add(filename);
  const stat = await lstat(filename).catch(() => undefined);
  if (!stat) return;
  if (stat.isSymbolicLink()) { findings.push({ path: relative, rule: 'symlink' }); return; }
  if (stat.isDirectory()) {
    for (const entry of await readdir(filename)) await scanPath(root, path.join(filename, entry), findings, read, visited, excludedRoots);
    return;
  }
  if (!stat.isFile()) return;
  try { inspectContent(findings, relative, await read(filename, 'utf8')); }
  catch { findings.push({ path: relative, rule: 'unreadable-content' }); }
}

export async function scanRepositorySafety(root, { generated = [], read = readFile, controllerRoots = [] } = {}) {
  const findings = [];
  const visited = new Set();
  const excludedRoots = excludedControllerRoots(root, controllerRoots);
  for (const filename of await repositoryPaths(root, generated)) {
    await scanPath(root, filename, findings, read, visited, excludedRoots);
  }
  const staged = await gitPaths(root, ['diff', '--cached', '--name-only', '-z']);
  for (const relative of staged) {
    const filename = path.resolve(root, relative);
    if (!within(root, filename) || isExcludedControllerPath(filename, excludedRoots)) continue;
    try { inspectContent(findings, relative, await gitText(root, ['show', `:${relative}`])); }
    catch { findings.push({ path: relative, rule: 'unreadable-index-content' }); }
  }
  for (const entry of (await gitText(root, ['ls-files', '-s', '-z'])).split('\0').filter(Boolean)) {
    const [metadata, relative] = entry.split('\t');
    if (metadata?.startsWith('120000 ') && relative) {
      const filename = path.resolve(root, relative);
      if (!isExcludedControllerPath(filename, excludedRoots)) findings.push({ path: relative, rule: 'cached-symlink' });
    }
  }
  if (findings.length) throw new Error(`Repository safety scan failed: ${findings.map((finding) => `${finding.path} (${finding.rule})`).join(', ')}`);
  return findings;
}
