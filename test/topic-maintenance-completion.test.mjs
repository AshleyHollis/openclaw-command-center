import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicMaintenanceCompletion, createTopicMaintenanceCompletionSubscription } from '../src/maintenance/completion.mjs';

function fixture() {
  const rows = new Map(); const scheduled = [];
  const binding = { status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' };
  const metadata = { getTopicOperation: id => rows.get(id), recordTopicOperation: row => (rows.set(row.logicalOperationId, row), row) };
  const maintenanceSchedule = {
    isScheduledMaintenanceRun: ({ runId }) => runId.startsWith('cron:maintenance-job:'),
    schedule: async input => (scheduled.push(input), { status: 'scheduled', jobId: 'maintenance-job' })
  };
  const owner = createTopicMaintenanceCompletion({ sourceService: { sessionTopicContext: async ({ sessionKey }) => sessionKey === binding.sessionKey ? binding : { status: 'unbound' } }, metadata, maintenanceSchedule, now: () => '2026-09-13T00:00:00.000Z' });
  const event = { runId: 'native-run-1', stream: 'lifecycle', sessionKey: binding.sessionKey, sessionId: binding.sessionId, data: { phase: 'end', executionSettled: true } };
  return { owner, rows, scheduled, event, binding, metadata, maintenanceSchedule };
}

test('a settled exact native Conversation completion schedules one Topic catch-up and replays safely', async () => {
  const { owner, scheduled, event } = fixture();
  const first = await owner.handle(event);
  const replay = await owner.handle(event);
  assert.equal(first.status, 'scheduled'); assert.equal(replay.status, 'replayed');
  assert.deepEqual(scheduled, [{ sessionKey: 'agent:main:a', reason: 'a completed native Conversation turn' }]);
});

test('the exact persisted cron job identity prevents maintenance from scheduling itself', async () => {
  const { owner, scheduled, event, rows } = fixture();
  const result = await owner.handle({ ...event, runId: 'cron:maintenance-job:1726185600000:runner' });
  assert.equal(result.status, 'ignored-maintenance-turn'); assert.equal(scheduled.length, 0);
  assert.equal(rows.get(result.logicalOperationId).currentStep, 'maintenance-turn-ignored');
});

test('missing, replaced, aborted or unsettled Conversation lifecycle identity cannot schedule maintenance', async () => {
  const { owner, scheduled, event } = fixture();
  for (const candidate of [
    { ...event, sessionId: undefined },
    { ...event, data: { phase: 'end', executionSettled: true, aborted: true } },
    { ...event, data: { phase: 'end' } },
    { ...event, sessionKey: 'agent:main:foreign' }
  ]) assert.equal((await owner.handle(candidate)).status, 'ignored');
  assert.equal(scheduled.length, 0);
});

test('the host subscription delegates only to the injected authoritative owners', async () => {
  const { event, metadata, maintenanceSchedule, binding, scheduled } = fixture();
  const subscription = createTopicMaintenanceCompletionSubscription({ getOwners: () => ({ sourceService: { sessionTopicContext: async () => binding }, metadata, maintenanceSchedule }) });
  assert.deepEqual(subscription.streams, ['lifecycle', 'tool']);
  await subscription.handle(event);
  assert.equal(scheduled.length, 1);
});

test('a successful native working Note tool result suppresses only its own terminal catch-up', async () => {
  const { event, metadata, maintenanceSchedule, binding, scheduled } = fixture();
  const subscription = createTopicMaintenanceCompletionSubscription({ getOwners: () => ({ sourceService: { sessionTopicContext: async () => binding }, metadata, maintenanceSchedule }) });
  const contexts = new Map();
  const ctx = { setRunContext: (namespace, value) => contexts.set(namespace, value), getRunContext: namespace => contexts.get(namespace) };
  await subscription.handle({ ...event, stream: 'tool', data: { phase: 'result', name: 'command_center_update_working_note', isError: false, result: { details: { status: 'applied' } } } }, ctx);
  await subscription.handle(event, ctx);
  assert.equal(scheduled.length, 0);
  assert.equal(contexts.get('command-center-topic-note-maintenance').workingNoteApplied, true);
});

test('a failed working Note tool result does not suppress the terminal catch-up', async () => {
  const { event, metadata, maintenanceSchedule, binding, scheduled } = fixture();
  const subscription = createTopicMaintenanceCompletionSubscription({ getOwners: () => ({ sourceService: { sessionTopicContext: async () => binding }, metadata, maintenanceSchedule }) });
  const contexts = new Map();
  const ctx = { setRunContext: (namespace, value) => contexts.set(namespace, value), getRunContext: namespace => contexts.get(namespace) };
  await subscription.handle({ ...event, stream: 'tool', data: { phase: 'result', name: 'command_center_update_working_note', isError: true } }, ctx);
  await subscription.handle(event, ctx);
  assert.equal(scheduled.length, 1);
  assert.equal(contexts.size, 0);
});

test('a transport-successful conflict or unknown Note result still schedules catch-up', async () => {
  for (const status of ['conflict', 'unknown']) {
    const { event, metadata, maintenanceSchedule, binding, scheduled } = fixture();
    const subscription = createTopicMaintenanceCompletionSubscription({ getOwners: () => ({ sourceService: { sessionTopicContext: async () => binding }, metadata, maintenanceSchedule }) });
    const contexts = new Map();
    const ctx = { setRunContext: (namespace, value) => contexts.set(namespace, value), getRunContext: namespace => contexts.get(namespace) };
    await subscription.handle({ ...event, stream: 'tool', data: { phase: 'result', name: 'command_center_update_working_note', isError: false, result: { details: { status } } } }, ctx);
    await subscription.handle(event, ctx);
    assert.equal(scheduled.length, 1, `${status} must not be reported as a saved working Note`);
    assert.equal(contexts.size, 0);
  }
});
