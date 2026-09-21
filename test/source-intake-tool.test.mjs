import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sourceNoteCaptureToolFactory, sourceCommitmentCaptureToolFactory, intakeReceiptToolFactory } from '../src/open-loops/source-intake-tool.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';

function metadataOwner() {
  const operations = new Map();
  return {
    operations,
    getSourceReference(id) { return id === 'note:fictional-email' ? { referenceId: id, topicId: 'topic-fictional-home', sourceKind: 'note' } : null; },
    findOpenLoopBySubject() { return null; },
    applyOpenLoopChange(input) { return { disposition: 'applied', observation: input.observation, loop: input.loop }; },
    getOperation(id) { return operations.get(id) ?? null; },
    recordOperation(input) { operations.set(input.logicalOperationId, { ...input }); return input; },
    listOperations() { return [...operations.values()]; }
  };
}

test('maintained producer saves one quiet Note with stable retry identity and exact evidence', async () => {
  const calls = [];
  const sourceService = { async notesCreate(input) {
    calls.push(input);
    return { status: calls.length === 1 ? 'applied' : 'replayed', value: { note: { schemaVersion: 1, path: input.path, revision: 'note-v1', sourceKind: 'note', sourceReference: { referenceId: 'note:fictional-source', topicId: input.topicId, sourceSystem: 'obsidian', sourceKind: 'note' } } } };
  } };
  const tool = sourceNoteCaptureToolFactory({ getOwners: () => ({ sourceService }) })();
  const params = { topicId: 'topic-fictional-home', noteFolderReferenceId: 'folder:fictional-home', sourceKind: 'email', sourceExternalId: 'fictional-message-1', sourceVersion: 'message-v1', path: 'Inbox/fictional-council-invoice.md', markdown: '# Fictional council invoice\n' };
  const first = await tool.execute(randomUUID(), params);
  const replay = await tool.execute(randomUUID(), params);
  assert.equal(first.details.sourceReference.referenceId, 'note:fictional-source');
  assert.equal(replay.details.sourceReference.referenceId, 'note:fictional-source');
  assert.equal(calls[0].logicalOperationId, calls[1].logicalOperationId);
  assert.equal(calls[0].requestId, calls[0].logicalOperationId);
  assert.deepEqual({ topicId: calls[0].topicId, referenceId: calls[0].referenceId, path: calls[0].path, text: calls[0].text, sourceKind: calls[0].sourceKind }, { topicId: params.topicId, referenceId: params.noteFolderReferenceId, path: params.path, text: params.markdown, sourceKind: 'note' });
});

test('source Note tool refuses a result without exact Topic-owned Note evidence', async () => {
  const tool = sourceNoteCaptureToolFactory({ getOwners: () => ({ sourceService: { notesCreate: async () => ({ status: 'applied', value: { note: { path: 'wrong.md', revision: 'v1', sourceReference: { referenceId: 'foreign', topicId: 'topic-foreign', sourceKind: 'note' } } } }) } }) })();
  await assert.rejects(() => tool.execute(randomUUID(), { topicId: 'topic-fictional-home', noteFolderReferenceId: 'folder:fictional-home', sourceKind: 'note', sourceExternalId: 'fictional-note-1', sourceVersion: 'note-v1', path: 'Inbox/source.md', markdown: '# Source\n' }), /exact Topic-owned Source Reference/u);
});

