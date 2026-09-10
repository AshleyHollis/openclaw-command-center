import path from 'node:path';
import { parseArgs } from 'node:util';
import { readBuiltReceipt } from '../src/build.mjs';
import { packagePluginArtifact } from '../src/plugin-artifact.mjs';
import { runRepositoryChecks } from './repository-checks.mjs';

// Build and package in one private CI invocation. This artifact is input to
// rehearsal/qualification, never evidence that those later checks passed.
try {
  const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true, allowPositionals: false });
  if (!values.output || !path.isAbsolute(values.output)) throw Object.assign(new Error('artifact-arguments-invalid'), { code: 'artifact-arguments-invalid' });
  const checks = await runRepositoryChecks({ purpose: 'capture-prerequisites' });
  const expectedBuildReceipt = await readBuiltReceipt();
  if (expectedBuildReceipt.digest !== checks.buildDigest) throw Object.assign(new Error('artifact-build-approval-mismatch'), { code: 'artifact-build-approval-mismatch' });
  const { receipt } = await packagePluginArtifact({ expectedBuildReceipt, outputDirectory: values.output });
  console.log(JSON.stringify({ status: 'candidate-packaged', releaseQualified: false,
    buildDigest: receipt.buildDigest, archiveSha256: receipt.archive.sha256, files: receipt.files.length }));
} catch (error) {
  const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : 'candidate-packaging-failed';
  console.error(code); process.exitCode = 1;
}
