import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveRealHostAcceptancePlan } from '../src/test-selection.mjs';

const digest = /^sha256:[a-f0-9]{64}$/u;
const receiptKeys = ['schemaVersion', 'sourceDigest', 'commit', 'executableDigest', 'contractDigest', 'packageDigest', 'runtimeDigest'];
function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

// Consume the existing host-receipt provenance format. Selection alone is not
// authentication: the worker must recompute the receipt and call verifyHost.
export function selectReleaseRuntime({ manifest, lock, packageWorkflow }) {
  const version = manifest.devDependencies.openclaw;
  const commit = manifest.commandCenter.compatibilityTuple.host.commit;
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.peerDependencies.openclaw, version);
  assert.equal(manifest.commandCenter.compatibilityTuple.host.range, `=${version}`);
  const native = lock.packages['node_modules/openclaw'];
  assert.equal(native.version, version);
  assert.match(native.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u);
  const versions = [...packageWorkflow.matchAll(/^\s+node-version: (\d+\.\d+\.\d+)\s*$/gmu)].map(match => match[1]);
  assert.equal(versions.length, 1, 'Packaging must declare one exact Node runtime');
  return { commit, version, node: versions[0] };
}

export function selectReleaseRehearsal({ provenance, manifest, lock, packageWorkflow, performanceIdentity, scenario }) {
  if (scenario !== 'capability-only') resolveRealHostAcceptancePlan(scenario);
  keys(provenance, ['schemaVersion', 'image', 'sourceCommit', 'hostVersion', 'receipt']);
  assert.equal(provenance.schemaVersion, 1);
  assert.match(provenance.image, /^ghcr\.io\/ashleyhollis\/openclaw@sha256:[a-f0-9]{64}$/u);
  const { commit, version, node } = selectReleaseRuntime({ manifest, lock, packageWorkflow });
  assert.equal(provenance.hostVersion, version);
  assert.equal(provenance.sourceCommit, commit);
  keys(provenance.receipt, receiptKeys);
  assert.equal(provenance.receipt.schemaVersion, 2);
  assert.equal(provenance.receipt.commit, commit);
  for (const key of receiptKeys.filter(key => key.endsWith('Digest'))) assert.match(provenance.receipt[key], digest);
  // The exact packaging runtime is already owned by package-candidate.yml.
  if (scenario === '' || ['native-release-prerequisites', 'scale-performance'].includes(scenario)) {
    assert.equal(provenance.hostVersion, performanceIdentity.hostVersion, 'Frozen performance host changed; separate baseline qualification is required');
    assert.deepEqual(provenance.receipt, performanceIdentity.hostReceipt, 'Frozen performance receipt changed');
  }
  return { image: provenance.image, commit, version, node, receipt: provenance.receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = async file => JSON.parse(await readFile(file, 'utf8'));
  const { releasePerformanceIdentity } = await import('../src/performance-baseline.mjs');
  const metadata = {
    manifest: await json('package.json'), lock: await json('package-lock.json'),
    packageWorkflow: await readFile('.github/workflows/package-candidate.yml', 'utf8')
  };
  let selected;
  if (process.env.PREPARE_HOST_RECEIPT === '1') {
    assert.match(process.env.IMAGE_DIGEST ?? '', digest);
    selected = { ...selectReleaseRuntime(metadata), image: `ghcr.io/ashleyhollis/openclaw@${process.env.IMAGE_DIGEST}` };
  } else selected = selectReleaseRehearsal({
    ...metadata, provenance: JSON.parse(process.env.HOST_PROVENANCE),
    performanceIdentity: releasePerformanceIdentity, scenario: process.env.REHEARSAL_SCENARIO ?? ''
  });
  await appendFile(process.env.GITHUB_ENV, `IMAGE=${selected.image}\nOPENCLAW_COMMIT=${selected.commit}\nOPENCLAW_VERSION=${selected.version}\nREHEARSAL_NODE=${selected.node}\n${selected.receipt ? `EXPECTED_HOST_RECEIPT=${JSON.stringify(selected.receipt)}\n` : ''}`);
  await appendFile(process.env.GITHUB_OUTPUT, `commit=${selected.commit}\nnode=${selected.node}\n`);
}
