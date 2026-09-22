import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createCommitmentCaptureService } from '../src/open-loops/commitment-capture.mjs';
import { projectIntakeAccounts, recordIntakeOutcome, recordIntakeSourcePlan } from '../src/open-loops/intake-accounting.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';
import { createProducerIntakeAdapter } from '../src/open-loops/producer-intake.mjs';
import { sourceNoteOperationId } from '../src/open-loops/source-intake-tool.mjs';

const record = Object.freeze({ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-mixed-message', sourceVersion: 'change-key-9', checkpoint: 'page-3:fictional-mixed-message', rawText: 'Fictional mixed email' });
const extraction = Object.freeze({ schemaVersion: 1, proposedTopic: 'Fictional Home', notePath: 'Inbox/fictional-mixed-email.md', knowledgeMarkdown: '# Fictional reference details\n', knowledgeOutcomeId: 'reference-details', knowledgeSummary: 'Retain fictional reference details', obligations: [
  { obligationId: 'pay-fictional-invoice', correlationNamespace: 'fictional-mixed-email', correlationId: 'pay-fictional-invoice', title: 'Pay fictional invoice', provenance: 'explicit', dueAt: '2026-10-01T00:00:00.000Z' },
  { obligationId: 'send-fictional-reference', correlationNamespace: 'fictional-mixed-email', correlationId: 'send-fictional-reference', title: 'Send fictional reference', provenance: 'explicit' },
  { obligationId: 'choose-fictional-window', correlationNamespace: 'fictional-mixed-email', correlationId: 'choose-fictional-window', title: 'Choose fictional delivery window', provenance: 'inferred', classification: 'decision' }
] });

async function fixture(prefix, { failSecondCaptureOnce = false, loseFirstOutcomeResponseOnce = false } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  metadata.createTopic({ topicId: 'topic-fictional-home', name: 'Fictional Home', paraCategory: 'project', lifecycle: 'active', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' });
  const noteReferenceId = 'note:fictional-mixed-message';
  let captureCalls = 0; let captureFailurePending = failSecondCaptureOnce; let lostResponsePending = loseFirstOutcomeResponseOnce; let tick = 0;
  const capture = createCommitmentCaptureService({ metadata, sourceService: { notesRead: async () => ({ revision: record.sourceVersion }) } });
  const adapter = createProducerIntakeAdapter({
    now: () => new Date(Date.parse('2026-09-22T01:00:00.000Z') + tick++ * 1000).toISOString(),
    extract: async () => extraction,
    resolveTopic: async () => ({ topicId: 'topic-fictional-home', noteFolderReferenceId: 'folder:fictional-home' }),
    saveSourceNote: async () => {
      if (!metadata.getSourceReference(noteReferenceId)) {
        metadata.createSourceReference({ version: 1, referenceId: noteReferenceId, topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/Inbox/fictional-mixed-email.md', observedRevision: record.sourceVersion });
        const logicalOperationId = sourceNoteOperationId({ topicId: 'topic-fictional-home', sourceKind: record.sourceKind, sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion });
        metadata.recordOperation({ logicalOperationId, transportRequestId: logicalOperationId, intentDigest: 'sha256:fictional-source-note', operationKind: 'notes.create', state: 'applied', resultStatus: 'applied', resultIdentity: '/fictional/Inbox/fictional-mixed-email.md', observedRevision: record.sourceVersion, createdAt: '2026-09-22T01:00:00.000Z', updatedAt: '2026-09-22T01:00:00.000Z' });
      }
      return { topicId: 'topic-fictional-home', sourceReferenceId: noteReferenceId, sourcePath: extraction.notePath, sourceVersion: record.sourceVersion, replayed: captureCalls > 0 };
    },
    captureSourceCommitment: async input => {
      captureCalls += 1;
      if (captureFailurePending && captureCalls === 2) { captureFailurePending = false; throw new Error('fictional-process-death'); }
      return capture.capture({ schemaVersion: 1, logicalOperationId: `capture-${input.sourceKind}-${input.sourceExternalId}-${input.sourceVersion}-${input.obligationId}`, ...input, occurredAt: '2026-09-22T01:00:00.000Z', observedAt: '2026-09-22T01:00:00.000Z', historicalBaseline: false });
    },
    captureChatCommitment: async () => { throw new Error('unexpected-chat-capture'); },
    recordIntakeSourcePlan: input => recordIntakeSourcePlan(metadata, { schemaVersion: 1, ...input }),
    recordIntakeOutcome: input => {
      const result = recordIntakeOutcome(metadata, { schemaVersion: 1, ...input });
      if (lostResponsePending && input.status === 'applied') { lostResponsePending = false; throw new Error('fictional-lost-response'); }
      return result;
    },
    recordIntakeReceipt: input => recordIntakeReceipt(metadata, { schemaVersion: 1, ...input })
  });
  return { stateDir, metadata, adapter, cleanup: async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); } };
}

test('crash after the first effect resumes the exact mixed email without duplicates', async () => {
  const f = await fixture('command-center-accounted-crash-', { failSecondCaptureOnce: true });
  try {
    const request = { runId: 'email-run-crash', records: [record], nextExpectedAt: '2026-09-23T01:00:00.000Z', enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false } };
    await assert.rejects(() => f.adapter.process(request), /fictional-process-death/u);
    assert.equal(f.metadata.listOpenLoops().length, 1);
    await f.adapter.process(request);
    assert.equal(f.metadata.listOpenLoops().length, 3);
    const [account] = projectIntakeAccounts(f.metadata, 'email');
    assert.deepEqual({ accounted: account.accounted, resolved: account.resolved, outcomes: account.counts.expected, pending: account.counts.decisionsPending }, { accounted: true, resolved: false, outcomes: 4, pending: 1 });
    assert.equal(f.metadata.listOperations().filter(item => item.operationKind === 'intake-outcome.email.v1').length, 4);
    f.metadata.observeSourceReference({ referenceId: 'note:fictional-mixed-message', observedRevision: 'note-v1', updatedAt: '2026-09-22T01:10:00.000Z' });
    await f.adapter.process({ runId: 'note-run-derived', records: [{ ...record, sourceKind: 'note', sourceExternalId: 'note:fictional-mixed-message', sourceVersion: 'note-v1', checkpoint: 'note:fictional-mixed-message', existingEvidence: { topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-mixed-message', sourcePath: extraction.notePath, sourceVersion: 'note-v1' } }], nextExpectedAt: '2026-09-29T01:00:00.000Z' });
    assert.equal(f.metadata.listOpenLoops().length, 3, 'processing the derived Note must append provenance without duplicating obligations');
    const payLoop = f.metadata.findOpenLoopBySubject('general', f.metadata.listOpenLoops().find(loop => loop.title === 'Pay fictional invoice').stableSubjectId);
    assert.deepEqual(payLoop.evidenceObservationIds.map(id => f.metadata.getOpenLoopObservation(id).source.kind).sort(), ['email', 'note']);
  } finally { await f.cleanup(); }
});

test('a lost outcome response replays the same effect and receipt exactly once', async () => {
  const f = await fixture('command-center-accounted-lost-response-', { loseFirstOutcomeResponseOnce: true });
  try {
    const request = { runId: 'email-run-lost-response', records: [record], nextExpectedAt: '2026-09-23T01:00:00.000Z' };
    await assert.rejects(() => f.adapter.process(request), /fictional-lost-response/u);
    await f.adapter.process(request);
    assert.equal(f.metadata.listOpenLoops().length, 3);
    assert.equal(f.metadata.listOperations().filter(item => item.operationKind === 'intake-source.email.v1').length, 1);
    assert.equal(f.metadata.listOperations().filter(item => item.operationKind === 'intake-outcome.email.v1').length, 4);
  } finally { await f.cleanup(); }
});
