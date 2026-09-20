import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRenovationFollowThrough } from '../src/metadata/renovation-follow-through.mjs';
import { planRenovationDecisionConflict, stableRenovationRequirementId } from '../src/open-loops/renovation-follow-through.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { projectQuietAttention } from '../src/open-loops/quiet-attention.mjs';

const at = '2026-09-20T02:00:00.000Z';
const later = '2026-09-22T02:00:00.000Z';
const source = (externalId, version = 'v1', kind = 'renovation-note-evidence') => ({ system: 'fictional-renovation-source', kind, externalId, version });
const ref = (kind, id, label) => ({ kind, namespace: 'fictional-home-project', id, ...(label ? { label } : {}) });
const owned = value => ({ ...value, actorId: 'fictional-operator' });

async function withApi(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-renovation-'));
  const service = openCommandCenterMetadataService({ stateDir });
  try { await run(createRenovationFollowThrough(service), service); } finally { service.close(); await rm(stateDir, { recursive: true, force: true }); }
}

function requirement(id, kind = 'purchase', overrides = {}) {
  return { schemaVersion: 1, source: source(`requirement-${id}`), requirement: ref(kind, id), occurredAt: at, observedAt: at, historicalBaseline: false, title: `Fictional requirement ${id}`, ...overrides };
}

test('an exact purchase resolves only the explicitly linked stale buy requirement', async () => {
  await withApi((api, service) => {
    api.recordRequirement(owned({ schemaVersion: 1, logicalOperationId: 'record-buy-tap', expectedRevision: 0, requirement: requirement('buy-tap') }));
    api.recordRequirement(owned({ schemaVersion: 1, logicalOperationId: 'record-buy-sink', expectedRevision: 0, requirement: requirement('buy-sink') }));
    const command = owned({ schemaVersion: 1, logicalOperationId: 'reconcile-tap-purchase', expectedRevision: 1, reconciliation: { schemaVersion: 1, source: source('receipt-tap'), requirement: ref('purchase', 'buy-tap'), purchase: ref('purchase', 'purchase-tap-001'), occurredAt: later, observedAt: later, historicalBaseline: false } });
    const result = api.reconcilePurchasedItem(command);
    assert.equal(result.loop.state, 'resolved');
    assert.equal(service.findOpenLoopBySubject('general', stableRenovationRequirementId(ref('purchase', 'buy-sink'))).state, 'waiting');
    assert.equal(result.observation.facts.requirementId, 'buy-tap');
    assert.equal(result.loop.evidenceObservationIds.length, 2);
    assert.equal(api.reconcilePurchasedItem(command).loop.revision, 2);
    assert.throws(() => api.reconcilePurchasedItem({ ...command, reconciliation: { ...command.reconciliation, purchase: ref('purchase', 'purchase-tap-002') } }), error => error.code === 'open-loop-intent-mismatch');
    const corrected = api.correctPurchasedItem(owned({ schemaVersion: 1, logicalOperationId: 'correct-tap-purchase', expectedRevision: 2, correction: { schemaVersion: 1, source: source('correct-receipt-tap'), requirement: ref('purchase', 'buy-tap'), purchase: ref('purchase', 'purchase-tap-001'), occurredAt: '2026-09-23T02:00:00.000Z', observedAt: '2026-09-23T02:00:00.000Z', rationale: 'The fictional receipt line belongs to another item.' } }));
    assert.equal(corrected.loop.state, 'waiting');
    assert.equal(corrected.loop.expectedEvent, 'explicitly linked purchase');
    assert.equal(corrected.observation.facts.eventKind, 'purchase-relationship-corrected');
    assert.equal(service.findOpenLoopBySubject('general', stableRenovationRequirementId(ref('purchase', 'buy-sink'))).state, 'waiting', 'the correction must not alter another requirement');
    const replacementLink = api.reconcilePurchasedItem(owned({ schemaVersion: 1, logicalOperationId: 'reconcile-tap-purchase-b', expectedRevision: 3, reconciliation: { ...command.reconciliation, source: source('receipt-tap-b'), purchase: ref('purchase', 'purchase-tap-002') } }));
    assert.equal(replacementLink.loop.state, 'resolved');
    assert.throws(() => api.correctPurchasedItem(owned({ schemaVersion: 1, logicalOperationId: 'correct-historical-tap-purchase', expectedRevision: 4, correction: { schemaVersion: 1, source: source('correct-old-receipt-tap'), requirement: ref('purchase', 'buy-tap'), purchase: ref('purchase', 'purchase-tap-001'), occurredAt: '2026-09-24T02:00:00.000Z', observedAt: '2026-09-24T02:00:00.000Z', rationale: 'Attempt to unlink already corrected history.' } })), /relationship-missing/u);
    assert.equal(service.findOpenLoopBySubject('general', stableRenovationRequirementId(ref('purchase', 'buy-tap'))).state, 'resolved');
  });
});

