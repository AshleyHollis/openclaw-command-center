import { createHash } from 'node:crypto';

const decisions = new Set(['confirm', 'defer', 'dismiss', 'resolve', 'correct-date']);
const paymentStates = new Set(['partially-paid', 'payment-pending', 'paid', 'disputed', 'cancelled', 'uncertain']);
const hash = value => createHash('sha256').update(value).digest('hex');

export function installOpenLoopActions(service, { ErrorType }) {
  const fail = (code, message = code) => { throw new ErrorType(code, message); };
  const text = (value, field, maximum = 500) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) fail('open-loop-action-invalid', `${field} must be a non-blank string`);
    return value.trim();
  };
  const instant = (value, field) => {
    const result = text(value, field, 64);
    if (Number.isNaN(Date.parse(result))) fail('open-loop-action-invalid', `${field} must be a valid instant`);
    return result;
  };
  const closed = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('open-loop-action-invalid');
    return value;
  };
  function identifiers(input, operationKind) {
    const logicalOperationId = text(input.logicalOperationId, 'logicalOperationId', 300);
    return {
      logicalOperationId,
      observationId: `user-decision:${hash(`${operationKind}\u0000${logicalOperationId}`).slice(0, 40)}`
    };
  }
  function record({ input, operationKind, facts, transition }) {
    const ids = identifiers(input, operationKind);
    const { updatedAt: _ownerTime, ...rootIntent } = input;
    const replay = service.replayOpenLoopChange({ schemaVersion: 1, logicalOperationId: ids.logicalOperationId, operationKind, intent: rootIntent });
    if (replay) return Object.freeze({ schemaVersion: 1, disposition: 'duplicate', loop: replay.loop, ...(replay.followUpIntent ? { followUpIntent: replay.followUpIntent } : {}), ...(replay.supportingNoteTarget ? { supportingNoteTarget: replay.supportingNoteTarget } : {}) });
    const loop = service.getOpenLoop(text(input.loopId, 'loopId', 300));
    if (!loop) fail('open-loop-missing');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== loop.revision) fail('open-loop-stale-revision');
    const updatedAt = instant(input.updatedAt, 'updatedAt');
    const actorId = text(input.actorId, 'actorId', 200);
    const rationale = text(input.rationale, 'rationale', 1000);
    // Validate the transition before persisting its evidence. A rejected action
    // must not leave an orphaned decision observation behind.
    const next = transition(loop, updatedAt);
    const observation = {
      schemaVersion: 1,
      observationId: ids.observationId,
      source: { system: 'command-center', kind: 'user-decision', externalId: ids.logicalOperationId, version: 'v1' },
      type: operationKind === 'payment-status' ? 'payment-evidence' : 'decision-evidence',
      occurredAt: updatedAt,
      observedAt: updatedAt,
      historicalBaseline: false,
      ...(loop.topicId === undefined ? {} : { topicId: loop.topicId }),
      entityRefs: [{ kind: 'open-loop', id: loop.loopId, evidence: ['explicit-user-action'] }],
      facts: { operationKind, actorId, rationale, ...facts }
    };
    const changed = service.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: ids.logicalOperationId, operationKind, intent: rootIntent, expectedRevision: loop.revision, observation, loop: { ...next, evidenceObservationIds: [...loop.evidenceObservationIds, ids.observationId], revision: loop.revision + 1 }, evidenceRoles: { [ids.observationId]: next.state === 'resolved' || next.state === 'cancelled' ? 'resolution' : 'update' }, updatedAt });
    return Object.freeze({ schemaVersion: 1, disposition: changed.disposition === 'updated' ? 'applied' : changed.disposition, loop: changed.loop,
      ...(changed.followUpIntent ? { followUpIntent: changed.followUpIntent } : {}), ...(changed.supportingNoteTarget ? { supportingNoteTarget: changed.supportingNoteTarget } : {}) });
  }

  service.recordOpenLoopDecision = input => {
    const value = closed(input, ['schemaVersion', 'logicalOperationId', 'loopId', 'expectedRevision', 'decision', 'reviewAt', 'dueAt', 'dueDate', 'dueTimeZone', 'amount', 'currency', 'actorId', 'rationale', 'updatedAt']);
    if (value.schemaVersion !== 1 || !decisions.has(value.decision)) fail('open-loop-action-invalid');
    if ((value.decision === 'defer') !== (value.reviewAt !== undefined)) fail('open-loop-action-invalid', 'Only defer requires reviewAt.');
    const dateOnly = value.dueDate !== undefined || value.dueTimeZone !== undefined;
    if ((value.dueDate === undefined) !== (value.dueTimeZone === undefined) || value.dueAt !== undefined && dateOnly) fail('open-loop-action-invalid', 'Corrected timing must be one instant or one calendar date with timezone.');
    const correctedTiming = value.dueAt !== undefined || dateOnly;
    if (correctedTiming && !['correct-date', 'confirm'].includes(value.decision) || value.decision === 'correct-date' && !correctedTiming) fail('open-loop-action-invalid', 'Corrected timing is required for correct-date and optional while confirming a suggestion.');
    const amount = value.amount === undefined ? undefined : Number(value.amount);
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) fail('open-loop-action-invalid', 'amount must be a positive integer in minor currency units');
    const currency = value.currency === undefined ? undefined : text(value.currency, 'currency', 3).toUpperCase();
    if ((amount === undefined) !== (currency === undefined) || currency !== undefined && !/^[A-Z]{3}$/u.test(currency) || amount !== undefined && value.decision !== 'confirm') fail('open-loop-action-invalid', 'Corrected amount and currency are only accepted together while confirming a suggestion.');
    const reviewAt = value.reviewAt === undefined ? undefined : instant(value.reviewAt, 'reviewAt');
    const dueAt = value.dueAt === undefined ? undefined : instant(value.dueAt, 'dueAt');
    const dueDate = value.dueDate === undefined ? undefined : text(value.dueDate, 'dueDate', 10);
    if (dueDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(dueDate)) fail('open-loop-action-invalid', 'dueDate must be a calendar date');
    const dueTimeZone = value.dueTimeZone === undefined ? undefined : text(value.dueTimeZone, 'dueTimeZone', 100);
    if (dueTimeZone !== undefined) try { new Intl.DateTimeFormat('en-US', { timeZone: dueTimeZone }).format(); } catch { fail('open-loop-action-invalid', 'dueTimeZone must be a valid IANA timezone'); }
    return record({
      input: value,
      operationKind: `decision-${value.decision}`,
      facts: { decision: value.decision, ...(reviewAt === undefined ? {} : { reviewAt }), ...(dueAt === undefined ? {} : { dueAt }), ...(dueDate === undefined ? {} : { dueDate, dueTimeZone }), ...(amount === undefined ? {} : { amount, currency }) },
      transition(loop) {
        if (['resolved', 'cancelled'].includes(loop.state) && value.decision !== 'resolve') fail('open-loop-terminal');
        if (value.decision === 'confirm') {
          if (loop.state !== 'suggested') fail('open-loop-action-invalid', 'Only a suggestion can be confirmed.');
          if (amount !== undefined && loop.kind !== 'payment') fail('open-loop-not-payment');
          const { dueAt: _oldAt, dueDate: _oldDate, dueTimeZone: _oldZone, ...withoutTiming } = loop;
          const timing = correctedTiming ? (dueAt === undefined ? { dueDate, dueTimeZone } : { dueAt }) : Object.fromEntries(Object.entries({ dueAt: loop.dueAt, dueDate: loop.dueDate, dueTimeZone: loop.dueTimeZone }).filter(([, item]) => item !== undefined));
          const accepted = { ...withoutTiming, ...timing, ...(amount === undefined ? {} : { amount, currency }), state: 'confirmed', ...(loop.kind === 'payment' && loop.paymentState === 'potential' ? { paymentState: 'unpaid' } : {}) };
          const hasDue = accepted.dueAt !== undefined || accepted.dueDate !== undefined;
          return { ...accepted, attention: { ...(loop.attention ?? {}), activated: !hasDue, currentEvidence: true } };
        }
        if (value.decision === 'defer') return { ...loop, state: 'waiting', reviewAt, attention: { ...(loop.attention ?? {}), reason: 'review-time', whyNow: `${loop.title} reached its accepted review time.`, actions: loop.attention?.actions?.length ? loop.attention.actions : ['Open evidence', 'Choose next review', 'Mark resolved'], activated: false, currentEvidence: true } };
        if (value.decision === 'correct-date') {
          const { dueAt: _oldAt, dueDate: _oldDate, dueTimeZone: _oldZone, ...withoutTiming } = loop;
          return { ...withoutTiming, ...(dueAt === undefined ? { dueDate, dueTimeZone } : { dueAt }), reviewAt: undefined, attention: { ...(loop.attention ?? {}), activated: false, currentEvidence: true } };
        }
        if (value.decision === 'dismiss') {
          if (loop.kind === 'payment' && loop.state !== 'suggested') fail('open-loop-payment-status-required');
          return { ...loop, state: 'cancelled', ...(loop.kind === 'payment' ? { paymentState: 'cancelled' } : {}), attention: { actions: [], activated: false, currentEvidence: true } };
        }
        if (loop.kind === 'payment') fail('open-loop-payment-status-required');
        return { ...loop, state: 'resolved', attention: { actions: [], activated: false, currentEvidence: true } };
      }
    });
  };

  service.recordOpenLoopPaymentStatus = input => {
    const value = closed(input, ['schemaVersion', 'logicalOperationId', 'loopId', 'expectedRevision', 'paymentState', 'paidAmount', 'currency', 'actorId', 'rationale', 'updatedAt']);
    if (value.schemaVersion !== 1 || !paymentStates.has(value.paymentState)) fail('open-loop-action-invalid');
    const paidAmount = value.paidAmount === undefined ? undefined : Number(value.paidAmount);
    if (paidAmount !== undefined && (!Number.isSafeInteger(paidAmount) || paidAmount < 0)) fail('open-loop-action-invalid');
    const currency = value.currency === undefined ? undefined : text(value.currency, 'currency', 3).toUpperCase();
    if ((paidAmount === undefined) !== (currency === undefined) || currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) fail('open-loop-action-invalid');
    return record({
      input: value,
      operationKind: 'payment-status',
      facts: { paymentState: value.paymentState, ...(paidAmount === undefined ? {} : { paidAmount, currency }), provenance: 'explicit-user-assertion' },
      transition(loop) {
        if (loop.kind !== 'payment') fail('open-loop-not-payment');
        if (paidAmount !== undefined && loop.currency !== undefined && currency !== loop.currency) fail('open-loop-currency-conflict');
        if (value.paymentState === 'partially-paid' && (paidAmount === undefined || loop.amount === undefined || paidAmount <= 0 || paidAmount >= loop.amount)) fail('open-loop-partial-payment-invalid');
        if (value.paymentState === 'paid') return { ...loop, state: 'resolved', paymentState: 'paid', attention: { actions: [], activated: false, currentEvidence: true } };
        if (value.paymentState === 'cancelled') return { ...loop, state: 'cancelled', paymentState: 'cancelled', attention: { actions: [], activated: false, currentEvidence: true } };
        if (value.paymentState === 'uncertain') return { ...loop, state: 'uncertain', paymentState: 'uncertain', attention: { reason: 'evidence-conflict', whyNow: 'The payment outcome needs reconciliation.', actions: ['Open bill', 'Review payment evidence'], activated: true, currentEvidence: true } };
        if (value.paymentState === 'disputed') return { ...loop, state: 'waiting', paymentState: 'disputed', attention: { actions: ['Open bill', 'Review dispute'], activated: false, currentEvidence: true } };
        return { ...loop, state: value.paymentState === 'payment-pending' ? 'monitoring' : 'confirmed', paymentState: value.paymentState };
      }
    });
  };
}
