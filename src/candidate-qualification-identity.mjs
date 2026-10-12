import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function validateCandidateQualificationIdentity(identity, metadata) {
  assert.deepEqual(Object.keys(identity).sort(), ['schemaVersion','hostVersion','hostReceipt','hostImage','nativeArchiveSha256','ccSourceCommit','ccBuildDigest','ccArchiveSha256','nativeReceiptSha256','ccReceiptSha256','provenanceSha256'].sort());
  assert.equal(identity.schemaVersion,1);
  assert.equal(identity.hostVersion,metadata.version);
  assert.equal(identity.hostReceipt.commit,metadata.commit);
  assert.equal(identity.ccSourceCommit,metadata.ccSourceCommit);
  assert.equal(identity.ccBuildDigest,metadata.ccBuildDigest);
  assert.match(identity.hostImage,/^ghcr\.io\/ashleyhollis\/openclaw@sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(identity.hostReceipt).sort(), ['schemaVersion','sourceDigest','commit','executableDigest','contractDigest','packageDigest','runtimeDigest'].sort());
  assert.equal(identity.hostReceipt.schemaVersion,2);
  assert.match(identity.hostReceipt.commit,/^[a-f0-9]{40}$/u);
  assert.match(identity.ccSourceCommit,/^[a-f0-9]{40}$/u);
  for (const key of ['sourceDigest','executableDigest','contractDigest','packageDigest','runtimeDigest']) assert.match(identity.hostReceipt[key],/^sha256:[a-f0-9]{64}$/u);
  for (const key of ['nativeArchiveSha256','ccBuildDigest','ccArchiveSha256','nativeReceiptSha256','ccReceiptSha256','provenanceSha256']) assert.match(identity[key],/^[a-f0-9]{64}$/u);
  assert.equal(identity.hostReceipt.packageDigest,`sha256:${identity.nativeArchiveSha256}`);
  return structuredClone(identity);
}

export function readCandidateQualificationIdentity() {
  // Independent collector pin, not the provenance being checked against itself.
  const file=process.env.COMMAND_CENTER_QUALIFICATION_IDENTITY;
  const expected=process.env.COMMAND_CENTER_QUALIFICATION_IDENTITY_SHA256;
  assert.ok(file,'Produced candidate qualification identity is required');
  assert.match(expected??'',/^[a-f0-9]{64}$/u,'Independent candidate identity digest is required');
  const bytes=readFileSync(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'Candidate qualification identity bytes changed');
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  const identity=validateCandidateQualificationIdentity(JSON.parse(bytes),{version:manifest.devDependencies.openclaw,commit:manifest.commandCenter.compatibilityTuple.host.commit,ccSourceCommit:'dc1fb006d0c3c57821129e7d1d645e237b91b65f',ccBuildDigest:'da18debd1f5aa312e534b0e71a888fceb843d0d4ec381b51b8e3c384df996c05'});
  if(process.env.COMMAND_CENTER_NATIVE_PACKAGE_SHA256) assert.equal(identity.nativeArchiveSha256,process.env.COMMAND_CENTER_NATIVE_PACKAGE_SHA256);
  if(process.env.IMAGE) assert.equal(identity.hostImage,process.env.IMAGE,'Selected image differs from independently bound candidate');
  return identity;
}
