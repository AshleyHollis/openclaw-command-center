import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { candidateRepositories } from './candidate-pair.mjs';

const commitPattern = /^[a-f0-9]{40}$/u;
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = message => { throw Object.assign(new Error(message), { code: 'candidate-input-invalid' }); };

async function git(checkout, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    child.stdout.on('data', chunk => { size += chunk.length; if (size <= 128 * 1024 * 1024) chunks.push(chunk); else child.kill(); });
    child.stderr.on('data', () => {});
    child.once('error', reject);
    child.once('close', code => code === 0 && size <= 128 * 1024 * 1024
      ? resolve(Buffer.concat(chunks)) : reject(new Error('Candidate Git object read failed')));
  });
}

function safePath(relative) {
  return relative && !relative.includes('\\') && !relative.includes('\0') &&
    relative.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}

function json(bytes) { return JSON.parse(bytes.toString('utf8')); }

/** Extract one committed CC tree into a new private candidate staging directory. */
export async function stageCandidateInputs({ sourceCheckout, sourceCommit, destination, hostCommit, hostPackageVersion, pluginApiVersion }) {
  if (!commitPattern.test(sourceCommit) || !commitPattern.test(hostCommit) ||
      typeof destination !== 'string' || !path.isAbsolute(destination) ||
      !/^\d{4}\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(hostPackageVersion ?? '')) fail('Candidate identities are incomplete');
  if ((await git(sourceCheckout, ['remote', 'get-url', 'origin'])).toString().trim() !== candidateRepositories.commandCenter ||
      (await git(sourceCheckout, ['cat-file', '-t', sourceCommit])).toString().trim() !== 'commit') fail('Candidate source repository or commit is invalid');
  const listing = (await git(sourceCheckout, ['ls-tree', '-r', '-z', sourceCommit])).toString('utf8').split('\0').filter(Boolean);
  if (!listing.length || listing.length > 20_000) fail('Candidate source inventory is invalid');
  const entries = listing.map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    if (!match || !safePath(match[3])) fail('Candidate source contains an unsafe member');
    return { mode: match[1], blob: match[2], file: match[3] };
  });
  const byName = new Map(entries.map(entry => [entry.file, entry]));
  for (const name of ['src/compatibility-tuple.json', 'package.json', 'package-lock.json']) if (!byName.has(name)) fail('Candidate source lacks a compatibility mirror');
  const content = new Map();
  for (const entry of entries) content.set(entry.file, await git(sourceCheckout, ['cat-file', 'blob', entry.blob]));
  const tuple = json(content.get('src/compatibility-tuple.json'));
  const pkg = json(content.get('package.json'));
  const lock = json(content.get('package-lock.json'));
  if (JSON.stringify(pkg.commandCenter?.compatibilityTuple) !== JSON.stringify(tuple) ||
      JSON.stringify(lock.packages?.['']?.commandCenter) !== JSON.stringify(pkg.commandCenter) ||
      tuple.host?.range !== `=${pkg.devDependencies?.openclaw}` ||
      pkg.devDependencies?.openclaw !== pkg.peerDependencies?.openclaw ||
      pkg.openclaw?.compat?.pluginApi !== tuple.pluginApi?.range ||
      pluginApiVersion !== tuple.pluginApi.range.slice(1)) fail('Candidate source/API dependency graph must match its exact released base');
  // A different SDK graph needs its own resolved lockfile and qualification.
  // Never fabricate dependency nodes by changing only the displayed version.
  const changedTuple = structuredClone(tuple);
  changedTuple.host = { range: `=${hostPackageVersion}`, commit: hostCommit };
  const overlay = [];
  if (JSON.stringify(changedTuple) !== JSON.stringify(tuple)) {
    pkg.commandCenter.compatibilityTuple = changedTuple;
    lock.packages[''].commandCenter.compatibilityTuple = changedTuple;
    for (const [name, value] of [['src/compatibility-tuple.json', changedTuple], ['package.json', pkg], ['package-lock.json', lock]]) {
      const before = content.get(name);
      const after = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      content.set(name, after);
      overlay.push({ path: name, before: digest(before), after: digest(after) });
    }
  }
  // Exclusive directory creation prevents replacing a worker's existing tree.
  await mkdir(destination);
  for (const entry of entries) {
    const target = path.join(destination, ...entry.file.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content.get(entry.file), { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
  const inventory = entries.map(entry => ({ path: entry.file, digest: digest(content.get(entry.file)) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ repository: candidateRepositories.commandCenter, sourceCommit,
    overlayDigest: overlay.length ? digest(JSON.stringify(overlay)) : null,
    inputTreeDigest: digest(JSON.stringify(inventory)), memberCount: inventory.length });
}
