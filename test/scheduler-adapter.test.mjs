import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createSchedulerAdapter } from '../src/sources/scheduler.mjs';

function metadataFixture() {
  const refs = [];
  return { refs, listSourceReferences: () => refs, createSourceReference: (reference) => { refs.push(reference); return reference; }, observeSourceReference: ({ referenceId, observedRevision }) => { const found = refs.find((reference) => reference.referenceId === referenceId); const updated = { ...found, observedRevision }; refs.splice(refs.indexOf(found), 1, updated); return updated; } };
}

test('Reminder creation is declarative and scheduler reads resolve exact job IDs', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const gateway = { request: async (method, params) => { calls.push({ method, params }); if (method === 'cron.add') return { id: 'job-fictional', configRevision: 'sha256:revision-1', declarationKey: params.declarationKey }; if (method === 'cron.get') return { id: params.id, configRevision: 'sha256:revision-1', enabled: true }; return { jobs: [] }; } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const created = await adapter.createReminder({ logicalOperationId: randomUUID(), declaration: { schedule: { kind: 'every', everyMs: 60_000 }, payload: { kind: 'systemEvent', text: 'fictional' } } });
  assert.equal(calls[0].method, 'cron.add');
  assert.match(calls[0].params.declarationKey, /^command-center:reminder:/);
  assert.equal(created.value.sourceReference.externalSourceId, 'job-fictional');
  const read = await adapter.read({ referenceId: created.value.sourceReference.referenceId });
  assert.equal(read.job.id, 'job-fictional');
  await assert.rejects(() => adapter.read({ referenceId: 'missing' }), /exact linked scheduler/i);
});

