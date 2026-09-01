import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcceptanceScenarioCoordinator, runSettledAcceptanceBatch } from '../src/acceptance-scenario-coordinator.mjs';

test('scenario coordinator records an early failure and still completes later independent siblings', async () => {
  const progress = [];
  const reached = [];
  const sharedFixture = {};
  const coordinator = createAcceptanceScenarioCoordinator({
    execute: async (_id, run) => run(),
    onProgress: (event) => progress.push(event)
  });

  await coordinator.collect('startup-activity', async () => {
    reached.push('startup-activity');
    sharedFixture.verifiedActivity = { activityId: 'activity-fictional', referenceId: 'reference-fictional' };
    throw new Error('authoritative readback failed after durable fixture publication');
  });
  await coordinator.collect('mount-bootstrap', async () => {
    reached.push('mount-bootstrap');
    return { mounted: true };
  });
  await coordinator.collect('downstream-release', async () => {
    reached.push('downstream-release');
    assert.deepEqual(sharedFixture.verifiedActivity, { activityId: 'activity-fictional', referenceId: 'reference-fictional' });
    return { assertionsCompleted: true, activityId: sharedFixture.verifiedActivity.activityId };
  });

  assert.deepEqual(reached, ['startup-activity', 'mount-bootstrap', 'downstream-release']);
  assert.deepEqual(coordinator.result('mount-bootstrap'), { mounted: true });
  assert.deepEqual(coordinator.result('downstream-release'), { assertionsCompleted: true, activityId: 'activity-fictional' });
  assert.deepEqual(coordinator.failures.map(({ id, error }) => ({ id, message: error.message })), [
    { id: 'startup-activity', message: 'authoritative readback failed after durable fixture publication' }
  ]);
  assert.deepEqual(progress, [
    { id: 'startup-activity', status: 'started' },
    { id: 'startup-activity', status: 'failed' },
    { id: 'mount-bootstrap', status: 'started' },
    { id: 'mount-bootstrap', status: 'passed' },
    { id: 'downstream-release', status: 'started' },
    { id: 'downstream-release', status: 'passed' }
  ]);
});

test('scenario coordinator rejects missing completion evidence', async () => {
  const coordinator = createAcceptanceScenarioCoordinator({ execute: async () => undefined });
  await coordinator.collect('empty-boundary', async () => ({ ignored: true }));

  assert.equal(coordinator.failures.length, 1);
  assert.throws(() => coordinator.result('empty-boundary'), /no completion evidence/iu);
});

test('mutation batches wait for every concurrent operation before reporting bounded failures', async () => {
  const releases = new Map();
  const completed = [];
  const operations = ['first', 'second', 'third'];
  const batch = runSettledAcceptanceBatch(operations, {
    identify: (id) => id,
    run: (id) => new Promise((resolve, reject) => releases.set(id, () => {
      completed.push(id);
      if (id === 'first') reject(new Error(`rejected ${'x'.repeat(500)}`));
      else resolve(id);
    }))
  });

  await new Promise((resolve) => setImmediate(resolve));
  releases.get('first')();
  releases.get('third')();
  releases.get('second')();
  await assert.rejects(batch, (error) => {
    assert.deepEqual(completed, ['first', 'third', 'second']);
    assert.equal(error.failures.length, 1);
    assert.equal(error.failures[0].id, 'first');
    assert.ok(error.failures[0].error.length <= 300);
    return true;
  });
});
