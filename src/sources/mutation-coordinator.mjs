import { randomUUID } from 'node:crypto';
import { assertLogicalOperationId, isAmbiguousMutationError, isRetryableReadError, OperationJournal } from './operation-journal.mjs';
import { intentDigest as digestIntent } from './reference.mjs';
import { SourceServiceError, sourceError, nonBlank } from './errors.mjs';

function terminal(status) { return ['applied', 'conflict'].includes(status); }

function reconciliationOutcome(value) {
  if (value?.matched === true || value?.status === 'reconciled' || value?.status === 'applied') return 'applied';
  return ['applied', 'not-applied', 'conflict', 'unknown'].includes(value?.outcome) ? value.outcome : 'unknown';
}

export class MutationCoordinator {
  constructor({ journal, metadata, now, requestIdFactory } = {}) {
    this.journal = journal ?? new OperationJournal({ metadata });
    this.now = now ?? (() => new Date().toISOString());
    this.requestIdFactory = requestIdFactory ?? ((base) => base);
  }

  async read({ operationKind, requestId = 'read', read }) {
    nonBlank(operationKind, 'operationKind');
    try { return await read({ requestId, attempt: 0 }); } catch (error) {
      if (!isRetryableReadError(error)) throw error;
      return read({ requestId, attempt: 1 });
    }
  }