test('scheduler exposes exact-reference list, create, update, enable, and run without deletion', async () => {
  const metadata = metadataFixture();
  const revision = 'sha256:revision-1';
  const reference = { version: 1, referenceId: 'schedule-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-1', observedRevision: revision };
  metadata.refs.push(reference);
  const calls = [];
  const gateway = { request: async (method, params) => { calls.push({ method, params }); if (method === 'cron.get') return { id: 'job-1', configRevision: revision, enabled: true }; if (method === 'cron.update') return { id: 'job-1', configRevision: 'sha256:revision-2', enabled: params.patch.enabled }; } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const result = await adapter.setEnabled({ referenceId: 'schedule-ref', enabled: false, logicalOperationId: randomUUID(), expectedConfigRevision: revision });
  assert.equal(result.value.job.id, 'job-1');
  assert.equal(calls.at(-1).params.expectedConfigRevision, revision);
  assert.equal(calls.at(-1).params.patch.enabled, false);
  const listed = await adapter.list();
  assert.equal(Array.isArray(listed), true);
  assert.equal(typeof adapter.create, 'function');
  assert.equal(typeof adapter.updateSchedule, 'function');
  assert.equal(typeof adapter.run, 'function');
  assert.equal(adapter.delete, undefined);
});

test('scheduler update replay reconciles an unknown applied outcome before stale-revision fencing', async () => {
  const metadata = metadataFixture();
  metadata.refs.push({ version: 1, referenceId: 'schedule-unknown-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-unknown', observedRevision: 'revision-1' });
  let job = { id: 'job-unknown', configRevision: 'revision-1', enabled: true };
  let failReconciliationRead = false;
  let updateCalls = 0;
  const gateway = { request: async (method, params) => {
    if (method === 'cron.get') {
      if (failReconciliationRead) { failReconciliationRead = false; throw new Error('fictional reconciliation interruption'); }
      return job;
    }
    if (method === 'cron.update') {
      updateCalls += 1;
      job = { ...job, ...params.patch, configRevision: 'revision-2' };
      failReconciliationRead = true;
      const error = new Error('fictional unknown transport outcome');
      error.code = 'timeout';
      error.ambiguous = true;
      throw error;
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const logicalOperationId = randomUUID();
  const input = { referenceId: 'schedule-unknown-ref', enabled: false, expectedConfigRevision: 'revision-1', logicalOperationId };
  await assert.rejects(adapter.setEnabled(input), /fictional reconciliation interruption/);
  const replay = await adapter.setEnabled(input);
  assert.equal(replay.status, 'applied');
  assert.equal(replay.value.job.configRevision, 'revision-2');
  assert.equal(updateCalls, 1);
});

test('scheduled-operation create, general update, and run dispatch exact authoritative jobs', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.add') return { id: 'created-job', configRevision: 'revision-1', declarationKey: params.declarationKey, enabled: params.enabled };
    if (method === 'cron.get') return { id: params.id, configRevision: params.id === 'created-job' && calls.some((call) => call.method === 'cron.update') ? 'revision-2' : 'revision-1', enabled: true, name: 'before' };
    if (method === 'cron.update') return { id: params.id, configRevision: 'revision-2', ...params.patch };
    if (method === 'cron.run') return { ok: true, ran: true };
    if (method === 'cron.runs') return { entries: calls.some((call) => call.method === 'cron.run') ? [{ jobId: params.id, runId: 'created-job-run' }] : [] };
    if (method === 'cron.list') return { jobs: calls.some((call) => call.method === 'cron.add') ? [{ id: 'created-job', configRevision: 'revision-2', declarationKey: calls.find((call) => call.method === 'cron.add').params.declarationKey, enabled: true }] : [] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const createInput = {
    referenceId: 'created-schedule-reference',
    logicalOperationId: randomUUID(),
    declaration: {
      name: 'fictional',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'fictional' }
    }
  };
  const created = await adapter.create(createInput);
  const replayed = await adapter.create({ ...createInput, requestId: 'explicit-replay' });
  assert.equal(replayed.status, 'applied');
  assert.equal(calls.filter((call) => call.method === 'cron.add').length, 1);
  const referenceId = created.value.sourceReference.referenceId;
  await adapter.updateSchedule({ referenceId, expectedConfigRevision: created.value.sourceReference.observedRevision, patch: { name: 'after' }, logicalOperationId: randomUUID() });
  const run = await adapter.run({ referenceId, logicalOperationId: randomUUID() });
  assert.equal(run.status, 'applied');
  assert.deepEqual(calls.filter((call) => ['cron.add', 'cron.update', 'cron.run'].includes(call.method)).map((call) => call.method), ['cron.add', 'cron.update', 'cron.update', 'cron.run']);
  assert.equal(calls.find((call) => call.method === 'cron.run').params.id, 'created-job');
});

test('scheduler actions construct closed conservative patches and reject unrelated fields', async () => {
  const metadata = metadataFixture();
  const revision = 'sha256:revision-closed';
  metadata.refs.push({ version: 1, referenceId: 'reminder-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'reminder-job', observedRevision: revision });
  metadata.refs.push({ version: 1, referenceId: 'schedule-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'schedule-job', observedRevision: revision });
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.get') return { id: params.id, configRevision: revision, enabled: true, schedule: { kind: 'at', at: '2026-08-23T00:00:00Z' }, payload: { kind: 'systemEvent', text: 'fictional' } };
    if (method === 'cron.update') return { id: params.id, configRevision: 'sha256:next', ...params.patch };
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const common = { expectedConfigRevision: revision, logicalOperationId: randomUUID() };
  await assert.rejects(() => adapter.complete({ ...common, referenceId: 'reminder-ref', patch: { payload: { text: 'unsafe' } } }), /unsupported.*field|patch/i);
  await assert.rejects(() => adapter.setEnabled({ ...common, referenceId: 'schedule-ref', enabled: false, patch: { schedule: { kind: 'every', everyMs: 1 } } }), /unsupported.*field|patch/i);
  await assert.rejects(() => adapter.snooze({ ...common, referenceId: 'reminder-ref', patch: { payload: { text: 'unsafe' } } }), /unsupported.*patch|field/i);
  await assert.rejects(() => adapter.reschedule({ ...common, referenceId: 'schedule-ref', patch: { enabled: false } }), /unsupported.*patch|field/i);

  await adapter.complete({ ...common, referenceId: 'reminder-ref' });
  assert.deepEqual(calls.at(-1).params.patch, { enabled: false });
  await adapter.setEnabled({ ...common, logicalOperationId: randomUUID(), referenceId: 'schedule-ref', enabled: false });
  assert.deepEqual(calls.at(-1).params.patch, { enabled: false });
  await adapter.setEnabled({ ...common, logicalOperationId: randomUUID(), referenceId: 'reminder-ref', enabled: false });
  assert.equal(calls.at(-1).params.id, 'reminder-job');
  assert.deepEqual(calls.at(-1).params.patch, { enabled: false });
  const schedule = { kind: 'at', at: '2026-08-24T00:00:00Z' };
  await adapter.snooze({ ...common, logicalOperationId: randomUUID(), referenceId: 'reminder-ref', patch: { schedule } });
  assert.deepEqual(calls.at(-1).params.patch, { schedule });
  await adapter.reschedule({ ...common, logicalOperationId: randomUUID(), referenceId: 'schedule-ref', patch: { schedule } });
  assert.deepEqual(calls.at(-1).params.patch, { schedule });
});

test('scheduler adapters reject nested path and URL provider inputs before dispatch', async () => {
  const metadata = metadataFixture();
  let calls = 0;
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway: { request: async () => { calls += 1; return {}; } } });
  await assert.rejects(() => adapter.create({ referenceId: 'schedule:new', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' }, path: '/fictional/private' } }), /unsupported/i);
  await assert.rejects(() => adapter.create({ referenceId: 'schedule:new', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'at', at: '2026-08-23T00:00:00Z' }, payload: { kind: 'systemEvent', text: 'fictional', url: 'https://fictional.invalid' } } }), /unsupported/i);
  assert.equal(calls, 0);
});

test('revision-less scheduler creation and reconciliation never persist a Source Reference', async () => {
  for (const ambiguous of [false, true]) {
    const metadata = metadataFixture();
    let declarationKey;
    const gateway = { request: async (method, params) => {
      if (method === 'cron.list') return { jobs: declarationKey ? [{ id: 'job-without-revision', declarationKey, enabled: false }] : [] };
      if (method === 'cron.add') {
        declarationKey = params.declarationKey;
        if (ambiguous) { const error = new Error('ambiguous'); error.code = 'timeout'; error.ambiguous = true; throw error; }
        return { id: 'job-without-revision', declarationKey, enabled: params.enabled };
      }
      if (method === 'cron.remove') return { removed: true, id: params.id };
      throw new Error(`Unexpected method ${method}`);
    } };
    const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
    await assert.rejects(() => adapter.create({ referenceId: `schedule:no-revision:${ambiguous}`, logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }), /configRevision|unknown|identity.*bound/i);
    assert.equal(metadata.refs.length, 0);
  }
});

test('scheduled-operation create removes its disabled job when durable binding fails', async () => {
  const refs = [];
  const metadata = {
    listSourceReferences: () => refs,
    getSourceReference: (referenceId) => refs.find((reference) => reference.referenceId === referenceId) ?? null,
    createSourceReference: () => { throw new Error('fictional metadata failure'); }
  };
  const calls = [];
  const jobs = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [...jobs] };
    if (method === 'cron.add') {
      const job = { id: 'disabled-candidate', configRevision: 'revision-disabled', declarationKey: params.declarationKey, enabled: params.enabled };
      jobs.push(job);
      return { created: true, job };
    }
    if (method === 'cron.remove') {
      const index = jobs.findIndex((job) => job.id === params.id);
      if (index !== -1) jobs.splice(index, 1);
      return { removed: true, id: params.id };
    }
    if (method === 'cron.update') throw new Error('must not enable an unbound schedule');
    throw new Error(`Unexpected method ${method}`);
  } };
  const coordinator = { mutate: async ({ execute }) => ({ status: 'applied', value: await execute({ requestId: 'create-request' }) }) };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway, coordinator });
  await assert.rejects(() => adapter.create({ referenceId: 'schedule:metadata-failure', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }), /metadata failure/i);
  assert.equal(calls.find((call) => call.method === 'cron.add').params.enabled, false);
  assert.equal(calls.filter((call) => call.method === 'cron.update').length, 0);
  assert.deepEqual(jobs, []);
  assert.deepEqual(calls.find((call) => call.method === 'cron.remove').params, { id: 'disabled-candidate' });
});

test('scheduled-operation create never removes a converged created:false declaration', async () => {
  const metadata = {
    ...metadataFixture(),
    createSourceReference: () => { throw new Error('fictional metadata failure'); }
  };
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [] };
    if (method === 'cron.add') return { created: false, job: { id: 'existing-unbound', configRevision: 'revision-existing', declarationKey: params.declarationKey, enabled: false } };
    if (method === 'cron.remove') throw new Error('must not remove a converged declaration');
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  await assert.rejects(
    () => adapter.create({ referenceId: 'schedule:converged', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }),
    /metadata failure/i
  );
  assert.equal(calls.some((call) => call.method === 'cron.remove'), false);
});

