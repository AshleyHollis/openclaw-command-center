import { AsyncLocalStorage } from 'node:async_hooks';
import { createCommitmentCaptureService, normalizeCommitmentCapture } from './commitment-capture.mjs';
import { effectiveSourceLocator } from '../sources/reference.mjs';

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
  return Object.freeze({ schemaVersion: 1, logicalOperationId: exactText(logicalOperationId, 'logical-operation-id', 300),
    loopId: exactText(effectId, 'effect-id', 300), expectedRevision, decision: 'dismiss', actorId: WITHDRAWAL_ACTOR,
    rationale: 'Withdraw an unchanged item created by this historical backfill.' });
}
function admittedRecordIdentity(input, sourceKind) {
  if (!input || input.sourceKind !== sourceKind) fail('backfill-record-authority-invalid');
  return Object.freeze({
    backfillId: exactText(input.backfillId, 'backfill-id', 300),
    logicalOperationId: exactText(input.logicalOperationId, 'logical-operation-id', 300),
    sourceKind: exactText(input.sourceKind, 'source-kind', 100),
    sourceExternalId: exactText(input.record?.sourceExternalId, 'source-external-id', 1000),
    sourceVersion: exactText(input.record?.sourceVersion, 'source-version', 1000),
    checkpoint: exactText(input.record?.checkpoint, 'checkpoint', 1000)
  });
}

