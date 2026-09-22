import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sourceTopicResolverToolFactory, sourceNoteCaptureToolFactory, sourceCommitmentCaptureToolFactory, intakeReceiptToolFactory, intakeSourcePlanToolFactory, intakeSourceAccountToolFactory, intakeOutcomeToolFactory } from '../src/open-loops/source-intake-tool.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';

function metadataOwner() {
  const operations = new Map();
  return {
    operations,
    getSourceReference(id) { return ['note:fictional-email', 'note:fictional-reference'].includes(id) ? { referenceId: id, topicId: 'topic-fictional-home', sourceKind: 'note' } : null; },
    findOpenLoopBySubject() { return null; },
    applyOpenLoopChange(input) { return { disposition: 'applied', observation: input.observation, loop: input.loop }; },
    getOperation(id) { return operations.get(id) ?? null; },
    recordOperation(input) { operations.set(input.logicalOperationId, { ...input }); return input; },
    commitIntakeAccountingOperation(input) {
      const prior = operations.get(input.logicalOperationId);
      if (prior && prior.intentDigest !== input.intentDigest) throw Object.assign(new Error('identity changed'), { code: 'intent-mismatch' });
      if (!prior) operations.set(input.logicalOperationId, { ...input });
      return { disposition: prior ? 'duplicate' : 'recorded', operation: prior ?? operations.get(input.logicalOperationId) };
    },
    commitIntakeReceiptOperation(input) {
      const prior = operations.get(input.logicalOperationId);
      operations.set(input.logicalOperationId, { ...input, createdAt: prior?.createdAt ?? input.createdAt });
      return { disposition: prior ? 'updated' : 'recorded', operation: operations.get(input.logicalOperationId) };
    },
    listOperations() { return [...operations.values()]; }
  };
}

