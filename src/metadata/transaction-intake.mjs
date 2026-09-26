import { planTransactionEvent } from '../open-loops/transaction-intake.mjs';
import { openLoopReminderReferenceId } from '../open-loops/reminder-coordinator.mjs';

export function installTransactionIntake(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  service.ingestTransactionEvent = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['schemaVersion', 'logicalOperationId', 'event'].includes(key)) || input.schemaVersion !== 1 || typeof input.logicalOperationId !== 'string' || input.logicalOperationId.trim() === '') fail('transaction-intake-invalid');
    let plan;
    try { plan = planTransactionEvent(input.event); } catch (error) { fail('transaction-intake-invalid', error.message); }
    const operationId = input.logicalOperationId.trim();
    const operationKind = 'transaction-intake';
    const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: operationId, operationKind, intent: input.event });
    if (replay) return Object.freeze({ ...replay, disposition: 'duplicate' });
    const existing = service.findOpenLoopBySubject(plan.loop.kind, plan.loop.stableSubjectId);
    const eventKind = plan.observation.facts.eventKind;
    const terminal = ['resolved', 'cancelled'].includes(existing?.state);
    const terminalOccurredAt = terminal ? existing.evidenceObservationIds.map(id => service.getOpenLoopObservation(id)).filter(item => ['installation-complete', 'delivery-complete', 'order-cancelled'].includes(item?.facts?.eventKind)).map(item => Date.parse(item.occurredAt)).sort((left, right) => left - right).at(-1) : undefined;
    const incomingTerminal = ['resolved', 'cancelled'].includes(plan.loop.state);
    const nativeReminderBound = existing && service.getSourceReference(openLoopReminderReferenceId(existing.loopId));
    const terminalNeedsDecision = Boolean(incomingTerminal && !plan.observation.historicalBaseline && !terminal && nativeReminderBound);
    const preserveTerminal = terminal && (plan.observation.historicalBaseline === true || terminalOccurredAt !== undefined && Date.parse(plan.observation.occurredAt) <= terminalOccurredAt || incomingTerminal && plan.loop.state === existing.state);
    const laterCurrentEvidence = existing && terminal && !preserveTerminal;
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
    if (preserveTerminal || existing && plan.observation.historicalBaseline) next = { ...existing, evidenceObservationIds: [...existing.evidenceObservationIds, plan.observation.observationId], revision: existing.revision + 1 };
    else if (plan.observation.facts.amount !== undefined) next = { ...next, amount: plan.observation.facts.amount, currency: plan.observation.facts.currency };
    if (laterCurrentEvidence) next = { ...next, state: 'uncertain', attention: { reason: 'evidence-conflict', whyNow: 'New current evidence conflicts with the recorded terminal outcome.', actions: ['Open source', 'Review evidence'], activated: true, currentEvidence: true } };
    else if (!plan.observation.historicalBaseline && (amountChanged || dateChanged) && plan.loop.state !== 'cancelled') next = { ...next, attention: { reason: 'material-change', whyNow: 'The exact source changed an amount or expected date; review the evidence before changing the plan.', actions: ['Open source', 'Compare versions', 'Record decision'], materialRevision: `${plan.observation.source.externalId}:${plan.observation.source.version}`, activated: true, currentEvidence: true } };
    if (terminalNeedsDecision) next = { ...next, state: 'uncertain', attention: { reason: 'evidence-conflict', whyNow: 'The source reports completion while a saved Reminder is active. Confirm the outcome to cancel that Reminder.', actions: ['Open source', 'Review evidence', 'Mark resolved'], activated: true, currentEvidence: true } };
    const reconciled = service.applyOpenLoopChange({
      schemaVersion: 1,
      logicalOperationId: operationId,
      operationKind,
      intent: input.event,
      expectedRevision: existing?.revision ?? 0,
      observation: plan.observation,
      loop: next,
      evidenceRoles: { [plan.observation.observationId]: laterCurrentEvidence || terminalNeedsDecision ? 'conflict' : existing ? incomingTerminal ? 'resolution' : 'update' : 'origin' },
      updatedAt: plan.observation.observedAt
    });
    return Object.freeze({ schemaVersion: 1, disposition: 'applied', observation: reconciled.observation, loop: reconciled.loop });
  };
}
