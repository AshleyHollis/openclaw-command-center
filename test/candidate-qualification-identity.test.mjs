import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCandidateQualificationIdentity, readCandidateQualificationIdentity } from '../src/candidate-qualification-identity.mjs';

// Fictional schema/negative fixtures only; never emitted as candidate receipts.
const hex='a'.repeat(64);
const metadata={version:'2026.10.1',commit:'b'.repeat(40),ccSourceCommit:'c'.repeat(40),ccBuildDigest:hex};
const fixture={schemaVersion:1,hostVersion:metadata.version,hostReceipt:{schemaVersion:2,sourceDigest:`sha256:${hex}`,commit:metadata.commit,executableDigest:`sha256:${hex}`,contractDigest:`sha256:${hex}`,packageDigest:`sha256:${hex}`,runtimeDigest:`sha256:${hex}`},hostImage:`ghcr.io/ashleyhollis/openclaw@sha256:${hex}`,nativeArchiveSha256:hex,ccSourceCommit:metadata.ccSourceCommit,ccBuildDigest:hex,ccArchiveSha256:hex,nativeReceiptSha256:hex,ccReceiptSha256:hex,provenanceSha256:hex};
test('current qualification identity binds exact source, build, package and complete host receipt',()=>{
  assert.deepEqual(validateCandidateQualificationIdentity(fixture,metadata),fixture);
  for(const mutate of [x=>{x.hostVersion='2026.9.5';},x=>{x.hostReceipt.commit='d'.repeat(40);},x=>{x.ccSourceCommit='d'.repeat(40);},x=>{x.ccBuildDigest='b'.repeat(64);},x=>{x.nativeArchiveSha256='b'.repeat(64);},x=>{delete x.hostReceipt.runtimeDigest;},x=>{x.hostImage='ghcr.io/ashleyhollis/openclaw:latest';},x=>{x.extra='unknown';}]){
    const value=structuredClone(fixture);mutate(value);assert.throws(()=>validateCandidateQualificationIdentity(value,metadata));
  }
});
test('missing produced identity fails closed instead of inheriting historical performance host',()=>{
  assert.equal(process.env.COMMAND_CENTER_QUALIFICATION_IDENTITY,undefined);
  assert.throws(()=>readCandidateQualificationIdentity(),/Produced candidate qualification identity is required/);
});
