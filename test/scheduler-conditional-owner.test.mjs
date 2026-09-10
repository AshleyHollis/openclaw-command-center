import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createMutationCoordinator } from '../src/sources/mutation-coordinator.mjs';
import { createSchedulerAdapter } from '../src/sources/scheduler.mjs';

async function fixture(t, request) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'scheduler-conditional-owner-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  metadata.createTopic({ topicId: 'topic-scheduler', name: 'Fictional scheduler', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'schedule-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-fictional', observedRevision: 'r1' });
  const adapter = () => createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway: { request }, coordinator: createMutationCoordinator({ metadata }) });
  return { adapter, get metadata() { return metadata; }, reopen() { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } }); } };
}

test('native CAS rejection preserves the caller base and returns a declared conflict', async (t) => {
  const f = await fixture(t, async (method) => {
    if (method === 'cron.get') return { id: 'job-fictional', configRevision: 'r1', enabled: true };
    assert.equal(method, 'cron.update');
    throw Object.assign(new Error('Concurrent native edit'), { details: { code: 'CRON_JOB_CHANGED', actualConfigRevision: 'r2' } });
  });
  const logicalOperationId = randomUUID();
  await assert.rejects(f.adapter().setEnabled({ referenceId: 'schedule-ref', logicalOperationId, expectedConfigRevision: 'r1', enabled: false }), (error) => error.code === 'conflict' && error.currentRevision === 'r2' && error.expectedRevision === 'r1');
  assert.equal(f.metadata.getOperation(logicalOperationId).state, 'conflict');
});

test('Scheduler update requires the caller base before any source read or write', async (t) => {
  const traffic = [];
  const f = await fixture(t, async (method, params) => {
    traffic.push(method);
    return { id: 'job-fictional', configRevision: method === 'cron.get' ? 'r1' : 'r2', enabled: params.patch?.enabled ?? true };
  });
  const logicalOperationId = randomUUID();
  await assert.rejects(f.adapter().setEnabled({ referenceId: 'schedule-ref', logicalOperationId, enabled: false }), (error) => error.code === 'invalid-request' && /expectedConfigRevision/.test(error.message));
  assert.deepEqual(traffic, []);
  assert.equal(f.metadata.getOperation(logicalOperationId), null);
});

test('restart replay does not replace an applied Scheduler receipt with an unrelated later revision', async (t) => {
  let job = { id: 'job-fictional', configRevision: 'r1', enabled: true, name: 'Initial' };
  let writes = 0;
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.get') return structuredClone(job);
    assert.equal(method, 'cron.update'); writes += 1;
    job = { ...job, ...params.patch, configRevision: 'r2' }; return structuredClone(job);
  });
  const input = { referenceId: 'schedule-ref', logicalOperationId: randomUUID(), expectedConfigRevision: 'r1', enabled: false };
  assert.equal((await f.adapter().setEnabled(input)).value.job.configRevision, 'r2');
  f.reopen();
  assert.equal((await f.adapter().setEnabled(input)).value.job.configRevision, 'r2');
  job = { ...job, name: 'Unrelated later edit', configRevision: 'r3' };
  await assert.rejects(f.adapter().setEnabled(input), (error) => error.code === 'unknown');
  assert.equal(f.metadata.getOperation(input.logicalOperationId).observedRevision, 'r2');
  assert.equal(writes, 1);
});

test('a saved normalized native schedule response replays after reopening without another write', async (t) => {
  let job = { id: 'job-fictional', configRevision: 'r1', enabled: true, schedule: { kind: 'every', everyMs: 30000, anchorMs: 1788652800000 } };
  let writes = 0;
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.get') return structuredClone(job);
    assert.equal(method, 'cron.update');
    assert.equal(params.expectedConfigRevision, 'r1');
    assert.deepEqual(params.patch, { schedule: { kind: 'every', everyMs: 60000 } });
    writes += 1;
    job = { ...job, configRevision: 'r2', schedule: { ...params.patch.schedule, anchorMs: 1788652860000 } };
    return structuredClone(job);
  });
  const input = { referenceId: 'schedule-ref', logicalOperationId: randomUUID(), expectedConfigRevision: 'r1', patch: { schedule: { kind: 'every', everyMs: 60000 } } };
  const receipt = await f.adapter().reschedule(input);
  assert.equal(receipt.value.job.schedule.anchorMs, 1788652860000);
  f.reopen();
  assert.deepEqual((await f.adapter().reschedule(input)).value.job, receipt.value.job);
  assert.equal(writes, 1);
  job = { ...job, configRevision: 'r3', schedule: { ...job.schedule, anchorMs: 1788652920000 } };
  await assert.rejects(f.adapter().reschedule(input), (error) => error.code === 'unknown');
  assert.equal(f.metadata.getOperation(input.logicalOperationId).observedRevision, 'r2');
  assert.equal(writes, 1);
});