  async mutate({ operationKind, requestId, logicalOperationId, topicId = null, referenceId = null, intent, intentDigest, idempotent = false, execute, reconcile }) {
    nonBlank(operationKind, 'operationKind');
    nonBlank(requestId, 'requestId');
    const logicalId = assertLogicalOperationId(logicalOperationId);
    const digest = intentDigest ?? digestIntent({ action: operationKind, topicId, referenceId, input: intent ?? {} });
    const existing = this.journal.get(logicalId);
    if (existing) {
      if (existing.intentDigest !== digest) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different intent.');
      if (existing.state === 'applied') {
        if (typeof reconcile !== 'function') throw sourceError('unknown', 'An applied mutation result requires authoritative reconciliation.', { logicalOperationId: logicalId, requestId });
        const appliedReconciliation = await reconcile({
          requestId,
          logicalOperationId: logicalId,
          intentDigest: digest,
          retry: true,
          applied: true,
          resultIdentity: existing.resultIdentity ?? null,
          observedRevision: existing.observedRevision ?? null,
          operationCreatedAt: existing.createdAt
        });
        const outcome = reconciliationOutcome(appliedReconciliation);
        if (outcome === 'applied') {
          const value = appliedReconciliation.value ?? appliedReconciliation.result ?? appliedReconciliation;
          this.journal.record({ ...existing, transportRequestId: requestId, state: 'applied', resultStatus: 'applied', resultIdentity: identityOf(value), observedRevision: revisionOf(value), updatedAt: this.now() });
          return this.wrapResult('applied', value, { logicalOperationId: logicalId, transportRequestId: requestId });
        }
        if (outcome === 'conflict') {
          this.journal.record({ ...existing, transportRequestId: requestId, state: 'conflict', resultStatus: 'conflict', updatedAt: this.now() });
          throw sourceError('conflict', 'Authoritative reconciliation found a conflicting mutation outcome.', { logicalOperationId: logicalId, requestId });
        }
        throw sourceError('unknown', 'The applied mutation result is not yet recoverable from the authoritative source.', { logicalOperationId: logicalId, requestId });
      }
      if (terminal(existing.state)) return Object.freeze({ ...existing, status: existing.state });
      if (['pending', 'unknown', 'not-applied'].includes(existing.state) && typeof reconcile === 'function') {
        const pendingReconciliation = await reconcile({ requestId, logicalOperationId: logicalId, intentDigest: digest, pending: existing.state === 'pending', retry: true, operationCreatedAt: existing.createdAt });
        const outcome = reconciliationOutcome(pendingReconciliation);
        if (outcome === 'applied') {
          const value = pendingReconciliation.value ?? pendingReconciliation.result ?? pendingReconciliation;
          this.journal.record({ logicalOperationId: logicalId, transportRequestId: requestId, intentDigest: digest, operationKind, state: 'applied', resultStatus: 'applied', resultIdentity: identityOf(value), observedRevision: revisionOf(value), updatedAt: this.now(), createdAt: existing.createdAt ?? this.now() });
          return this.wrapResult('applied', value, { logicalOperationId: logicalId, transportRequestId: requestId });
        }
        if (outcome === 'conflict') {
          this.journal.record({ ...existing, transportRequestId: requestId, state: 'conflict', resultStatus: 'conflict', updatedAt: this.now() });
          throw sourceError('conflict', 'Authoritative reconciliation found a conflicting mutation outcome.', { logicalOperationId: logicalId, requestId });
        }
        if (outcome === 'unknown') {
          this.journal.record({ ...existing, transportRequestId: requestId, state: 'unknown', resultStatus: 'unknown', updatedAt: this.now() });
          throw sourceError('unknown', 'Mutation delivery remains ambiguous after authoritative reconciliation.', { logicalOperationId: logicalId, requestId });
        }
      }
      if (['pending', 'unknown'].includes(existing.state) && typeof reconcile !== 'function') throw sourceError('unknown', 'A pending mutation requires authoritative reconciliation.', { logicalOperationId: logicalId, requestId });
    }
    const pendingOperation = this.journal.record({ logicalOperationId: logicalId, transportRequestId: requestId, intentDigest: digest, operationKind, state: 'pending', createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now() });
    let attempt = 0;
    while (true) {
      const transportRequestId = requestId;
      try {
        const value = await execute({ requestId: transportRequestId, logicalOperationId: logicalId, intentDigest: digest, attempt, operationCreatedAt: pendingOperation.createdAt });
        const result = this.wrapResult('applied', value, { logicalOperationId: logicalId, transportRequestId });
        this.journal.record({ logicalOperationId: logicalId, transportRequestId, intentDigest: digest, operationKind, state: 'applied', resultStatus: 'applied', resultIdentity: identityOf(value), observedRevision: revisionOf(value), updatedAt: this.now(), createdAt: pendingOperation.createdAt });
        return result;
      } catch (error) {
        if (!isAmbiguousMutationError(error)) {
          const status = error?.code === 'conflict' ? 'conflict' : null;
          if (status) this.journal.record({ logicalOperationId: logicalId, transportRequestId, intentDigest: digest, operationKind, state: status, resultStatus: status, observedRevision: error.currentRevision ?? null, updatedAt: this.now(), createdAt: pendingOperation.createdAt });
          throw error;
        }
        if (idempotent && attempt === 0) {
          attempt += 1;
          continue;
        }
        if (typeof reconcile !== 'function') {
          this.journal.record({ logicalOperationId: logicalId, transportRequestId, intentDigest: digest, operationKind, state: 'unknown', resultStatus: 'unknown', updatedAt: this.now(), createdAt: pendingOperation.createdAt });
          throw sourceError('unknown', 'Mutation delivery was ambiguous and authoritative reconciliation is unavailable.', { cause: error, logicalOperationId: logicalId, requestId: transportRequestId });
        }
        const reconciliation = await reconcile({ requestId, logicalOperationId: logicalId, intentDigest: digest, error, attempt, operationCreatedAt: pendingOperation.createdAt });
        const outcome = reconciliationOutcome(reconciliation);
        if (outcome === 'applied') {
          const value = reconciliation.value ?? reconciliation.result ?? reconciliation;
          const result = this.wrapResult('applied', value, { logicalOperationId: logicalId, transportRequestId });
          this.journal.record({ logicalOperationId: logicalId, transportRequestId, intentDigest: digest, operationKind, state: 'applied', resultStatus: 'applied', resultIdentity: identityOf(value), observedRevision: revisionOf(value), updatedAt: this.now(), createdAt: pendingOperation.createdAt });
          return result;
        }
        this.journal.record({ logicalOperationId: logicalId, transportRequestId, intentDigest: digest, operationKind, state: outcome, resultStatus: outcome, updatedAt: this.now(), createdAt: pendingOperation.createdAt });
        throw sourceError(outcome, outcome === 'unknown' ? 'Mutation delivery remains ambiguous after authoritative reconciliation.' : `Mutation reconciliation reported ${outcome}.`, { cause: error, logicalOperationId: logicalId, requestId: transportRequestId });
      }
    }
  }

  wrapResult(status, value, ids) {
    return Object.freeze({ schemaVersion: 1, status, requestId: ids.transportRequestId, logicalOperationId: ids.logicalOperationId, value });
  }
}

function identityOf(value) {
  if (value === null || value === undefined) return null;
  return value.sourceReference?.externalSourceId ?? value.sourceReference?.referenceId ?? value.note?.sourceReference?.externalSourceId ?? value.note?.sourceReference?.referenceId ?? value.externalSourceId ?? value.path ?? value.note?.path ?? value.analysisId ?? value.runId ?? value.run?.runId ?? value.id ?? null;
}

function revisionOf(value) {
  return value?.revision ?? value?.observedRevision ?? value?.sourceReference?.observedRevision ?? value?.note?.revision ?? value?.note?.sourceReference?.observedRevision ?? value?.job?.configRevision ?? null;
}

export function createMutationCoordinator(options) {
  return new MutationCoordinator(options);
}
