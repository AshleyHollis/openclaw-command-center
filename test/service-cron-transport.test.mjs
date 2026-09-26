import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderServiceCronTransport } from '../src/open-loops/service-cron-transport.mjs';

test('service Reminder transport uses the current revision-bearing Cron handle', async () => {
  const calls = [];
  const job = { id: 'reminder-1', enabled: true, configRevision: 'sha256:before' };
  const cron = {
    getWithRevision: async id => id === job.id ? { ...job } : undefined,
    add: async input => { calls.push(['add', input.id]); return { id: input.id }; },
    updateWithRevision: async (id, patch, revision) => {
      calls.push(['update', id, revision]);
      assert.equal(revision, job.configRevision);
      Object.assign(job, patch, { configRevision: 'sha256:after' });
      return { ...job };
    }
  };
  const transport = createReminderServiceCronTransport({ getCron: () => cron, assertCurrent() {} });
  assert.deepEqual(await transport.request('cron.get', { id: job.id }), job);
  await assert.rejects(transport.request('cron.list', { includeDisabled: true }), { code: 'capability-unavailable' });
  assert.deepEqual(await transport.request('cron.add', { id: job.id }), job);
  assert.equal((await transport.request('cron.update', { id: job.id, patch: { enabled: false },
    expectedConfigRevision: 'sha256:before' })).enabled, false);
  assert.deepEqual(calls, [['add', job.id], ['update', job.id, 'sha256:before']]);
});

test('service Reminder transport fails closed without a current supported service handle', async () => {
  let active = true;
  const transport = createReminderServiceCronTransport({ getCron: () => ({}),
    assertCurrent() { if (!active) throw Object.assign(new Error('retired'), { code: 'capability-unavailable' }); } });
  await assert.rejects(transport.request('cron.get', { id: 'reminder-1' }), { code: 'capability-unavailable' });
  active = false;
  await assert.rejects(transport.request('cron.update', { id: 'reminder-1', patch: { enabled: false },
    expectedConfigRevision: 'sha256:before' }), { code: 'capability-unavailable' });
});

test('service Reminder transport rejects a scheduler replacement during a read', async () => {
  let release;
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const first = { getWithRevision: async () => { entered(); await waiting; return { id: 'reminder-1', configRevision: 'sha256:old' }; },
    updateWithRevision() {} };
  const second = { getWithRevision: async () => undefined, updateWithRevision() {} };
  let current = first;
  const transport = createReminderServiceCronTransport({ getCron: () => current, assertCurrent() {} });
  const pending = transport.request('cron.get', { id: 'reminder-1' });
  await reading;
  current = second;
  release();
  await assert.rejects(pending, { code: 'capability-unavailable' });
});