test('scheduled-operation create never removes an unproven incompatible cron.add result', async () => {
  const metadata = metadataFixture();
  const jobs = [];
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [...jobs] };
    if (method === 'cron.add') {
      const job = { id: 'incompatible-candidate', configRevision: 'revision-unsafe', declarationKey: params.declarationKey, enabled: true };
      jobs.push(job);
      return job;
    }
    if (method === 'cron.remove') {
      jobs.splice(0, jobs.length);
      return { removed: true, id: params.id };
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  await assert.rejects(
    () => adapter.create({ referenceId: 'schedule:incompatible', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }),
    /disabled/i
  );
  assert.equal(jobs.length, 1);
  assert.equal(calls.some((call) => call.method === 'cron.remove'), false);
  assert.equal(metadata.refs.length, 0);
});

test('scheduled-operation create never removes a cron.add identity owned by another Topic', async () => {
  const foreignReference = { version: 1, referenceId: 'schedule:foreign', topicId: 'topic-foreign', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-foreign', observedRevision: 'revision-foreign' };
  const references = [foreignReference];
  const metadata = {
    listSourceReferences: (topicId) => topicId ? references.filter((reference) => reference.topicId === topicId) : references,
    getSourceReference: (referenceId) => references.find((reference) => reference.referenceId === referenceId) ?? null,
    createSourceReference: () => { throw new Error('global authoritative identity collision'); }
  };
  const calls = [];
  const logicalOperationId = randomUUID();
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [] };
    if (method === 'cron.add') return { id: foreignReference.externalSourceId, configRevision: foreignReference.observedRevision, declarationKey: params.declarationKey, enabled: false };
    if (method === 'cron.remove') throw new Error('must not remove a foreign job');
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  await assert.rejects(
    () => adapter.create({ referenceId: 'schedule:requested', logicalOperationId, declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }),
    (error) => error.code === 'conflict'
  );
  assert.equal(calls.filter((call) => call.method === 'cron.add').length, 1);
  assert.equal(calls.some((call) => call.method === 'cron.remove'), false);
  assert.equal(metadata.getSourceReference(foreignReference.referenceId), foreignReference);
});

