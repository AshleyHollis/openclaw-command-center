import { createHash } from 'node:crypto';
import { planTransactionEvent } from '../open-loops/transaction-intake.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function installTransactionIntake(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  service.ingestTransactionEvent = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['schemaVersion', 'logicalOperationId', 'event'].includes(key)) || input.schemaVersion !== 1 || typeof input.logicalOperationId !== 'string' || input.logicalOperationId.trim() === '') fail('transaction-intake-invalid');
    let plan;
    try { plan = planTransactionEvent(input.event); } catch (error) { fail('transaction-intake-invalid', error.message); }
    const operationId = input.logicalOperationId.trim();
    const operationHash = hash(operationId).slice(0, 40);
    const observed = service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: `transaction-intake:observe:${operationHash}`, observation: plan.observation });
    const existing = service.findOpenLoopBySubject(plan.loop.kind, plan.loop.stableSubjectId);
    if (existing?.evidenceObservationIds.includes(plan.observation.observationId)) return Object.freeze({ schemaVersion: 1, disposition: 'duplicate', observation: observed.observation, loop: existing });
    const eventKind = plan.observation.facts.eventKind;
    const terminal = ['resolved', 'cancelled'].includes(existing?.state);
    const laterCurrentEvidence = existing && terminal && plan.observation.historicalBaseline !== true && !['installation-complete', 'order-cancelled'].includes(eventKind);
    const amountChanged = existing?.amount !== undefined && plan.observation.facts.amount !== undefined && (existing.amount !== plan.observation.facts.amount || existing.currency !== plan.observation.facts.currency);
    const dateChanged = existing?.dueAt !== undefined && plan.loop.dueAt !== undefined && existing.dueAt !== plan.loop.dueAt;
    let next = existing ? {
      ...existing,
      title: plan.loop.title,
      ...(plan.loop.dueAt === undefined ? {} : { dueAt: plan.loop.dueAt }),
      ...(plan.loop.expectedEvent === undefined ? {} : { expectedEvent: plan.loop.expectedEvent }),
      state: plan.loop.state,
      attention: plan.loop.attention,
      evidenceObservationIds: [...existing.evidenceObservationIds, plan.observation.observationId],
      revision: existing.revision + 1
    } : plan.loop;
    if (plan.observation.facts.amount !== undefined) next = { ...next, amount: plan.observation.facts.amount, currency: plan.observation.facts.currency };
    if (laterCurrentEvidence) next = { ...next, state: 'uncertain', attention: { reason: 'evidence-conflict', whyNow: 'New current evidence conflicts with the recorded terminal outcome.', actions: ['Open source', 'Review evidence'], activated: true, currentEvidence: true } };
    else if (!plan.observation.historicalBaseline && (amountChanged || dateChanged) && plan.loop.state !== 'cancelled') next = { ...next, attention: { reason: 'material-change', whyNow: 'The exact source changed an amount or expected date; review the evidence before changing the plan.', actions: ['Open source', 'Compare versions', 'Record decision'], materialRevision: `${plan.observation.source.externalId}:${plan.observation.source.version}`, activated: true, currentEvidence: true } };
    const reconciled = service.reconcileOpenLoop({
      schemaVersion: 1,
      logicalOperationId: `transaction-intake:reconcile:${operationHash}`,
      expectedRevision: existing?.revision ?? 0,
      loop: next,
      evidenceRoles: { [plan.observation.observationId]: laterCurrentEvidence ? 'conflict' : existing ? eventKind === 'installation-complete' || eventKind === 'order-cancelled' ? 'resolution' : 'update' : 'origin' },
      updatedAt: plan.observation.observedAt
    });
    return Object.freeze({ schemaVersion: 1, disposition: 'applied', observation: observed.observation, loop: reconciled.loop });
  };
}
