import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validatePackageBinding, validatePackageReceipt } from '../scripts/rehearsal-package-binding.mjs';
const sourceCommit = 'a'.repeat(40);
const receipt = { sourceCommit, buildDigest: 'b'.repeat(64), archive: { sha256: 'c'.repeat(64) } };
const bytes = Buffer.from(JSON.stringify(receipt));
const binding = { runId: '1234', sourceCommit, buildDigest: receipt.buildDigest, archiveSha256: receipt.archive.sha256,
  receiptSha256: createHash('sha256').update(bytes).digest('hex') };
test('selected CC package binds exact source, receipt bytes, archive and build', () => {
  assert.deepEqual(validatePackageBinding(binding, sourceCommit), binding);
  assert.deepEqual(validatePackageReceipt(binding, bytes), receipt);
});
test('mixed CC source, receipt tampering and stale archive/build tuples are refused', () => {
  assert.throws(() => validatePackageBinding(binding, 'd'.repeat(40)));
  assert.throws(() => validatePackageBinding({ ...binding, runId: '1234\nINJECT=true' }, sourceCommit));
  assert.throws(() => validatePackageReceipt(binding, Buffer.concat([bytes, Buffer.from('\n')])));
  for (const name of ['sourceCommit', 'buildDigest', 'archiveSha256']) {
    assert.throws(() => validatePackageReceipt({ ...binding, [name]: 'd'.repeat(name === 'sourceCommit' ? 40 : 64) }, bytes));
  }
});