test('ambiguous Reminder add never retries a declarative upsert or claims an unwitnessed job', async (t) => {
  let job = null; let writes = 0;
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.list') return { jobs: job ? [structuredClone(job)] : [] };
    assert.equal(method, 'cron.add'); writes += 1;
    // Native declaration-key add is an upsert: a retry would erase this later edit.
    if (job) { job = { ...job, ...params, configRevision: 'r3' }; return structuredClone(job); }
    job = { ...params, id: 'reminder-fictional', name: 'Later operator edit', configRevision: 'r2' };
    throw Object.assign(new Error('Reply lost'), { code: 'timeout', ambiguous: true });
  });
  const input = { logicalOperationId: randomUUID(), declaration: { name: 'Original reminder', schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'systemEvent', text: 'Fictional reminder' } } };
  await assert.rejects(f.adapter().createReminder(input), (error) => error.code === 'unknown');
  f.reopen();
  await assert.rejects(f.adapter().createReminder(input), (error) => error.code === 'unknown');
  assert.equal(job.name, 'Later operator edit');
  assert.equal(writes, 1);
  assert.equal(f.metadata.listSourceReferences('topic-scheduler').some((ref) => ref.externalSourceId === 'reminder-fictional'), false);
});

test('an omitted native revision cannot borrow the last observed revision to qualify replay', async (t) => {
  let job = { id: 'job-fictional', configRevision: 'r1', enabled: true };
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.get') return structuredClone(job);
    job = { ...job, ...params.patch, configRevision: 'r2' }; return structuredClone(job);
  });
  const input = { referenceId: 'schedule-ref', logicalOperationId: randomUUID(), expectedConfigRevision: 'r1', enabled: false };
  await f.adapter().setEnabled(input);
  delete job.configRevision;
  await assert.rejects(f.adapter().setEnabled(input), (error) => error.code === 'source-recovery');
  assert.equal(f.metadata.getOperation(input.logicalOperationId).observedRevision, 'r2');
});

test('binding failure preserves a later-edited Cron job when conditional removal is unavailable', async (t) => {
  let job = null; let removals = 0;
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.list') return { jobs: job ? [structuredClone(job)] : [] };
    if (method === 'cron.add') {
      const created = { ...params, id: 'rollback-fictional', configRevision: 'r1' };
      job = { ...created, name: 'Later operator edit', configRevision: 'r2' };
      // A competing metadata writer wins the requested reference after preflight.
      f.metadata.createSourceReference({ version: 1, referenceId: 'rollback-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'other-fictional', observedRevision: 'other-r1' });
      return { created: true, job: created };
    }
    if (method === 'cron.remove') { removals += 1; job = null; return { removed: true }; }
    throw new Error(`Unexpected ${method}`);
  });
  await assert.rejects(f.adapter().create({ referenceId: 'rollback-ref', logicalOperationId: randomUUID(), declaration: { name: 'Original schedule', schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'systemEvent', text: 'Fictional schedule' } } }), (error) => error.code === 'unknown');
  assert.equal(job?.configRevision, 'r2');
  assert.equal(job?.name, 'Later operator edit');
  assert.equal(removals, 0);
  assert.equal(f.metadata.getSourceReference('rollback-ref').externalSourceId, 'other-fictional');
});

test('ambiguous disabled Schedule creation cannot bind or enable a later declaration', async (t) => {
  let job; let enables = 0;
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.list') return { jobs: job ? [structuredClone(job)] : [] };
    if (method === 'cron.add') {
      job = { ...params, id: 'unwitnessed-schedule', name: 'Later operator edit', configRevision: 'r2' };
      throw Object.assign(new Error('Reply lost'), { code: 'timeout', ambiguous: true });
    }
    if (method === 'cron.update') { enables += 1; job = { ...job, ...params.patch, configRevision: 'r3' }; return structuredClone(job); }
    throw new Error(`Unexpected ${method}`);
  });
  const input = { referenceId: 'unwitnessed-ref', logicalOperationId: randomUUID(), declaration: { name: 'Original schedule', schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'systemEvent', text: 'Fictional schedule' } } };
  await assert.rejects(f.adapter().create(input), (error) => error.code === 'unknown');
  f.reopen();
  await assert.rejects(f.adapter().create(input), (error) => error.code === 'unknown');
  assert.equal(enables, 0);
  assert.equal(f.metadata.getSourceReference('unwitnessed-ref'), null);
});

test('Scheduler owns an immutable nested patch while the native preflight is pending', async (t) => {
  let releaseRead; let enteredRead;
  const heldRead = new Promise((resolve) => { releaseRead = resolve; });
  const entered = new Promise((resolve) => { enteredRead = resolve; });
  const f = await fixture(t, async (method, params) => {
    if (method === 'cron.get') { enteredRead(); await heldRead; return { id: 'job-fictional', configRevision: 'r1' }; }
    return { id: 'job-fictional', configRevision: 'r2', ...params.patch };
  });
  const input = { referenceId: 'schedule-ref', logicalOperationId: randomUUID(), expectedConfigRevision: 'r1', patch: { payload: { kind: 'systemEvent', text: 'Original' } } };
  const result = f.adapter().updateSchedule(input);
  try { await entered; input.patch.payload.text = 'Replacement'; }
  finally { releaseRead(); }
  assert.equal((await result).value.job.payload.text, 'Original');
});
