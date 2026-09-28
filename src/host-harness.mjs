import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchWithRuntimeDispatcher } from 'openclaw/plugin-sdk/runtime-fetch';
import { assertBuiltDigest } from './build.mjs';
import { fixtureEnvironment } from './fixtures.mjs';
import { boundedTrafficEvidence, describeTrafficEvidence, TrafficGuard } from './isolation.mjs';
import { packagedHostDigest } from './packaged-host-integrity.mjs';
import { assertCandidateArchiveBytes, assertCandidatePairEvidence, parseCandidatePair } from './candidate-pair.mjs';

export const descriptorEnvironment = 'COMMAND_CENTER_ISOLATED_HOST';
const diagnosticHostProfile = process.env.COMMAND_CENTER_DIAGNOSTIC_HOST_PROFILE;
if (diagnosticHostProfile && (diagnosticHostProfile !== 'conditional-cron-id-pr53'
  || process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO !== 'diagnostic-clarification-worker')) {
  throw new Error('The conditional Cron ID host profile is limited to the clarification-worker diagnostic.');
}
export const pinnedHost = Object.freeze({
  // The evaluator checkout is the exact authenticated first-live host receipt.
  packageVersion: diagnosticHostProfile ? '2026.9.5' : '2026.9.6',
  commit: diagnosticHostProfile ? 'e603f08382dfb3cbe8245b673fcbd793bad9ce9d' : '5b4bbbf8f583ff7c1a64b55670a206fdda2251ed',
  packageDigest: diagnosticHostProfile ? 'sha256:675cea09c7800caf9084c6c700024232d54c5b940c8d8d3887f148f6894963cb' : 'sha256:624cc9063a8ff71b84022d4b56a56134b295412abd3529f13eb36f6660e998b1',
  executable: 'openclaw.mjs',
  args: Object.freeze(['gateway', 'run', '--allow-unconfigured'])
});
const sha256Digest = /^sha256:[a-f0-9]{64}$/;
const hostOutputClassifierTailLength = 1024;

// Report vocabulary is deliberately finite: never print exception properties
// supplied by a host, filesystem, process or validation dependency.
const reportCategories = new Set(['descriptor-absent', 'descriptor-invalid', 'wrapper-mismatch',
  'invalid-commit', 'dirty-host-source', 'host-integrity', 'restart-owner', 'restart-limit',
  'endpoint-isolation', 'host-early-exit', 'host-launch', 'host-stop', 'readiness-timeout',
  'readiness-flapping', 'transport-timeout', 'isolation-evidence-unavailable',
  'isolation-violation', 'plugin-not-found', 'bootstrap-authentication-failure']);
const hostIntegrityReasons = new Set(['package-digest-mismatch', 'source-receipt-unavailable',
  'source-receipt-mismatch', 'runtime-layout-mismatch', 'installed-build-mismatch',
  'runtime-inventory-unsafe', 'runtime-digest-mismatch', 'candidate-descriptor-mismatch',
  'verification-bypass']);
const runtimeDiffs = new WeakMap();
const maximumInventoryEntries = 100_000;
const maximumDiffEntries = 6;

function runtimeInventory() {
  const entries = new Map();
  return { entries, truncated: false, record(entry) {
    if (entries.size >= maximumInventoryEntries) { this.truncated = true; return; }
    entries.set(entry.relative, Object.freeze({ type: entry.type, executable: entry.executable, contentHash: entry.contentHash }));
  } };
}

function safeInstalledPath(value) {
  // The output is private, but names can still be chosen by an untrusted host.
  // Reject anything outside the installed package and redact suspicious names.
  if (typeof value !== 'string' || value.length > 96 || !value.startsWith('node_modules/') ||
      value.split('/').length > 10 || value.split('/').some(part => !/^[a-zA-Z0-9@._+-]{1,48}$/u.test(part) ||
        part === '.' || part === '..' || /token|secret|auth|credential|cookie|password|session|private|bearer|key/iu.test(part))) {
    return '[redacted]';
  }
  return value;
}

function safeFingerprint(value) {
  if (!value || !['directory', 'file', 'symlink'].includes(value.type) || typeof value.executable !== 'boolean' ||
      !(value.contentHash === null || typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(value.contentHash))) {
    return null;
  }
  return { type: value.type, executable: value.executable, contentHash: value.contentHash };
}