test('a replacement purchase retains a separately identified disposition obligation and deadline', async () => {
  await withApi((api, service) => {
    const result = api.recordReplacementDisposition(owned({ schemaVersion: 1, logicalOperationId: 'replacement-return', expectedRevision: 0, replacement: { schemaVersion: 1, source: source('replacement-receipt'), replacementPurchase: ref('purchase', 'replacement-mixer-001'), replacedItem: ref('renovation-item', 'faulty-mixer-001'), obligation: ref('return', 'return-faulty-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Return fictional faulty mixer', dueAt: '2026-09-25T00:00:00.000Z' } }));
    assert.equal(result.loop.stableSubjectId, stableRenovationRequirementId(ref('return', 'return-faulty-mixer-001')));
    assert.equal(result.loop.dueAt, '2026-09-25T00:00:00.000Z');
    assert.equal(result.observation.facts.replacementPurchaseId, 'replacement-mixer-001');
    assert.equal(service.listOpenLoops().length, 1);
    const projected = projectQuietAttention(result.loop, { now: '2026-09-24T00:00:00.000Z' });
    assert.equal(projected.group, 'attention');
    assert.equal(projected.reason, 'due-window');
  });
});

test('delivery waits for installation when installation is required', async () => {
  await withApi((api) => {
    api.recordRequirement(owned({ schemaVersion: 1, logicalOperationId: 'record-installation', expectedRevision: 0, requirement: requirement('install-oven', 'installation') }));
    const delivered = api.recordFulfilment(owned({ schemaVersion: 1, logicalOperationId: 'oven-delivered', expectedRevision: 1, fulfilment: { schemaVersion: 1, source: source('oven-delivery', 'v1', 'delivery-record'), requirement: ref('installation', 'install-oven'), fulfilmentKind: 'delivered', installationRequired: true, occurredAt: later, observedAt: later, historicalBaseline: false } }));
    assert.equal(delivered.loop.state, 'monitoring');
    assert.equal(delivered.loop.expectedEvent, 'installation');
    const installed = api.recordFulfilment(owned({ schemaVersion: 1, logicalOperationId: 'oven-installed', expectedRevision: 2, fulfilment: { schemaVersion: 1, source: source('oven-installation', 'v1', 'installation-record'), requirement: ref('installation', 'install-oven'), fulfilmentKind: 'installed', installationRequired: true, occurredAt: '2026-09-24T02:00:00.000Z', observedAt: '2026-09-24T02:00:00.000Z', historicalBaseline: false } }));
    assert.equal(installed.loop.state, 'resolved');
    assert.equal(installed.loop.evidenceObservationIds.length, 3);
  });
});

test('a partial order update keeps one exact follow-up with item detail and an accepted review time', async () => {
  await withApi((api, service) => {
    api.recordRequirement(owned({ schemaVersion: 1, logicalOperationId: 'record-tap-order', expectedRevision: 0, requirement: requirement('tap-order-17', 'purchase', { title: 'Await fictional tap order' }) }));
    const partial = api.recordFulfilment(owned({ schemaVersion: 1, logicalOperationId: 'tap-order-partial', expectedRevision: 1, fulfilment: { schemaVersion: 1, source: source('tap-order-delivery', 'v1', 'explicit-fulfilment'), requirement: ref('purchase', 'tap-order-17'), fulfilmentKind: 'delivered', installationRequired: false, fulfilledItemIds: ['tap-body', 'tap-hose'], outstandingItemIds: ['tap-handle'], expectedAt: '2026-09-25T00:00:00.000Z', note: 'Two of three fictional items were checked against the packing slip.', occurredAt: later, observedAt: later, historicalBaseline: false } }));
    assert.equal(partial.loop.state, 'monitoring');
    assert.equal(partial.loop.expectedEvent, 'delivery of tap-handle');
    assert.equal(partial.loop.dueAt, '2026-09-25T00:00:00.000Z');
    assert.deepEqual(partial.observation.facts.fulfilledItemIds, ['tap-body', 'tap-hose']);
    assert.deepEqual(partial.observation.facts.outstandingItemIds, ['tap-handle']);
    assert.equal(service.listOpenLoops().length, 1);
    const deferred = service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'review-tap-order-friday', loopId: partial.loop.loopId, expectedRevision: 2, decision: 'defer', reviewAt: '2026-09-25T09:00:00.000Z', actorId: 'fictional-operator', rationale: 'Review Friday if the outstanding handle has not arrived.', updatedAt: '2026-09-22T03:00:00.000Z' });
    assert.equal(deferred.loop.state, 'waiting');
    assert.equal(projectQuietAttention(deferred.loop, { now: '2026-09-25T08:59:00.000Z' }).group, 'deferred');
    assert.equal(projectQuietAttention(deferred.loop, { now: '2026-09-25T09:00:00.000Z' }).group, 'attention');
  });
});

