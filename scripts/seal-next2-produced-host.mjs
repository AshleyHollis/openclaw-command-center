import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { retainedAssemblyProduct, validateAssemblyInputs, validatePackageBinding, validatePackageReceipt } from './rehearsal-package-binding.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pair = 'next2-7aaa-dc1-20261012';
const nativeCommit = '7aaa0289cc95f683decddfca1cc506e550d24b48';
export const finalNext2Members = Object.freeze([
  'cc-package-binding.json', 'candidate-qualification-identity.json', 'command-center-receipt.json',
  'command-center.tgz', 'host-provenance.json', 'native-next2-discord.bundle', 'package-candidate.json'
]);
export const frozenNext2Inputs = Object.freeze({
  'image-input-packet-current.tar.gz': ['434a355998a28918bc3e72079bae0070b281f18dcb2c700c60452edccf4c2b76', 54439],
  'package-candidate.json': ['ddedac83bad84a0c96944bbd6b221f29ae6fc3e752f43749c395cbff50a743c0', 438],
  'command-center-receipt.json': [retainedAssemblyProduct.receiptSha256, 42891],
  'openclaw-current.tgz': ['248259c5a7cdab28954cfa292b18c87991743a81e3ddc41cf8206e96e86b19e2', 107287756],
  'command-center.tgz': [retainedAssemblyProduct.archiveSha256, 3794958]
});
const required = name => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};
const read = async name => readFile(path.join(required('ASSEMBLY_DIRECTORY'), name));
export async function verifyRawNext2Inputs() {
  for (const [name, [digest, length]] of Object.entries(frozenNext2Inputs)) {
    const bytes = await read(name);
    assert.equal(bytes.length, length, `${name} length changed`);
    assert.equal(sha(bytes), digest, `${name} digest changed`);
  }
  const archive = JSON.parse(await read('package-candidate.json'));
  assert.equal(archive.sha256, frozenNext2Inputs['openclaw-current.tgz'][0]);
  assert.equal(archive.packageSourceSha, nativeCommit);
  const bundleBytes = await readFile(required('NATIVE_BUNDLE'));
  assert.equal(bundleBytes.length, 53893);
  assert.equal(sha(bundleBytes), '3395b701b574f2d0c6d7ef5b5f1126304bedba8da77f32b4f958f50624f557a0');
}

export function verifyAssemblyEvidence({ receipt, workflow, manifest, runId, runAttempt, assemblySourceCommit, imageDigest }) {
  assert.deepEqual(Object.keys(workflow).sort(), ['runId', 'runAttempt', 'workflowCommit'].sort());
  assert.equal(workflow.runId, runId);
  assert.equal(workflow.runAttempt, runAttempt);
  assert.equal(workflow.workflowCommit, assemblySourceCommit);
  assert.equal(manifest.pairId, pair);
  assert.equal(manifest.hostCommit, nativeCommit);
  assert.equal(manifest.ccCommit, retainedAssemblyProduct.sourceCommit);
  assert.equal(manifest.ccBuildDigest, retainedAssemblyProduct.buildDigest);
  for (const [name, [digest, length]] of Object.entries(frozenNext2Inputs))
    assert.deepEqual(manifest.inputs[name], { sha256: digest, bytes: length });
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.pairId, pair);
  assert.deepEqual(receipt.manifest, manifest);
  assert.equal(receipt.state, 'complete', 'Assembly pair is incomplete');
  for (const kind of ['host', 'carrier'])
    assert.equal(receipt.images?.[kind]?.readbackPassed, true, `${kind} registry readback failed`);
  assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(receipt.images.host.ref, `ghcr.io/ashleyhollis/openclaw@${imageDigest}`);
  assert.match(receipt.images.carrier.ref, /^ghcr\.io\/ashleyhollis\/openclaw@sha256:[a-f0-9]{64}$/u);
}

