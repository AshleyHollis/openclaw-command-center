import { spawnSync } from 'node:child_process';
import { ordinaryTestLanes } from '../src/test-selection.mjs';

// Shared process owner: ordinary qualification fails fast; preflight collects
// both independent lanes without changing their concurrency or SDK environment.
export function runTestLanes(files, { env, collectFailures = false, execute = spawnSync } = {}) {
  if (typeof collectFailures !== 'boolean') throw new TypeError('collectFailures must be boolean');
  const lanes = ordinaryTestLanes(files);
  if (lanes.length === 0) throw new Error('at least one test lane is required');
  const outcomes = [];
  let status = 0;
  let error;
  for (const lane of lanes) {
    let result;
    try { result = execute(process.execPath, lane.argv, { stdio: 'inherit', env }); }
    catch (failure) { result = { error: failure }; }
    const passed = !result?.error && result?.status === 0 && !result?.signal;
    const exitCode = passed ? 0 : Number.isInteger(result?.status) && result.status > 0 ? result.status : 1;
    outcomes.push(Object.freeze({ id: lane.id, status: passed ? 'passed' : 'failed', exitCode }));
    if (!passed) {
      status ||= exitCode;
      error ??= result?.error;
      if (!collectFailures) break;
    }
  }
  return Object.freeze({ status, error, outcomes: Object.freeze(outcomes) });
}
