import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { recordIntakeOutcome, recordIntakeSourcePlan } from '../src/open-loops/intake-accounting.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';
import { prepareAdmittedRetry, reconcileAdmittedRetry, producerSourceExternalId } from '../src/open-loops/intake-retry.mjs';
import { producerIntakePlanDigest } from '../src/open-loops/producer-intake-plan.mjs';

test('retry owner keeps an unknown outcome distinct and never invents processed sources', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-retry-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extraction = { schemaVersion: 1, proposedTopic: null, notePath: '', knowledgeMarkdown: '', obligations: [], noAction: { outcomeId: 'fictional:no-action', summary: 'Fictional source needs no action' } };
  const plan = { schemaVersion: 1, purpose: 'command-center-producer-intake', runId: 'fictional-original', sourceKind: 'email', sourceNamespace: 'fictional-account', scope: { accountBinding: 'fictional-binding', folders: ['inbox'], sinceUtc: '2026-09-20T00:00:00.000Z', beforeUtc: '2026-09-21T00:00:00.000Z', maxMessages: 5, batchKind: 'canary' }, processorVersion: 'fictional-v1', nextExpectedAt: '2026-09-22T00:00:00.000Z', enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false }, records: [{ schemaVersion: 1, sourceExternalId: 'fictional-source', sourceVersion: 'upstream-revision', checkpoint: 'page-1', acceptedExtraction: extraction }] };
  const digest = producerIntakePlanDigest(plan);
  const sourceExternalId = producerSourceExternalId(plan.sourceNamespace, plan.records[0].sourceExternalId);
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { notes: true } });
  try {
    recordIntakeSourcePlan(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId, sourceVersion: 'upstream-revision', checkpoint: 'page-1', observedAt: '2026-09-21T01:00:00.000Z', processorVersion: plan.processorVersion, acceptedExtraction: extraction, outcomes: [{ outcomeId: 'fictional:no-action', kind: 'no-action' }], enumeration: plan.enumeration });
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: plan.runId, planDigest: digest, checkpoint: 'start', status: 'pending', observedAt: '2026-09-21T01:00:00.000Z', nextExpectedAt: plan.nextExpectedAt, processedCount: 0, actionableCount: 0, noteCount: 0, scope: plan.scope, enumeration: plan.enumeration });
    recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId, sourceVersion: 'upstream-revision', outcomeId: 'fictional:no-action', kind: 'no-action', status: 'unknown', summary: 'The source effect is uncertain', recordedAt: '2026-09-21T01:01:00.000Z' });
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: `${plan.runId}:retry:one`, purpose: 'admitted-retry', retryOfRunId: plan.runId, planDigest: digest, checkpoint: 'start', status: 'pending', observedAt: '2026-09-21T01:02:00.000Z', processedCount: 0, actionableCount: 0, noteCount: 0, scope: plan.scope });
    const prepared = prepareAdmittedRetry(metadata, plan, digest, 'one');
    assert.equal(prepared.records.length, 0); assert.equal(prepared.blockedOutcomeCount, 1);
    const revoked = Object.assign(new Error('operator-cancelled'), { code: 'operator-cancelled' });
    assert.throws(() => reconcileAdmittedRetry(metadata, plan, digest, 'one', () => { throw revoked; }), { code: 'operator-cancelled' });
    assert.equal(prepareAdmittedRetry(metadata, plan, digest, 'one').priorRetry.status, 'pending', 'revoked authority cannot finalize the receipt');
    const recovered = reconcileAdmittedRetry(metadata, plan, digest, 'one');
    assert.equal(recovered.status, 'blocked-outcomes-remain');
    assert.equal(recovered.receipt.receipt.status, 'failed');
    assert.equal(recovered.receipt.receipt.processedCount, 0);
    assert.equal(recovered.receipt.receipt.lastSuccessfulAt, undefined);
  } finally { metadata.close(); }
});

test('retry selects admitted missing work when a later source was never admitted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-retry-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extraction = source => ({ schemaVersion: 1, proposedTopic: null, notePath: '', knowledgeMarkdown: '', obligations: [], noAction: { outcomeId: `${source}:no-action`, summary: 'Fictional source needs no action' } });
  const enumeration = { scope: 'complete', scannedCount: 2, remainingCount: 0, failedReadCount: 0, scanCapReached: false };
  const plan = { schemaVersion: 1, purpose: 'command-center-producer-intake', runId: 'fictional-partial', sourceKind: 'email', sourceNamespace: 'fictional-account', scope: { accountBinding: 'fictional-binding', folders: ['inbox'], sinceUtc: '2026-09-20T00:00:00.000Z', beforeUtc: '2026-09-21T00:00:00.000Z', maxMessages: 5, batchKind: 'canary' }, processorVersion: 'fictional-v1', nextExpectedAt: '2026-09-22T00:00:00.000Z', enumeration, records: ['first', 'second'].map(source => ({ schemaVersion: 1, sourceExternalId: source, sourceVersion: `upstream-${source}`, checkpoint: source, acceptedExtraction: extraction(source) })) };
  const digest = producerIntakePlanDigest(plan);
  const metadata = openCommandCenterMetadataService({ stateDir: root, capabilities: { notes: true } });
  try {
    const first = plan.records[0];
    recordIntakeSourcePlan(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: producerSourceExternalId(plan.sourceNamespace, first.sourceExternalId), sourceVersion: first.sourceVersion, checkpoint: first.checkpoint, observedAt: '2026-09-21T01:00:00.000Z', processorVersion: plan.processorVersion, acceptedExtraction: first.acceptedExtraction, outcomes: [{ outcomeId: 'first:no-action', kind: 'no-action' }], enumeration });
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: plan.runId, planDigest: digest, checkpoint: 'start', status: 'pending', observedAt: '2026-09-21T01:00:00.000Z', nextExpectedAt: plan.nextExpectedAt, processedCount: 0, actionableCount: 0, noteCount: 0, scope: plan.scope, enumeration });
    const prepared = prepareAdmittedRetry(metadata, plan, digest, 'partial');
    assert.deepEqual(prepared.records.map(item => item.sourceVersion), ['upstream-first']);
    assert.equal(prepared.unadmittedSourceCount, 1);
    assert.equal(metadata.listOperations().filter(item => item.operationKind === 'intake-source.email.v1').length, 1, 'retry preparation must not admit the later source');
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: `${plan.runId}:retry:partial`, purpose: 'admitted-retry', retryOfRunId: plan.runId, planDigest: digest, unadmittedSourceCount: 1, checkpoint: 'start', status: 'pending', observedAt: '2026-09-21T01:00:30.000Z', processedCount: 0, actionableCount: 0, noteCount: 0, scope: plan.scope });
    recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: producerSourceExternalId(plan.sourceNamespace, first.sourceExternalId), sourceVersion: first.sourceVersion, outcomeId: 'first:no-action', kind: 'no-action', status: 'no-action', summary: 'Fictional source needs no action', recordedAt: '2026-09-21T01:01:00.000Z' });
    const remaining = reconcileAdmittedRetry(metadata, plan, digest, 'partial');
    assert.equal(remaining.status, 'unadmitted-sources-remain');
    assert.equal(remaining.unadmittedSourceCount, 1);
    assert.equal(remaining.receipt.receipt.unadmittedSourceCount, 1);
    assert.equal(metadata.listOperations().filter(item => item.operationKind === 'intake-source.email.v1').length, 1);
  } finally { metadata.close(); }
});
