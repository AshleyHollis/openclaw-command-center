import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { finalNext2Members, frozenNext2Inputs, assertFinalNext2Members,
  validateProducedBinding, verifyAssemblyEvidence } from '../scripts/seal-next2-produced-host.mjs';
import { retainedAssemblyProduct, validateAssemblyRun } from '../scripts/rehearsal-package-binding.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'b'.repeat(40), image = `sha256:${'a'.repeat(64)}`;
const manifest = { pairId: 'next2-7aaa-dc1-20261012',
  hostCommit: '7aaa0289cc95f683decddfca1cc506e550d24b48',
  ccCommit: retainedAssemblyProduct.sourceCommit, ccBuildDigest: retainedAssemblyProduct.buildDigest,
  inputs: Object.fromEntries(Object.entries(frozenNext2Inputs).map(([name, [digest, bytes]]) =>
    [name, { sha256: digest, bytes }])) };
const workflow = { runId: '123', runAttempt: '1', workflowCommit: commit };
const receipt = { schemaVersion: 1, pairId: manifest.pairId, manifest, state: 'complete',
  images: { host: { ref: `ghcr.io/ashleyhollis/openclaw@${image}`, readbackPassed: true },
    carrier: { ref: `ghcr.io/ashleyhollis/openclaw@sha256:${'c'.repeat(64)}`, readbackPassed: true } } };
const evidence = () => ({ receipt: structuredClone(receipt), workflow: structuredClone(workflow),
  manifest: structuredClone(manifest), runId: '123', runAttempt: '1', assemblySourceCommit: commit, imageDigest: image });

test('same-run completed assembly evidence admits an outer run still in progress', () => {
  assert.doesNotThrow(() => verifyAssemblyEvidence(evidence()));
  const binding = { source: 'assembly', runId: '123', runAttempt: '1', assemblySourceCommit: commit };
  assert.throws(() => validateAssemblyRun(binding, { id: 123, run_attempt: 1,
    repository: { full_name: 'example/private' }, head_sha: commit,
    path: '.github/workflows/assemble-sealed-image-pair.yml', status: 'in_progress' }, 'example/private'));
});

test('producer rejects incomplete pair, failed carrier readback, wrong run and wrong image', () => {
  for (const change of [
    value => { value.receipt.state = 'running'; },
    value => { value.receipt.images.carrier.readbackPassed = false; },
    value => { value.workflow.runAttempt = '2'; },
    value => { value.receipt.images.host.ref = `ghcr.io/ashleyhollis/openclaw@sha256:${'d'.repeat(64)}`; },
    value => { value.manifest.inputs['openclaw-current.tgz'].sha256 = 'e'.repeat(64); }
  ]) {
    const value = evidence(); change(value);
    assert.throws(() => verifyAssemblyEvidence(value));
  }
});

test('produced binding rejects changed identity, native archive and CC receipt bytes', () => {
  const nativeReceiptBytes = Buffer.from('fictional native metadata');
  const provenance = { image: `ghcr.io/ashleyhollis/openclaw@${image}`, receipt: { schemaVersion: 2 } };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance));
  const identity = { ccSourceCommit: retainedAssemblyProduct.sourceCommit,
    ccBuildDigest: retainedAssemblyProduct.buildDigest, ccArchiveSha256: retainedAssemblyProduct.archiveSha256,
    ccReceiptSha256: retainedAssemblyProduct.receiptSha256, provenanceSha256: sha(provenanceBytes),
    hostImage: provenance.image, hostReceipt: provenance.receipt,
    nativeArchiveSha256: frozenNext2Inputs['openclaw-current.tgz'][0], nativeReceiptSha256: sha(nativeReceiptBytes) };
  const identityBytes = Buffer.from(JSON.stringify(identity));
  const receiptBytes = Buffer.from(JSON.stringify({ sourceCommit: retainedAssemblyProduct.sourceCommit,
    buildDigest: retainedAssemblyProduct.buildDigest, archive: { sha256: retainedAssemblyProduct.archiveSha256 } }));
  const args = { runId: '123', runAttempt: '1', assemblySourceCommit: commit,
    identityBytes, provenanceBytes, receiptBytes, nativeReceiptBytes };
  assert.throws(() => validateProducedBinding(args), /CC receipt bytes changed/u);
  assert.throws(() => validateProducedBinding({ ...args, identityBytes: Buffer.from('{}') }));
  assert.throws(() => validateProducedBinding({ ...args, identityBytes: Buffer.from(JSON.stringify({ ...identity,
    nativeArchiveSha256: 'f'.repeat(64) })) }));
  assert.throws(() => validateProducedBinding({ ...args, nativeReceiptBytes: Buffer.from('changed') }));
});

test('final artifact requires all seven members and a pristine directory', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next2-seal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(assertFinalNext2Members(directory), /Final artifact members changed/u);
  for (const name of finalNext2Members) await writeFile(path.join(directory, name), 'fictional fixture\n');
  await assertFinalNext2Members(directory);
  await assert.rejects(writeFile(path.join(directory, finalNext2Members[0]), 'changed\n', { flag: 'wx' }), { code: 'EEXIST' });
});