test('maintained intake resolves only one exact active Topic without returning its locator', async () => {
  const metadata = {
    listTopics: () => [
      { topicId: 'topic-fictional-home', name: 'Fictional Home', lifecycle: 'active' },
      { topicId: 'topic-fictional-archive', name: 'Fictional Home', lifecycle: 'archived' }
    ],
    listSourceReferences: topicId => topicId === 'topic-fictional-home'
      ? [{ referenceId: 'folder:fictional-home', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault' },
        { referenceId: 'note:fictional-existing', topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/vault/Invoices/Fictional.md', observedRevision: 'note-v7' }]
      : []
  };
  const sourceService = { notesRead: async input => {
    assert.equal(input.referenceId, 'note:fictional-existing'); assert.equal(input.observedRevision, 'note-v7');
    return { path: input.path, revision: 'note-v7', sourceReference: { referenceId: 'note:fictional-existing', topicId: input.topicId, sourceKind: 'note' } };
  } };
  const tool = sourceTopicResolverToolFactory({ getOwners: () => ({ metadata, sourceService }) })();
  const result = await tool.execute(randomUUID(), { topicName: 'Fictional Home' });
  assert.deepEqual(result.details, { status: 'resolved', topicId: 'topic-fictional-home', noteFolderReferenceId: 'folder:fictional-home' });
  assert.equal(result.content[0].text.includes('/private/'), false);
  const existing = await tool.execute(randomUUID(), { topicName: 'Fictional Home', notePath: 'Invoices/Fictional.md' });
  assert.deepEqual(existing.details.evidence, { sourceReferenceId: 'note:fictional-existing', revision: 'note-v7', path: 'Invoices/Fictional.md' });
  assert.equal((await tool.execute(randomUUID(), { topicName: 'Unknown Topic' })).details.status, 'unresolved');
  await assert.rejects(() => tool.execute(randomUUID(), { topicName: ' Fictional Home' }), /exact canonical Topic name/u);
});

test('maintained intake refuses ambiguous Topic ownership and Topics without one Note Folder', async () => {
  const metadata = {
    listTopics: () => [
      { topicId: 'topic-one', name: 'Duplicate', lifecycle: 'active' },
      { topicId: 'topic-two', name: 'Duplicate', lifecycle: 'active' },
      { topicId: 'topic-no-folder', name: 'No Folder', lifecycle: 'active' }
    ],
    listSourceReferences: topicId => topicId === 'topic-no-folder' ? [] : [{ referenceId: `folder:${topicId}`, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder' }]
  };
  const tool = sourceTopicResolverToolFactory({ getOwners: () => ({ metadata }) })();
  assert.equal((await tool.execute(randomUUID(), { topicName: 'Duplicate' })).details.status, 'ambiguous');
  assert.equal((await tool.execute(randomUUID(), { topicName: 'No Folder' })).details.status, 'unresolved');
});

test('maintained intake admits one freshly verified producer Note through its exact Topic path', async () => {
  const metadata = {
    listTopics: () => [{ topicId: 'topic-fictional-home', name: 'Fictional Home', lifecycle: 'active' }],
    listSourceReferences: () => [{ referenceId: 'folder:fictional-home', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault' }]
  };
  let read;
  const sourceService = { async notesRead(input) {
    read = input;
    return { path: input.path, revision: 'sha256:retained-note', sourceReference: { referenceId: 'note:fresh-email', topicId: input.topicId, sourceKind: 'note', observedRevision: 'sha256:retained-note' } };
  } };
  const tool = sourceTopicResolverToolFactory({ getOwners: () => ({ metadata, sourceService }) })();
  const result = await tool.execute(randomUUID(), { topicName: 'Fictional Home', notePath: 'Inbox/Fresh email.md' });
  assert.deepEqual(read, { schemaVersion: 1, topicId: 'topic-fictional-home', path: 'Inbox/Fresh email.md' });
  assert.deepEqual(result.details.evidence, { sourceReferenceId: 'note:fresh-email', revision: 'sha256:retained-note', path: 'Inbox/Fresh email.md' });
});

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

test('receipt tool returns the exact durable continuation until a resumed run completes', async () => {
  const metadata = metadataOwner();
  const tool = intakeReceiptToolFactory({ getOwners: () => ({ metadata }) })();
  const counts = { processedCount: 1, actionableCount: 0, noteCount: 0 };
  await tool.execute('partial', { sourceKind: 'email', runId: 'email-partial', checkpoint: 'page-2', status: 'incomplete', observedAt: '2026-09-22T02:00:00.000Z', nextExpectedAt: '2026-09-22T02:05:00.000Z', ...counts, continuation: { scopeId: 'mailbox-fixture', cursor: 'page-3', remainingCount: 2, failedReadCount: 1, scanCapReached: true } });
  const resumed = await tool.execute('resume', { sourceKind: 'email', runId: 'email-resume', checkpoint: 'start', status: 'pending', observedAt: '2026-09-22T02:05:00.000Z', nextExpectedAt: '2026-09-22T02:10:00.000Z', ...counts });
  assert.deepEqual(resumed.details.resumeFrom, { scopeId: 'mailbox-fixture', cursor: 'page-3', remainingCount: 2, failedReadCount: 1, scanCapReached: true });
  await tool.execute('complete', { sourceKind: 'email', runId: 'email-resume', checkpoint: 'complete', status: 'healthy-processed', observedAt: '2026-09-22T02:06:00.000Z', lastSuccessfulAt: '2026-09-22T02:06:00.000Z', nextExpectedAt: '2026-09-23T02:06:00.000Z', ...counts });
  const next = await tool.execute('next', { sourceKind: 'email', runId: 'email-next', checkpoint: 'start', status: 'pending', observedAt: '2026-09-23T02:06:00.000Z', nextExpectedAt: '2026-09-23T02:10:00.000Z', ...counts });
  assert.equal(next.details.resumeFrom, undefined);
});

test('source-accounting tools retain a stable plan and each exact outcome', async () => {
  const metadata = metadataOwner();
  const planTool = intakeSourcePlanToolFactory({ getOwners: () => ({ metadata }) })();
  const accountTool = intakeSourceAccountToolFactory({ getOwners: () => ({ metadata }) })();
  const outcomeTool = intakeOutcomeToolFactory({ getOwners: () => ({ metadata }) })();
  const source = { sourceKind: 'email', sourceExternalId: 'fictional-message-accounted', sourceVersion: 'v3' };
  const extraction = { schemaVersion: 1, proposedTopic: 'Fictional Home', notePath: 'Inbox/fictional-reference.md', knowledgeMarkdown: '# Fictional reference\n', knowledgeOutcomeId: 'quiet-reference', obligations: [] };
  const planned = await planTool.execute('plan', { ...source, checkpoint: 'page-2:message-7', observedAt: '2026-09-22T02:00:00.000Z', processorVersion: 'fictional-processor-v4', acceptedExtraction: extraction, outcomes: [{ outcomeId: 'quiet-reference', kind: 'information' }], enumeration: { scope: 'bounded', scannedCount: 10, remainingCount: 2, failedReadCount: 0, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'page-3' } });
  const before = await accountTool.execute('load-before', source);
  const outcome = await outcomeTool.execute('outcome', { ...source, outcomeId: 'quiet-reference', kind: 'information', status: 'quiet', summary: 'Fictional reference retained', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-reference', sourcePath: 'Inbox/fictional-reference.md', sourceReferenceVersion: 'note-v1', recordedAt: '2026-09-22T02:00:01.000Z' });
  const after = await accountTool.execute('load-after', source);
  assert.equal(planned.details.plan.outcomes.length, 1);
  assert.equal(before.details.plan.processorVersion, 'fictional-processor-v4');
  assert.deepEqual(before.details.plan.acceptedExtraction, extraction);
  assert.equal(before.details.account.outcomes[0].status, 'missing');
  assert.deepEqual(JSON.parse(before.content[0].text), { status: 'found', ...source, processorVersion: 'fictional-processor-v4', acceptedExtraction: extraction, outcomes: [{ outcomeId: 'quiet-reference', kind: 'information', status: 'missing' }] });
  assert.equal(outcome.details.outcome.status, 'quiet');
  assert.equal(after.details.account.outcomes[0].status, 'quiet');
  assert.equal(JSON.parse(after.content[0].text).outcomes[0].sourceReferenceVersion, 'note-v1');
  assert.deepEqual([...metadata.operations.values()].map(item => item.operationKind).sort(), ['intake-outcome.email.v1', 'intake-source.email.v1']);
});
