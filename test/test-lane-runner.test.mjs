import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestLanes } from '../scripts/test-lanes.mjs';

const files = ['test/migration-recovery.test.mjs', 'test/first-live-native-ui.test.mjs'];
test('preflight retains both lane failures and the inherited test runtime environment', () => {
  const env = { FICTIONAL_RUNTIME: 'bound' };
  const observed = [];
  const result = runTestLanes(files, { env, collectFailures: true, execute: (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.equal(options.env, env);
    observed.push(args);
    return { status: observed.length === 1 ? 2 : 3 };
  } });
  assert.equal(result.status, 2);
  assert.deepEqual(result.outcomes, [{ id: 'parallel', status: 'failed', exitCode: 2 }, { id: 'browser', status: 'failed', exitCode: 3 }]);
  assert.equal(observed.length, 2);
  assert.ok(observed[1].includes('--test-concurrency=1'));
});

test('normal qualification keeps fail-fast behavior and original exit status', () => {
  let calls = 0;
  const result = runTestLanes(files, { env: {}, execute: () => { calls += 1; return { status: 7 }; } });
  assert.equal(result.status, 7);
  assert.equal(calls, 1);
});

test('preflight observes the browser lane after a child launch error and cannot report success', () => {
  const failure = new Error('Fictional launch failure');
  let calls = 0;
  const result = runTestLanes(files, { env: {}, collectFailures: true, execute: () => {
    calls += 1;
    return calls === 1 ? { error: failure, status: null } : { status: 0 };
  } });
  assert.equal(result.status, 1);
  assert.equal(result.error, failure);
  assert.deepEqual(result.outcomes.map(row => row.status), ['failed', 'passed']);
});

test('only clean child exits produce passing lane evidence', () => {
  assert.equal(runTestLanes(files, { env: {}, execute: () => ({ status: 0 }) }).status, 0);
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('spawn error') }]) {
    assert.equal(runTestLanes(files, { env: {}, execute: () => result }).outcomes[0].status, 'failed');
  }
  assert.throws(() => runTestLanes([], { env: {} }), /at least one/u);
});
