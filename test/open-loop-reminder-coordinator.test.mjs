import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import {
  createOpenLoopReminderCoordinator,
  openLoopReminderReferenceId,
  planOpenLoopReminder
} from '../src/open-loops/reminder-coordinator.mjs';

const topicId = 'topic-fictional-renovation';
const dueAt = '2026-10-04T07:00:00.000Z';
const correctedAt = '2026-10-06T07:00:00.000Z';

function loop(overrides = {}) {
  return {
    schemaVersion: 1,
    loopId: 'loop-fictional-electrician-invoice',
    kind: 'payment',
    stableSubjectId: 'invoice:FICTIONAL-1042',
    title: 'Pay fictional electrician invoice',
    topicId,
    state: 'confirmed',
    paymentState: 'unpaid',
    amount: 184500,
    currency: 'AUD',
    dueAt,
    attention: { actions: ['Open original'], activated: false, currentEvidence: true },
    evidenceObservationIds: ['observation-fictional-invoice'],
    revision: 1,
    ...overrides
  };
}

function schedulerGateway() {
  const jobs = new Map();
  const calls = [];
  let revision = 0;
  let failAfterNextUpdate = false;
  const nextRevision = () => `fictional-revision-${++revision}`;
  return {
    calls,
    jobs,
    loseNextUpdateResponse() { failAfterNextUpdate = true; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'cron.list') return { jobs: [...jobs.values()].map(job => structuredClone(job)) };
      if (method === 'cron.get') return structuredClone(jobs.get(params.id));
      if (method === 'cron.add') {
        const id = `fictional-reminder-${jobs.size + 1}`;
        const job = { ...structuredClone(params), id, configRevision: nextRevision() };
        jobs.set(id, job);
        return { created: true, job: structuredClone(job) };
      }
      if (method === 'cron.update') {
        const current = jobs.get(params.id);
        if (current.configRevision !== params.expectedConfigRevision) {
          const error = new Error('changed');
          error.code = 'CRON_JOB_CHANGED';
          error.actualConfigRevision = current.configRevision;
          throw error;
        }
        const job = { ...current, ...structuredClone(params.patch), configRevision: nextRevision() };
        jobs.set(job.id, job);
        if (failAfterNextUpdate) {
          failAfterNextUpdate = false;
          const error = new Error('fictional response lost after commit');
          error.code = 'timeout';
          error.ambiguous = true;
          throw error;
        }
        return structuredClone(job);
      }
      throw new Error(`Unexpected method ${method}`);
    }
  };
}

test('planning preserves unknown and date-only timing and requires an existing Topic', () => {
  assert.deepEqual(planOpenLoopReminder({ loop: loop({ dueAt: undefined }) }), {
    schemaVersion: 1,
    action: 'none',
    referenceId: openLoopReminderReferenceId(loop().loopId),
    reason: 'accepted-time-unknown'
  });
  const dateOnly = planOpenLoopReminder({ loop: loop(), acceptedTiming: { kind: 'date', date: '2026-10-04', timeZone: 'Australia/Brisbane' } });
  assert.equal(dateOnly.action, 'blocked');
  assert.equal(dateOnly.reason, 'date-time-required');
  assert.equal(dateOnly.timing.date, '2026-10-04');
  assert.equal(planOpenLoopReminder({ loop: loop({ topicId: undefined }) }).reason, 'topic-required');
  assert.equal(planOpenLoopReminder({ loop: loop({ state: 'suggested' }) }).reason, 'confirmation-required');
});

test('a Topic-bound open loop creates, corrects, and cancels one native Reminder through durable owner receipts', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-open-loop-reminder-'));
  const gateway = schedulerGateway();
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    let coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });

    const created = await coordinator.reconcile({ loop: loop(), logicalOperationId: '10000000-0000-4000-8000-000000000001' });
    assert.equal(created.status, 'applied');
    assert.equal(created.plan.action, 'create');
    assert.equal(created.value.job.enabled, true);
    assert.deepEqual(created.value.job.schedule, { kind: 'at', at: dueAt });
    assert.equal(created.value.sourceReference.referenceId, openLoopReminderReferenceId(loop().loopId));
    assert.equal(gateway.jobs.size, 1);
    const createReceipt = metadata.getOperation('10000000-0000-4000-8000-000000000001');
    assert.equal(createReceipt.state, 'applied');
    assert.equal(createReceipt.operationKind, 'reminders.create');

    const corrected = loop({ dueAt: correctedAt, revision: 2 });
    const rescheduled = await coordinator.reconcile({
      loop: corrected,
      logicalOperationId: '10000000-0000-4000-8000-000000000002',
      expectedConfigRevision: created.value.job.configRevision
    });
    assert.equal(rescheduled.plan.action, 'reschedule');
    assert.deepEqual(rescheduled.value.job.schedule, { kind: 'at', at: correctedAt });
    assert.equal(metadata.getOperation('10000000-0000-4000-8000-000000000002').operationKind, 'reminders.snooze');

    const paid = loop({ dueAt: correctedAt, revision: 3, state: 'resolved', paymentState: 'paid' });
    const completed = await coordinator.reconcile({
      loop: paid,
      logicalOperationId: '10000000-0000-4000-8000-000000000003',
      expectedConfigRevision: rescheduled.value.job.configRevision
    });
    assert.equal(completed.plan.action, 'cancel');
    assert.equal(completed.value.job.enabled, false);
    assert.equal(metadata.getOperation('10000000-0000-4000-8000-000000000003').operationKind, 'reminders.complete');

    const updatesBeforeRestart = gateway.calls.filter(call => call.method === 'cron.update').length;
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    const replay = await coordinator.reconcile({
      loop: paid,
      logicalOperationId: '10000000-0000-4000-8000-000000000003',
      expectedConfigRevision: rescheduled.value.job.configRevision
    });
    assert.equal(replay.status, 'applied');
    assert.equal(gateway.calls.filter(call => call.method === 'cron.update').length, updatesBeforeRestart, 'restart replay must not redispatch');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a lost reschedule response remains unknown across restart and never rereads a revision to make stale intent succeed', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-open-loop-reminder-lost-'));
  const gateway = schedulerGateway();
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    let coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    const created = await coordinator.reconcile({ loop: loop(), logicalOperationId: '20000000-0000-4000-8000-000000000001' });
    gateway.loseNextUpdateResponse();
    const input = {
      loop: loop({ dueAt: correctedAt, revision: 2 }),
      logicalOperationId: '20000000-0000-4000-8000-000000000002',
      expectedConfigRevision: created.value.job.configRevision
    };
    await assert.rejects(() => coordinator.reconcile(input), error => error.code === 'unknown');
    assert.equal(metadata.getOperation(input.logicalOperationId).state, 'unknown');
    const updates = gateway.calls.filter(call => call.method === 'cron.update').length;

    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    await assert.rejects(() => coordinator.reconcile(input), error => error.code === 'unknown');
    assert.equal(gateway.calls.filter(call => call.method === 'cron.update').length, updates, 'recovery must reconcile without dispatching again');
    assert.equal(metadata.getOperation(input.logicalOperationId).state, 'unknown');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
