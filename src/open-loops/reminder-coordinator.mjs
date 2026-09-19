import { createHash } from 'node:crypto';
import { normalizeLoop } from './contracts.mjs';
import { sourceError, nonBlank } from '../sources/errors.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';
import { createReminderAdapter } from '../sources/reminders.mjs';

const terminalStates = new Set(['resolved', 'cancelled']);
const terminalPaymentStates = new Set(['paid', 'cancelled']);

function reminderReferenceId(loopId) {
  const key = createHash('sha256').update(loopId).digest('hex').slice(0, 40);
  return `open-loop-reminder:${key}`;
}

function instant(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw sourceError('invalid-request', `${field} must be an RFC 3339 instant.`);
  }
  return value;
}

export function zonedDateAtNine(date, timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); } catch { throw sourceError('invalid-request', 'acceptedTiming.timeZone must be a valid IANA timezone.'); }
  const [year, month, day] = date.split('-').map(Number); const desiredUtcShape = Date.UTC(year, month - 1, day, 9); let candidate = desiredUtcShape;
  const formatter = new Intl.DateTimeFormat('en-US-u-hc-h23', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const observedUtcShape = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second); const correction = desiredUtcShape - observedUtcShape;
    if (correction === 0) return new Date(candidate).toISOString(); candidate += correction;
  }
  throw sourceError('invalid-request', 'The accepted calendar date could not be resolved in its timezone.');
}

function normalizedTiming(loop, acceptedTiming, defaultTimeZone = 'UTC') {
  if (acceptedTiming !== undefined) {
    if (!acceptedTiming || typeof acceptedTiming !== 'object' || Array.isArray(acceptedTiming)) throw sourceError('invalid-request', 'acceptedTiming must be an object.');
    const keys = Object.keys(acceptedTiming);
    if (acceptedTiming.kind === 'instant' && keys.every((key) => ['kind', 'at', 'basis'].includes(key))) {
      const basis = acceptedTiming.basis ?? 'explicit';
      if (typeof basis !== 'string' || basis.trim() === '') throw sourceError('invalid-request', 'acceptedTiming.basis must be a non-blank string.');
      return { kind: 'instant', at: instant(acceptedTiming.at, 'acceptedTiming.at'), basis: basis.trim() };
    }
    if (acceptedTiming.kind === 'date' && keys.every((key) => ['kind', 'date', 'timeZone', 'basis'].includes(key))) {
      if (typeof acceptedTiming.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(acceptedTiming.date)) throw sourceError('invalid-request', 'acceptedTiming.date must be a calendar date.');
      const basis = acceptedTiming.basis ?? 'explicit';
      if (typeof basis !== 'string' || basis.trim() === '') throw sourceError('invalid-request', 'acceptedTiming.basis must be a non-blank string.');
      if (acceptedTiming.timeZone !== undefined && (typeof acceptedTiming.timeZone !== 'string' || acceptedTiming.timeZone.trim() === '')) throw sourceError('invalid-request', 'acceptedTiming.timeZone must be a non-blank string.');
      const timeZone = acceptedTiming.timeZone?.trim() || defaultTimeZone;
      return { kind: 'date', date: acceptedTiming.date, timeZone, at: zonedDateAtNine(acceptedTiming.date, timeZone), basis: basis.trim() };
    }
    if (acceptedTiming.kind === 'unknown' && keys.length === 1) return { kind: 'unknown' };
    throw sourceError('invalid-request', 'acceptedTiming is unsupported.');
  }
  if (loop.reviewAt) return { kind: 'instant', at: loop.reviewAt, basis: 'review-at' };
  if (loop.dueDate) return { kind: 'date', date: loop.dueDate, timeZone: loop.dueTimeZone, at: zonedDateAtNine(loop.dueDate, loop.dueTimeZone), basis: 'due-date' };
  if (loop.dueAt) return { kind: 'instant', at: loop.dueAt, basis: 'due-at' };
  return { kind: 'unknown' };
}

function alreadyScheduled(job, at) {
  return job?.enabled === true && job?.schedule?.kind === 'at' && job.schedule.at === at;
}

