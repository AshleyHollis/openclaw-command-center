import { createCommitmentCaptureService, normalizeCommitmentCapture } from './commitment-capture.mjs';

const WITHDRAWAL_ACTOR = 'historical-backfill-withdrawal';

function fail(code) { throw Object.assign(new TypeError(code), { code }); }
function exactText(value, field, maximum = 500) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim() || value.length > maximum) fail(`backfill-${field}-invalid`);
  return value;
}
function publicEffect(result) {
  if (!result?.loop || !Number.isSafeInteger(result.loop.revision)) fail('backfill-commitment-result-invalid');
  const disposition = result.disposition === 'created' ? 'created' : result.disposition === 'updated' ? 'updated' : 'unchanged';
  return Object.freeze({ disposition, effectId: result.loop.loopId, revision: result.loop.revision });
}
function withdrawalIntent({ logicalOperationId, effectId, expectedRevision }) {
  return Object.freeze({
    schemaVersion: 1,
    logicalOperationId: exactText(logicalOperationId, 'logical-operation-id', 300),
    loopId: exactText(effectId, 'effect-id', 300),
    expectedRevision,
    decision: 'dismiss',
    actorId: WITHDRAWAL_ACTOR,
    rationale: 'Withdraw an unchanged item created by this historical backfill.'
  });
}

// Private adapters receive only this bounded owner. They can resolve exact
// Topic/Note evidence and invoke the existing durable commitment owners; they
// cannot reach raw metadata or manufacture an unjournaled Command Center write.
export function createHistoricalBackfillOperator({ metadata, sourceService, now = () => new Date().toISOString() } = {}) {
  if (!metadata || !sourceService) fail('backfill-operator-owner-missing');
  const commitments = createCommitmentCaptureService({ metadata, sourceService });

  return Object.freeze({
    resolveTopic({ topicName } = {}) {
      const name = exactText(topicName, 'topic-name', 200);
      const candidates = metadata.listTopics().filter(topic => topic.name === name && topic.lifecycle === 'active');
      const matches = candidates.flatMap(topic => {
        const folders = metadata.listSourceReferences(topic.topicId)
          .filter(reference => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
        return folders.length === 1 ? [{ topicId: topic.topicId, noteFolderReferenceId: folders[0].referenceId }] : [];
      });
      if (matches.length !== 1) return Object.freeze({ status: matches.length > 1 ? 'ambiguous' : 'unresolved' });
      return Object.freeze({ status: 'resolved', ...matches[0] });
    },

    async readNote({ topicId, noteFolderReferenceId, path } = {}) {
      const result = await sourceService.notesRead({
        schemaVersion: 1,
        topicId: exactText(topicId, 'topic-id', 300),
        referenceId: exactText(noteFolderReferenceId, 'note-folder-reference-id', 300),
        path: exactText(path, 'note-path', 1000)
      });
      const reference = result?.sourceReference;
      if (!reference || reference.topicId !== topicId || reference.sourceKind !== 'note') fail('backfill-note-evidence-invalid');
      return Object.freeze({ text: result.text, path: result.path, revision: result.revision, sourceReferenceId: reference.referenceId });
    },

    async captureCommitment({ logicalOperationId, capture } = {}) {
      const value = normalizeCommitmentCapture({ ...capture, logicalOperationId, historicalBaseline: true });
      return publicEffect(await commitments.capture(value));
    },

    reconcileCommitment({ logicalOperationId, capture } = {}) {
      const value = normalizeCommitmentCapture({ ...capture, logicalOperationId, historicalBaseline: true });
      const replay = metadata.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId, operationKind: 'commitment.capture.v1', intent: value });
      return replay ? Object.freeze({ status: 'applied', result: publicEffect(replay) }) : Object.freeze({ status: 'not-applied' });
    },

    inspectEffect({ effectId } = {}) {
      const loop = metadata.getOpenLoop(exactText(effectId, 'effect-id', 300));
      if (!loop) return null;
      const userDecided = loop.evidenceObservationIds.some(observationId => {
        const evidence = metadata.getOpenLoopObservation(observationId);
        return evidence?.source?.system === 'command-center'
          && evidence.source.kind === 'user-decision'
          && evidence.facts?.actorId !== WITHDRAWAL_ACTOR;
      });
      return Object.freeze({ revision: loop.revision, userDecided });
    },

    withdrawEffect({ logicalOperationId, effectId, expectedRevision } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('backfill-effect-revision-invalid');
      const intent = withdrawalIntent({ logicalOperationId, effectId, expectedRevision });
      const result = metadata.recordOpenLoopDecision({ ...intent, updatedAt: now() });
      return Object.freeze({ status: result?.loop?.state === 'cancelled' ? 'applied' : 'conflict' });
    },

    reconcileWithdrawal({ logicalOperationId, effectId, expectedRevision } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('backfill-effect-revision-invalid');
      const intent = withdrawalIntent({ logicalOperationId, effectId, expectedRevision });
      const replay = metadata.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: intent.logicalOperationId, operationKind: 'decision-dismiss', intent });
      return Object.freeze({ status: replay?.loop?.state === 'cancelled' ? 'applied' : 'not-applied' });
    }
  });
}