/** Only bounded, validated metadata; never store bytes or symlink text in evidence. */
export function summarizePackagedRuntimeDiff(before, after) {
  const counts = { added: 0, removed: 0, changed: 0 };
  const entries = [];
  let truncated = Boolean(before?.truncated || after?.truncated);
  try {
    if (!(before?.entries instanceof Map) || !(after?.entries instanceof Map)) throw new TypeError('inventory unavailable');
    for (const relative of new Set([...before.entries.keys(), ...after.entries.keys()])) {
      const oldValue = before.entries.has(relative) ? safeFingerprint(before.entries.get(relative)) : null;
      const newValue = after.entries.has(relative) ? safeFingerprint(after.entries.get(relative)) : null;
      if ((before.entries.has(relative) && !oldValue) || (after.entries.has(relative) && !newValue)) throw new TypeError('invalid entry');
      const kind = !oldValue ? 'added' : !newValue ? 'removed' :
        JSON.stringify(oldValue) !== JSON.stringify(newValue) ? 'changed' : null;
      if (!kind) continue;
      counts[kind] += 1;
      if (entries.length < maximumDiffEntries) entries.push({ kind, path: safeInstalledPath(relative), before: oldValue, after: newValue });
      else truncated = true;
    }
    const report = { kind: 'candidate-runtime-diff', counts, truncated, entries };
    return Object.freeze(JSON.stringify(report).length <= 4096 ? report :
      { kind: 'candidate-runtime-diff', counts, truncated: true, entries: [] });
  } catch {
    return Object.freeze({ kind: 'candidate-runtime-diff', counts: { added: 0, removed: 0, changed: 0 }, truncated: true, entries: [] });
  }
}

/** Only the exact failure created by candidate restart can carry this report. */
export function candidateRuntimeDiff(error) { return runtimeDiffs.get(error); }

export class HarnessFailure extends Error {
  constructor(category, message, reason) {
    super(message);
    this.name = 'HarnessFailure';
    this.category = category;
    this.reason = hostIntegrityReasons.has(reason) ? reason : 'unspecified';
  }
}

const smokePhases = new Set(['initial-host-launch', 'host-restart']);

export function closedCandidateSmokeFailure(error, executionPhase) {
  try {
    const category = error instanceof HarnessFailure && reportCategories.has(error.category) ? error.category : 'unclassified';
    const reason = category === 'host-integrity' && hostIntegrityReasons.has(error.reason) ? error.reason : 'unspecified';
    return Object.freeze({ category, reason, phase: smokePhases.has(executionPhase) ? executionPhase : 'unknown' });
  } catch {
    return Object.freeze({ category: 'unclassified', reason: 'unspecified', phase: 'unknown' });
  }
}

function parseIntegrity(value, packaged = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessFailure('descriptor-invalid', 'Host descriptor requires authenticated source and executable integrity');
  }
  const sourceDigest = value.sourceDigest;
  const executableDigest = value.executableDigest ?? value.wrapperSha256;
  const contractDigest = value.contractDigest;
  if (!sha256Digest.test(sourceDigest) || !sha256Digest.test(executableDigest)
    || !sha256Digest.test(contractDigest)) {
    throw new HarnessFailure('descriptor-invalid', 'Host descriptor integrity is incomplete');
  }
  if (packaged && (!sha256Digest.test(value.packageDigest) || !sha256Digest.test(value.runtimeDigest))) {
    throw new HarnessFailure('descriptor-invalid', 'Packaged host requires archive and installed-runtime integrity');
  }
  return Object.freeze({ sourceDigest, executableDigest, contractDigest, ...(packaged ? { packageDigest: value.packageDigest, runtimeDigest: value.runtimeDigest } : {}) });
}

