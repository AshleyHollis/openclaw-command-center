import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { stopFixtureProcessTree, waitForFixtureClose, verifyFixtureGroupStopped } from './support/fixture-process-owner.mjs';

test('fixture cleanup closes inherited streams after the process-group leader exits', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    descendant.once('spawn', () => process.exit(0));
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let timer;
  try {
    assert.equal(await exited, 0);
    stopFixtureProcessTree(child);
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned descendant kept fixture streams open after leader exit')), 1000); })]);
  } finally {
    clearTimeout(timer);
    // The regression owns this exact group even while the old helper is broken.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await closed;
  }
});

test('fixture deadline terminates and joins a stalled child before rejecting', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  const rescue = setTimeout(() => stopFixtureProcessTree(child), 1000);
  try {
    await assert.rejects(waitForFixtureClose(child, { timeoutMs: 100 }), /timed out/);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    await verifyFixtureGroupStopped(child);
  } finally {
    clearTimeout(rescue);
    stopFixtureProcessTree(child);
    await closed;
  }
});

test('fixture cancellation closes its owned child before returning', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const cancellation = new AbortController();
  const completion = waitForFixtureClose(child, { signal: cancellation.signal });
  cancellation.abort(new Error('Requested fixture cancellation'));
  await assert.rejects(completion, /Requested fixture cancellation/);
  assert.equal(child.signalCode, 'SIGKILL');
  await verifyFixtureGroupStopped(child);
});
