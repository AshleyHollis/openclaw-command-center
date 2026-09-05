import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, createHostOutputClassifier, fetchJsonWithDeadline, HarnessFailure, classifyHostOutput, parseHostDescriptor, pinnedHost, redact, verifyHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';

const sourceDigest = `sha256:${'a'.repeat(64)}`;
const placeholderExecutableDigest = `sha256:${'b'.repeat(64)}`;
const contractDigest = `sha256:${'c'.repeat(64)}`;

function hostDescriptor({ checkout = '/fixture', executable = pinnedHost.executable, args = pinnedHost.args, commit = pinnedHost.commit, integrity = { sourceDigest, executableDigest: placeholderExecutableDigest, contractDigest }, ...rest } = {}) {
  return JSON.stringify({ checkout, executable, args, commit, integrity, ...rest });
}

async function temporaryHost() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-host-'));
  const root = path.join(parent, 'openclaw-host');
  await mkdir(root);
  const wrapper = path.join(root, pinnedHost.executable);
  const contents = '#!/usr/bin/env node\nconsole.log("fixture host");\n';
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
  assert.equal(pinnedHost.commit, '2309e6542d0ba631178c8e647a2dc8b4763651bd');
  assert.doesNotThrow(() => parseHostDescriptor(hostDescriptor()));
  assert.throws(() => parseHostDescriptor(hostDescriptor({ commit: '19686a23834910173df0fd1f77bd762ffcda2afd' })), (error) => error.category === 'invalid-commit');
});

test('requires consecutive readiness and notices flapping', async () => {
  const values = [true, false, true, true];
  await waitForConsecutiveReadiness(() => values.shift(), new Promise(() => {}), { attempts: 4 });
  await assert.rejects(waitForConsecutiveReadiness(() => false, new Promise(() => {}), { attempts: 2 }), (error) => error.category === 'readiness-flapping');
});

test('startup readiness retries only refused connections and still requires consecutive successful probes', async () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('socket not listening'), { code: 'ECONNREFUSED' }) });
  const observations = [refused, true, refused, true, true];
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
  assert.doesNotMatch(redact(['Bear', 'er fictional-token-123456'].join('')), /fictional-token/);
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