test('return completion leaves an exact refund obligation open', async () => {
  await withApi((api, service) => {
    const common = { replacementPurchase: ref('purchase', 'replacement-mixer-001'), replacedItem: ref('renovation-item', 'faulty-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false };
    const returned = api.recordReplacementDisposition(owned({ schemaVersion: 1, logicalOperationId: 'record-return-obligation', expectedRevision: 0, replacement: { schemaVersion: 1, source: source('replacement-return'), ...common, obligation: ref('return', 'return-faulty-mixer-001'), title: 'Return fictional faulty mixer', dueAt: '2026-09-25T00:00:00.000Z' } }));
    const refund = api.recordReplacementDisposition(owned({ schemaVersion: 1, logicalOperationId: 'record-refund-obligation', expectedRevision: 0, replacement: { schemaVersion: 1, source: source('replacement-refund'), ...common, obligation: ref('refund', 'refund-faulty-mixer-001'), title: 'Await fictional mixer refund', dueAt: '2026-10-02T00:00:00.000Z' } }));
    const completedReturn = service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'complete-return', loopId: returned.loop.loopId, expectedRevision: 1, decision: 'resolve', actorId: 'fictional-operator', rationale: 'The fictional carrier receipt confirms the old item was returned.', updatedAt: later });
    assert.equal(completedReturn.loop.state, 'resolved');
    assert.equal(service.getOpenLoop(refund.loop.loopId).state, 'confirmed');
    assert.equal(service.listOpenLoops().length, 2);
  });
});

test('prerequisites surface as individually addressable items only for an explicitly activated exact stage', async () => {
  await withApi((api) => {
    const stage = ref('renovation-stage', 'cabinet-installation');
    for (const id of ['disconnect-water', 'clear-work-area']) api.recordRequirement(owned({ schemaVersion: 1, logicalOperationId: `record-${id}`, expectedRevision: 0, requirement: requirement(id, 'prerequisite', { stage }) }));
    assert.deepEqual(api.projectStagePrerequisites({ stage }).items, []);
    api.recordStageActivation(owned({ schemaVersion: 1, logicalOperationId: 'activate-cabinet-installation', expectedRevision: 0, activation: { schemaVersion: 1, source: source('stage-cabinet', 'v1', 'explicit-stage-state'), stage, active: true, occurredAt: later, observedAt: later } }));
    const group = api.projectStagePrerequisites({ stage });
    assert.equal(group.active, true);
    assert.equal(group.items.length, 2);
    assert.equal(new Set(group.items.map(item => item.loop.loopId)).size, 2);
    assert.ok(group.items.every(item => item.reason === 'activated-blocker'));
    assert.deepEqual(api.projectStagePrerequisites({ stage: ref('renovation-stage', 'painting') }).items, []);
    assert.equal(api.projectActiveStagePrerequisites().length, 1);
    assert.equal(api.projectActiveStagePrerequisites()[0].items.length, 2);
    api.recordStageActivation(owned({ schemaVersion: 1, logicalOperationId: 'deactivate-cabinet-installation', expectedRevision: 0, activation: { schemaVersion: 1, source: source('stage-cabinet', 'v2', 'explicit-stage-state'), stage, active: false, occurredAt: '2026-09-23T02:00:00.000Z', observedAt: '2026-09-23T02:00:00.000Z' } }));
    assert.deepEqual(api.projectStagePrerequisites({ stage }).items, []);
    assert.deepEqual(api.projectActiveStagePrerequisites(), []);
  });
});

