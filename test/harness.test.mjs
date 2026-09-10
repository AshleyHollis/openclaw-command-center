import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:net';
import * as hostHarness from '../src/host-harness.mjs';
import { build } from '../src/build.mjs';
import { createIsolatedWorld, disposeIsolatedWorld } from '../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, createHostOutputClassifier, fetchJsonWithDeadline, HarnessFailure, classifyHostOutput, parseHostDescriptor, pinnedHost, redact, verifyHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';
import { packagedHostDigest } from '../src/packaged-host-integrity.mjs';
import { assertPerformanceHostIdentity, releasePerformanceIdentity } from '../src/performance-baseline.mjs';

test('parsed packaged descriptor retains the identity required by performance capture', () => {
  const { schemaVersion, commit, ...integrity } = releasePerformanceIdentity.hostReceipt;
  const descriptor = parseHostDescriptor(JSON.stringify({ schemaVersion, commit, integrity,
    checkout: '/fixture/source', runtimeRoot: '/fixture/runtime', executable: 'node_modules/openclaw/openclaw.mjs', args: pinnedHost.args }));
  assert.deepEqual(assertPerformanceHostIdentity(descriptor), releasePerformanceIdentity.hostReceipt);
  assert.throws(() => assertPerformanceHostIdentity({ ...descriptor, schemaVersion: 1 }), /pinned host/u);
});

const sourceDigest = `sha256:${'a'.repeat(64)}`;
const placeholderExecutableDigest = `sha256:${'b'.repeat(64)}`;
const contractDigest = `sha256:${'c'.repeat(64)}`;

function hostDescriptor({ checkout = '/fixture', executable = pinnedHost.executable, args = pinnedHost.args, commit = pinnedHost.commit, integrity = { sourceDigest, executableDigest: placeholderExecutableDigest, contractDigest }, ...rest } = {}) {
  return JSON.stringify({ checkout, executable, args, commit, integrity, ...rest });
}

