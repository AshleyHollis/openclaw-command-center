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
  const diagnostics = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object' || diagnostics.length >= 8) return;
    const diagnostic = { name: value.name };
    if (typeof value.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.code)) diagnostic.code = value.code;
    if (typeof value.message === 'string' && /^[\x20-\x7e]{1,200}$/.test(value.message)) diagnostic.message = value.message;
    diagnostics.push(diagnostic);
    visit(value.cause);
    if (Array.isArray(value.errors)) for (const nested of value.errors) visit(nested);
  };
  visit(error);
  console.error(JSON.stringify({ code, diagnostics })); process.exitCode = 1;
}
