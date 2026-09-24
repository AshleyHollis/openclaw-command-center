import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { pinnedHost } from '../../src/host-harness.mjs';

const execFileAsync = promisify(execFile);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function json(file, read = readFile) {
  try { return JSON.parse(await read(file, 'utf8')); }
  catch { fail('preflight-identity', `Required host identity file is absent or invalid: ${path.basename(file)}`); }
}

export function assertSafePluginMode(mode, label) {
  if ((mode & 0o002) !== 0) fail('preflight-unsafe-path', `Plugin path is world-writable: ${label}`);
}

export function assertBoundCronSchema(validate) {
  if (typeof validate !== 'function') fail('preflight-capability', 'Installed host does not export the Cron add validator.');
  const fictionalDeclaration = {
    id: '00000000-0000-4000-8000-000000000001', name: 'Fictional preflight', enabled: true,
    deleteAfterRun: false, schedule: { kind: 'at', at: '2026-10-01T00:00:00.000Z' },
    payload: { kind: 'systemEvent', text: 'Fictional preflight' }, sessionTarget: 'main', wakeMode: 'next-heartbeat'
  };
  if (validate(fictionalDeclaration) !== true) fail('preflight-capability', 'Installed host cron.add rejects the explicit ID required by bound Reminders.');
}

/** Cheap identity/capability gate. The acceptance harness still performs full host integrity verification. */
export async function assertFastHostAdmission(descriptor, { requireBoundCron = false, read = readFile,
  readCommit = async checkout => (await execFileAsync('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim(),
  loadCronValidator = async installed => (await import(pathToFileURL(path.join(installed, 'dist/gateway/protocol/index.js')).href)).validateCronAddParams } = {}) {
  if (descriptor?.schemaVersion !== 2) fail('preflight-identity', 'Installed-package acceptance needs a packaged host descriptor.');
  const installed = path.join(descriptor.runtimeRoot, 'node_modules/openclaw');
  const [sourceCommit, receipt, build, hostPackage] = await Promise.all([
    readCommit(descriptor.checkout), json(path.join(path.dirname(descriptor.checkout), 'receipt.json'), read),
    json(path.join(installed, 'dist/build-info.json'), read), json(path.join(installed, 'package.json'), read)
  ]);
  if (sourceCommit !== descriptor.commit || receipt.commit !== descriptor.commit
    || receipt.sourceDigest !== descriptor.integrity.sourceDigest
    || receipt.executableDigest !== descriptor.integrity.executableDigest
    || receipt.contractDigest !== descriptor.integrity.contractDigest
    || receipt.packageDigest !== descriptor.integrity.packageDigest || receipt.runtimeDigest !== descriptor.integrity.runtimeDigest
    || build.commit !== descriptor.commit || build.version !== pinnedHost.packageVersion
    || hostPackage.version !== pinnedHost.packageVersion || hostPackage.name !== 'openclaw') {
    fail('preflight-identity', 'Host checkout, receipt and installed package do not describe the same pinned build.');
  }
  if (requireBoundCron) {
    let validator;
    try { validator = await loadCronValidator(installed); }
    catch { fail('preflight-capability', 'Installed host Cron add schema could not be loaded.'); }
    assertBoundCronSchema(validator);
  }
  return Object.freeze({ hostCommit: descriptor.commit, packageVersion: hostPackage.version,
    boundCronId: requireBoundCron ? 'accepted' : 'not-requested', fullHostIntegrity: 'deferred-to-acceptance' });
}

/** Match OpenClaw's local-plugin admission before spending time starting a Gateway. */
export async function assertCandidatePluginPermissions(candidateRoot, { stat = lstat, entries = readdir } = {}) {
  if (process.platform !== 'linux') fail('preflight-platform', 'Plugin permission admission must run on the Linux host.');
  const root = path.resolve(candidateRoot);
  const inspect = async (file, label) => {
    const info = await stat(file).catch(() => fail('preflight-unsafe-path', `Plugin path is missing: ${label}`));
    if (info.isSymbolicLink()) fail('preflight-unsafe-path', `Plugin path is symlinked: ${label}`);
    assertSafePluginMode(info.mode, label);
    return info;
  };
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    await inspect(ancestor, ancestor === root ? 'candidate root' : 'candidate ancestor');
    if (ancestor === path.dirname(ancestor)) break;
  }
  await inspect(path.join(root, 'openclaw.plugin.json'), 'plugin manifest');
  await inspect(path.join(root, 'package.json'), 'plugin package');
  const dist = path.join(root, 'dist');
  let inspected = 0;
  const walk = async (directory, relative = 'dist') => {
    await inspect(directory, relative);
    for (const entry of await entries(directory, { withFileTypes: true })) {
      const label = `${relative}/${entry.name}`;
      const file = path.join(directory, entry.name);
      const info = await inspect(file, label);
      inspected += 1;
      if (info.isDirectory()) await walk(file, label);
    }
  };
  await walk(dist);
  return Object.freeze({ candidatePermissions: 'safe', inspectedPaths: inspected });
}
