import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { packagePluginArtifact } from '../src/plugin-artifact.mjs';

// The approval digest is supplied separately by the build/publishing owner.
// Never adopt dist's own receipt as an independent packaging approval.
try {
  const { values } = parseArgs({ options: {
    'build-receipt': { type: 'string' }, 'receipt-sha256': { type: 'string' }, output: { type: 'string' }
  }, strict: true, allowPositionals: false });
  if (!values['build-receipt'] || !path.isAbsolute(values['build-receipt']) || !values.output || !path.isAbsolute(values.output) ||
      !/^[a-f0-9]{64}$/.test(values['receipt-sha256'] ?? '')) throw Object.assign(new Error('artifact-arguments-invalid'), { code: 'artifact-arguments-invalid' });
  const bytes = await readFile(values['build-receipt']);
  if (bytes.length > 2 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== values['receipt-sha256']) {
    throw Object.assign(new Error('artifact-build-approval-mismatch'), { code: 'artifact-build-approval-mismatch' });
  }
  const { receipt } = await packagePluginArtifact({ expectedBuildReceipt: JSON.parse(bytes.toString('utf8')), outputDirectory: values.output });
  console.log(JSON.stringify({ status: 'verified', buildDigest: receipt.buildDigest, archiveSha256: receipt.archive.sha256, files: receipt.files.length }));
} catch (error) {
  const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : 'artifact-packaging-failed';
  console.error(code); process.exitCode = 1;
}
