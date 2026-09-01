import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcceptanceScenarioCoordinator, runBoundedAcceptanceSlice, runIsolatedAcceptanceSlices, runSettledAcceptanceBatch } from '../src/acceptance-scenario-coordinator.mjs';

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

test('bounded slices cancel and await cleanup below the controller inactivity boundary', async () => {
  let cleaned = false;
  await assert.rejects(() => runBoundedAcceptanceSlice('stalled', async (signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    cleaned = true;
  }, { timeoutMs: 5, cleanupTimeoutMs: 20 }), /exceeded its 5 ms deadline/u);
  assert.equal(cleaned, true);
  await assert.rejects(() => runBoundedAcceptanceSlice('invalid-bound', async () => {}, { timeoutMs: 290_000, cleanupTimeoutMs: 10_000 }), /below the controller inactivity timeout/u);
});

test('two isolated lanes interleave reversed completion and continue after an earlier failure', async () => {
  const releases = new Map();
  const started = [];
  const completed = [];
  const run = runIsolatedAcceptanceSlices([
    { id: 'lane-a-first', run: () => new Promise((_resolve, reject) => releases.set('lane-a-first', () => { completed.push('lane-a-first'); reject(new Error('fictional first failure')); })) },
    { id: 'lane-b-first', run: () => new Promise((resolve) => releases.set('lane-b-first', () => { completed.push('lane-b-first'); resolve({ lane: 'b' }); })) },
    { id: 'lane-a-later', run: async () => { completed.push('lane-a-later'); return { later: true }; } },
    { id: 'lane-b-later', run: async () => { completed.push('lane-b-later'); return { later: true }; } }
  ], { maxConcurrency: 2, timeoutMs: 100, cleanupTimeoutMs: 20, onProgress: (event) => { if (event.status === 'started') started.push(event.id); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['lane-a-first', 'lane-b-first']);
  releases.get('lane-b-first')();
  await new Promise((resolve) => setImmediate(resolve));
  releases.get('lane-a-first')();
  const outcome = await run;
  assert.ok(completed.indexOf('lane-b-first') < completed.indexOf('lane-a-first'), 'the second lane must be able to complete before the first lane');
  assert.deepEqual(new Set(completed), new Set(['lane-a-first', 'lane-b-first', 'lane-a-later', 'lane-b-later']));
  assert.deepEqual(outcome.failures.map(({ id }) => id), ['lane-a-first']);
  assert.deepEqual(outcome.results.get('lane-b-first'), { lane: 'b' });
  assert.deepEqual(outcome.results.get('lane-a-later'), { later: true });
  assert.deepEqual(outcome.results.get('lane-b-later'), { later: true });
});

test('an uncooperative cancelled slice is fatal and no later sibling starts', async () => {
  const started = [];
  const outcome = runIsolatedAcceptanceSlices([
    { id: 'uncooperative', run: () => new Promise(() => {}) },
    { id: 'other-active-lane', run: () => new Promise(() => {}) },
    { id: 'must-not-start-a', run: async () => ({ reached: true }) },
    { id: 'must-not-start-b', run: async () => ({ reached: true }) }
  ], { maxConcurrency: 2, timeoutMs: 5, cleanupTimeoutMs: 5, onProgress: (event) => { if (event.status === 'started') started.push(event.id); } });
  const result = await outcome;
  assert.deepEqual(started, ['uncooperative', 'other-active-lane']);
  assert.equal(result.failures[0].error.fatalAcceptanceCleanup, true);
  assert.equal(result.results.has('must-not-start-a'), false);
  assert.equal(result.results.has('must-not-start-b'), false);
});
