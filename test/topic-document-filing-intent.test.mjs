import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createTopicDocumentFilingService } from '../src/documents/filing.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'filing-intent-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  const binding = { status: 'bound', topicId: 'fictional-topic', name: 'Fictional project', sessionKey: 'agent:main:fictional', sessionId: 'fictional-session', referenceId: 'fictional-conversation' };
  metadata.createTopic({ topicId: binding.topicId, name: binding.name, paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'fictional-folder', topicId: binding.topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault', observedRevision: 'folder-basis' });
  metadata.setSourceLocator({ referenceId: 'fictional-folder', locator: '/fictional/vault', ownership: 'adopted', observedRevision: 'folder-basis' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: binding.referenceId, topicId: binding.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: binding.sessionKey, observedRevision: '10' }, state: { referenceId: binding.referenceId, sessionId: binding.sessionId, status: 'open', isPrimary: true } });
  let reads = 0;
  const attachment = { selection: { entryId: 'fictional-user-entry', mediaIndex: 0, offset: 0, generation: 'fictional-generation' }, mediaRef: 'media://inbound/fictional-original', fileName: 'original.pdf', contentType: 'application/pdf', sizeBytes: 8, createdAt: '2026-01-01T00:00:00Z' };
  const runtime = { principalId: 'fictional-principal', assertCurrent() {} };
  const input = { topicId: binding.topicId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, selection: attachment.selection, logicalOperationId: '00000000-0000-4000-8000-000000000123', subfolder: 'Reference' };
  const service = () => createTopicDocumentFilingService({ metadata, sourceService: { sessionTopicContext: async () => binding, requireTopicService: () => ({ notes: {} }), listTopicSourceReferences: id => metadata.listSourceReferences(id) }, mediaLoader: async () => { reads++; return { buffer: Buffer.from('original'), contentType: 'application/pdf' }; }, attachmentReader: { resolve: async () => attachment } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { input, runtime, attachment, service, get metadata() { return metadata; }, reads: () => reads, reopen() { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); } };
}

test('prepared attachment retains one original intent across restart without rereading changed media or choosing a new path', async t => {
  const f = await fixture(t);
  const prepared = await f.service().prepareAttachment(f.input, f.runtime);
  assert.equal(prepared.logicalOperationId, f.input.logicalOperationId);
  assert.equal(prepared.status, 'prepared');
  assert.match(prepared.document.path, /^Documents\/Reference\/original--[a-f0-9]{12}\.pdf$/u);
  const reads = f.reads();
  f.attachment.fileName = 'renamed.pdf';
  f.reopen();
  assert.deepEqual(await f.service().prepareAttachment(f.input, f.runtime), prepared);
  assert.equal(f.reads(), reads);
  await assert.rejects(() => f.service().prepareAttachment({ ...f.input, subfolder: 'Changed' }, f.runtime), { code: 'intent-mismatch' });
  await assert.rejects(() => f.service().prepareAttachment(f.input, { ...f.runtime, principalId: 'another-principal' }), { code: 'intent-mismatch' });
});

test('filing binding and original lineage receipt roll back together when completion authority retires', async t => {
  const f = await fixture(t);
  await f.service().prepareAttachment(f.input, f.runtime);
  const parent = f.metadata.getTopicOperation(f.input.logicalOperationId);
  const note = { version: 1, referenceId: 'document:fictional-original', topicId: f.input.topicId, sourceSystem: 'obsidian', sourceKind: 'document', externalSourceId: `/fictional/vault/${parent.intent.documentPath}`, observedRevision: parent.intent.sourceDigest };
  f.metadata.createSourceReference(note);
  // This fixture supplies a retained Note evidence row to exercise the real
  // completion transaction. Filesystem provenance is proved separately in the
  // Linux owner/recovery tests, never by this synthetic evidence fixture.
  f.metadata.recordTopicOperation({ logicalOperationId: `notes.fs:${parent.intent.noteLogicalOperationId}`, topicId: parent.topicId, operationKind: 'notes.filesystem-effect', state: 'applied', currentStep: 'metadata-applied',
    intent: { operation: 'create', destinationPath: parent.intent.documentPath, desiredRevision: parent.intent.sourceDigest, sourceKind: 'document' },
    result: { sourceReference: note, publishedIdentity: { version: 2, ino: 123, birthtimeMs: 10 }, noteFolderReferenceId: parent.intent.folderReferenceId } });
  let calls = 0;
  assert.throws(() => f.metadata.completeDocumentFiling({ logicalOperationId: parent.logicalOperationId }, () => { if (++calls === 2) throw Object.assign(new Error('Retired'), { code: 'unauthenticated' }); }), { code: 'unauthenticated' });
  assert.equal(f.metadata.listSourceReferences(parent.topicId).filter(row => row.sourceKind === 'attachment').length, 0);
  assert.equal(f.metadata.getTopicOperation(parent.logicalOperationId).state, 'pending');
  f.reopen();
  const receipt = f.metadata.completeDocumentFiling({ logicalOperationId: parent.logicalOperationId }, () => {});
  assert.equal(receipt.source.entryId, 'fictional-user-entry');
  assert.equal(receipt.source.sessionId, 'fictional-session');
  assert.equal(receipt.document.referenceId, note.referenceId);
  assert.equal(f.metadata.getTopicOperation(parent.logicalOperationId).state, 'applied');
  assert.throws(() => f.metadata.recordTopicOperation({ ...parent, state: 'pending', currentStep: 'prepared' }), { code: 'filing-owner-required' });
  assert.throws(() => f.metadata.completeTopicProvisioning({ logicalOperationId: parent.logicalOperationId, topicId: parent.topicId }), { code: 'filing-owner-required' });
  assert.deepEqual(f.metadata.completeDocumentFiling({ logicalOperationId: parent.logicalOperationId }, () => {}), receipt);
});

test('late identical preparation cannot reset a claimed original dispatch', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.service().prepareAttachment(f.input, f.runtime), f.service().prepareAttachment(f.input, f.runtime)]);
  assert.deepEqual(first, second);
  const prepared = f.metadata.getTopicOperation(f.input.logicalOperationId);
  const claimed = f.metadata.claimDocumentFiling({ logicalOperationId: f.input.logicalOperationId }, f.runtime.assertCurrent);
  assert.equal(claimed.dispatch, true);
  const late = f.metadata.prepareDocumentFiling(prepared, f.runtime.assertCurrent);
  assert.equal(late.currentStep, 'dispatch-claimed');
  assert.equal(late.state, 'unknown');
  assert.equal(f.metadata.claimDocumentFiling({ logicalOperationId: f.input.logicalOperationId }, f.runtime.assertCurrent).dispatch, false);
  const replay = await f.service().prepareAttachment(f.input, f.runtime);
  assert.equal(replay.status, 'unknown');
  assert.equal(replay.canFile, false);
});