export function planOpenLoopReminder(input = {}) {
  const loop = normalizeLoop(input.loop);
  const referenceId = reminderReferenceId(loop.loopId);
  const binding = input.sourceReference ?? null;
  if (binding && (binding.referenceId !== referenceId || binding.sourceSystem !== 'scheduler' || binding.sourceKind !== 'reminder_schedule')) {
    throw sourceError('conflict', 'The open loop Reminder binding does not identify its exact owned native Reminder.');
  }
  const terminal = terminalStates.has(loop.state) || terminalPaymentStates.has(loop.paymentState);
  if (terminal) return Object.freeze(binding
    ? input.schedulerJob?.enabled === false
      ? { schemaVersion: 1, action: 'none', referenceId, topicId: binding.topicId, reason: 'already-cancelled' }
      : { schemaVersion: 1, action: 'cancel', referenceId, topicId: binding.topicId, reason: 'loop-terminal' }
    : { schemaVersion: 1, action: 'none', referenceId, reason: 'loop-terminal-without-reminder' });

  const timing = normalizedTiming(loop, input.acceptedTiming, input.defaultTimeZone);
  if (timing.kind === 'unknown') return Object.freeze(binding
    ? { schemaVersion: 1, action: 'cancel', referenceId, topicId: binding.topicId, reason: 'accepted-time-removed' }
    : { schemaVersion: 1, action: 'none', referenceId, reason: 'accepted-time-unknown' });
  if (loop.state === 'suggested') return Object.freeze({ schemaVersion: 1, action: 'blocked', referenceId, reason: 'confirmation-required', timing });
  if (!loop.topicId) return Object.freeze({ schemaVersion: 1, action: 'blocked', referenceId, reason: 'topic-required', timing });
  if (binding && binding.topicId !== loop.topicId) throw sourceError('conflict', 'The open loop Topic differs from the owned native Reminder Topic.');
  if (binding && alreadyScheduled(input.schedulerJob, timing.at)) return Object.freeze({ schemaVersion: 1, action: 'none', referenceId, topicId: loop.topicId, reason: 'already-scheduled', timing });
  return Object.freeze({
    schemaVersion: 1,
    action: binding ? 'reschedule' : 'create',
    referenceId,
    topicId: loop.topicId,
    timing,
    declaration: {
      name: `Open loop: ${loop.title}`,
      description: `Command Center open-loop reminder (${loop.loopId})`,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: 'at', at: timing.at },
      payload: { kind: 'systemEvent', text: `Review open loop: ${loop.title}` },
      sessionTarget: 'main',
      wakeMode: 'next-heartbeat'
    }
  });
}

export function createOpenLoopReminderCoordinator({ api, gateway, metadata, reminderFactory = createReminderAdapter } = {}) {
  if (!metadata?.getSourceReference) throw sourceError('capability-unavailable', 'Open-loop Reminder coordination requires durable Source Reference metadata.');
  const adapterFor = (topicId) => reminderFactory({ api, gateway, metadata, topicId });
  return Object.freeze({
    plan(input = {}) {
      const loop = normalizeLoop(input.loop);
      const referenceId = reminderReferenceId(loop.loopId);
      return planOpenLoopReminder({ ...input, loop, defaultTimeZone: input.defaultTimeZone ?? api?.config?.agents?.defaults?.userTimezone ?? 'UTC', sourceReference: input.sourceReference ?? metadata.getSourceReference(referenceId) });
    },
    async reconcile(input = {}) {
      const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
      const loop = normalizeLoop(input.loop);
      const referenceId = reminderReferenceId(loop.loopId);
      let sourceReference = metadata.getSourceReference(referenceId);
      let schedulerJob = input.schedulerJob;
      let expectedConfigRevision = input.expectedConfigRevision;
      const priorOperation = metadata.getOperation?.(logicalOperationId);
      if (sourceReference && schedulerJob === undefined && !priorOperation) {
        const current = await adapterFor(sourceReference.topicId).read({ schemaVersion: 1, referenceId });
        sourceReference = current.sourceReference;
        schedulerJob = current.job;
        expectedConfigRevision = current.job?.configRevision;
      }
      const plan = planOpenLoopReminder({ loop, acceptedTiming: input.acceptedTiming, defaultTimeZone: input.defaultTimeZone ?? api?.config?.agents?.defaults?.userTimezone ?? 'UTC', sourceReference, schedulerJob });
      if (['none', 'blocked'].includes(plan.action)) return Object.freeze({ schemaVersion: 1, status: plan.action, logicalOperationId, plan });
      const topicId = plan.topicId;
      const reminder = adapterFor(topicId);
      if (plan.action === 'create') {
        const receipt = await reminder.create({ schemaVersion: 1, requestId: input.requestId, referenceId, logicalOperationId, declaration: plan.declaration });
        return Object.freeze({ ...receipt, plan });
      }
      expectedConfigRevision = nonBlank(expectedConfigRevision, 'expectedConfigRevision');
      if (plan.action === 'reschedule') {
        const receipt = await reminder.reschedule({ schemaVersion: 1, requestId: input.requestId, referenceId, logicalOperationId, expectedConfigRevision, patch: { schedule: plan.declaration.schedule } });
        return Object.freeze({ ...receipt, plan });
      }
      const receipt = await reminder.complete({ schemaVersion: 1, requestId: input.requestId, referenceId, logicalOperationId, expectedConfigRevision });
      return Object.freeze({ ...receipt, plan });
    }
  });
}

export function openLoopReminderReferenceId(loopId) {
  return reminderReferenceId(nonBlank(loopId, 'loopId'));
}