function under(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function parseDescriptorAgainstHost(raw, expectedHost) {
  if (!raw) throw new HarnessFailure('descriptor-absent', `${descriptorEnvironment} is mandatory`);
  let descriptor;
  try { descriptor = JSON.parse(raw); } catch { throw new HarnessFailure('descriptor-invalid', 'Host descriptor is not valid JSON'); }
  const command = descriptor?.command && typeof descriptor.command === 'object' ? descriptor.command : descriptor;
  if (!descriptor || typeof descriptor.checkout !== 'string' || typeof command?.executable !== 'string' || !Array.isArray(command.args)) {
    throw new HarnessFailure('descriptor-invalid', 'Host descriptor requires checkout, executable, and args');
  }
  let wrapper = command.executable;
  let args = command.args;
  let runtimeExecutable;
  // The controller may describe either `openclaw.mjs gateway …` directly or
  // `node openclaw.mjs gateway …`; validate the same immutable invocation.
  if (path.basename(wrapper) !== expectedHost.executable) {
    if (!/^node(?:\.exe)?$/iu.test(path.basename(wrapper)) || typeof args[0] !== 'string' || path.basename(args[0]) !== expectedHost.executable) {
      throw new HarnessFailure('wrapper-mismatch', 'Host descriptor does not name the controller-owned wrapper');
    }
    runtimeExecutable = wrapper;
    wrapper = args[0];
    args = args.slice(1);
  }
  if (JSON.stringify(args) !== JSON.stringify(expectedHost.args)) {
    throw new HarnessFailure('wrapper-mismatch', 'Host descriptor does not name the controller-owned wrapper');
  }
  if (descriptor.commit !== expectedHost.commit) throw new HarnessFailure('invalid-commit', 'Host descriptor commit is not pinned');
  const packaged = descriptor.schemaVersion === 2;
  if (descriptor.schemaVersion !== undefined && ![1, 2].includes(descriptor.schemaVersion)) throw new HarnessFailure('descriptor-invalid', 'Unsupported host descriptor version');
  if (packaged && (typeof descriptor.runtimeRoot !== 'string' || wrapper !== 'node_modules/openclaw/openclaw.mjs')) {
    throw new HarnessFailure('descriptor-invalid', 'Packaged host requires the exact installed layout');
  }
  const integrity = parseIntegrity(descriptor.integrity, packaged);
  if (packaged && integrity.packageDigest !== expectedHost.packageDigest) throw new HarnessFailure('host-integrity', 'Host archive is not the pinned package', 'package-digest-mismatch');
  return Object.freeze({ commit: descriptor.commit, checkout: descriptor.checkout, executable: wrapper, runtimeExecutable, args: Object.freeze([...args]), integrity, ...(packaged ? { schemaVersion: 2, runtimeRoot: descriptor.runtimeRoot } : {}) });
}

export function parseHostDescriptor(raw = process.env[descriptorEnvironment]) {
  return parseDescriptorAgainstHost(raw, pinnedHost);
}

/** Candidate-only parser; the ordinary release parser retains committed pins. */
export function parseCandidateHostDescriptor(raw, pairValue) {
  const pair = parseCandidatePair(pairValue);
  const host = pair.openClaw;
  const descriptor = parseDescriptorAgainstHost(raw, { ...host, commit: host.sourceCommit, executable: pinnedHost.executable, args: pinnedHost.args });
  if (descriptor.schemaVersion !== 2) throw new HarnessFailure('descriptor-invalid', 'Candidate host requires a packaged runtime receipt');
  return descriptor;
}

function git(checkout, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git exited ${code}`)));
  });
}

async function assertNoSymlinkPath(root, relative, stat = lstat) {
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if ((await stat(current)).isSymbolicLink()) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper contains a symlink');
  }
}

async function assertHostIntegrity(checkout, descriptor, read, expectedHost) {
  let receipt;
  try {
    receipt = JSON.parse(await read(path.join(path.dirname(checkout), 'receipt.json'), 'utf8'));
  } catch {
    throw new HarnessFailure('host-integrity', 'Host source-integrity receipt is unavailable', 'source-receipt-unavailable');
  }
  if (receipt?.schemaVersion !== (descriptor.schemaVersion === 2 ? 2 : 1) || receipt.commit !== expectedHost.commit
    || !sha256Digest.test(receipt.sourceDigest)
    || !sha256Digest.test(receipt.executableDigest)
    || !sha256Digest.test(receipt.contractDigest)
    || receipt.sourceDigest !== descriptor.integrity.sourceDigest
    || receipt.executableDigest !== descriptor.integrity.executableDigest
    || receipt.contractDigest !== descriptor.integrity.contractDigest
    || (descriptor.schemaVersion === 2 && (receipt.packageDigest !== descriptor.integrity.packageDigest || receipt.runtimeDigest !== descriptor.integrity.runtimeDigest))) {
    throw new HarnessFailure('host-integrity', 'Host source/runtime integrity receipt differs from the descriptor', 'source-receipt-mismatch');
  }
}

/** Injectable filesystem/Git seams keep host-integrity category tests offline. */
async function verifyHostAgainst(descriptor, expectedHost, { gitCommand = git, resolvePath = realpath, read = readFile, stat = lstat } = {}, inventory) {
  const checkout = await resolvePath(descriptor.checkout).catch(() => { throw new HarnessFailure('descriptor-invalid', 'Host checkout is not accessible'); });
  const packaged = descriptor.schemaVersion === 2;
  let runtimeRoot = checkout;
  if (packaged) {
    const expectedRoot = path.join(path.dirname(checkout), 'runtime');
    if (path.resolve(descriptor.runtimeRoot) !== expectedRoot || (await stat(expectedRoot)).isSymbolicLink()) throw new HarnessFailure('host-integrity', 'Packaged runtime must be the separate sibling handoff', 'runtime-layout-mismatch');
    runtimeRoot = await resolvePath(expectedRoot);
  }
  const wrapper = path.resolve(runtimeRoot, descriptor.executable);
  if (!under(runtimeRoot, wrapper)) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper escapes its runtime');
  const wrapperRelative = packaged ? expectedHost.executable : path.relative(checkout, wrapper);
  await assertNoSymlinkPath(runtimeRoot, path.relative(runtimeRoot, wrapper), stat);
  if (descriptor.runtimeExecutable) {
    const [declaredRuntime, controllerRuntime] = await Promise.all([resolvePath(descriptor.runtimeExecutable), resolvePath(process.execPath)]).catch(() => {
      throw new HarnessFailure('wrapper-mismatch', 'Controller runtime is not available');
    });
    if (declaredRuntime !== controllerRuntime) throw new HarnessFailure('wrapper-mismatch', 'Host descriptor runtime does not match the controller runtime');
  }
  let commit;
  try { commit = await gitCommand(checkout, ['rev-parse', 'HEAD']); } catch { throw new HarnessFailure('invalid-commit', 'Host checkout is not a Git checkout'); }
  if (commit !== expectedHost.commit) throw new HarnessFailure('invalid-commit', 'Host checkout is not at the pinned commit');
  if (expectedHost.repository && await gitCommand(checkout, ['remote', 'get-url', 'origin']).catch(() => '') !== expectedHost.repository) {
    throw new HarnessFailure('invalid-commit', 'Candidate host repository origin differs from the pair');
  }
  try { await gitCommand(checkout, ['cat-file', '-e', `${expectedHost.commit}^{commit}`]); } catch { throw new HarnessFailure('invalid-commit', 'Pinned host object is not a Git commit'); }
  try { await gitCommand(checkout, ['fsck', '--full']); } catch { throw new HarnessFailure('invalid-commit', 'Pinned host object database failed integrity validation'); }
  if (await gitCommand(checkout, ['status', '--porcelain', '--untracked-files=no']).catch(() => 'dirty')) throw new HarnessFailure('dirty-host-source', 'Host tracked source is dirty');
  const hostPackage = JSON.parse(await read(path.join(checkout, 'package.json'), 'utf8').catch(() => '{}'));
  if (hostPackage.version !== expectedHost.packageVersion) throw new HarnessFailure('invalid-commit', 'Host package version is not pinned');
  const indexed = await gitCommand(checkout, ['ls-files', '-s', '--', wrapperRelative]);
  const blob = indexed.split(/\s+/)[1];
  if (!blob) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper is not tracked by its pinned commit');
  const contents = await read(wrapper);
  const object = createHash('sha1').update(`blob ${contents.byteLength}\0`).update(contents).digest('hex');
  if (object !== blob) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper differs from the Git object');
  const wrapperSha256 = createHash('sha256').update(contents).digest('hex');
  if (descriptor.integrity.executableDigest.slice('sha256:'.length) !== wrapperSha256) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper integrity assertion differs');
  await assertHostIntegrity(checkout, descriptor, read, expectedHost);
  if (packaged) {
    const installed = path.dirname(wrapper);
    const installedPackage = JSON.parse(await read(path.join(installed, 'package.json'), 'utf8'));
    const build = JSON.parse(await read(path.join(installed, 'dist/build-info.json'), 'utf8'));
    if (installedPackage.name !== 'openclaw' || installedPackage.version !== expectedHost.packageVersion || build.commit !== expectedHost.commit || build.version !== expectedHost.packageVersion) throw new HarnessFailure('host-integrity', 'Packaged build identity differs from pinned source', 'installed-build-mismatch');
    const actual = await packagedHostDigest(runtimeRoot, inventory ? { onEntry: entry => inventory.record(entry) } : undefined)
      .catch(() => { throw new HarnessFailure('host-integrity', 'Packaged runtime inventory is unsafe', 'runtime-inventory-unsafe'); });
    if (actual !== descriptor.integrity.runtimeDigest) throw new HarnessFailure('host-integrity', 'Installed runtime differs from its preparation receipt', 'runtime-digest-mismatch');
  }
  return Object.freeze({ checkout: packaged ? path.dirname(wrapper) : checkout, wrapper, commit, runtimeExecutable: descriptor.runtimeExecutable });
}

/** Release callers cannot select another expected host through options. */
export function verifyHost(descriptor, options) { return verifyHostAgainst(descriptor, pinnedHost, options); }

export function verifyCandidateHost(descriptor, pairValue, options) {
  const host = parseCandidatePair(pairValue).openClaw;
  const parsed = parseCandidateHostDescriptor(JSON.stringify(descriptor), pairValue);
  if (parsed.commit !== host.sourceCommit ||
      Object.entries({ packageDigest: host.packageDigest, runtimeDigest: host.runtimeDigest,
        sourceDigest: host.sourceDigest, executableDigest: host.executableDigest,
        contractDigest: host.contractDigest }).some(([key, value]) => parsed.integrity?.[key] !== value)) {
    throw new HarnessFailure('host-integrity', 'Candidate host descriptor differs from the pair', 'candidate-descriptor-mismatch');
  }
  return verifyHostAgainst(parsed, { ...host, commit: host.sourceCommit, executable: pinnedHost.executable, args: pinnedHost.args }, options);
}

export function redact(text, maximum = 4096) {
  return String(text).slice(0, maximum)
    .replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]')
    .replace(/(token|cookie|password|secret|key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?:file:\/\/\/)?[A-Za-z]:[\\/]+Users[\\/]+[^\s'";,]+/gi, '[path redacted]')
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s'";,]+/gi, '[path redacted]')
    .replace(/\/root\/[^\s'";,]*/gi, '[path redacted]');
}

export function classifyHostOutput(text) {
  return hostOutputCategories(text)[0];
}

function hostOutputCategories(text) {
  // Classification never emits this input. Do not apply the diagnostics cap
  // here: a host can report a fatal marker after more than 4096 bytes of
  // harmless output.
  const output = String(text);
  const categories = [];
  if (/plugin not found:\s*command-center/i.test(output)) categories.push('plugin-not-found');
  if (/(?:bootstrap|gateway)[^\n]*(?:authentication|auth)[^\n]*(?:failed|failure|error|denied)|(?:failed|failure|error|denied)[^\n]*(?:bootstrap|gateway)[^\n]*(?:authentication|auth)/i.test(output)) categories.push('bootstrap-authentication-failure');
  return categories;
}

/**
 * Keep enough unreported context to recognize a fatal marker split across
 * stream chunks. This state is intentionally separate from bounded redacted
 * diagnostics, which must stop retaining output after their cap.
 */
export function createHostOutputClassifier(diagnostics) {
  let tail = '';
  if (diagnostics) diagnostics.fatalCategories ??= [];
  return (chunk) => {
    const output = `${tail}${String(chunk)}`;
    tail = output.slice(-hostOutputClassifierTailLength);
    const categories = hostOutputCategories(output);
    if (diagnostics) {
      // Retain the first readiness failure, but keep checking drained output.
      // The closed category vocabulary bounds this evidence independently of logs.
      diagnostics.category ||= categories[0];
      for (const category of categories) if (!diagnostics.fatalCategories.includes(category)) diagnostics.fatalCategories.push(category);
    }
    return categories[0];
  };
}

/** Fail finalization when a fatal marker arrived after readiness. */
export function assertNoFatalHostOutput(diagnostics, { expectedPluginNotFound = false } = {}) {
  if (expectedPluginNotFound && (!Array.isArray(diagnostics?.fatalCategories) || !diagnostics.fatalCategories.includes('plugin-not-found'))) {
    throw new Error('Expected plugin rejection requires complete fatal output category evidence.');
  }
  const categories = new Set([...(diagnostics?.fatalCategories ?? []), ...(diagnostics?.category ? [diagnostics.category] : [])]);
  for (const category of categories) {
    if (expectedPluginNotFound && category === 'plugin-not-found') continue;
    throw new HarnessFailure(category, `Host reported ${category}`);
  }
}

function drainStream(stream) {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', resolve);
  });
}

const worldRuns = new WeakMap();
const runOwners = new WeakMap();
const stoppingChildren = new WeakMap();
const maximumHostGenerations = 8;

export async function launchPinnedHost(options) {
  const { world } = options;
  if (!world || worldRuns.has(world)) throw new HarnessFailure('restart-owner', 'World already has a host lifecycle owner');
  const owner = { options: { ...options }, transitioning: true, current: undefined };
  worldRuns.set(world, owner);
  try {
    return await launchGeneration(owner, options, []);
  } catch (error) {
    worldRuns.delete(world);
    throw error;
  } finally { owner.transitioning = false; }
}

/** Candidate launch uses the same isolated world and lifecycle safeguards. */
export async function launchCandidateHost(options) {
  if (options.hostVerificationOptions) throw new HarnessFailure('host-integrity', 'Candidate launch requires real source and runtime verification', 'verification-bypass');
  const descriptor = parseCandidateHostDescriptor(JSON.stringify(options.descriptor), options.candidatePair);
  const pair = assertCandidatePairEvidence(options.candidatePair, {
    inputTreeReceipt: options.inputTreeReceipt, buildReceipt: options.buildReceipt,
    artifactReceipt: options.artifactReceipt, hostDescriptor: descriptor
  });
  const expectedHost = { ...pair.openClaw, commit: pair.openClaw.sourceCommit, executable: pinnedHost.executable, args: pinnedHost.args };
  const { world } = options;
  if (!world || worldRuns.has(world)) throw new HarnessFailure('restart-owner', 'World already has a host lifecycle owner');
  const owner = { options: { ...options, descriptor }, expectedHost, candidatePair: pair, transitioning: true, current: undefined };
  worldRuns.set(world, owner);
  try { return await launchGeneration(owner, owner.options, []); }
  catch (error) { worldRuns.delete(world); throw error; }
  finally { owner.transitioning = false; }
}

/** Restart only a run issued by this owner; never copy state or choose a new port. */
export async function restartPinnedHost(previousRun, { signal, onOutput } = {}) {
  const owner = runOwners.get(previousRun);
  if (!owner || owner.current !== previousRun || owner.transitioning) throw new HarnessFailure('restart-owner', 'Restart requires the current, idle host lifecycle owner');
  if (previousRun.generations.length >= maximumHostGenerations) throw new HarnessFailure('restart-limit', 'Host generation diagnostic limit reached');
  owner.transitioning = true;
  const { world } = owner.options;
  try {
    // Cancellation must not leave the predecessor running. It is checked only
    // after stop/drain, before any new reservation or child can be created.
    await stopPinnedHost(previousRun.child);
    await boundedCompletion(previousRun.outputDrained, 2_000, 'host-output-drain');
    signal?.throwIfAborted();
    for (const generation of previousRun.generations) {
      assertNoFatalHostOutput(generation.diagnostics);
      generation.diagnostics.guard.assertClean();
      if (generation.diagnostics.cleanupError) throw generation.diagnostics.cleanupError;
    }
    await assertRecordedChildTraffic(world);
    if (typeof world.gatewayReservation.reacquire !== 'function') throw new HarnessFailure('endpoint-isolation', 'World does not support a real endpoint reacquisition');
    await world.gatewayReservation.reacquire({ signal });
    return await launchGeneration(owner, { ...owner.options, signal, onOutput: onOutput ?? owner.options.onOutput }, previousRun.generations);
  } catch (error) {
    // There is no successor on a failed launch. Release any listener acquired
    // for it, leaving the exact previous run available for diagnosis/retry.
    if (world.gatewayReservation.isReserved()) await world.gatewayReservation.release();
    throw error;
  } finally { owner.transitioning = false; }
}

async function launchGeneration(owner, { descriptor, world, buildReceipt, onOutput = () => {}, signal, notificationCaPath, hostVerificationOptions }, preceding) {
  signal?.throwIfAborted();
  if (owner.candidatePair) {
    assertCandidatePairEvidence(owner.candidatePair, { inputTreeReceipt: owner.options.inputTreeReceipt,
      buildReceipt, artifactReceipt: owner.options.artifactReceipt, hostDescriptor: descriptor });
    await assertCandidateArchiveBytes(owner.candidatePair, owner.options);
  }
  const inventory = owner.candidatePair ? runtimeInventory() : undefined;
  let host;
  try { host = await verifyHostAgainst(descriptor, owner.expectedHost ?? pinnedHost, hostVerificationOptions, inventory); }
  catch (error) {
    if (owner.candidatePair && owner.runtimeBaseline && error instanceof HarnessFailure &&
        error.category === 'host-integrity' && error.reason === 'runtime-digest-mismatch') {
      runtimeDiffs.set(error, summarizePackagedRuntimeDiff(owner.runtimeBaseline, inventory));
    }
    throw error;
  }
  if (inventory && !owner.runtimeBaseline) owner.runtimeBaseline = inventory;
  signal?.throwIfAborted();
  await assertBuiltDigest(buildReceipt);
  signal?.throwIfAborted();
  if (world?.gateway?.host !== '127.0.0.1' || !Number.isInteger(world.gateway.port) || world.gateway.port === 18789
    || !world.gatewayReservation?.isReserved?.()) {
    throw new HarnessFailure('endpoint-isolation', 'Isolated world does not hold a unique loopback Gateway endpoint');
  }
  await world.gatewayReservation.release();
  if (world.gatewayReservation.isReserved()) throw new HarnessFailure('endpoint-isolation', 'Isolated Gateway endpoint reservation was not released for the host');
  signal?.throwIfAborted();
  const guard = new TrafficGuard();
  guard.assert('127.0.0.1', 'host launch');
  const guardModule = new URL('./isolated-child-guard.mjs', import.meta.url);
  const executable = host.runtimeExecutable || host.wrapper;
  const arguments_ = host.runtimeExecutable ? [host.wrapper, ...descriptor.args] : descriptor.args;
  if (notificationCaPath && !under(world.root, path.resolve(notificationCaPath))) throw new HarnessFailure('endpoint-isolation', 'Notification CA path escapes the isolated world');
  const child = spawn(executable, arguments_, {
    cwd: host.checkout,
    // Preserve only the executable search path needed by the controller's
    // `#!/usr/bin/env node` wrapper. Fixture/configuration state remains
    // explicitly rooted in the disposable world.
    env: { PATH: process.env.PATH, [fixtureEnvironment]: world.manifestPath, OPENCLAW_CONFIG_PATH: world.manifest.configPath, HOME: world.root, TMPDIR: world.tempRoot, TMP: world.tempRoot, TEMP: world.tempRoot, COMMAND_CENTER_DISABLE_HOSTED_PLUGIN_CATALOG: '1', NODE_OPTIONS: `--import=${guardModule.href}`, ...(world.machineCredential ? { COMMAND_CENTER_FIXTURE_DEV_BEARER: world.machineCredential } : {}), ...(notificationCaPath ? { NODE_EXTRA_CA_CERTS: path.resolve(notificationCaPath) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const diagnostics = { stdout: '', stderr: '', category: undefined, guard };
  const classifiers = { stdout: createHostOutputClassifier(diagnostics), stderr: createHostOutputClassifier(diagnostics) };
  // A child can emit its final output after `exit`. Keep this promise from
  // launch time so finalization waits for every data event before checking
  // fatal categories and traffic evidence.
  const outputDrained = Promise.all([drainStream(child.stdout), drainStream(child.stderr)]);
  let reportFatal;
  const fatalOutput = new Promise((resolve) => { reportFatal = resolve; });
  for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', (chunk) => {
    classifiers[key](chunk);
    diagnostics[key] = redact(`${diagnostics[key]}${chunk}`);
    if (diagnostics.category) reportFatal(new HarnessFailure(diagnostics.category, `Host reported ${diagnostics.category}`));
    onOutput(key, diagnostics[key]);
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(new HarnessFailure(diagnostics.category || 'host-early-exit', `Host exited before readiness (${code ?? signal})`)));
    child.once('error', error => resolve(new HarnessFailure('host-launch', `Host process failed: ${error.code ?? 'unknown'}`)));
  });
  const earlyExit = Promise.race([exited, fatalOutput]);
  let abortCleanup = Promise.resolve();
  const abortHost = () => {
    abortCleanup = stopPinnedHost(child).then(() => boundedCompletion(outputDrained, 2_000, 'host-output-drain'));
    // Keep the actual rejection available to the caller, while recording it in
    // the retained generation evidence even when cancellation isn't awaited.
    abortCleanup.catch(error => { diagnostics.cleanupError = error; reportFatal(error); });
  };
  if (signal?.aborted) abortHost();
  else signal?.addEventListener('abort', abortHost, { once: true });
  child.once('close', () => signal?.removeEventListener('abort', abortHost));
  const generation = Object.freeze({ child, diagnostics, outputDrained });
  const run = Object.freeze({ child, diagnostics, earlyExit, outputDrained, host, endpoint: world.gateway,
    generations: Object.freeze([...preceding, generation]), get abortCleanup() { return abortCleanup; } });
  owner.current = run;
  runOwners.set(run, owner);
  return run;
}

export async function assertRecordedChildTraffic(world) {
  const entries = (await readFile(world.manifest.trafficLog, 'utf8').catch(error => {
    // No attempts need not create a log. Every other read failure is lost evidence.
    if (error?.code === 'ENOENT') return '';
    throw new HarnessFailure('isolation-evidence-unavailable', 'Child traffic evidence could not be read.');
  }))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const prohibited = entries.filter((entry) => !entry.permitted);
  if (prohibited.length) {
    const error = new HarnessFailure('isolation-violation', `Host attempted ${prohibited.length} prohibited destination(s): ${describeTrafficEvidence(prohibited)}`);
    error.diagnostics = Object.freeze({ childTraffic: boundedTrafficEvidence(prohibited) });
    throw error;
  }
  return entries;
}

function childExited(child) { return child.exitCode !== null || child.signalCode !== null; }

async function boundedCompletion(operation, timeoutMs, category) {
  let timer;
  try {
    await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HarnessFailure(category, `Host lifecycle exceeded ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function stopPinnedHost(child) {
  if (childExited(child)) return Promise.resolve();
  if (stoppingChildren.has(child)) return stoppingChildren.get(child);
  const stopping = (async () => {
    let onExit;
    const exited = new Promise(resolve => { onExit = resolve; child.once('exit', onExit); });
    try {
      child.kill('SIGTERM');
      try { await boundedCompletion(exited, 2_000, 'host-stop'); }
      catch (error) {
        if (error.category !== 'host-stop') throw error;
        if (!childExited(child)) child.kill('SIGKILL');
        await boundedCompletion(exited, 2_000, 'host-stop');
      }
      if (!childExited(child)) throw new HarnessFailure('host-stop', 'Host exit was not proven');
    } finally { child.off('exit', onExit); }
  })();
  stoppingChildren.set(child, stopping);
  stopping.finally(() => stoppingChildren.delete(child)).catch(() => {});
  return stopping;
}

function abortableDelay(delayMs, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() { signal?.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Operation aborted.')); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function withAbort(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Operation aborted.')); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(operation).then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); }
    );
  });
}

export async function waitForConsecutiveReadiness(observe, earlyExit, { required = 2, attempts = 20, deadlineMs, delayMs = 100, signal, now = Date.now, wait = abortableDelay } = {}) {
  if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) throw new TypeError('Readiness deadline must be positive.');
  const startedAt = now();
  let consecutive = 0;
  let attempt = 0;
  let successfulObservations = 0;
  let refusedConnections = 0;
  while (deadlineMs === undefined ? attempt < attempts : now() - startedAt < deadlineMs) {
    signal?.throwIfAborted();
    const remainingProbeMs = deadlineMs === undefined ? undefined : Math.max(1, deadlineMs - (now() - startedAt));
    const probeController = remainingProbeMs === undefined ? undefined : new AbortController();
    const abortProbe = () => probeController.abort(signal.reason);
    if (probeController && signal?.aborted) abortProbe();
    else if (probeController) signal?.addEventListener('abort', abortProbe, { once: true });
    const probeTimer = probeController && setTimeout(() => probeController.abort(new HarnessFailure('readiness-timeout', `Host readiness probe exceeded the remaining ${remainingProbeMs} ms startup deadline`)), remainingProbeMs);
    const probeSignal = probeController?.signal ?? signal;
    let result;
    try {
      const observation = Promise.resolve().then(() => observe(probeSignal)).catch((error) => {
        probeSignal?.throwIfAborted();
        // A newly launched listener may not have bound its port yet, or may
        // reset an accepted probe while replacing its startup handler. Both
        // are transport-level non-readiness; authenticated response failures
        // still propagate immediately.
        if (['ECONNREFUSED', 'ECONNRESET'].includes(error?.cause?.code ?? error?.code)) { refusedConnections += 1; return false; }
        // A listener can accept the bootstrap request before startup releases
        // the route. The request keeps its own short transport deadline while
        // this owner retains the authoritative, longer startup deadline.
        if (error?.category === 'transport-timeout') return false;
        throw error;
      });
      result = await withAbort(Promise.race([observation, earlyExit.then((error) => { throw error; })]), probeSignal);
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
      signal?.removeEventListener('abort', abortProbe);
    }
    attempt += 1;
    if (result) successfulObservations += 1;
    consecutive = result ? consecutive + 1 : 0;
    if (consecutive >= required) return;
    const remaining = deadlineMs === undefined ? delayMs : Math.max(0, deadlineMs - (now() - startedAt));
    if (remaining === 0) break;
    await withAbort(Promise.race([wait(Math.min(delayMs, remaining), signal), earlyExit.then((error) => { throw error; })]), signal);
  }
  const failure = new HarnessFailure(deadlineMs === undefined ? 'readiness-flapping' : 'readiness-timeout', deadlineMs === undefined
    ? 'Host did not produce consecutive readiness observations'
    : `Host did not produce consecutive readiness observations within ${deadlineMs} ms`);
  failure.readiness = Object.freeze({ attempts: attempt, successfulObservations, refusedConnections, elapsedMs: now() - startedAt });
  throw failure;
}

export async function fetchJsonWithDeadline(url, options = {}, { label = 'HTTP operation', timeoutMs = 10_000, fetchImpl = fetchWithRuntimeDispatcher, captureNonJsonBody = false } = {}) {
  const controller = new AbortController();
  const parentSignal = options.signal;
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    controller.signal.throwIfAborted();
    let body;
    let parseError;
    let rawBody;
    if (typeof response.text === 'function') {
      const text = await response.text();
      try { body = JSON.parse(text); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        parseError = error;
        if (captureNonJsonBody) rawBody = text;
      }
    } else {
      try { body = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        parseError = error;
      }
    }
    return { response, body, parseError, ...(captureNonJsonBody ? { rawBody } : {}) };
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    if (timedOut) throw new HarnessFailure('transport-timeout', `${label} exceeded its ${timeoutMs} ms deadline`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