test('scheduled-operation rollback rechecks ownership after metadata persistence races', async () => {
  const references = [];
  const metadata = {
    listSourceReferences: (topicId) => topicId ? references.filter((reference) => reference.topicId === topicId) : references,
    getSourceReference: (referenceId) => references.find((reference) => reference.referenceId === referenceId) ?? null,
    createSourceReference: (reference) => {
      references.push({ ...reference, referenceId: 'schedule:racing-foreign', topicId: 'topic-foreign' });
      throw new Error('fictional metadata race');
    }
  };
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [] };
    if (method === 'cron.add') return { created: true, job: { id: 'job-racing', configRevision: 'revision-racing', declarationKey: params.declarationKey, enabled: false } };
    if (method === 'cron.remove') throw new Error('must not remove a newly foreign-owned job');
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  await assert.rejects(
    () => adapter.create({ referenceId: 'schedule:racing-request', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }),
    /metadata race/i
  );
  assert.equal(calls.some((call) => call.method === 'cron.remove'), false);
  assert.equal(references[0].topicId, 'topic-foreign');
  assert.equal(references[0].externalSourceId, 'job-racing');
});

test('concurrent creates sharing a reference ID leave only the bound schedule enabled', async () => {
  const refs = [];
  const metadata = {
    listSourceReferences: () => refs,
    getSourceReference: (referenceId) => refs.find((reference) => reference.referenceId === referenceId) ?? null,
    createSourceReference: (reference) => {
      if (refs.some((item) => item.referenceId === reference.referenceId)) throw new Error('duplicate reference identity');
      refs.push(reference);
      return reference;
    },
    observeSourceReference: ({ referenceId, observedRevision }) => {
      const index = refs.findIndex((reference) => reference.referenceId === referenceId);
      refs[index] = { ...refs[index], observedRevision };
      return refs[index];
    }
  };
  const jobs = [];
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [...jobs] };
    if (method === 'cron.add') {
      const job = { id: `job-${jobs.length + 1}`, configRevision: `revision-${jobs.length + 1}`, declarationKey: params.declarationKey, enabled: params.enabled };
      jobs.push(job);
      return job;
    }
    if (method === 'cron.update') {
      const index = jobs.findIndex((job) => job.id === params.id);
      jobs[index] = { ...jobs[index], ...params.patch, configRevision: `${params.expectedConfigRevision}:enabled` };
      return jobs[index];
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  const coordinator = { mutate: async ({ execute }) => ({ status: 'applied', value: await execute({ requestId: randomUUID() }) }) };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway, coordinator });
  const secondAdapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway, coordinator });
  const declaration = { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } };
  const results = await Promise.allSettled([
    adapter.create({ referenceId: 'schedule:shared', logicalOperationId: randomUUID(), declaration }),
    secondAdapter.create({ referenceId: 'schedule:shared', logicalOperationId: randomUUID(), declaration })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(calls.filter((call) => call.method === 'cron.add').every((call) => call.params.enabled === false), true);
  const enables = calls.filter((call) => call.method === 'cron.update' && call.params.patch.enabled === true);
  assert.equal(enables.length, 1);
  assert.equal(enables[0].params.id, refs[0].externalSourceId);
  assert.equal(jobs.find((job) => job.id === refs[0].externalSourceId).enabled, true);
  assert.equal(calls.filter((call) => call.method === 'cron.add').length, 1);
});