test('a purchase conflicting with a recorded choice requests review without changing the decision', async () => {
  await withApi((api, service) => {
    service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'record-tap-choice', expectedRevision: 0, decision: { schemaVersion: 1, decisionId: 'tap-colour-choice', status: 'confirmed', decidedAt: at, actorId: 'fictional-operator', subject: { kind: 'product-choice', id: 'tap-colour', label: 'Fictional tap colour choice' }, chosenOption: 'brushed nickel', alternatives: ['matte black'], rationale: 'Matches the fictional sink.', assumptions: [], sourceObservationIds: [] } });
    const challenged = api.recordDecisionConflict(owned({ schemaVersion: 1, logicalOperationId: 'tap-purchase-conflict', expectedRevision: 1, conflict: { schemaVersion: 1, decisionId: 'tap-colour-choice', source: source('tap-receipt', 'v1', 'purchase-record'), conflictKind: 'purchase-vs-choice', occurredAt: later, observedAt: later, historicalBaseline: false, summary: 'The fictional receipt records a different finish.', recordedChoice: 'brushed nickel', observedChoice: 'matte black', evidenceSelectors: ['receipt:line-item:finish'] } }));
    assert.equal(challenged.decision.loop.state, 'decision-needed');
    assert.equal(challenged.decision.currentRecord, undefined);
    assert.equal(service.getDecisionMemory('tap-colour-choice').currentRecord.facts.chosenOption, 'brushed nickel');
    assert.equal(challenged.observation.facts.assessment, 'contradicted');
  });
});

test('matching choice evidence stays quiet and planners reject name-only or implicit relationships', async () => {
  const unchanged = planRenovationDecisionConflict({ schemaVersion: 1, decisionId: 'finish-choice', source: source('matching-quote', 'v2', 'quote'), conflictKind: 'revised-quote', occurredAt: later, observedAt: later, historicalBaseline: false, summary: 'The revised quote retains the selected finish.', recordedChoice: 'white', observedChoice: 'white', evidenceSelectors: ['quote:finish'] });
  assert.equal(unchanged.assessment, 'unchanged');
  assert.equal(unchanged.material, false);
  assert.throws(() => stableRenovationRequirementId({ kind: 'purchase', namespace: 'fictional-home-project', id: '' }), /requirement.id/);
  await withApi(api => assert.throws(() => api.reconcilePurchasedItem(owned({ schemaVersion: 1, logicalOperationId: 'name-only', expectedRevision: 1, reconciliation: { schemaVersion: 1, source: source('name-only-receipt'), requirement: { kind: 'purchase', namespace: 'fictional-home-project', id: '' }, purchase: ref('purchase', 'receipt-item'), occurredAt: later, observedAt: later, historicalBaseline: false } })), /requirement.id/));
});

