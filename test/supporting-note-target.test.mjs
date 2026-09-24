import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createCommitmentCaptureService } from '../src/open-loops/commitment-capture.mjs';
import { selectSupportingNoteTarget } from '../src/open-loops/supporting-note-target.mjs';
import { prepareSupportingNoteAnnotation, supportingNoteOperationId } from '../src/open-loops/supporting-note-annotation.mjs';

const loop = { loopId: 'fictional-bill', topicId: 'fictional-home', evidenceObservationIds: ['capture-bill', 'decision-paid'] };
const capture = { observationId: 'capture-bill', source: { system: 'command-center-capture', kind: 'email' }, topicId: loop.topicId,
  observedAt: '2026-09-24T01:00:00.000Z', facts: { sourceReferenceId: 'note:fictional-email', sourcePath: 'Inbox/fictional-email.md',
    sourceReferenceVersion: 'sha256:retained-note-before', sourceVersion: 'email-change-key-18' } };
const reference = { referenceId: 'note:fictional-email', topicId: loop.topicId, sourceSystem: 'obsidian', sourceKind: 'note', observedRevision: 'sha256:note-after-unrelated-edit' };
const select = (observations = [capture], selectedLoop = loop, selectedReference = reference) => selectSupportingNoteTarget({ loop: selectedLoop, observations,
  getSourceReference: id => id === selectedReference?.referenceId ? selectedReference : null });

test('supporting Note selection keeps upstream and retained revisions distinct and follows the current exact Note revision', () => {
  const selected = select([capture, { observationId: 'decision-paid', source: { system: 'command-center', kind: 'user-decision' } }]);
  assert.equal(selected.status, 'ready');
  assert.deepEqual(selected.target, { topicId: loop.topicId, referenceId: reference.referenceId, path: capture.facts.sourcePath,
    expectedRevision: reference.observedRevision, captureObservationId: capture.observationId,
    upstreamSourceVersion: 'email-change-key-18', retainedNoteRevision: 'sha256:retained-note-before' });
  assert.notEqual(selected.target.expectedRevision, selected.target.retainedNoteRevision);
  assert.notEqual(selected.target.retainedNoteRevision, selected.target.upstreamSourceVersion);
});

test('supporting Note selection refuses ambiguous, missing and foreign targets', () => {
  assert.equal(select([], { ...loop, evidenceObservationIds: [] }).status, 'none');
  assert.deepEqual(select([{ ...capture, facts: { ...capture.facts, sourceReferenceVersion: undefined } }]),
    { schemaVersion: 1, status: 'conflict', reason: 'capture-note-identity-unavailable' });
  assert.deepEqual(select([capture, { ...capture, observationId: 'capture-other', facts: { ...capture.facts, sourceReferenceId: 'note:other' } }],
    { ...loop, evidenceObservationIds: ['capture-bill', 'capture-other'] }),
  { schemaVersion: 1, status: 'conflict', reason: 'multiple-supporting-notes' });
  assert.deepEqual(select([capture], loop, { ...reference, sourceKind: 'document' }),
    { schemaVersion: 1, status: 'conflict', reason: 'supporting-note-reference-unavailable' });
  assert.deepEqual(select([capture], loop, { ...reference, topicId: 'another-topic' }),
    { schemaVersion: 1, status: 'conflict', reason: 'supporting-note-reference-unavailable' });
});

test('an accepted bill decision retains its exact supporting Note target across restart', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-supporting-note-target-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: loop.topicId, paraCategory: 'area', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, ...reference, externalSourceId: '/fictional/Inbox/fictional-email.md', observedRevision: capture.facts.sourceReferenceVersion });
    const captureService = createCommitmentCaptureService({ metadata });
    const created = await captureService.capture({ schemaVersion: 1, logicalOperationId: '10000000-0000-4000-8000-000000000011',
      sourceKind: 'email', sourceExternalId: 'email:fictional-bill', sourceVersion: capture.facts.sourceVersion,
      sourceReferenceId: reference.referenceId, sourcePath: capture.facts.sourcePath,
      sourceReferenceVersion: capture.facts.sourceReferenceVersion, topicId: loop.topicId,
      title: 'Pay fictional bill', obligationId: 'fictional-bill', obligationKind: 'payment', provenance: 'explicit',
      occurredAt: '2026-09-24T01:00:00.000Z', observedAt: '2026-09-24T01:01:00.000Z', historicalBaseline: false });
    metadata.observeSourceReference({ referenceId: reference.referenceId, observedRevision: reference.observedRevision,
      updatedAt: '2026-09-24T01:02:00.000Z' });
    const paidInput = { schemaVersion: 1, logicalOperationId: '20000000-0000-4000-8000-000000000022', loopId: created.loop.loopId,
      expectedRevision: created.loop.revision, paymentState: 'paid', actorId: 'fictional-operator',
      rationale: 'Fictional assertion; no payment was made.', updatedAt: '2026-09-24T01:03:00.000Z' };
    const paid = metadata.recordOpenLoopPaymentStatus(paidInput);
    assert.equal(paid.supportingNoteTarget.status, 'ready');
    assert.equal(paid.supportingNoteTarget.target.expectedRevision, reference.observedRevision);
    assert.equal(paid.supportingNoteTarget.target.upstreamSourceVersion, capture.facts.sourceVersion);
    const accepted = metadata.getOpenLoopSupportingNoteIntent(paidInput.logicalOperationId);
    assert.equal(accepted.current, true);
    assert.equal(accepted.intent, undefined);
    const desired = prepareSupportingNoteAnnotation({ text: '# Fictional invoice\n', loopId: created.loop.loopId,
      observation: accepted.observation }).text;
    const preparedInput = { schemaVersion: 1, decisionOperationId: paidInput.logicalOperationId,
      expectedLoopRevision: paid.loop.revision, target: paid.supportingNoteTarget.target, text: desired };
    const prepared = metadata.prepareOpenLoopSupportingNoteIntent(preparedInput);
    assert.equal(prepared.logicalOperationId, supportingNoteOperationId(paidInput.logicalOperationId));
    assert.equal(prepared.text, desired);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    assert.deepEqual(metadata.getOpenLoopUserActionReceipt(paidInput.logicalOperationId).supportingNoteTarget, paid.supportingNoteTarget);
    assert.deepEqual(metadata.recordOpenLoopPaymentStatus(paidInput).supportingNoteTarget, paid.supportingNoteTarget);
    assert.equal(metadata.recordOpenLoopPaymentStatus(paidInput).supportingNoteIntent, undefined,
      'unchanged user-decision replay must not return private full Note bytes');
    assert.deepEqual(metadata.getOpenLoopSupportingNoteIntent(paidInput.logicalOperationId).intent, prepared);
    assert.deepEqual(metadata.prepareOpenLoopSupportingNoteIntent(preparedInput), prepared);
    assert.throws(() => metadata.prepareOpenLoopSupportingNoteIntent({ ...preparedInput, text: `${desired}changed` }),
      error => error.code === 'open-loop-note-intent-mismatch');
    assert.equal(metadata.getCurrentOpenLoopUserActionReceipt(created.loop.loopId).supportingNoteTarget.status, 'ready');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
