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

// Packaging consumes the collector's selected artifact; it never substitutes
// the historical EA SDK when the candidate host changes.
export function selectNativeSdkPackage(metadata, binding, receipt) {
  const selected = selectReleaseRuntime(metadata);
  keys(binding, ['runId', 'artifactName', 'archiveSha256']);
  assert.match(binding.runId, /^[1-9][0-9]*$/u);
  assert.match(binding.archiveSha256, /^[a-f0-9]{64}$/u);
  assert.match(binding.artifactName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  if (receipt) {
    assert.equal(receipt.name, 'openclaw');
    assert.equal(receipt.source, 'ref');
    assert.equal(receipt.packageSourceSha, selected.commit);
    assert.equal(receipt.packageRef, selected.commit);
    assert.equal(receipt.version, selected.version);
    assert.equal(receipt.sha256, binding.archiveSha256);
  }
  return { ...selected, ...binding };
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
  if (process.argv[2] === 'native-sdk') {
    const binding = JSON.parse(process.env.NATIVE_PACKAGE_BINDING ?? 'null');
    const selected = selectNativeSdkPackage(metadata, binding,
      process.argv[3] ? await json(process.argv[3]) : undefined);
    if (!process.argv[3]) process.stdout.write(
      `${selected.runId}\n${selected.artifactName}\n${selected.archiveSha256}\n`);
    process.exit(0);
  }
  let selected;
  if (process.env.PREPARE_HOST_RECEIPT === '1') {
    assert.match(process.env.IMAGE_DIGEST ?? '', digest);
    assert.match(process.env.COMMAND_CENTER_NATIVE_PACKAGE_SHA256 ?? '', /^[a-f0-9]{64}$/u);
    selected = { ...selectReleaseRuntime(metadata), image: `ghcr.io/ashleyhollis/openclaw@${process.env.IMAGE_DIGEST}` };
  } else selected = selectReleaseRehearsal({
    ...metadata, provenance: JSON.parse(process.env.HOST_PROVENANCE),
    performanceIdentity: releasePerformanceIdentity, scenario: process.env.REHEARSAL_SCENARIO ?? ''
  });
  await appendFile(process.env.GITHUB_ENV, `IMAGE=${selected.image}\nOPENCLAW_COMMIT=${selected.commit}\nOPENCLAW_VERSION=${selected.version}\nREHEARSAL_NODE=${selected.node}\nCOMMAND_CENTER_NATIVE_PACKAGE_SHA256=${selected.receipt ? selected.receipt.packageDigest.slice(7) : process.env.COMMAND_CENTER_NATIVE_PACKAGE_SHA256}\n${selected.receipt ? `EXPECTED_HOST_RECEIPT=${JSON.stringify(selected.receipt)}\n` : ''}`);
  await appendFile(process.env.GITHUB_OUTPUT, `commit=${selected.commit}\nnode=${selected.node}\n`);
}