test('maintained email producer captures an obligation only through its exact saved Note evidence', async () => {
  const metadata = metadataOwner(); let read;
  const sourceService = { async notesRead(input) { read = input; return { revision: 'note-v1' }; } };
  const tool = sourceCommitmentCaptureToolFactory({ getOwners: () => ({ metadata, sourceService }) })();
  const result = await tool.execute(randomUUID(), { topicId: 'topic-fictional-home', sourceKind: 'email', sourceExternalId: 'fictional-message-1', sourceVersion: 'message-v1', sourceReferenceId: 'note:fictional-email', sourcePath: 'Inbox/Fictional council invoice.md', title: 'Pay fictional council invoice', obligationId: 'fictional-council-invoice-1', provenance: 'explicit', dueAt: '2026-10-01T00:00:00.000Z', importance: 'high', importanceOrigin: 'source' });
  assert.equal(result.details.loop.state, 'confirmed');
  assert.equal(result.details.loop.topicId, 'topic-fictional-home');
  assert.deepEqual(read, { schemaVersion: 1, topicId: 'topic-fictional-home', referenceId: 'note:fictional-email', path: 'Inbox/Fictional council invoice.md' });
  await assert.rejects(() => tool.execute(randomUUID(), { topicId: 'topic-other', sourceKind: 'email', sourceExternalId: 'fictional-message-1', sourceVersion: 'message-v1', sourceReferenceId: 'note:fictional-email', sourcePath: 'Inbox/Fictional council invoice.md', title: 'Wrong Topic', obligationId: 'wrong-topic', provenance: 'explicit' }), /exactly owned/u);
});

test('content-free intake receipts update one run checkpoint and reject identity drift', async () => {
  const metadata = metadataOwner();
  const pending = { schemaVersion: 1, sourceKind: 'email', runId: 'fictional-run-1', checkpoint: 'complete', status: 'pending', observedAt: '2026-09-20T00:00:00.000Z', nextExpectedAt: '2026-09-21T00:00:00.000Z', processedCount: 0, actionableCount: 0, noteCount: 0 };
  const first = recordIntakeReceipt(metadata, pending);
  const final = recordIntakeReceipt(metadata, { ...pending, status: 'healthy-processed', observedAt: '2026-09-20T00:05:00.000Z', lastSuccessfulAt: '2026-09-20T00:05:00.000Z', processedCount: 3, actionableCount: 1, noteCount: 2 });
  assert.equal(first.logicalOperationId, final.logicalOperationId);
  assert.equal(final.disposition, 'updated');
  assert.equal(metadata.operations.size, 1);
  const receipt = JSON.parse([...metadata.operations.values()][0].resultIdentity);
  assert.deepEqual({ status: receipt.status, processed: receipt.processedCount, actionable: receipt.actionableCount, notes: receipt.noteCount }, { status: 'healthy-processed', processed: 3, actionable: 1, notes: 2 });
});

test('receipt tool records a healthy empty Note pass without creating an obligation', async () => {
  const metadata = metadataOwner();
  const tool = intakeReceiptToolFactory({ getOwners: () => ({ metadata }) })();
  const result = await tool.execute('ignored-by-stable-receipt-owner', { sourceKind: 'note', runId: 'fictional-note-run', checkpoint: 'complete', status: 'healthy-empty', observedAt: '2026-09-20T01:00:00.000Z', lastSuccessfulAt: '2026-09-20T01:00:00.000Z', nextExpectedAt: '2026-09-27T01:00:00.000Z', processedCount: 0, actionableCount: 0, noteCount: 0 });
  assert.equal(result.details.receipt.status, 'healthy-empty');
  assert.equal(metadata.operations.size, 1);
});

test('receipt tool records Chat coverage separately from Note processing', async () => {
  const metadata = metadataOwner();
  const tool = intakeReceiptToolFactory({ getOwners: () => ({ metadata }) })();
  const result = await tool.execute('chat-receipt', { sourceKind: 'chat', runId: 'fictional-chat-run', checkpoint: 'message-9', status: 'healthy-processed', observedAt: '2026-09-20T02:00:00.000Z', lastSuccessfulAt: '2026-09-20T02:00:00.000Z', nextExpectedAt: '2026-09-21T02:00:00.000Z', processedCount: 1, actionableCount: 1, noteCount: 0 });
  assert.equal(result.details.receipt.sourceKind, 'chat');
  assert.equal([...metadata.operations.values()][0].operationKind, 'intake-receipt.chat.v1');
});