test('a revised quote conflict uses the same explicit-review boundary', async () => {
  await withApi((api, service) => {
    service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'record-cabinet-choice', expectedRevision: 0, decision: { schemaVersion: 1, decisionId: 'cabinet-finish-choice', status: 'confirmed', decidedAt: at, actorId: 'fictional-operator', subject: { kind: 'product-choice', id: 'cabinet-finish', label: 'Fictional cabinet finish choice' }, chosenOption: 'warm white', alternatives: ['cool white'], rationale: 'Keeps the fictional room palette consistent.', assumptions: [], sourceObservationIds: [] } });
    const challenged = api.recordDecisionConflict(owned({ schemaVersion: 1, logicalOperationId: 'cabinet-quote-conflict', expectedRevision: 1, conflict: { schemaVersion: 1, decisionId: 'cabinet-finish-choice', source: source('cabinet-quote', 'v2', 'quote'), conflictKind: 'revised-quote', occurredAt: later, observedAt: later, historicalBaseline: false, summary: 'The revised fictional quote names a different cabinet finish.', recordedChoice: 'warm white', observedChoice: 'cool white', evidenceSelectors: ['quote:finish'] } }));
    assert.equal(challenged.decision.loop.state, 'decision-needed');
    assert.equal(service.getDecisionMemory('cabinet-finish-choice').currentRecord.facts.chosenOption, 'warm white');
    assert.match(challenged.decision.loop.attention.whyNow, /remains unchanged/i);
  });
});

test('a reviewed quote fact does not reopen for a source-only revision and different scopes are not compared as savings', async () => {
  await withApi((api, service) => {
    service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'record-cost-choice', expectedRevision: 0, decision: { schemaVersion: 1, decisionId: 'cabinet-cost-choice', status: 'confirmed', decidedAt: at, actorId: 'fictional-operator', subject: { kind: 'quote-choice', id: 'cabinet-cost', label: 'Fictional cabinet quote' }, chosenOption: 'AUD 12000 same scope', alternatives: [], rationale: 'Accepted against the recorded scope.', assumptions: ['Same cabinet and installation scope.'], sourceObservationIds: [] } });
    const first = api.recordDecisionConflict(owned({ schemaVersion: 1, logicalOperationId: 'cost-change-v2', expectedRevision: 1, conflict: { schemaVersion: 1, decisionId: 'cabinet-cost-choice', source: source('cabinet-quote', 'v2', 'quote'), conflictKind: 'revised-quote', occurredAt: later, observedAt: later, historicalBaseline: false, summary: 'The same fictional scope is now AUD 14500.', recordedChoice: 'AUD 12000 same scope', observedChoice: 'AUD 14500 same scope', scopeComparison: 'like-for-like', evidenceSelectors: ['quote:total', 'quote:scope'] } }));
    assert.equal(first.decision.loop.state, 'decision-needed');
    const dismissed = service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'dismiss-reviewed-cost-change', loopId: first.decision.loop.loopId, expectedRevision: 2, decision: 'resolve', actorId: 'fictional-operator', rationale: 'Reviewed and retained the current decision for now.', updatedAt: '2026-09-22T03:00:00.000Z' });
    assert.equal(dismissed.loop.state, 'resolved');
    const sameFacts = api.recordDecisionConflict(owned({ schemaVersion: 1, logicalOperationId: 'cost-change-format-only-v3', expectedRevision: 3, conflict: { schemaVersion: 1, decisionId: 'cabinet-cost-choice', source: source('cabinet-quote', 'v3', 'quote'), conflictKind: 'revised-quote', occurredAt: '2026-09-23T00:00:00.000Z', observedAt: '2026-09-23T00:00:00.000Z', historicalBaseline: false, summary: 'Formatting changed; supported cost and scope facts did not.', recordedChoice: 'AUD 12000 same scope', observedChoice: 'AUD 14500 same scope', scopeComparison: 'like-for-like', evidenceSelectors: ['quote:total', 'quote:scope'] } }));
    assert.equal(sameFacts.decision.loop.state, 'resolved');
    assert.equal(sameFacts.decision.loop.attention.activated, false);
    const differentScope = planRenovationDecisionConflict({ schemaVersion: 1, decisionId: 'cabinet-cost-choice', source: source('cabinet-quote-other-scope', 'v1', 'quote'), conflictKind: 'revised-quote', occurredAt: later, observedAt: later, historicalBaseline: false, summary: 'A cheaper quote excludes installation.', recordedChoice: 'AUD 12000 including installation', observedChoice: 'AUD 10000 supply only', scopeComparison: 'different-scope', evidenceSelectors: ['quote:scope'] });
    assert.equal(differentScope.assessment, 'ambiguous');
    assert.equal(differentScope.material, false);
    assert.match(differentScope.assumption, /different-scope/u);
  });
});
