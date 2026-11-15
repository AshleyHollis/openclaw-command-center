import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { distRoot, readBuiltReceipt } from '../src/build.mjs';
import { verifyPluginArtifact } from '../src/plugin-artifact.mjs';

const sourceRoot = path.dirname(distRoot);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validatePackageBinding(binding, sourceCommit) {
  assert.ok(binding && typeof binding === 'object' && !Array.isArray(binding), 'Candidate package binding must be an object');
  assert.deepEqual(Object.keys(binding).sort(), ['archiveSha256', 'buildDigest', 'receiptSha256', 'runId', 'sourceCommit']);
  assert.match(binding.runId, /^[1-9]\d*$/u);
  assert.match(binding.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(binding.sourceCommit, sourceCommit, 'Selected candidate source differs from qualification source');
  for (const name of ['archiveSha256', 'buildDigest', 'receiptSha256']) assert.match(binding[name], /^[a-f0-9]{64}$/u);
  return binding;
}

async function installSelectedPackage(binding, runnerTemp) {
  const run = JSON.parse(await readFile(path.join(runnerTemp, 'selected-cc-package-run.json'), 'utf8'));
  assert.equal(String(run.id), binding.runId, 'Selected candidate producer run differs');
  assert.equal(run.head_sha, binding.sourceCommit, 'Selected candidate producer source differs');
  assert.equal(run.path, '.github/workflows/package-candidate.yml', 'Selected run did not run candidate packaging');
  assert.equal(run.conclusion, 'success', 'Selected candidate producer did not succeed');

  const directory = path.join(runnerTemp, 'selected-cc-package');
  const receiptBytes = await readFile(path.join(directory, 'receipt.json'));
  assert.equal(sha256(receiptBytes), binding.receiptSha256, 'Selected candidate receipt bytes differ');
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.sourceCommit, binding.sourceCommit);
  assert.equal(receipt.buildDigest, binding.buildDigest);
  assert.equal(receipt.archive.sha256, binding.archiveSha256);

  // Keep staging on the same filesystem as dist so publication is a rename.
  const staging = await mkdtemp(path.join(sourceRoot, '.qualification-package-'));
  try {
    const verified = await verifyPluginArtifact({
      archivePath: path.join(directory, 'command-center.tgz'),
      expectedReceipt: receipt,
      destinationDirectory: path.join(staging, 'verified')
    });
    // The harness installs from the checkout. Its tracked package files must
    // match the archive, and its output comes directly from the verified tree.
    for (const file of receipt.files.filter(file => !file.path.startsWith('dist/'))) {
      assert.equal(sha256(await readFile(path.join(sourceRoot, file.path))), file.sha256,
        `Checked-out package member differs: ${file.path}`);
    }
    await rename(path.join(verified, 'dist'), distRoot);
    try {
      assert.equal((await readBuiltReceipt()).digest, binding.buildDigest);
    } catch (error) {
      await rm(distRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const binding = validatePackageBinding(JSON.parse(process.env.CC_PACKAGE_BINDING), process.env.GITHUB_SHA);
  switch (process.argv[2]) {
    case 'select':
      await appendFile(process.env.GITHUB_ENV, `CC_PACKAGE_RUN=${binding.runId}\nCC_PACKAGE_ARTIFACT=command-center-candidate-${binding.sourceCommit}\n`);
      break;
    case 'install':
      await installSelectedPackage(binding, process.env.RUNNER_TEMP);
      console.log(JSON.stringify({ status: 'qualification-package-verified', ...binding }));
      break;
    default:
      throw new Error('Expected select or install');
  }
}