// The CLI retains the authority runners and passes only commandCenter to the
// private module. Adapter reads and writes therefore require a per-callback
// capability issued by the backfill owner.
export function createHistoricalBackfillOperator({ metadata, sourceService, plan, loadBackfillState, assertCurrent = () => {}, now = () => new Date().toISOString() } = {}) {
  if (!metadata || !sourceService || !plan || typeof loadBackfillState !== 'function') fail('backfill-operator-owner-missing');
  const commitments = createCommitmentCaptureService({ metadata });
  const authority = new AsyncLocalStorage();
  const requireRecord = () => {
    assertCurrent();
    const current = authority.getStore();
    if (current?.kind !== 'record' || current.active !== true) fail('backfill-record-authority-required');
    return current;
  };
  const requireEffect = (effectId, expectedRevision) => {
    assertCurrent();
    const current = authority.getStore();
    if (current?.kind !== 'effect' || current.active !== true || current.effect.effectId !== effectId || expectedRevision !== undefined && current.effect.revision !== expectedRevision) fail('backfill-effect-authority-required');
    return current;
  };
  const assertTopicScope = (topicName, topicId) => {
    if (plan.scope.topicNames?.length && !plan.scope.topicNames.includes(topicName)) fail('backfill-topic-out-of-scope');
    if (plan.scope.topicIds?.length && !plan.scope.topicIds.includes(topicId)) fail('backfill-topic-out-of-scope');
  };
  const prepareCapture = ({ logicalOperationId, capture } = {}) => {
    const current = requireRecord();
    const admitted = current.admitted;
    if (logicalOperationId !== admitted.logicalOperationId || capture?.sourceKind !== plan.sourceKind || capture.sourceKind !== admitted.sourceKind || capture.sourceExternalId !== admitted.sourceExternalId || capture.sourceVersion !== admitted.sourceVersion) fail('backfill-capture-authority-mismatch');
    const evidence = current.evidence.get(capture.sourceReferenceId);
    if (!evidence || evidence.topicId !== capture.topicId || evidence.path !== capture.sourcePath) fail('backfill-capture-evidence-required');
    const value = normalizeCommitmentCapture({ ...capture, logicalOperationId, historicalBaseline: true });
    return { current, evidence, value };
  };
  const verifyFreshEvidence = async ({ current, evidence }) => {
    const reference = metadata.getSourceReference(evidence.sourceReferenceId);
    if (!reference || reference.topicId !== evidence.topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note' || reference.observedRevision !== evidence.revision) fail('backfill-note-evidence-changed');
    const result = await sourceService.notesRead({ schemaVersion: 1, topicId: evidence.topicId, referenceId: evidence.sourceReferenceId, observedRevision: evidence.revision, path: evidence.path });
    assertCurrent();
    if (authority.getStore() !== current || current.active !== true) fail('backfill-record-authority-replaced');
    if (result?.sourceReference?.referenceId !== evidence.sourceReferenceId || result.sourceReference.topicId !== evidence.topicId || result.sourceReference.sourceKind !== 'note' || result.path !== evidence.path || result.revision !== evidence.revision) fail('backfill-note-evidence-changed');
  };

  const commandCenter = Object.freeze({
    resolveTopic({ topicName } = {}) {
      requireRecord();
      const name = exactText(topicName, 'topic-name', 200);
      if (plan.scope.topicNames?.length && !plan.scope.topicNames.includes(name)) fail('backfill-topic-out-of-scope');
      const candidates = metadata.listTopics().filter(topic => topic.name === name && topic.lifecycle === 'active');
      const matches = candidates.flatMap(topic => {
        const folders = metadata.listSourceReferences(topic.topicId).filter(reference => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
        return folders.length === 1 ? [{ topicId: topic.topicId, noteFolderReferenceId: folders[0].referenceId }] : [];
      }).filter(match => !plan.scope.topicIds?.length || plan.scope.topicIds.includes(match.topicId));
      if (matches.length !== 1) return Object.freeze({ status: matches.length > 1 ? 'ambiguous' : 'unresolved' });
      return Object.freeze({ status: 'resolved', ...matches[0] });
    },

    async readNote({ topicId, noteFolderReferenceId, path } = {}) {
      const current = requireRecord();
      const selectedTopicId = exactText(topicId, 'topic-id', 300);
      const selectedFolderId = exactText(noteFolderReferenceId, 'note-folder-reference-id', 300);
      const selectedPath = exactText(path, 'note-path', 1000);
      const topic = metadata.getTopic(selectedTopicId);
      assertTopicScope(topic?.name, selectedTopicId);
      const folder = metadata.getSourceReference(selectedFolderId);
      if (!topic || topic.lifecycle !== 'active' || !folder || folder.topicId !== selectedTopicId || folder.sourceSystem !== 'obsidian' || folder.sourceKind !== 'note_folder') fail('backfill-note-folder-invalid');
      const root = effectiveSourceLocator(metadata, folder).replace(/[\\/]+$/u, '');
      const externalId = `${root}/${selectedPath.replace(/\\/gu, '/')}`;
      const matches = metadata.listSourceReferences(selectedTopicId).filter(reference => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note' && effectiveSourceLocator(metadata, reference) === externalId);
      if (matches.length !== 1) fail('backfill-note-evidence-unresolved');
      const reference = matches[0];
      const result = await sourceService.notesRead({ schemaVersion: 1, topicId: selectedTopicId, referenceId: reference.referenceId, observedRevision: reference.observedRevision, path: selectedPath });
      assertCurrent();
      if (authority.getStore() !== current || current.active !== true) fail('backfill-record-authority-replaced');
      const observed = result?.sourceReference;
      if (!observed || observed.referenceId !== reference.referenceId || observed.topicId !== selectedTopicId || observed.sourceKind !== 'note' || result.revision !== reference.observedRevision) fail('backfill-note-evidence-invalid');
      current.evidence.set(reference.referenceId, Object.freeze({ topicId: selectedTopicId, sourceReferenceId: reference.referenceId, path: result.path, revision: result.revision }));
      return Object.freeze({ text: result.text, path: result.path, revision: result.revision, sourceReferenceId: reference.referenceId });
    },

    async captureCommitment({ logicalOperationId, capture } = {}) {
      const { current, evidence, value } = prepareCapture({ logicalOperationId, capture });
      await verifyFreshEvidence({ current, evidence });
      assertCurrent();
      return publicEffect(await commitments.capture(value));
    },

    reconcileCommitment({ logicalOperationId, capture } = {}) {
      const { value } = prepareCapture({ logicalOperationId, capture });
      assertCurrent();
      const replay = metadata.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: value.logicalOperationId, operationKind: 'commitment.capture.v1', intent: value });
      return replay ? Object.freeze({ status: 'applied', result: publicEffect(replay) }) : Object.freeze({ status: 'not-applied' });
    },

    inspectEffect({ effectId } = {}) {
      requireEffect(exactText(effectId, 'effect-id', 300));
      const loop = metadata.getOpenLoop(effectId);
      if (!loop) return null;
      const userDecided = loop.evidenceObservationIds.some(observationId => {
        const evidence = metadata.getOpenLoopObservation(observationId);
        return evidence?.source?.system === 'command-center' && evidence.source.kind === 'user-decision' && evidence.facts?.actorId !== WITHDRAWAL_ACTOR;
      });
      return Object.freeze({ revision: loop.revision, userDecided });
    },

    withdrawEffect({ logicalOperationId, effectId, expectedRevision } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('backfill-effect-revision-invalid');
      requireEffect(exactText(effectId, 'effect-id', 300), expectedRevision);
      const intent = withdrawalIntent({ logicalOperationId, effectId, expectedRevision });
      assertCurrent();
      const result = metadata.recordOpenLoopDecision({ ...intent, updatedAt: now() });
      return Object.freeze({ status: result?.loop?.state === 'cancelled' ? 'applied' : 'conflict' });
    },

    reconcileWithdrawal({ logicalOperationId, effectId, expectedRevision } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('backfill-effect-revision-invalid');
      requireEffect(exactText(effectId, 'effect-id', 300), expectedRevision);
      const intent = withdrawalIntent({ logicalOperationId, effectId, expectedRevision });
      assertCurrent();
      const replay = metadata.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: intent.logicalOperationId, operationKind: 'decision-dismiss', intent });
      return Object.freeze({ status: replay?.loop?.state === 'cancelled' ? 'applied' : 'not-applied' });
    }
  });

  return Object.freeze({
    commandCenter,
    async runWithRecordAuthority(input, callback) {
      assertCurrent();
      if (typeof callback !== 'function') fail('backfill-record-authority-invalid');
      const admitted = admittedRecordIdentity(input, plan.sourceKind);
      if (admitted.backfillId !== plan.backfillId) fail('backfill-record-authority-invalid');
      const capability = { kind: 'record', admitted, evidence: new Map(), active: true };
      try { return await authority.run(capability, callback); }
      finally { capability.active = false; capability.evidence.clear(); }
    },
    async runWithEffectAuthority(input, callback) {
      assertCurrent();
      if (!input || typeof callback !== 'function') fail('backfill-effect-authority-invalid');
      const state = await loadBackfillState();
      assertCurrent();
      const matches = state?.effects?.filter(effect => effect.effectId === input.effectId) ?? [];
      if (matches.length !== 1) fail('backfill-effect-not-owned');
      const effect = matches[0];
      if (input.expectedRevision !== undefined && input.expectedRevision !== effect.revision) fail('backfill-effect-not-owned');
      const capability = { kind: 'effect', effect, active: true };
      try { return await authority.run(capability, callback); }
      finally { capability.active = false; }
    }
  });
}
