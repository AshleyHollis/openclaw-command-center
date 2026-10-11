import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function validatePackageBinding(binding, sourceCommit) {
  assert.deepEqual(Object.keys(binding).sort(), ['archiveSha256', 'buildDigest', 'receiptSha256', 'runId', 'sourceCommit'].sort());
  assert.match(binding.runId, /^[1-9]\d*$/u);
  assert.match(binding.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(binding.sourceCommit, sourceCommit, 'Selected CC package source differs from rehearsal source');
  for (const name of ['archiveSha256', 'buildDigest', 'receiptSha256']) assert.match(binding[name], /^[a-f0-9]{64}$/u);
  return binding;
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
  const binding = validatePackageBinding(JSON.parse(process.env.CC_PACKAGE_BINDING), process.env.GITHUB_SHA);
  if (process.argv[2] === 'select') {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_ENV, `CC_PACKAGE_RUN=${binding.runId}\nCC_PACKAGE_ARTIFACT=command-center-candidate-${binding.sourceCommit}\n`);
  } else {
    const { verifyPluginArtifact } = await import('../src/plugin-artifact.mjs');
    const { readBuiltReceipt } = await import('../src/build.mjs');
    const { scanPublicEvidence } = await import('../src/safety.mjs');
    const directory = path.join(process.env.RUNNER_TEMP, 'selected-cc-package');
    const receipt = validatePackageReceipt(binding, await readFile(path.join(directory, 'receipt.json')));
    const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    assert.equal(String(run.id), binding.runId);
    assert.equal(run.head_sha, binding.sourceCommit);
    assert.equal(run.path, '.github/workflows/package-candidate.yml');
    assert.equal(run.conclusion, 'success');
    const privateParent = path.join(process.env.RUNNER_TEMP, 'verified-cc');
    await mkdir(privateParent, { mode: 0o700, recursive: true });
    await verifyPluginArtifact({ archivePath: path.join(directory, 'command-center.tgz'), expectedReceipt: receipt,
      destinationDirectory: path.join(privateParent, process.argv[2]) });
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
      hostReceipt: JSON.parse(process.env.EXPECTED_HOST_RECEIPT), hostImage: process.env.IMAGE,
      featureMap: FIRST_LIVE_FEATURES, selectedScenario: process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO,
      scenariosRan, phase: process.argv[2], performanceQualified: false };
    scanPublicEvidence([JSON.stringify(result)], { label: 'hosted-rehearsal-package-binding' });
    await writeFile(path.join(process.env.RUNNER_TEMP, `rehearsal-package-${process.argv[2]}.json`), `${JSON.stringify(result)}\n`, { flag: 'wx' });
  }
}
