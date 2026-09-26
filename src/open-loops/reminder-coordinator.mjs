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

export function openLoopReminderOperationId(parentId) {
  const bytes = createHash('sha256').update(`${nonBlank(parentId, 'parentId')}\u0000open-loop-reminder`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    async reconcileAccepted(input = {}) {
      const loop = normalizeLoop(input.loop);
      const intent = input.followUpIntent;
      if (!intent || intent.schemaVersion !== 1 || intent.loopId !== loop.loopId || intent.loopRevision !== loop.revision
        || intent.referenceId !== reminderReferenceId(loop.loopId)
        || intent.logicalOperationId !== assertLogicalOperationId(intent.logicalOperationId)) {
        throw sourceError('invalid-request', 'Saved Reminder follow-up does not match the accepted decision.');
      }
      if (metadata.getOpenLoop?.(loop.loopId)?.revision !== loop.revision) throw sourceError('conflict', 'A newer open-loop decision superseded this Reminder follow-up.');
      if (['none', 'blocked', 'conflict'].includes(intent.action)) return Object.freeze({ schemaVersion: 1, status: intent.action, logicalOperationId: intent.logicalOperationId, plan: intent });
      const reminder = adapterFor(nonBlank(intent.topicId, 'topicId'));
      let receipt;
      if (intent.action === 'cancel-after-update' || intent.action === 'reschedule-after-update') {
        const predecessor = intent.predecessor;
        if (!predecessor || predecessor.logicalOperationId !== assertLogicalOperationId(predecessor.logicalOperationId)
          || !predecessor.expectedConfigRevision || predecessor.expectedConfigRevision !== intent.expectedConfigRevision) {
          throw sourceError('invalid-request', 'Pending native update identity is unavailable.');
        }
        const prior = metadata.getOperation?.(predecessor.logicalOperationId);
        if (!prior || ['pending', 'not-applied', 'unknown'].includes(prior.state)) {
          return Object.freeze({ schemaVersion: 1, status: prior?.state === 'unknown' ? 'unknown' : 'pending',
            logicalOperationId: intent.logicalOperationId, plan: intent });
        }
        if (prior.state !== 'applied' || !prior.observedRevision
          || prior.resultIdentity !== metadata.getSourceReference(intent.referenceId)?.externalSourceId) {
          throw sourceError('conflict', 'The predecessor Scheduler update has no exact accepted result.');
        }
        receipt = intent.action === 'cancel-after-update'
          ? await reminder.complete({ schemaVersion: 1, referenceId: intent.referenceId,
              logicalOperationId: intent.logicalOperationId, expectedConfigRevision: prior.observedRevision })
          : await reminder.reschedule({ schemaVersion: 1, referenceId: intent.referenceId,
              logicalOperationId: intent.logicalOperationId, expectedConfigRevision: prior.observedRevision,
              patch: { schedule: intent.declaration?.schedule } });
      } else if (intent.action === 'cancel-pending-create' || intent.action === 'reschedule-pending-create') {
        const predecessor = intent.predecessor;
        if (!predecessor || predecessor.logicalOperationId !== assertLogicalOperationId(predecessor.logicalOperationId)
          || !Number.isSafeInteger(predecessor.loopRevision) || predecessor.loopRevision >= intent.loopRevision
          || !predecessor.declaration) throw sourceError('invalid-request', 'Pending native create identity is unavailable.');
        const prior = metadata.getOperation?.(predecessor.logicalOperationId);
        const bound = metadata.getSourceReference(intent.referenceId);
        let expectedConfigRevision;
        if (prior?.state === 'applied' && prior.resultIdentity === bound?.externalSourceId && prior.observedRevision) {
          // The successor may already have changed the job before a crash.
          // Reuse the durable predecessor receipt, not its obsolete final shape.
          expectedConfigRevision = prior.observedRevision;
        } else {
          const recovered = await reminder.recoverBound({ schemaVersion: 1, referenceId: intent.referenceId,
            logicalOperationId: predecessor.logicalOperationId, declaration: predecessor.declaration });
          if (recovered.status === 'not-applied') return Object.freeze({ schemaVersion: 1, status: 'pending', logicalOperationId: intent.logicalOperationId, plan: intent });
          expectedConfigRevision = nonBlank(recovered.value?.job?.configRevision, 'recoveredConfigRevision');
        }
        receipt = intent.action === 'cancel-pending-create'
          ? await reminder.complete({ schemaVersion: 1, referenceId: intent.referenceId,
              logicalOperationId: intent.logicalOperationId, expectedConfigRevision })
          : await reminder.reschedule({ schemaVersion: 1, referenceId: intent.referenceId,
              logicalOperationId: intent.logicalOperationId, expectedConfigRevision,
              patch: { schedule: intent.declaration?.schedule } });
      } else if (intent.action === 'create') {
        receipt = await reminder.createBound({ schemaVersion: 1, referenceId: intent.referenceId,
          logicalOperationId: intent.logicalOperationId, declaration: intent.declaration });
      } else if (intent.action === 'reschedule') {
        receipt = await reminder.reschedule({ schemaVersion: 1, referenceId: intent.referenceId,
          logicalOperationId: intent.logicalOperationId, expectedConfigRevision: nonBlank(intent.expectedConfigRevision, 'expectedConfigRevision'),
          patch: { schedule: intent.declaration?.schedule } });
      } else if (intent.action === 'cancel') {
        receipt = await reminder.complete({ schemaVersion: 1, referenceId: intent.referenceId,
          logicalOperationId: intent.logicalOperationId, expectedConfigRevision: nonBlank(intent.expectedConfigRevision, 'expectedConfigRevision') });
      } else throw sourceError('invalid-request', 'Saved Reminder follow-up action is unsupported.');
      const currentLoop = metadata.getOpenLoop?.(loop.loopId);
      const latest = metadata.getCurrentOpenLoopUserActionReceipt?.(loop.loopId);
      if (currentLoop?.revision !== loop.revision) {
        const successorOwnsPredecessor = latest.followUpIntent?.predecessor?.logicalOperationId === intent.logicalOperationId;
        const canHandoff = (intent.action === 'create' && ['cancel-pending-create', 'reschedule-pending-create'].includes(latest.followUpIntent?.action))
          || (intent.action === 'reschedule' && ['cancel-after-update', 'reschedule-after-update'].includes(latest.followUpIntent?.action));
        if (successorOwnsPredecessor && canHandoff) {
          const successor = await this.reconcileAccepted({ loop: latest.loop, followUpIntent: latest.followUpIntent });
          return Object.freeze({ schemaVersion: 1, status: 'superseded', logicalOperationId: intent.logicalOperationId,
            plan: intent, successorStatus: successor.status });
        }
        throw sourceError('conflict', 'A newer decision superseded this native Reminder follow-up after dispatch.');
      }
      return Object.freeze({ ...receipt, plan: intent });
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
        if (expectedConfigRevision !== undefined && expectedConfigRevision !== current.job?.configRevision) throw sourceError('conflict', 'The native Reminder changed after the requested open-loop action was formed.');
        expectedConfigRevision ??= current.job?.configRevision;
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
