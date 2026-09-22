import assert from 'node:assert/strict';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planCommitmentCapture } from '../src/open-loops/commitment-capture.mjs';
import { projectIntakeAccounts, recordIntakeOutcome, recordIntakeSourcePlan } from '../src/open-loops/intake-accounting.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function temporaryStateDir(prefix) {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { path: value, cleanup: () => rm(value, { recursive: true, force: true }) };
}

function sourcePlan() {
  return {
    schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', checkpoint: 'page-1:message-42', observedAt: '2026-09-22T01:00:00.000Z',
    outcomes: [
      { outcomeId: 'pay-invoice', kind: 'obligation' },
      { outcomeId: 'send-reference', kind: 'obligation' },
      { outcomeId: 'choose-delivery', kind: 'decision' },
      { outcomeId: 'reference-details', kind: 'information' }
    ],
    enumeration: { scope: 'bounded', scannedCount: 25, remainingCount: 4, failedReadCount: 1, scanCapReached: true }
  };
}

function addTopic(metadata) {
  metadata.createTopic({ topicId: 'topic-fictional-home', name: 'Fictional home', paraCategory: 'project', lifecycle: 'active', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' });
}

function addDecisionLoop(metadata) {
  const planned = planCommitmentCapture({
    schemaVersion: 1, logicalOperationId: 'decision-capture', sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', topicId: 'topic-fictional-home', title: 'Choose fictional delivery window', obligationId: 'choose-delivery', provenance: 'inferred', occurredAt: '2026-09-22T01:00:00.000Z', observedAt: '2026-09-22T01:00:00.000Z', historicalBaseline: false
  });
  return metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: 'decision-capture', operationKind: 'commitment.capture.v1', intent: planned.value, expectedRevision: 0, observation: planned.observation, loop: planned.loop, evidenceRoles: { [planned.observation.observationId]: 'origin' }, updatedAt: '2026-09-22T01:00:00.000Z' }).loop;
}

function addObligationLoop(metadata, obligationId, title) {
  const logicalOperationId = `capture-${obligationId}`;
  const planned = planCommitmentCapture({
    schemaVersion: 1, logicalOperationId, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', topicId: 'topic-fictional-home', title, obligationId, provenance: 'explicit', occurredAt: '2026-09-22T01:00:00.000Z', observedAt: '2026-09-22T01:00:00.000Z', historicalBaseline: false
  });
  return metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId, operationKind: 'commitment.capture.v1', intent: planned.value, expectedRevision: 0, observation: planned.observation, loop: planned.loop, evidenceRoles: { [planned.observation.observationId]: 'origin' }, updatedAt: '2026-09-22T01:00:00.000Z' }).loop;
}

function addEffects(metadata) {
  const payment = addObligationLoop(metadata, 'pay-invoice', 'Pay fictional invoice');
  const response = addObligationLoop(metadata, 'send-reference', 'Send fictional reference');
  const decision = addDecisionLoop(metadata);
  metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-message-42', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/reference.md', observedRevision: 'note-v1' });
  return { payment, response, decision };
}

test('mixed email accounting distinguishes accounted-for from resolved and retains bounded enumeration gaps', async () => {
  const temporary = await temporaryStateDir('command-center-intake-accounting-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata);
    const first = recordIntakeSourcePlan(metadata, sourcePlan());
    assert.equal(recordIntakeSourcePlan(metadata, sourcePlan()).disposition, 'duplicate');
    const { payment, response, decision } = addEffects(metadata);
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: payment.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'send-reference', kind: 'obligation', status: 'applied', summary: 'Send fictional reference', loopId: response.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'choose-delivery', kind: 'decision', status: 'pending-decision', summary: 'Choose fictional delivery window', loopId: decision.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained fictional reference details', sourceReferenceId: 'note:fictional-message-42', sourceReferenceVersion: 'note-v1' });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(first.plan.sourceVersion, 'change-key-7');
    assert.deepEqual({ accounted: account.accounted, resolved: account.resolved, expected: account.counts.expected, pending: account.counts.decisionsPending, quiet: account.counts.quiet }, { accounted: true, resolved: false, expected: 4, pending: 1, quiet: 1 });
    assert.deepEqual(account.enumeration, { scope: 'bounded', scannedCount: 25, remainingCount: 4, failedReadCount: 1, scanCapReached: true });
    assert.equal(recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained fictional reference details', sourceReferenceId: 'note:fictional-message-42', sourceReferenceVersion: 'note-v1' }).disposition, 'duplicate');
    assert.throws(() => recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Changed under retry', sourceReferenceId: 'note:fictional-message-42', sourceReferenceVersion: 'note-v1' }), { code: 'intent-mismatch' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('a structured clarification resolves only its linked outcome and survives SQLite restart', async () => {
  const temporary = await temporaryStateDir('command-center-intake-clarification-');
  try {
    let metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan()); const { payment, response, decision } = addEffects(metadata);
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: payment.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'send-reference', kind: 'obligation', status: 'applied', summary: 'Send fictional reference', loopId: response.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'choose-delivery', kind: 'decision', status: 'pending-decision', summary: 'Choose fictional delivery window', loopId: decision.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained fictional reference details', sourceReferenceId: 'note:fictional-message-42', sourceReferenceVersion: 'note-v1' });
    metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'clarify-fictional-delivery', loopId: decision.loopId, expectedRevision: decision.revision, decision: 'confirm', actorId: 'operator-fixture', rationale: 'Use the standard fictional window.', updatedAt: '2026-09-22T01:05:00.000Z' });
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(account.resolved, true);
    assert.deepEqual(account.outcomes.map(item => [item.outcomeId, item.status]), [['pay-invoice', 'applied'], ['send-reference', 'applied'], ['choose-delivery', 'clarified'], ['reference-details', 'quiet']]);
    assert.throws(() => metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'stale-clarification', loopId: decision.loopId, expectedRevision: decision.revision, decision: 'dismiss', actorId: 'operator-fixture', rationale: 'A stale different answer.', updatedAt: '2026-09-22T01:06:00.000Z' }), { code: 'open-loop-stale-revision' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('missing and unresolved outcomes remain visible instead of advancing the source to resolved', async () => {
  const temporary = await temporaryStateDir('command-center-intake-partial-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path }); recordIntakeSourcePlan(metadata, sourcePlan());
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'unresolved-topic', summary: 'Topic requires review' });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(account.accounted, false); assert.equal(account.resolved, false); assert.equal(account.counts.unresolvedTopics, 1); assert.equal(account.outcomes.filter(item => item.status === 'missing').length, 3);
    metadata.close();
  } finally { await temporary.cleanup(); }
});