export function validateProducedBinding({ runId, runAttempt, assemblySourceCommit, identityBytes, provenanceBytes,
  receiptBytes, nativeReceiptBytes }) {
  const identity = JSON.parse(identityBytes);
  assert.equal(identity.nativeArchiveSha256, frozenNext2Inputs['openclaw-current.tgz'][0]);
  assert.equal(identity.nativeReceiptSha256, sha(nativeReceiptBytes));
  const binding = {
    source: 'assembly', pairId: pair, runId, runAttempt, assemblySourceCommit,
    ...retainedAssemblyProduct,
    identitySha256: sha(identityBytes), provenanceSha256: sha(provenanceBytes)
  };
  validatePackageBinding(binding, retainedAssemblyProduct.sourceCommit);
  validateAssemblyInputs(binding, identityBytes, provenanceBytes);
  validatePackageReceipt(binding, receiptBytes);
  return binding;
}

export async function assertFinalNext2Members(directory) {
  assert.deepEqual((await readdir(directory)).sort(), [...finalNext2Members].sort(), 'Final artifact members changed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
await verifyRawNext2Inputs();
const runId = required('ASSEMBLY_RUN_ID'), runAttempt = required('ASSEMBLY_RUN_ATTEMPT');
assert.match(runId, /^[1-9]\d*$/u);
assert.match(runAttempt, /^[1-9]\d*$/u);
assert.equal(runId, required('GITHUB_RUN_ID'));
assert.equal(runAttempt, required('GITHUB_RUN_ATTEMPT'));
assert.equal(required('ASSEMBLY_SOURCE_COMMIT'), required('GITHUB_SHA'));
assert.match(required('ASSEMBLY_SOURCE_COMMIT'), /^[a-f0-9]{40}$/u);
verifyAssemblyEvidence({
  receipt: JSON.parse(await read('receipt.json')),
  workflow: JSON.parse(await read('workflow.json')),
  manifest: JSON.parse(await read('reviewed-manifest.json')),
  runId, runAttempt, assemblySourceCommit: required('ASSEMBLY_SOURCE_COMMIT'),
  imageDigest: required('HOST_IMAGE_DIGEST')
});
if (process.argv[2] === 'preflight') process.exit(0);
const identityBytes = await readFile(required('IDENTITY_FILE'));
const provenanceBytes = await readFile(required('PROVENANCE_FILE'));
const identity = JSON.parse(identityBytes), provenance = JSON.parse(provenanceBytes);
assert.equal(identity.nativeArchiveSha256, frozenNext2Inputs['openclaw-current.tgz'][0]);
assert.equal(identity.nativeReceiptSha256, sha(await read('package-candidate.json')));
assert.equal(identity.hostImage, `ghcr.io/ashleyhollis/openclaw@${required('HOST_IMAGE_DIGEST')}`);
assert.equal(provenance.image, identity.hostImage);
assert.equal(provenance.receipt.packageDigest, `sha256:${frozenNext2Inputs['openclaw-current.tgz'][0]}`);
const binding = validateProducedBinding({ runId, runAttempt, assemblySourceCommit: required('ASSEMBLY_SOURCE_COMMIT'),
  identityBytes, provenanceBytes, receiptBytes: await read('command-center-receipt.json'),
  nativeReceiptBytes: await read('package-candidate.json') });
const output = required('FINAL_DIRECTORY');
await mkdir(output);
for (const name of ['command-center.tgz', 'command-center-receipt.json', 'package-candidate.json'])
  await copyFile(path.join(required('ASSEMBLY_DIRECTORY'), name), path.join(output, name));
await copyFile(required('NATIVE_BUNDLE'), path.join(output, 'native-next2-discord.bundle'));
await copyFile(required('IDENTITY_FILE'), path.join(output, 'candidate-qualification-identity.json'));
await copyFile(required('PROVENANCE_FILE'), path.join(output, 'host-provenance.json'));
await writeFile(path.join(output, 'cc-package-binding.json'), `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' });
await assertFinalNext2Members(output);
console.log(JSON.stringify({ pairId: pair, artifact: required('FINAL_ARTIFACT_NAME'), image: provenance.image,
  identitySha256: binding.identitySha256, provenanceSha256: binding.provenanceSha256, releaseQualified: false }));
}
