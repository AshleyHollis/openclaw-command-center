import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcceptanceScenarioCoordinator } from '../src/acceptance-scenario-coordinator.mjs';

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
