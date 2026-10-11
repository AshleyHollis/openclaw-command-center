import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectReleaseRehearsal, selectReleaseRuntime } from '../scripts/release-rehearsal-selection.mjs';

const json = async file => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
const metadata = { manifest: await json('package.json'), lock: await json('package-lock.json'),
  packageWorkflow: await readFile(new URL('../.github/workflows/package-candidate.yml', import.meta.url), 'utf8') };
const runtime = selectReleaseRuntime(metadata);
const hash = `sha256:${'a'.repeat(64)}`;
const provenance = { schemaVersion: 1, image: `ghcr.io/ashleyhollis/openclaw@${hash}`,
  sourceCommit: runtime.commit, hostVersion: runtime.version,
  receipt: { schemaVersion: 2, sourceDigest: hash, commit: runtime.commit, executableDigest: hash,
    contractDigest: hash, packageDigest: hash, runtimeDigest: hash } };
const selection = () => ({ ...structuredClone(metadata), provenance: structuredClone(provenance),
  performanceIdentity: { hostVersion: 'historical', hostReceipt: {} }, scenario: 'capability-only' });

test('focused rehearsal derives the current native tuple and existing packaging runtime', () => {
  assert.deepEqual(selectReleaseRehearsal(selection()), { ...runtime, image: provenance.image, receipt: provenance.receipt });
});

test('mixed release identities, mutable images and injected environment values fail closed', () => {
  for (const mutate of [
    value => { value.scenario = 'fictional-unsupported-scenario'; },
    value => { value.provenance.image = 'ghcr.io/ashleyhollis/openclaw:latest'; },
    value => { value.provenance.image += '\nINJECTED=true'; },
    value => { value.provenance.sourceCommit = 'b'.repeat(40); },
    value => { value.provenance.hostVersion = '2026.9.5'; },
    value => { value.provenance.receipt.commit = 'b'.repeat(40); },
    value => { delete value.provenance.receipt.runtimeDigest; },
    value => { value.provenance.receipt.packageDigest = 'not-a-digest'; },
    value => { value.provenance.privateData = 'unrecognized'; },
    value => { value.lock.packages['node_modules/openclaw'].version = '0.0.0'; },
    value => { value.manifest.peerDependencies.openclaw = '0.0.0'; },
    value => { value.packageWorkflow += '\n          node-version: 24.22.0\n'; }
  ]) {
    const value = selection(); mutate(value);
    assert.throws(() => selectReleaseRehearsal(value));
  }
});

test('full and performance-dependent lanes cannot rebind the frozen baseline', () => {
  for (const scenario of ['', 'scale-performance', 'native-release-prerequisites']) {
    assert.throws(() => selectReleaseRehearsal({ ...selection(), scenario }), /Frozen performance host changed/);
    const value = selection(); value.scenario = scenario;
    value.performanceIdentity = { hostVersion: provenance.hostVersion, hostReceipt: structuredClone(provenance.receipt) };
    assert.deepEqual(selectReleaseRehearsal(value).receipt, provenance.receipt);
    value.performanceIdentity.hostReceipt.runtimeDigest = `sha256:${'b'.repeat(64)}`;
    assert.throws(() => selectReleaseRehearsal(value), /Frozen performance receipt changed/);
  }
});
