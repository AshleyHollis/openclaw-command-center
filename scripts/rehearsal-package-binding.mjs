import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const retainedAssemblyProduct = Object.freeze({
  sourceCommit: 'dc1fb006d0c3c57821129e7d1d645e237b91b65f',
  buildDigest: 'da18debd1f5aa312e534b0e71a888fceb843d0d4ec381b51b8e3c384df996c05',
  archiveSha256: '3bdb9e79d3e0339e7419afc8bcdf32b5d143b861ab252418c92ec60d804f094a',
  receiptSha256: '87407da27e5a1c2d11eedb9bf910ed1d5a2826c59dc6cea8becd1396c10da5de'
});
const rootMembers = ['LICENSE', 'openclaw.plugin.json', 'package.json'];
export async function restoreVerifiedProduct({ verifiedDirectory, checkoutDirectory, receipt }) {
  const expected = receipt.files.map(file => file.path).sort();
  assert.deepEqual(expected.filter(name => !name.startsWith('dist/')), rootMembers,
    'Verified product must contain exactly the three existing root manifests');
  assert.ok(expected.some(name => name === 'dist/.command-center-digest.json'), 'Sealed dist receipt is required');
  const found = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert.ok(entry.isDirectory() || entry.isFile(), `Unsafe verified product member: ${name}`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else found.push(name);
    }
  }
  await visit(verifiedDirectory);
  assert.deepEqual(found.sort(), expected, 'Verified product has missing or extra members');
  const dist = path.join(checkoutDirectory, 'dist');
  assert.equal(await lstat(dist).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), false, 'Candidate dist must be absent before restoring the sealed product');
  for (const file of receipt.files) {
    const bytes = await readFile(path.join(verifiedDirectory, file.path));
    assert.equal(bytes.length, file.sizeBytes, `Verified product size changed: ${file.path}`);
    assert.equal(sha(bytes), file.sha256, `Verified product byte changed: ${file.path}`);
    if (rootMembers.includes(file.path)) assert.deepEqual(await readFile(path.join(checkoutDirectory, file.path)), bytes,
      `Checkout root manifest differs from sealed product: ${file.path}`);
  }
  await cp(path.join(verifiedDirectory, 'dist'), dist, { recursive: true, force: false, errorOnExist: true });
}
export function validatePackageBinding(binding, sourceCommit) {
  const assembly = binding.source === 'assembly';
  assert.deepEqual(Object.keys(binding).sort(), (assembly
    ? ['source', 'pairId', 'runId', 'runAttempt', 'assemblySourceCommit', 'archiveSha256', 'buildDigest', 'receiptSha256', 'sourceCommit', 'identitySha256', 'provenanceSha256']
    : ['archiveSha256', 'buildDigest', 'receiptSha256', 'runId', 'sourceCommit']).sort());
  assert.match(binding.runId, /^[1-9]\d*$/u);
  if (assembly) {
    assert.equal(binding.pairId, 'next2-7aaa-dc1-20261012');
    assert.match(binding.runAttempt, /^[1-9]\d*$/u);
    assert.match(binding.assemblySourceCommit, /^[a-f0-9]{40}$/u);
    for (const name of ['identitySha256', 'provenanceSha256']) assert.match(binding[name], /^[a-f0-9]{64}$/u);
    for (const [name, expected] of Object.entries(retainedAssemblyProduct))
      assert.equal(binding[name], expected, `Assembly product ${name} differs from frozen package`);
  }
  assert.match(binding.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(binding.sourceCommit, sourceCommit, 'Selected CC package source differs from frozen product source');
  for (const name of ['archiveSha256', 'buildDigest', 'receiptSha256']) assert.match(binding[name], /^[a-f0-9]{64}$/u);
  return binding;
}
export function validateAssemblyRun(binding, run, repository) {
  assert.equal(binding.source, 'assembly');
  assert.equal(String(run.id), binding.runId);
  assert.equal(String(run.run_attempt), binding.runAttempt);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_sha, binding.assemblySourceCommit);
  assert.equal(run.path, '.github/workflows/assemble-sealed-image-pair.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
}
export function validateAssemblyRequest(binding, runId, runAttempt) {
  assert.equal(binding.source, 'assembly');
  assert.equal(binding.runId, runId, 'Assembly run input differs from pinned binding');
  assert.equal(binding.runAttempt, runAttempt, 'Assembly attempt input differs from pinned binding');
}
export function validateAssemblyInputs(binding, identityBytes, provenanceBytes) {
  assert.equal(sha(identityBytes), binding.identitySha256, 'Installed-host identity bytes changed');
  assert.equal(sha(provenanceBytes), binding.provenanceSha256, 'Host provenance bytes changed');
  const identity = JSON.parse(identityBytes);
  const provenance = JSON.parse(provenanceBytes);
  assert.equal(identity.ccSourceCommit, binding.sourceCommit);
  assert.equal(identity.ccBuildDigest, binding.buildDigest);
  assert.equal(identity.ccArchiveSha256, binding.archiveSha256);
  assert.equal(identity.ccReceiptSha256, binding.receiptSha256);
  assert.equal(identity.provenanceSha256, binding.provenanceSha256);
  assert.equal(identity.hostImage, provenance.image);
  assert.deepEqual(identity.hostReceipt, provenance.receipt);
  return { identity, provenance };
}
export function validatePackageReceipt(binding, bytes) {
  assert.equal(sha(bytes), binding.receiptSha256, 'CC receipt bytes changed');
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.sourceCommit, binding.sourceCommit);
  assert.equal(receipt.buildDigest, binding.buildDigest);
  assert.equal(receipt.archive.sha256, binding.archiveSha256);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(process.env.CC_PACKAGE_BINDING);
  const binding = validatePackageBinding(input, input.source === 'assembly'
    ? retainedAssemblyProduct.sourceCommit : process.env.COMMAND_CENTER_SOURCE_COMMIT ?? process.env.GITHUB_SHA);
  if (process.argv[2] === 'select') {
    const { appendFile } = await import('node:fs/promises');
    if (binding.source === 'assembly') {
      validateAssemblyRequest(binding, process.env.ASSEMBLY_RUN_ID, process.env.ASSEMBLY_RUN_ATTEMPT);
      const directory = path.join(process.env.RUNNER_TEMP, 'selected-cc-package');
      validateAssemblyRun(binding, JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')), process.env.GITHUB_REPOSITORY);
      const identityFile = path.join(directory, 'candidate-qualification-identity.json');
      const provenanceFile = path.join(directory, 'host-provenance.json');
      const { provenance } = validateAssemblyInputs(binding, await readFile(identityFile), await readFile(provenanceFile));
      await appendFile(process.env.GITHUB_ENV, `COMMAND_CENTER_QUALIFICATION_IDENTITY=${identityFile}\nCOMMAND_CENTER_QUALIFICATION_IDENTITY_SHA256=${binding.identitySha256}\nHOST_PROVENANCE=${JSON.stringify(provenance)}\nCOMMAND_CENTER_SOURCE_COMMIT=${binding.sourceCommit}\n`);
    } else await appendFile(process.env.GITHUB_ENV, `CC_PACKAGE_RUN=${binding.runId}\nCC_PACKAGE_ARTIFACT=command-center-candidate-${binding.sourceCommit}\n`);
  } else {
    const { verifyPluginArtifact } = await import('../src/plugin-artifact.mjs');
    const { readBuiltReceipt } = await import('../src/build.mjs');
    const { scanPublicEvidence } = await import('../src/safety.mjs');
    const directory = path.join(process.env.RUNNER_TEMP, 'selected-cc-package');
    const receipt = validatePackageReceipt(binding, await readFile(path.join(directory, binding.source === 'assembly' ? 'command-center-receipt.json' : 'receipt.json')));
    const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    if (binding.source === 'assembly') {
      validateAssemblyRun(binding, run, process.env.GITHUB_REPOSITORY);
      validateAssemblyInputs(binding, await readFile(path.join(directory, 'candidate-qualification-identity.json')),
        await readFile(path.join(directory, 'host-provenance.json')));
    } else {
      assert.equal(String(run.id), binding.runId);
      assert.equal(run.head_sha, binding.sourceCommit);
      assert.equal(run.path, '.github/workflows/package-candidate.yml');
      assert.equal(run.conclusion, 'success');
    }
    const privateParent = path.join(process.env.RUNNER_TEMP, 'verified-cc');
    await mkdir(privateParent, { mode: 0o700, recursive: true });
    const verifiedDirectory = path.join(privateParent, process.argv[2]);
    await verifyPluginArtifact({ archivePath: path.join(directory, 'command-center.tgz'), expectedReceipt: receipt,
      destinationDirectory: verifiedDirectory });
    if (binding.source === 'assembly' && process.argv[2] === 'before') await restoreVerifiedProduct({
      verifiedDirectory, checkoutDirectory: process.cwd(), receipt });
    assert.equal((await readBuiltReceipt()).digest, binding.buildDigest);
    // Every packaged byte, including manifests, must equal what this source
    // rehearsal will load. Do not install a historical feature fixture.
    for (const file of receipt.files) assert.equal(sha(await readFile(file.path)), file.sha256, `CC packaged member changed: ${file.path}`);
    const { FIRST_LIVE_FEATURES } = await import('../dist/release-scope.mjs');
    let scenariosRan = [];
    if (process.argv[2] === 'after' && process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO !== 'capability-only') {
      const log = await readFile(path.join(process.env.RUNNER_TEMP, 'qualification.log'), 'utf8');
      const markers = ['acceptance-scenario-result=', 'acceptance-prerequisites='];
      const results = log.split(/\r?\n/u).flatMap(line => markers.filter(marker => line.includes(marker))
        .map(marker => JSON.parse(line.slice(line.indexOf(marker) + marker.length))));
      assert.equal(results.length, 1, 'Exactly one canonical scenario completion must be retained');
      assert.equal(results[0].buildDigest, binding.buildDigest);
      scenariosRan = results[0];
    }
    const result = { schemaVersion: 1, kind: 'hosted-rehearsal-package-binding', ...binding,
      harnessSourceCommit: process.env.HARNESS_SOURCE_COMMIT,
      hostReceipt: JSON.parse(process.env.EXPECTED_HOST_RECEIPT), hostImage: process.env.IMAGE,
      featureMap: FIRST_LIVE_FEATURES, selectedScenario: process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO,
      scenariosRan, phase: process.argv[2], performanceQualified: false };
    scanPublicEvidence([JSON.stringify(result)], { label: 'hosted-rehearsal-package-binding' });
    await writeFile(path.join(process.env.RUNNER_TEMP, `rehearsal-package-${process.argv[2]}.json`), `${JSON.stringify(result)}\n`, { flag: 'wx' });
  }
}
