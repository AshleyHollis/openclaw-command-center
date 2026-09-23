import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadIntakeSourceAccount } from './intake-accounting.mjs';
import { recordIntakeReceipt } from './intake-receipt.mjs';
import { producerIntakePlanDigest } from './producer-intake-plan.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };

export function producerSourceExternalId(sourceNamespace, sourceExternalId) {
  const digest = createHash('sha256').update(JSON.stringify([sourceNamespace, sourceExternalId])).digest('hex');
  return `namespaced:v1:sha256:${digest}`;
}

function receiptsFor(metadata, sourceKind) {
  return metadata.listOperations().filter(item => item.operationKind === `intake-receipt.${sourceKind}.v1` && item.resultStatus !== 'superseded').map(item => {
    try { return JSON.parse(item.resultIdentity ?? 'null'); } catch { return null; }
  });
}

export function prepareAdmittedRetry(metadata, plan, expectedDigest, attemptId) {
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(attemptId)) fail('producer-retry-attempt-invalid');
  if (producerIntakePlanDigest(plan) !== expectedDigest) fail('producer-plan-digest-mismatch');
  const runId = `${plan.runId}:retry:${attemptId}`;
  if (runId.length > 300) fail('producer-retry-attempt-invalid');
  const receipts = receiptsFor(metadata, plan.sourceKind);
  const original = receipts.find(item => item?.runId === plan.runId && item.purpose !== 'admitted-retry');
  const priorRetry = receipts.find(item => item?.runId === runId && item.purpose === 'admitted-retry');
  const enumeration = { scope: plan.enumeration.scope, scannedCount: plan.enumeration.scannedCount, remainingCount: plan.enumeration.remainingCount, failedReadCount: plan.enumeration.failedReadCount, scanCapReached: plan.enumeration.scanCapReached };
  if (!original || !['pending', 'failed'].includes(original.status) || original.planDigest !== expectedDigest || !isDeepStrictEqual(original.scope, plan.scope) || !isDeepStrictEqual(original.enumeration, enumeration)) fail('producer-retry-original-unavailable');
  if (priorRetry && (priorRetry.planDigest !== expectedDigest || priorRetry.retryOfRunId !== original.runId)) fail('producer-retry-intent-mismatch');
  let blockedOutcomeCount = 0;
  const records = [];
  for (const record of plan.records) {
    const sourceExternalId = producerSourceExternalId(plan.sourceNamespace, record.sourceExternalId);
    const durable = loadIntakeSourceAccount(metadata, { sourceKind: plan.sourceKind, sourceExternalId, sourceVersion: record.sourceVersion });
    const accepted = durable?.plan;
    if (!accepted || accepted.checkpoint !== record.checkpoint || accepted.processorVersion !== plan.processorVersion || accepted.retainedNoteRevision !== record.retainedNoteRevision || !isDeepStrictEqual(accepted.acceptedExtraction, record.acceptedExtraction) || !isDeepStrictEqual(accepted.enumeration, plan.enumeration)) fail('producer-retry-source-not-admitted');
    const outcomes = durable.account?.outcomes ?? [];
    blockedOutcomeCount += outcomes.filter(item => ['failed', 'unknown', 'unresolved-topic'].includes(item.status)).length;
    if (outcomes.some(item => item.status === 'missing')) records.push({ ...record, sourceKind: plan.sourceKind, sourceExternalId });
  }
  return Object.freeze({ runId, records: Object.freeze(records), blockedOutcomeCount, priorRetry });
}

export function reconcileAdmittedRetry(metadata, plan, expectedDigest, attemptId) {
  const state = prepareAdmittedRetry(metadata, plan, expectedDigest, attemptId);
  if (state.records.length !== 0) fail('producer-retry-work-remains');
  if (state.priorRetry?.status !== 'pending') return Object.freeze({ schemaVersion: 1, status: state.priorRetry?.status === 'failed' ? 'retry-failed-new-attempt-required' : state.blockedOutcomeCount ? 'blocked-outcomes-remain' : 'nothing-to-retry', retriedSources: 0, blockedOutcomeCount: state.blockedOutcomeCount });
  const observedAt = new Date().toISOString();
  const status = state.blockedOutcomeCount ? 'failed' : 'healthy-processed';
  const receipt = recordIntakeReceipt(metadata, { ...state.priorRetry, status, observedAt, ...(status === 'healthy-processed' ? { lastSuccessfulAt: observedAt } : {}) });
  return Object.freeze({ schemaVersion: 1, status: state.blockedOutcomeCount ? 'blocked-outcomes-remain' : status, retriedSources: 0, blockedOutcomeCount: state.blockedOutcomeCount, recoveredPendingReceipt: true, receipt });
}
