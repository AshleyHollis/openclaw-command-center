import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchWithRuntimeDispatcher } from 'openclaw/plugin-sdk/runtime-fetch';
import { assertBuiltDigest } from './build.mjs';
import { fixtureEnvironment } from './fixtures.mjs';
import { boundedTrafficEvidence, describeTrafficEvidence, TrafficGuard } from './isolation.mjs';

export const descriptorEnvironment = 'COMMAND_CENTER_ISOLATED_HOST';
export const pinnedHost = Object.freeze({
  // The evaluator checkout is the current authenticated host. The beta.3
  // ticket pin remains a separate, exact prior-release compatibility row.
  packageVersion: '2026.8.2',
  commit: '19686a23834910173df0fd1f77bd762ffcda2afd',
  executable: 'openclaw.mjs',
  args: Object.freeze(['gateway', 'run', '--allow-unconfigured'])
});
const sha256Digest = /^sha256:[a-f0-9]{64}$/;
const hostOutputClassifierTailLength = 1024;

export class HarnessFailure extends Error {
  constructor(category, message) { super(message); this.name = 'HarnessFailure'; this.category = category; }
}

function parseIntegrity(value) {
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
  return Object.freeze({ sourceDigest, executableDigest, contractDigest });
}

function under(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function parseHostDescriptor(raw = process.env[descriptorEnvironment]) {
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
  if (path.basename(wrapper) !== pinnedHost.executable) {
    if (path.basename(wrapper) !== 'node' || typeof args[0] !== 'string' || path.basename(args[0]) !== pinnedHost.executable) {
      throw new HarnessFailure('wrapper-mismatch', 'Host descriptor does not name the controller-owned wrapper');
    }
    runtimeExecutable = wrapper;
    wrapper = args[0];
    args = args.slice(1);
  }
  if (JSON.stringify(args) !== JSON.stringify(pinnedHost.args)) {
    throw new HarnessFailure('wrapper-mismatch', 'Host descriptor does not name the controller-owned wrapper');
  }
  if (descriptor.commit !== pinnedHost.commit) throw new HarnessFailure('invalid-commit', 'Host descriptor commit is not pinned');
  const integrity = parseIntegrity(descriptor.integrity);
  return Object.freeze({ checkout: descriptor.checkout, executable: wrapper, runtimeExecutable, args: Object.freeze([...args]), integrity });
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

async function assertHostIntegrity(checkout, descriptor, read) {
  let receipt;
  try {
    receipt = JSON.parse(await read(path.join(path.dirname(checkout), 'receipt.json'), 'utf8'));
  } catch {
    throw new HarnessFailure('host-integrity', 'Host source-integrity receipt is unavailable');
  }
  if (receipt?.schemaVersion !== 1 || receipt.commit !== pinnedHost.commit
    || !sha256Digest.test(receipt.sourceDigest)
    || !sha256Digest.test(receipt.executableDigest)
    || !sha256Digest.test(receipt.contractDigest)
    || receipt.sourceDigest !== descriptor.integrity.sourceDigest
    || receipt.executableDigest !== descriptor.integrity.executableDigest
    || receipt.contractDigest !== descriptor.integrity.contractDigest) {
    throw new HarnessFailure('host-integrity', 'Host source/runtime integrity receipt differs from the descriptor');
  }
}

/** Injectable filesystem/Git seams keep host-integrity category tests offline. */
export async function verifyHost(descriptor, { gitCommand = git, resolvePath = realpath, read = readFile, stat = lstat } = {}) {
  const checkout = await resolvePath(descriptor.checkout).catch(() => { throw new HarnessFailure('descriptor-invalid', 'Host checkout is not accessible'); });
  const wrapper = path.resolve(checkout, descriptor.executable);
  if (!under(checkout, wrapper)) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper escapes its checkout');
  const wrapperRelative = path.relative(checkout, wrapper);
  await assertNoSymlinkPath(checkout, wrapperRelative, stat);
  if (descriptor.runtimeExecutable) {
    const [declaredRuntime, controllerRuntime] = await Promise.all([resolvePath(descriptor.runtimeExecutable), resolvePath(process.execPath)]).catch(() => {
      throw new HarnessFailure('wrapper-mismatch', 'Controller runtime is not available');
    });
    if (declaredRuntime !== controllerRuntime) throw new HarnessFailure('wrapper-mismatch', 'Host descriptor runtime does not match the controller runtime');
  }
  let commit;
  try { commit = await gitCommand(checkout, ['rev-parse', 'HEAD']); } catch { throw new HarnessFailure('invalid-commit', 'Host checkout is not a Git checkout'); }
  if (commit !== pinnedHost.commit) throw new HarnessFailure('invalid-commit', 'Host checkout is not at the pinned commit');
  try { await gitCommand(checkout, ['cat-file', '-e', `${pinnedHost.commit}^{commit}`]); } catch { throw new HarnessFailure('invalid-commit', 'Pinned host object is not a Git commit'); }
  try { await gitCommand(checkout, ['fsck', '--full']); } catch { throw new HarnessFailure('invalid-commit', 'Pinned host object database failed integrity validation'); }
  if (await gitCommand(checkout, ['status', '--porcelain', '--untracked-files=no']).catch(() => 'dirty')) throw new HarnessFailure('dirty-host-source', 'Host tracked source is dirty');
  const hostPackage = JSON.parse(await read(path.join(checkout, 'package.json'), 'utf8').catch(() => '{}'));
  if (hostPackage.version !== pinnedHost.packageVersion) throw new HarnessFailure('invalid-commit', 'Host package version is not pinned');
  const indexed = await gitCommand(checkout, ['ls-files', '-s', '--', wrapperRelative]);
  const blob = indexed.split(/\s+/)[1];
  if (!blob) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper is not tracked by its pinned commit');
  const contents = await read(wrapper);
  const object = createHash('sha1').update(`blob ${contents.byteLength}\0`).update(contents).digest('hex');
  if (object !== blob) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper differs from the Git object');
  const wrapperSha256 = createHash('sha256').update(contents).digest('hex');
  if (descriptor.integrity.executableDigest.slice('sha256:'.length) !== wrapperSha256) throw new HarnessFailure('wrapper-mismatch', 'Host wrapper integrity assertion differs');
  await assertHostIntegrity(checkout, descriptor, read);
  return Object.freeze({ checkout, wrapper, commit, runtimeExecutable: descriptor.runtimeExecutable });
}

export function redact(text, maximum = 4096) {
  return String(text).slice(0, maximum)
    .replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]')
    .replace(/(token|cookie|password|secret|key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
}

export function classifyHostOutput(text) {
  // Classification never emits this input. Do not apply the diagnostics cap
  // here: a host can report a fatal marker after more than 4096 bytes of
  // harmless output.
  const output = String(text);
  if (/plugin not found:\s*command-center/i.test(output)) return 'plugin-not-found';
  if (/(?:bootstrap|authentication)[^\n]*(?:failed|failure|error|denied)|(?:failed|failure|error|denied)[^\n]*(?:bootstrap|authentication)/i.test(output)) return 'bootstrap-authentication-failure';
  return undefined;
}

/**
 * Keep enough unreported context to recognize a fatal marker split across
 * stream chunks. This state is intentionally separate from bounded redacted
 * diagnostics, which must stop retaining output after their cap.
 */
export function createHostOutputClassifier() {
  let tail = '';
  return (chunk) => {
    const output = `${tail}${String(chunk)}`;
    tail = output.slice(-hostOutputClassifierTailLength);
    return classifyHostOutput(output);
  };
}

/** Fail finalization when a fatal marker arrived after readiness. */
export function assertNoFatalHostOutput(diagnostics) {
  if (diagnostics?.category) {
    throw new HarnessFailure(diagnostics.category, `Host reported ${diagnostics.category}`);
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

export async function launchPinnedHost({ descriptor, world, buildReceipt, onOutput = () => {}, signal }) {
  signal?.throwIfAborted();
  const host = await verifyHost(descriptor);
  signal?.throwIfAborted();
  await assertBuiltDigest(buildReceipt);
  if (world?.gateway?.host !== '127.0.0.1' || !Number.isInteger(world.gateway.port) || world.gateway.port === 18789
    || !world.gatewayReservation?.isReserved?.()) {
    throw new HarnessFailure('endpoint-isolation', 'Isolated world does not hold a unique loopback Gateway endpoint');
  }
  await world.gatewayReservation.release();
  if (world.gatewayReservation.isReserved()) throw new HarnessFailure('endpoint-isolation', 'Isolated Gateway endpoint reservation was not released for the host');
  const guard = new TrafficGuard();
  guard.assert('127.0.0.1', 'host launch');
  const guardModule = new URL('./isolated-child-guard.mjs', import.meta.url);
  const executable = host.runtimeExecutable || host.wrapper;
  const arguments_ = host.runtimeExecutable ? [host.wrapper, ...pinnedHost.args] : pinnedHost.args;
  const child = spawn(executable, arguments_, {
    cwd: host.checkout,
    // Preserve only the executable search path needed by the controller's
    // `#!/usr/bin/env node` wrapper. Fixture/configuration state remains
    // explicitly rooted in the disposable world.
    env: { PATH: process.env.PATH, [fixtureEnvironment]: world.manifestPath, OPENCLAW_CONFIG_PATH: world.manifest.configPath, HOME: world.root, TMPDIR: world.tempRoot, TMP: world.tempRoot, TEMP: world.tempRoot, COMMAND_CENTER_DISABLE_HOSTED_PLUGIN_CATALOG: '1', NODE_OPTIONS: `--import=${guardModule.pathname}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const abortHost = () => { void stopPinnedHost(child); };
  if (signal?.aborted) abortHost();
  else signal?.addEventListener('abort', abortHost, { once: true });
  child.once('exit', () => signal?.removeEventListener('abort', abortHost));
  const diagnostics = { stdout: '', stderr: '', category: undefined, guard };
  const classifiers = { stdout: createHostOutputClassifier(), stderr: createHostOutputClassifier() };
  // A child can emit its final output after `exit`. Keep this promise from
  // launch time so finalization waits for every data event before checking
  // fatal categories and traffic evidence.
  const outputDrained = Promise.all([drainStream(child.stdout), drainStream(child.stderr)]);
  let reportFatal;
  const fatalOutput = new Promise((resolve) => { reportFatal = resolve; });
  for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', (chunk) => {
    diagnostics.category ||= classifiers[key](chunk);
    diagnostics[key] = redact(`${diagnostics[key]}${chunk}`);
    if (diagnostics.category) reportFatal(new HarnessFailure(diagnostics.category, `Host reported ${diagnostics.category}`));
    onOutput(key, diagnostics[key]);
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(new HarnessFailure(diagnostics.category || 'host-early-exit', `Host exited before readiness (${code ?? signal})`))));
  const earlyExit = Promise.race([exited, fatalOutput]);
  return Object.freeze({ child, diagnostics, earlyExit, outputDrained, host, endpoint: world.gateway });
}

export async function assertRecordedChildTraffic(world) {
  const entries = (await readFile(world.manifest.trafficLog, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const prohibited = entries.filter((entry) => !entry.permitted);
  if (prohibited.length) {
    const error = new HarnessFailure('isolation-violation', `Host attempted ${prohibited.length} prohibited destination(s): ${describeTrafficEvidence(prohibited)}`);
    error.diagnostics = Object.freeze({ childTraffic: boundedTrafficEvidence(prohibited) });
    throw error;
  }
  return entries;
}

export async function stopPinnedHost(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
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
      result = await withAbort(Promise.race([Promise.resolve().then(() => observe(probeSignal)), earlyExit.then((error) => { throw error; })]), probeSignal);
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
      signal?.removeEventListener('abort', abortProbe);
    }
    attempt += 1;
    consecutive = result ? consecutive + 1 : 0;
    if (consecutive >= required) return;
    const remaining = deadlineMs === undefined ? delayMs : Math.max(0, deadlineMs - (now() - startedAt));
    if (remaining === 0) break;
    await withAbort(Promise.race([wait(Math.min(delayMs, remaining), signal), earlyExit.then((error) => { throw error; })]), signal);
  }
  throw new HarnessFailure(deadlineMs === undefined ? 'readiness-flapping' : 'readiness-timeout', deadlineMs === undefined
    ? 'Host did not produce consecutive readiness observations'
    : `Host did not produce consecutive readiness observations within ${deadlineMs} ms`);
}

export async function fetchJsonWithDeadline(url, options = {}, { label = 'HTTP operation', timeoutMs = 10_000, fetchImpl = fetchWithRuntimeDispatcher } = {}) {
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
    try { body = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      parseError = error;
    }
    return { response, body, parseError };
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    if (timedOut) throw new HarnessFailure('transport-timeout', `${label} exceeded its ${timeoutMs} ms deadline`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
