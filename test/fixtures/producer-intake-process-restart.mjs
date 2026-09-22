import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createCommitmentCaptureService } from '../../src/open-loops/commitment-capture.mjs';
import { loadIntakeSourceAccount, projectIntakeAccounts, recordIntakeOutcome, recordIntakeSourcePlan } from '../../src/open-loops/intake-accounting.mjs';
import { recordIntakeReceipt } from '../../src/open-loops/intake-receipt.mjs';
import { createProducerIntakeAdapter } from '../../src/open-loops/producer-intake.mjs';
import { sourceNoteOperationId } from '../../src/open-loops/source-intake-tool.mjs';

const [stateDir, mode] = process.argv.slice(2);
const source = Object.freeze({ sourceKind: 'email', sourceExternalId: 'fictional-process-message', sourceVersion: 'email-change-key-31' });
const noteRevision = 'note-revision-41';
const noteReferenceId = 'note:fictional-process-message';
const extraction = Object.freeze({ schemaVersion: 1, proposedTopic: 'Fictional process home', notePath: 'Inbox/fictional-process-message.md', knowledgeMarkdown: '# Fictional process reference\n', knowledgeOutcomeId: 'process-reference', obligations: [
  { obligationId: 'process-choice', title: 'Choose fictional process window', provenance: 'inferred', classification: 'decision' },
  { obligationId: 'process-payment', title: 'Pay fictional process invoice', provenance: 'explicit' },
  { obligationId: 'process-reply', title: 'Reply with fictional process reference', provenance: 'explicit' }
] });

const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
if (!metadata.listTopics().some(topic => topic.topicId === 'topic-fictional-process-home')) {
  metadata.createTopic({ topicId: 'topic-fictional-process-home', name: 'Fictional process home', paraCategory: 'project', lifecycle: 'active', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-process-home', topicId: 'topic-fictional-process-home', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/process' });
}
const capture = createCommitmentCaptureService({ metadata, sourceService: { notesRead: async () => ({ revision: noteRevision }) } });
let tick = 0;
const adapter = createProducerIntakeAdapter({
  processorVersion: mode === 'crash' ? 'fictional-process-processor-v1' : 'fictional-process-processor-v2',
  now: () => new Date(Date.parse('2026-09-22T03:00:00.000Z') + tick++ * 1000).toISOString(),
  extract: async () => {
    if (mode === 'resume') throw new Error('restart must load the durable accepted extraction');
    return extraction;
  },
  loadIntakeSourceAccount: input => loadIntakeSourceAccount(metadata, input),
  resolveTopic: async () => ({ topicId: 'topic-fictional-process-home', noteFolderReferenceId: 'folder:fictional-process-home' }),
  saveSourceNote: async () => {
    if (!metadata.getSourceReference(noteReferenceId)) {
      metadata.createSourceReference({ version: 1, referenceId: noteReferenceId, topicId: 'topic-fictional-process-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/process/Inbox/fictional-process-message.md', observedRevision: noteRevision });
      const logicalOperationId = sourceNoteOperationId({ topicId: 'topic-fictional-process-home', ...source });
      metadata.recordOperation({ logicalOperationId, transportRequestId: logicalOperationId, intentDigest: 'sha256:fictional-process-note', operationKind: 'notes.create', state: 'applied', resultStatus: 'applied', resultIdentity: '/fictional/process/Inbox/fictional-process-message.md', observedRevision: noteRevision, createdAt: '2026-09-22T03:00:00.000Z', updatedAt: '2026-09-22T03:00:00.000Z' });
    }
    return { topicId: 'topic-fictional-process-home', sourceReferenceId: noteReferenceId, sourcePath: extraction.notePath, sourceReferenceVersion: noteRevision, replayed: true };
  },
  captureSourceCommitment: input => capture.capture({ schemaVersion: 1, logicalOperationId: `process-capture-${input.obligationId}`, ...input, occurredAt: '2026-09-22T03:00:00.000Z', observedAt: '2026-09-22T03:00:00.000Z', historicalBaseline: false }),
  captureChatCommitment: async () => { throw new Error('unexpected Chat capture'); },
  recordIntakeSourcePlan: input => recordIntakeSourcePlan(metadata, { schemaVersion: 1, ...input }),
  recordIntakeOutcome: async input => {
    const result = recordIntakeOutcome(metadata, { schemaVersion: 1, ...input });
    if (mode === 'crash' && input.outcomeId === 'process-choice') {
      const loop = metadata.getOpenLoop(input.loopId);
      metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-process-user-decision', loopId: input.loopId, expectedRevision: loop.revision, decision: 'confirm', actorId: 'fictional-operator', rationale: 'Keep the accepted fictional window.', updatedAt: '2026-09-22T03:00:10.000Z' });
      process.send?.({ type: 'after-one-actionable-effect', loopId: input.loopId });
      await new Promise(() => {});
    }
    return result;
  },
  recordIntakeReceipt: input => recordIntakeReceipt(metadata, { schemaVersion: 1, ...input })
});

try {
  const result = await adapter.process({ runId: `fictional-process-${mode}`, nextExpectedAt: '2026-09-23T03:00:00.000Z', records: [{ schemaVersion: 1, ...source, checkpoint: 'page-1:fictional-process-message', rawText: 'Fictional process mixed email' }] });
  const account = projectIntakeAccounts(metadata, 'email')[0];
  process.send?.({ type: 'completed', result, account, loops: metadata.listOpenLoops().map(loop => ({ loopId: loop.loopId, title: loop.title, state: loop.state, revision: loop.revision })) });
  process.disconnect?.();
} catch (error) {
  process.send?.({ type: 'failed', message: error?.stack ?? String(error) });
  process.disconnect?.();
  process.exitCode = 1;
} finally { metadata.close(); }
