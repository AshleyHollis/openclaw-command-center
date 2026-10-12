import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { admitRehearsalBuildIdentity, readRehearsalIdentity, selectNativeSdkPackage, selectReleaseRehearsal, selectReleaseRuntime } from '../scripts/release-rehearsal-selection.mjs';
import { releasePerformanceIdentity } from '../src/performance-baseline.mjs';

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

test('historical dispatch uses its frozen identity while callable qualification requires a produced identity', () => {
  assert.equal(readRehearsalIdentity('historical'), releasePerformanceIdentity);
  assert.throws(() => readRehearsalIdentity('candidate'), /Produced candidate qualification identity is required/);
  assert.throws(() => readRehearsalIdentity(undefined), /must be explicit/);
});
test('historical dispatch preparation admits its pinned host without a candidate file', () => {
  assert.equal(admitRehearsalBuildIdentity({ mode: 'historical', buildDigest: 'a'.repeat(64),
    hostReceipt: structuredClone(releasePerformanceIdentity.hostReceipt) }), releasePerformanceIdentity);
  const changed = structuredClone(releasePerformanceIdentity.hostReceipt);
  changed.runtimeDigest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => admitRehearsalBuildIdentity({ mode: 'historical', buildDigest: 'a'.repeat(64),
    hostReceipt: changed }), /selected receipt/);
  assert.throws(() => admitRehearsalBuildIdentity({ mode: 'candidate', buildDigest: 'a'.repeat(64),
    hostReceipt: releasePerformanceIdentity.hostReceipt }), /Produced candidate qualification identity is required/);
});

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

test('native SDK packaging rejects stale source, archive and receipt identities', () => {
  const binding = { runId: '123', artifactName: 'nas-runtime-package-fictional-123-1', archiveSha256: 'a'.repeat(64) };
  const receipt = { name: 'openclaw', source: 'ref', packageSourceSha: runtime.commit,
    packageRef: runtime.commit, version: runtime.version, sha256: binding.archiveSha256 };
  assert.equal(selectNativeSdkPackage(metadata, binding, receipt).commit, runtime.commit);
  for (const mutation of [
    value => { value.receipt.packageSourceSha = 'b'.repeat(40); },
    value => { value.receipt.packageRef = 'b'.repeat(40); },
    value => { value.receipt.version = '0.0.0'; },
    value => { value.receipt.sha256 = 'b'.repeat(64); },
    value => { value.binding.artifactName = 'bad\nENV=value'; },
    value => { value.binding.runId = '123;command'; },
    value => { value.binding.extra = 'unreviewed'; }
  ]) {
    const value = structuredClone({ binding, receipt }); mutation(value);
    assert.throws(() => selectNativeSdkPackage(metadata, value.binding, value.receipt));
  }
});
test('full qualification rejects another image even with matching host receipt',()=>{
  const value=selection();value.scenario='scale-performance';
  value.performanceIdentity={hostVersion:provenance.hostVersion,hostReceipt:structuredClone(provenance.receipt),hostImage:'ghcr.io/ashleyhollis/openclaw@sha256:'+ 'b'.repeat(64)};
  assert.throws(()=>selectReleaseRehearsal(value),/Produced qualification image changed/);
});