async function temporaryHost(contents = '#!/usr/bin/env node\nconsole.log("fixture host");\n') {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-host-'));
  const root = path.join(parent, 'openclaw-host');
  await mkdir(root);
  const wrapper = path.join(root, pinnedHost.executable);
  await Promise.all([
    writeFile(wrapper, contents),
    writeFile(path.join(root, 'package.json'), JSON.stringify({ version: pinnedHost.packageVersion }))
  ]);
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(contents)}\0`).update(contents).digest('hex');
  const integrity = Object.freeze({ sourceDigest, executableDigest: `sha256:${createHash('sha256').update(contents).digest('hex')}`, contractDigest });
  await writeFile(path.join(parent, 'receipt.json'), JSON.stringify({ schemaVersion: 1, commit: pinnedHost.commit, ...integrity }));
  return { parent, root, blob, integrity };
}

function hostGit({ commit = pinnedHost.commit, status = '', blob } = {}) {
  return async (_checkout, args) => {
    if (args.join(' ') === 'rev-parse HEAD') return commit;
    if (args[0] === 'cat-file' || args.join(' ') === 'fsck --full') return '';
    if (args.join(' ') === 'status --porcelain --untracked-files=no') return status;
    if (args[0] === 'ls-files') return `100644 ${blob} 0\t${pinnedHost.executable}`;
    throw new Error(`Unexpected fixture git command: ${args.join(' ')}`);
  };
}

test('packaged host binds installed build and dependencies independently of clean source', async () => {
  const fixture = await temporaryHost();
  try {
    const runtimeRoot = path.join(fixture.parent, 'runtime');
    const installed = path.join(runtimeRoot, 'node_modules/openclaw');
    await mkdir(path.join(installed, 'dist'), { recursive: true });
    await writeFile(path.join(installed, 'openclaw.mjs'), await readFile(path.join(fixture.root, 'openclaw.mjs')));
    await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'openclaw', version: pinnedHost.packageVersion }));
    await writeFile(path.join(installed, 'dist/build-info.json'), JSON.stringify({ commit: pinnedHost.commit, version: pinnedHost.packageVersion }));
    const dependency = path.join(runtimeRoot, 'node_modules/dependency.js');
    await writeFile(dependency, 'export const dependency = true;');
    const integrity = { ...fixture.integrity, packageDigest: pinnedHost.packageDigest, runtimeDigest: await packagedHostDigest(runtimeRoot) };
    await writeFile(path.join(fixture.parent, 'receipt.json'), JSON.stringify({ schemaVersion: 2, commit: pinnedHost.commit, ...integrity }));
    const raw = hostDescriptor({ schemaVersion: 2, checkout: fixture.root, runtimeRoot, executable: 'node_modules/openclaw/openclaw.mjs', integrity });
    const descriptor = parseHostDescriptor(raw);
    const options = { gitCommand: hostGit({ blob: fixture.blob }) };
    assert.equal((await verifyHost(descriptor, options)).checkout, installed);
    assert.throws(() => parseHostDescriptor(JSON.stringify({ ...JSON.parse(raw), integrity: { ...integrity, packageDigest: sourceDigest } })), error => error.category === 'host-integrity');
    await assert.rejects(verifyHost({ ...descriptor, runtimeRoot: fixture.root }, options), error => error.category === 'host-integrity');
    await writeFile(dependency, 'tampered');
    await assert.rejects(verifyHost(descriptor, options), error => error.category === 'host-integrity');
    await writeFile(dependency, 'export const dependency = true;');
    await writeFile(path.join(installed, 'dist/build-info.json'), JSON.stringify({ commit: 'wrong', version: pinnedHost.packageVersion }));
    await assert.rejects(verifyHost(descriptor, options), error => error.category === 'host-integrity');
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('categorizes absent and malformed host descriptors', () => {
  // The acceptance test supplies the mandatory descriptor through the process
  // environment, so make the absent-descriptor unit case independent of it.
  assert.throws(() => parseHostDescriptor(''), (error) => error instanceof HarnessFailure && error.category === 'descriptor-absent');
  assert.throws(() => parseHostDescriptor('{'), (error) => error.category === 'descriptor-invalid');
  assert.throws(() => parseHostDescriptor(hostDescriptor({ executable: 'other.mjs', args: [] })), (error) => error.category === 'wrapper-mismatch');
  assert.throws(() => parseHostDescriptor(JSON.stringify({ checkout: '/fixture', executable: pinnedHost.executable, args: pinnedHost.args, commit: pinnedHost.commit })), (error) => error.category === 'descriptor-invalid');
  const descriptor = parseHostDescriptor(hostDescriptor());
  assert.equal(descriptor.executable, pinnedHost.executable);
  const nodeDescriptor = parseHostDescriptor(hostDescriptor({ executable: undefined, args: undefined, command: { executable: 'node', args: ['openclaw.mjs', ...pinnedHost.args] } }));
  assert.equal(nodeDescriptor.executable, 'openclaw.mjs');
  assert.throws(() => parseHostDescriptor(hostDescriptor({ executable: 'untrusted-wrapper', args: ['openclaw.mjs', ...pinnedHost.args] })), (error) => error.category === 'wrapper-mismatch');
  assert.throws(() => parseHostDescriptor(hostDescriptor({ commit: 'different' })), (error) => error.category === 'invalid-commit');
  assert.throws(
    () => parseHostDescriptor(hostDescriptor({ integrity: { sourceDigest, executableDigest: placeholderExecutableDigest } })),
    (error) => error.category === 'descriptor-invalid'
  );
});

test('runtime checkout identity remains distinct from the compatibility and performance receipt identities', () => {
  assert.equal(pinnedHost.commit, '3040eff630e5a6d9a9f9f5ce52af3c0971776f15');
  assert.doesNotThrow(() => parseHostDescriptor(hostDescriptor()));
  assert.throws(() => parseHostDescriptor(hostDescriptor({ commit: '19686a23834910173df0fd1f77bd762ffcda2afd' })), (error) => error.category === 'invalid-commit');
});

test('requires consecutive readiness and notices flapping', async () => {
  const values = [true, false, true, true];
  await waitForConsecutiveReadiness(() => values.shift(), new Promise(() => {}), { attempts: 4 });
  await assert.rejects(waitForConsecutiveReadiness(() => false, new Promise(() => {}), { attempts: 2 }), (error) => error.category === 'readiness-flapping');
});

test('startup readiness retries transient listener interruptions and still requires consecutive successful probes', async () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('socket not listening'), { code: 'ECONNREFUSED' }) });
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('listener restarted'), { code: 'ECONNRESET' }) });
  const observations = [refused, true, reset, true, true];
  let calls = 0;
  await waitForConsecutiveReadiness(() => { calls += 1; const next = observations.shift(); if (next instanceof Error) throw next; return next; }, new Promise(() => {}), { attempts: 5, wait: async () => {} });
  assert.equal(calls, 5);
  for (const failure of [new Error('invalid authenticated response'), Object.assign(new Error('certificate rejected'), { code: 'CERT_HAS_EXPIRED' })]) {
    await assert.rejects(waitForConsecutiveReadiness(() => { throw failure; }, new Promise(() => {})), (error) => error === failure);
  }
  await assert.rejects(waitForConsecutiveReadiness(() => false, Promise.resolve(refused)), (error) => error === refused);
  let clock = 0;
  await assert.rejects(waitForConsecutiveReadiness(() => { throw refused; }, new Promise(() => {}), {
    attempts: 2, now: () => clock, wait: async (ms) => { clock += ms; }
  }), (error) => {
    assert.deepEqual(error.readiness, { attempts: 2, successfulObservations: 0, refusedConnections: 2, elapsedMs: 200 });
    return error.category === 'readiness-flapping';
  });
});

test('elapsed readiness deadlines allow late success and reject flapping without real sleeps', async () => {
  let clock = 0;
  const wait = async (delayMs) => { clock += delayMs; };
  const late = [false, false, true, true];
  await waitForConsecutiveReadiness(() => late.shift(), new Promise(() => {}), { deadlineMs: 1_000, delayMs: 100, now: () => clock, wait });
  assert.equal(clock, 300);

  clock = 0;
  const observations = [];
  await assert.rejects(
    waitForConsecutiveReadiness(() => { const value = observations.length % 2 === 0; observations.push(value); return value; }, new Promise(() => {}), { deadlineMs: 250, delayMs: 100, now: () => clock, wait }),
    (error) => error.category === 'readiness-timeout' && /within 250 ms/u.test(error.message)
  );
  assert.deepEqual(observations, [true, false, true]);
  assert.equal(clock, 250);
});

test('readiness cancellation settles during a pending probe and between attempts', async () => {
  const duringProbe = new AbortController();
  let probeAborted = false;
  const pendingProbe = waitForConsecutiveReadiness(async (signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    probeAborted = true;
    return false;
  }, new Promise(() => {}), { attempts: 10, delayMs: 100, signal: duringProbe.signal });
  await new Promise((resolve) => setImmediate(resolve));
  duringProbe.abort(new Error('cancel during readiness probe'));
  await assert.rejects(pendingProbe, /cancel during readiness probe/u);
  assert.equal(probeAborted, true);

  const betweenAttempts = new AbortController();
  let observations = 0;
  const pendingDelay = waitForConsecutiveReadiness(() => { observations += 1; return false; }, new Promise(() => {}), { attempts: 10, delayMs: 10_000, signal: betweenAttempts.signal });
  await new Promise((resolve) => setImmediate(resolve));
  betweenAttempts.abort(new Error('cancel between readiness probes'));
  await assert.rejects(pendingDelay, /cancel between readiness probes/u);
  assert.equal(observations, 1);
});

test('readiness deadline aborts a non-settling active probe', async () => {
  await assert.rejects(
    waitForConsecutiveReadiness((signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), new Promise(() => {}), { deadlineMs: 10 }),
    (error) => error.category === 'readiness-timeout' && /probe exceeded/iu.test(error.message)
  );
});

test('JSON readiness fetch keeps cancellation and timeout active through a deferred body', async () => {
  const deferredResponse = (_url, { signal }) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  });
  const cancelled = new AbortController();
  const cancellation = fetchJsonWithDeadline('http://127.0.0.1/readiness', { signal: cancelled.signal }, { fetchImpl: deferredResponse, timeoutMs: 1_000 });
  cancelled.abort(new Error('cancel deferred readiness body'));
  await assert.rejects(cancellation, /cancel deferred readiness body/u);
  await assert.rejects(
    fetchJsonWithDeadline('http://127.0.0.1/readiness', {}, { label: 'deferred readiness body', fetchImpl: deferredResponse, timeoutMs: 10 }),
    (error) => error.category === 'transport-timeout' && /deferred readiness body/u.test(error.message)
  );
});

test('categorizes host integrity failures and early exit', async () => {
  const fixture = await temporaryHost();
  const descriptor = parseHostDescriptor(hostDescriptor({ checkout: fixture.root, integrity: fixture.integrity }));
  try {
    const verified = await verifyHost(descriptor, { gitCommand: hostGit({ blob: fixture.blob }) });
    assert.equal(verified.commit, pinnedHost.commit);
    await assert.rejects(
      verifyHost(descriptor, {
        gitCommand: hostGit({ blob: fixture.blob }),
        read: async (filename) => filename.endsWith('package.json')
          ? JSON.stringify({ version: '2026.8.1-beta.3' })
          : readFile(filename)
      }),
      (error) => error.category === 'invalid-commit' && /package version/u.test(error.message)
    );
    await assert.rejects(verifyHost(descriptor, { gitCommand: hostGit({ commit: 'different', blob: fixture.blob }) }), (error) => error.category === 'invalid-commit');
    await assert.rejects(verifyHost(descriptor, { gitCommand: hostGit({ status: ' M src/index.mjs', blob: fixture.blob }) }), (error) => error.category === 'dirty-host-source');
    await assert.rejects(verifyHost(descriptor, { gitCommand: hostGit({ blob: '0'.repeat(40) }) }), (error) => error.category === 'wrapper-mismatch');
    await assert.rejects(
      verifyHost(descriptor, {
        gitCommand: hostGit({ blob: fixture.blob }),
        read: async (filename) => filename.endsWith('receipt.json')
          ? JSON.stringify({ schemaVersion: 1, commit: pinnedHost.commit, sourceDigest: `sha256:${'d'.repeat(64)}`, executableDigest: fixture.integrity.executableDigest, contractDigest })
          : readFile(filename)
      }),
      (error) => error.category === 'host-integrity'
    );
    await assert.rejects(
      verifyHost(descriptor, {
        gitCommand: hostGit({ blob: fixture.blob }),
        read: async (filename) => filename.endsWith('receipt.json')
          ? JSON.stringify({ schemaVersion: 1, commit: pinnedHost.commit, sourceDigest, executableDigest: fixture.integrity.executableDigest, contractDigest: `sha256:${'d'.repeat(64)}` })
          : readFile(filename)
      }),
      (error) => error.category === 'host-integrity'
    );
    await assert.rejects(
      verifyHost(descriptor, {
        gitCommand: hostGit({ blob: fixture.blob }),
        read: async (filename) => filename.endsWith('receipt.json')
          ? JSON.stringify({ schemaVersion: 1, commit: pinnedHost.commit, sourceDigest, executableDigest: `sha256:${'d'.repeat(64)}`, contractDigest })
          : readFile(filename)
      }),
      (error) => error.category === 'host-integrity'
    );
    await assert.rejects(
      waitForConsecutiveReadiness(() => true, Promise.resolve(new HarnessFailure('host-early-exit', 'fixture host exited'))),
      (error) => error.category === 'host-early-exit'
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('categorizes host bootstrap and plugin failures without retaining authentication material', () => {
  assert.equal(classifyHostOutput('plugin not found: command-center'), 'plugin-not-found');
  assert.equal(classifyHostOutput('bootstrap authentication failed'), 'bootstrap-authentication-failure');
  assert.equal(classifyHostOutput('bootstrap authentication configuration loaded'), undefined);
  assert.equal(classifyHostOutput('Embedded agent failed: No route-compatible authentication source is configured for openai.'), undefined);
  assert.doesNotMatch(redact(['Bear', 'er fictional-token-123456'].join('')), /fictional-token/);
  const fictionalHome = ['file:/', '/', 'home/fictional-user/private-output'].join('');
  const fictionalRoot = ['/', 'root/.openclaw/state'].join('');
  assert.doesNotMatch(redact(`${fictionalHome} ${fictionalRoot}`), /(?:\/home|\/root)/u);
});

test('classifies a late plugin failure across bounded host-output chunks', () => {
  const classify = createHostOutputClassifier();
  assert.equal(classify('x'.repeat(4_097)), undefined);
  assert.equal(classify('plugin not found: command-'), undefined);
  assert.equal(classify('center'), 'plugin-not-found');
});

test('rejects a plugin failure reported after readiness', () => {
  const diagnostics = { category: undefined };
  assert.doesNotThrow(() => assertNoFatalHostOutput(diagnostics));
  diagnostics.category = classifyHostOutput('plugin not found: command-center');
  assert.throws(() => assertNoFatalHostOutput(diagnostics), (error) => error.category === 'plugin-not-found');
});

test('reports bounded source and destination evidence for prohibited child traffic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-harness-'));
  const trafficLog = path.join(root, 'traffic.jsonl');
  try {
    await writeFile(trafficLog, [
      JSON.stringify({ source: 'dns', destination: 'catalog.example.invalid', permitted: false }),
      JSON.stringify({ source: 'https', destination: 'catalog.example.invalid', permitted: false })
    ].join('\n'));
    let caught;
    try {
      await assertRecordedChildTraffic({ manifest: { trafficLog } });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof HarnessFailure);
    assert.equal(caught.category, 'isolation-violation');
    assert.match(caught.message, /dns -> catalog\.example\.invalid/);
    assert.deepEqual(caught.diagnostics.childTraffic, [
      { source: 'dns', destination: 'catalog.example.invalid' },
      { source: 'https', destination: 'catalog.example.invalid' }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expected plugin rejection cannot hide a later authentication failure across output chunks', () => {
  for (const chunks of [
    ['plugin not found: command-center\n', 'bootstrap authentication failed\n'],
    ['plugin not found: command-center\nbootstrap authentication failed\n'],
    ['plugin not found: command-center\n', 'bootstrap authenti', 'cation denied\n']
  ]) {
    const diagnostics = {};
    const observe = createHostOutputClassifier(diagnostics);
    for (const chunk of chunks) observe(chunk);
    assert.equal(diagnostics.category, 'plugin-not-found');
    assert.deepEqual(diagnostics.fatalCategories, ['plugin-not-found', 'bootstrap-authentication-failure']);
    assert.throws(() => assertNoFatalHostOutput(diagnostics, { expectedPluginNotFound: true }), error => error.category === 'bootstrap-authentication-failure');
  }
  const expected = {};
  const observe = createHostOutputClassifier(expected);
  for (let index = 0; index < 20; index += 1) observe('plugin not found: command-center\n');
  assert.deepEqual(expected.fatalCategories, ['plugin-not-found']);
  assert.doesNotThrow(() => assertNoFatalHostOutput(expected, { expectedPluginNotFound: true }));
  assert.throws(() => assertNoFatalHostOutput(expected), error => error.category === 'plugin-not-found');
  assert.throws(() => assertNoFatalHostOutput({ category: 'plugin-not-found' }, { expectedPluginNotFound: true }), /complete fatal output/u);
});

test('unreadable child traffic evidence fails closed rather than passing as no traffic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-evidence-'));
  try {
    await assert.rejects(assertRecordedChildTraffic({ manifest: { trafficLog: root } }), error => error instanceof HarnessFailure && error.category === 'isolation-evidence-unavailable');
    assert.deepEqual(await assertRecordedChildTraffic({ manifest: { trafficLog: path.join(root, 'absent.jsonl') } }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A real process/socket/SQLite fixture, not an OpenClaw activation proof. Only
// Git is an external fixture; wrapper, package, receipt and build hashes are real.
const restartWrapper = `import { createServer } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const world = JSON.parse(readFileSync(process.env.COMMAND_CENTER_FIXTURE_MANIFEST));
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH));
const db = new DatabaseSync(path.join(world.database, 'restart.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS generations (id INTEGER PRIMARY KEY)');
db.prepare('INSERT INTO generations DEFAULT VALUES').run();
const generation = db.prepare('SELECT COUNT(*) AS n FROM generations').get().n;
const server = createServer(socket => socket.end('generation=' + generation));
process.on('SIGTERM', () => { console.log('STOPPING:' + generation); server.close(() => { db.close(); console.log('DRAINED:' + generation); }); });
server.listen(config.gateway.port, config.gateway.bind === 'loopback' ? '127.0.0.1' : 'invalid', () => {
 console.log('READY:' + JSON.stringify({ generation, pid: process.pid, root: world.root, inode: statSync(path.join(world.vault, 'fixture-note.md')).ino, databaseInode: statSync(path.join(world.database, 'restart.sqlite')).ino }));
});
`;
let restartBuild;
async function restartFixture(t, contents = restartWrapper) {
  const fixture = await temporaryHost(contents);
  const world = await createIsolatedWorld({ candidateRoot: process.cwd() });
  await writeFile(path.join(world.paths.vault, 'fixture-note.md'), '# Fictional retained Note\nUnchanged between host generations.\n');
  const runs = [];
  t.after(async () => {
    for (const run of runs.reverse()) {
      await hostHarness.stopPinnedHost(run.child);
      await run.outputDrained;
    }
    await disposeIsolatedWorld(world);
    await rm(fixture.parent, { recursive: true, force: true });
  });
  restartBuild ??= build();
  const options = {
    descriptor: parseHostDescriptor(hostDescriptor({ checkout: fixture.root, executable: undefined, args: undefined,
      command: { executable: process.execPath, args: [pinnedHost.executable, ...pinnedHost.args] }, integrity: fixture.integrity })),
    world, buildReceipt: await restartBuild, hostVerificationOptions: { gitCommand: hostGit({ blob: fixture.blob }) }
  };
  return { fixture, world, runs, options };
}
async function fixtureReady(run) {
  await waitForConsecutiveReadiness(() => /READY:/u.test(run.diagnostics.stdout), run.earlyExit, { deadlineMs: 10_000, delayMs: 10 });
  return JSON.parse(run.diagnostics.stdout.match(/READY:(.*)/u)[1]);
}

test('restart stops and drains the actual predecessor and preserves world, Note inode and SQLite', async t => {
  const { world, runs, options } = await restartFixture(t);
  const manifest = await readFile(world.manifestPath);
  const config = await readFile(world.manifest.configPath);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  const firstReady = await fixtureReady(first);
  const second = await hostHarness.restartPinnedHost(first); runs.push(second);
  const secondReady = await fixtureReady(second);
  assert.equal(first.child.exitCode, 0);
  assert.match(first.diagnostics.stdout, /DRAINED:1/u);
  assert.equal(secondReady.generation, 2);
  assert.notEqual(secondReady.pid, firstReady.pid);
  assert.equal(secondReady.inode, firstReady.inode);
  assert.equal(secondReady.databaseInode, firstReady.databaseInode);
  assert.equal(secondReady.root, firstReady.root);
  assert.equal(second.endpoint, first.endpoint);
  assert.equal(second.generations.length, 2);
  assert.equal(second.generations[0].diagnostics, first.diagnostics);
  assert.deepEqual(await readFile(world.manifestPath), manifest);
  assert.deepEqual(await readFile(world.manifest.configPath), config);
  await assert.rejects(hostHarness.restartPinnedHost(first), error => error.category === 'restart-owner');
});

test('restart refuses a real competing same-port listener without changing the world', async t => {
  const { world, runs, options } = await restartFixture(t);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  await hostHarness.stopPinnedHost(first.child);
  await first.outputDrained;
  const competitor = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { competitor.once('error', reject); competitor.listen(world.gateway.port, world.gateway.host, resolve); });
  try {
    await assert.rejects(hostHarness.restartPinnedHost(first), { code: 'EADDRINUSE' });
    assert.equal(world.gatewayReservation.isReserved(), false);
  } finally { await new Promise(resolve => competitor.close(resolve)); }
  const second = await hostHarness.restartPinnedHost(first); runs.push(second);
  assert.equal((await fixtureReady(second)).generation, 2);
});

test('restart owns the exact run and refuses concurrent launch or restart transitions', async t => {
  const { runs, options } = await restartFixture(t);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  await assert.rejects(hostHarness.launchPinnedHost(options), error => error.category === 'restart-owner');
  await assert.rejects(hostHarness.restartPinnedHost({ ...first }), error => error.category === 'restart-owner');
  const pending = hostHarness.restartPinnedHost(first);
  await assert.rejects(hostHarness.restartPinnedHost(first), error => error.category === 'restart-owner');
  const second = await pending; runs.push(second);
  assert.equal((await fixtureReady(second)).generation, 2);
});

test('restart proves SIGKILL exit when a real child refuses SIGTERM and stopping is repeatable', async t => {
  const contents = restartWrapper.replace("process.on('SIGTERM', () => {", "process.on('SIGTERM', () => { return;");
  const { runs, options } = await restartFixture(t, contents);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  const second = await hostHarness.restartPinnedHost(first); runs.push(second);
  assert.equal(first.child.signalCode, 'SIGKILL');
  await hostHarness.stopPinnedHost(first.child);
  assert.equal((await fixtureReady(second)).generation, 2);
});

test('cancelled restart stops its predecessor without creating a successor, and successor abort drains', async t => {
  const { runs, options, world } = await restartFixture(t);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  const cancelled = new AbortController(); cancelled.abort(new Error('fixture restart cancelled'));
  await assert.rejects(hostHarness.restartPinnedHost(first, { signal: cancelled.signal }), /fixture restart cancelled/u);
  assert.equal(first.child.exitCode, 0);
  assert.equal(world.gatewayReservation.isReserved(), false);
  const successorAbort = new AbortController();
  const second = await hostHarness.restartPinnedHost(first, { signal: successorAbort.signal }); runs.push(second);
  await fixtureReady(second);
  successorAbort.abort();
  await second.abortCleanup;
  assert.equal(second.child.exitCode, 0);
  assert.match(second.diagnostics.stdout, /DRAINED:2/u);
});

test('restart rechecks real immutable wrapper bytes before spawning the successor', async t => {
  const { fixture, runs, options, world } = await restartFixture(t);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  await writeFile(path.join(fixture.root, pinnedHost.executable), `${restartWrapper}\n// changed fixture bytes\n`);
  await assert.rejects(hostHarness.restartPinnedHost(first), error => ['host-integrity', 'wrapper-mismatch'].includes(error.category));
  assert.equal(first.child.exitCode, 0);
  assert.equal(world.gatewayReservation.isReserved(), false);
});

