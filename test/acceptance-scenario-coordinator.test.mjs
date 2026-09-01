import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcceptanceScenarioCoordinator, requireBoundedMutationResponse, runAbortableAcceptanceBoundary, runBoundedAcceptanceSlice, runIsolatedAcceptanceSlices, runSequentialAcceptanceBatch, runSettledAcceptanceBatch } from '../src/acceptance-scenario-coordinator.mjs';

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

test('release fixture mutations execute sequentially with explicit concurrency one', async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const completed = [];
  const result = await runSequentialAcceptanceBatch([1, 2, 3], {
    identify: (id) => `conversation-${id}`,
    run: async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(id);
      await new Promise((resolve) => setImmediate(resolve));
      completed.push(id);
      active -= 1;
      return id * 2;
    }
  });
  assert.equal(peak, 1);
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(completed, [1, 2, 3]);
  assert.deepEqual(result, [2, 4, 6]);
});

test('cancelled sequential fixture mutation settles the active item and never starts later items', async () => {
  const controller = new AbortController();
  const started = [];
  const batch = runSequentialAcceptanceBatch([1, 2, 3], {
    signal: controller.signal,
    identify: (id) => `conversation-${id}`,
    run: async (id, _index, signal) => {
      started.push(id);
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('sequential fixture deadline'));
  await assert.rejects(batch, /sequential fixture deadline/u);
  assert.deepEqual(started, [1]);
});

test('bounded mutation rejection reports status, body keys, and code without response content', async () => {
  const privateContent = 'fictional private response detail';
  await assert.rejects(
    requireBoundedMutationResponse({ ok: false, status: 422, async json() { return { status: 'error', code: 'session-capacity', message: privateContent }; } }, 'Session fixture creation'),
    (error) => {
      assert.match(error.message, /status 422/u);
      assert.match(error.message, /code=session-capacity/u);
      assert.match(error.message, /bodyKeys=\["status","code","message"\]/u);
      assert.doesNotMatch(error.message, new RegExp(privateContent, 'u'));
      return true;
    }
  );
});

test('mutation response parsing cancels a deferred body and settles before later sequential items start', async () => {
  const controller = new AbortController();
  const started = [];
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"status":"pending"')); },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const batch = runSequentialAcceptanceBatch([1, 2], {
    signal: controller.signal,
    run: async (item, _index, signal) => {
      started.push(item);
      return requireBoundedMutationResponse(response, 'deferred mutation response', signal);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('response body deadline'));
  await assert.rejects(batch, /response body deadline/u);
  assert.equal(cancelled, true);
  assert.deepEqual(started, [1]);
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

test('a cooperatively cancelled timed-out scenario records failure and later siblings still run', async () => {
  const reached = [];
  const coordinator = createAcceptanceScenarioCoordinator({
    execute: (id, run) => runBoundedAcceptanceSlice(id, run, { timeoutMs: 5, cleanupTimeoutMs: 20 })
  });
  await coordinator.collect('timed-out-startup', async (signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    reached.push('startup-cleaned');
  });
  await coordinator.collect('later-sibling', async () => { reached.push('later-sibling'); return { passed: true }; });
  assert.deepEqual(reached, ['startup-cleaned', 'later-sibling']);
  assert.deepEqual(coordinator.failures.map(({ id }) => id), ['timed-out-startup']);
  assert.deepEqual(coordinator.result('later-sibling'), { passed: true });
});

test('the shared browser boundary closes deferred work on cancellation before a sibling starts', async () => {
  const reached = [];
  const coordinator = createAcceptanceScenarioCoordinator({
    execute: (id, run) => runBoundedAcceptanceSlice(id, (signal) => runAbortableAcceptanceBoundary(
      () => run(signal),
      { signal, onAbort: () => deferredReject(new Error('fictional browser page closed')) }
    ), { timeoutMs: 5, cleanupTimeoutMs: 20 })
  });
  let deferredReject;
  await coordinator.collect('deferred-browser-work', () => new Promise((_resolve, reject) => { deferredReject = reject; }));
  await coordinator.collect('later-browser-sibling', async () => { reached.push('later-browser-sibling'); return { passed: true }; });
  assert.deepEqual(reached, ['later-browser-sibling']);
  assert.deepEqual(coordinator.failures.map(({ id }) => id), ['deferred-browser-work']);
  assert.deepEqual(coordinator.result('later-browser-sibling'), { passed: true });
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
