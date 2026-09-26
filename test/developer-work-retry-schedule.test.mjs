import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEVELOPER_WORK_RETRY_SCHEDULE_KEY, developerWorkRetryDeclaration, reconcileDeveloperWorkRetrySchedule } from '../src/developer-work/retry-schedule.mjs';
import { developerWorkFlushToolFactory } from '../src/developer-work/flush-tool.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';

function schedulerFixture() {
  const jobs = [];
  const calls = [];
  const scheduler = {
    async list(options) { calls.push(['list', options]); return structuredClone(jobs); },
    async add(input) { calls.push(['add', input]); const job = { ...structuredClone(input), id: 'dev-retry-job' }; jobs.push(job); return job; },
    async update(id, patch) { calls.push(['update', id, patch]); const job = jobs.find(row => row.id === id); Object.assign(job, structuredClone(patch)); return structuredClone(job); }
  };
  return { scheduler, jobs, calls };
}

test('DEV outbox retry uses one quiet native Cron declaration and converges without duplicate jobs', async () => {
  const fixture = schedulerFixture();
  const first = await reconcileDeveloperWorkRetrySchedule({ scheduler: fixture.scheduler });
  assert.equal(first.job.declarationKey, DEVELOPER_WORK_RETRY_SCHEDULE_KEY);
  assert.equal(first.declaration.schedule.expr, '*/5 * * * *');
  assert.deepEqual(first.declaration.payload.toolsAllow, ['command_center_flush_developer_work']);
  assert.equal(first.declaration.delivery.mode, 'none');
  const second = await reconcileDeveloperWorkRetrySchedule({ scheduler: fixture.scheduler });
  assert.equal(second.job.id, first.job.id);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'add').length, 1);
  fixture.jobs[0].enabled = false;
  const repaired = await reconcileDeveloperWorkRetrySchedule({ scheduler: fixture.scheduler });
  assert.equal(repaired.job.enabled, true);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'update').length, 1);
});

test('lost native add reply is reconciled from the authoritative declaration identity', async () => {
  const fixture = schedulerFixture();
  const add = fixture.scheduler.add;
  let loseReply = true;
  fixture.scheduler.add = async input => {
    const result = await add(input);
    if (loseReply) { loseReply = false; throw new Error('lost add reply'); }
    return result;
  };
  await assert.rejects(() => reconcileDeveloperWorkRetrySchedule({ scheduler: fixture.scheduler }), /lost add reply/u);
  const recovered = await reconcileDeveloperWorkRetrySchedule({ scheduler: fixture.scheduler });
  assert.equal(recovered.job.id, 'dev-retry-job');
  assert.equal(fixture.calls.filter(([kind]) => kind === 'add').length, 1);
});

test('competing or missing native schedule authority fails closed', async () => {
  const fixture = schedulerFixture();
  fixture.jobs.push({ ...developerWorkRetryDeclaration(), id: 'one' }, { ...developerWorkRetryDeclaration(), id: 'two' });
  await assert.rejects(() => reconcileDeveloperWorkRetrySchedule({ scheduler: fixture.scheduler }), { code: 'conflict' });
  await assert.rejects(() => reconcileDeveloperWorkRetrySchedule({}), /native Cron service/u);
});

test('retry tool only flushes previously recorded work', async () => {
  let calls = 0;
  const result = { delivered: 1, attempted: 1, pending: 0 };
  const tool = developerWorkFlushToolFactory({ getOwner: () => ({ flush: async () => { calls++; return result; } }) })();
  assert.deepEqual((await tool.execute('cron-run-1', {})).details, result);
  await assert.rejects(() => tool.execute('cron-run-2', { workId: 'new-work' }), { code: 'invalid-request' });
  assert.equal(calls, 1);
});

test('explicit DEV producer startup binds its durable outbox to the native Cron owner', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-dev-retry-startup-'));
  const fixture = schedulerFixture();
  const api = {
    runtime: { state: { resolveStateDir: () => stateDir }, agent: { session: { getSessionEntry: () => undefined } } },
    logger: {}, pluginConfig: { developerWorkProducer: {
      enabled: true, producerId: 'sample-dev', allowedProjects: ['sample-project'], allowedAgentIds: ['sample-agent'],
      receiverBaseUrl: 'https://live.example.test', tokenEnv: 'SAMPLE_DEV_BEARER'
    } }
  };
  const service = createMetadataService(api);
  try {
    await service.start({ getCron: () => fixture.scheduler });
    assert.ok(service.developerWorkProducer);
    assert.equal(fixture.jobs.length, 1);
    assert.equal(fixture.jobs[0].declarationKey, DEVELOPER_WORK_RETRY_SCHEDULE_KEY);
  } finally {
    await service.stop();
    if (path.dirname(stateDir) !== os.tmpdir() || !path.basename(stateDir).startsWith('cc-dev-retry-startup-')) throw new Error('Refusing unsafe test cleanup path');
    await rm(stateDir, { recursive: true, force: true });
  }
});