test('restart refuses while a real descendant retains predecessor output after its exit', async t => {
  const contents = `import { spawn } from 'node:child_process';\n${restartWrapper.replace("console.log('STOPPING:' + generation);", "console.log('STOPPING:' + generation); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 1, 2] }).unref();")}`;
  const { runs, options, world } = await restartFixture(t, contents);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  await assert.rejects(hostHarness.restartPinnedHost(first), error => error.category === 'host-output-drain');
  assert.equal(first.child.exitCode, 0);
  assert.equal(world.gatewayReservation.isReserved(), false);
  assert.equal(first.generations.length, 1);
});

test('restart cannot discard a fatal predecessor marker emitted during its final drain', async t => {
  const contents = restartWrapper.replace("console.log('DRAINED:' + generation);", "console.log('DRAINED:' + generation); console.error('plugin not found: command-center');");
  const { runs, options, world } = await restartFixture(t, contents);
  const first = await hostHarness.launchPinnedHost(options); runs.push(first);
  await fixtureReady(first);
  await assert.rejects(hostHarness.restartPinnedHost(first), error => error.category === 'plugin-not-found');
  assert.match(first.diagnostics.stderr, /plugin not found/u);
  assert.equal(first.child.exitCode, 0);
  assert.equal(world.gatewayReservation.isReserved(), false);
});