test('ambiguous create never adopts an enabled declaration without an exact prior binding', async () => {
  const metadata = metadataFixture();
  let dispatched = false;
  let declarationKey;
  const gateway = { request: async (method, params) => {
    if (method === 'cron.add') {
      dispatched = true;
      declarationKey = params.declarationKey;
      const error = new Error('ambiguous');
      error.code = 'timeout';
      error.ambiguous = true;
      throw error;
    }
    if (method === 'cron.list') return { jobs: dispatched ? [{ id: 'enabled-orphan', declarationKey, configRevision: 'revision-enabled', enabled: true }] : [] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const logicalOperationId = randomUUID();
  await assert.rejects(() => adapter.create({ referenceId: 'schedule:enabled-orphan', logicalOperationId, declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }), /conflict/i);
  assert.equal(metadata.refs.length, 0);
});

test('ambiguous disabled create never enables a job bound under another reference', async () => {
  const metadata = metadataFixture();
  metadata.refs.push({ version: 1, referenceId: 'schedule:other-binding', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-other-binding', observedRevision: 'revision-disabled' });
  let dispatched = false;
  let declarationKey;
  let updates = 0;
  const gateway = { request: async (method, params) => {
    if (method === 'cron.add') {
      dispatched = true;
      declarationKey = params.declarationKey;
      const error = new Error('ambiguous');
      error.code = 'timeout';
      error.ambiguous = true;
      throw error;
    }
    if (method === 'cron.list') return { jobs: dispatched ? [{ id: 'job-other-binding', declarationKey, configRevision: 'revision-disabled', enabled: false }] : [] };
    if (method === 'cron.update') { updates += 1; return {}; }
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  await assert.rejects(() => adapter.create({ referenceId: 'schedule:requested-binding', logicalOperationId: randomUUID(), declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }), /conflict/i);
  assert.equal(updates, 0);
  assert.equal(metadata.refs.some((reference) => reference.referenceId === 'schedule:requested-binding'), false);
});

test('scheduled create fingerprint binds the requested reference before redispatch', async () => {
  const metadata = metadataFixture();
  const jobs = [];
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [...jobs] };
    if (method === 'cron.add') {
      const job = { id: 'job-fingerprint', declarationKey: params.declarationKey, configRevision: 'revision-disabled', enabled: false };
      jobs.push(job);
      return job;
    }
    if (method === 'cron.update') {
      jobs[0] = { ...jobs[0], enabled: true, configRevision: 'revision-enabled' };
      return jobs[0];
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const logicalOperationId = randomUUID();
  const declaration = { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } };
  await adapter.create({ referenceId: 'schedule:fingerprint-a', logicalOperationId, declaration });
  const before = calls.length;
  await assert.rejects(() => adapter.create({ referenceId: 'schedule:fingerprint-b', logicalOperationId, declaration }), /different intent|intent.*mismatch/i);
  assert.equal(calls.length, before);
});

test('applied scheduled create replay observes a later disabled state without re-enabling', async () => {
  const metadata = metadataFixture();
  const jobs = [];
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.list') return { jobs: [...jobs] };
    if (method === 'cron.add') {
      const job = { id: 'job-applied-replay', declarationKey: params.declarationKey, configRevision: 'revision-disabled', enabled: false };
      jobs.push(job);
      return job;
    }
    if (method === 'cron.update') {
      jobs[0] = { ...jobs[0], enabled: params.patch.enabled, configRevision: params.patch.enabled ? 'revision-enabled' : 'revision-later-disabled' };
      return jobs[0];
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const logicalOperationId = randomUUID();
  const input = { referenceId: 'schedule:applied-replay', logicalOperationId, declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } };
  await adapter.create(input);
  jobs[0] = { ...jobs[0], enabled: false, configRevision: 'revision-later-disabled' };
  const updatesBeforeReplay = calls.filter((call) => call.method === 'cron.update').length;
  const replay = await adapter.create({ ...input, requestId: 'replay-request' });
  assert.equal(replay.value.job.enabled, false);
  assert.equal(calls.filter((call) => call.method === 'cron.update').length, updatesBeforeReplay);
  assert.equal(jobs[0].enabled, false);
});

test('a validated cron.update revision is durable after metadata reopen', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-scheduler-reopen-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId: 'topic-scheduler-reopen', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({
      version: 1,
      referenceId: 'schedule-reopen-ref',
      topicId: 'topic-scheduler-reopen',
      sourceSystem: 'scheduler',
      sourceKind: 'schedule',
      externalSourceId: 'job-reopen',
      observedRevision: 'revision-1'
    });
    const gateway = { request: async (method, params) => {
      if (method === 'cron.get') return { id: 'job-reopen', configRevision: 'revision-1', enabled: true };
      if (method === 'cron.update') return { id: params.id, configRevision: 'revision-2', enabled: params.patch.enabled };
      throw new Error(`Unexpected method ${method}`);
    } };
    const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler-reopen', metadata, gateway });
    await adapter.setEnabled({ referenceId: 'schedule-reopen-ref', enabled: false, expectedConfigRevision: 'revision-1', logicalOperationId: randomUUID() });
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    assert.equal(metadata.getSourceReference('schedule-reopen-ref').observedRevision, 'revision-2');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('scheduler list observations persist current revisions across metadata reopen', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-scheduler-list-reopen-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    metadata.createTopic({ topicId: 'topic-scheduler-list', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({
      version: 1,
      referenceId: 'schedule-list-ref',
      topicId: 'topic-scheduler-list',
      sourceSystem: 'scheduler',
      sourceKind: 'schedule',
      externalSourceId: 'job-list',
      observedRevision: 'revision-old'
    });
    const gateway = { request: async (method) => {
      if (method === 'cron.list') return { jobs: [{ id: 'job-list', configRevision: 'revision-current', enabled: true }] };
      throw new Error(`Unexpected method ${method}`);
    } };
    const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler-list', metadata, gateway });
    const [listed] = await adapter.list();
    assert.equal(listed.sourceReference.observedRevision, 'revision-current');
    gateway.request = async (method) => {
      if (method === 'cron.list') return { jobs: [{ id: 'job-list', enabled: true }] };
      throw new Error(`Unexpected method ${method}`);
    };
    const [withoutRevision] = await adapter.list();
    assert.equal(withoutRevision.sourceReference.observedRevision, 'revision-current');
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
    assert.equal(metadata.getSourceReference('schedule-list-ref').observedRevision, 'revision-current');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('scheduler read retains a known revision and update rejects a revision-less response', async () => {
  const metadata = metadataFixture();
  metadata.refs.push({ version: 1, referenceId: 'schedule-revision-ref', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-revision', observedRevision: 'revision-known' });
  let update = false;
  const gateway = { request: async (method, params) => {
    if (method === 'cron.get') return { id: params.id, enabled: true };
    if (method === 'cron.update') { update = true; return { id: params.id, enabled: params.patch.enabled }; }
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  const read = await adapter.read({ referenceId: 'schedule-revision-ref' });
  assert.equal(read.sourceReference.observedRevision, 'revision-known');
  await assert.rejects(() => adapter.setEnabled({ referenceId: 'schedule-revision-ref', expectedConfigRevision: 'revision-known', enabled: false, logicalOperationId: randomUUID() }), /omitted.*revision/i);
  assert.equal(update, true);
  assert.equal(metadata.refs.find((reference) => reference.referenceId === 'schedule-revision-ref').observedRevision, 'revision-known');
});

test('applied scheduled run replay resolves its authoritative run receipt without redispatch', async () => {
  const metadata = metadataFixture();
  metadata.refs.push({ version: 1, referenceId: 'schedule-run-replay', topicId: 'topic-scheduler', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'job-run-replay', observedRevision: 'revision-1' });
  const operationId = randomUUID();
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'cron.get') return { id: params.id, configRevision: 'revision-1', enabled: true };
    if (method === 'cron.run') return { ok: true, ran: true };
    if (method === 'cron.runs') return { entries: calls.some((call) => call.method === 'cron.run') ? [{ jobId: params.id, runId: 'authoritative-run-receipt', status: 'ok' }] : [] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSchedulerAdapter({ topicId: 'topic-scheduler', metadata, gateway });
  await adapter.run({ referenceId: 'schedule-run-replay', logicalOperationId: operationId, requestId: 'run-first' });
  const replay = await adapter.run({ referenceId: 'schedule-run-replay', logicalOperationId: operationId, requestId: 'run-replay' });
  assert.equal(replay.value.runId, 'authoritative-run-receipt');
  assert.equal(calls.filter((call) => call.method === 'cron.run').length, 1);
  assert.equal(calls.filter((call) => call.method === 'cron.runs').length, 3);
  assert.equal(calls.filter((call) => call.method === 'cron.get').length, 1);
});
