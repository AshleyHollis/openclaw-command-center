import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCandidateSmokeStages, runCandidateSmokeCleanup } from '../src/candidate-smoke-stages.mjs';

function recorder() {
  const records = [];
  return { records, stages: createCandidateSmokeStages(line => records.push(JSON.parse(line))) };
}

test('stage markers are ordered, fixed-enum and never serialize exception or arbitrary stage data', () => {
  const { records, stages } = recorder();
  const sensitiveValue = 'unexpected-stage-payload';
  stages.stage('initial-host-launch');
  stages.stage('initial-readiness');
  stages.stage('installed-browser');
  stages.failure(new Error(sensitiveValue));
  stages.stage(sensitiveValue);
  stages.failure(new Error(sensitiveValue));
  assert.deepEqual(records, [
    { kind: 'candidate-smoke-stage', event: 'start', stage: 'initial-host-launch' },
    { kind: 'candidate-smoke-stage', event: 'start', stage: 'initial-readiness' },
    { kind: 'candidate-smoke-stage', event: 'start', stage: 'installed-browser' },
    { kind: 'candidate-smoke-stage', event: 'failure', stage: 'installed-browser' },
    { kind: 'candidate-smoke-stage', event: 'start', stage: 'input' }
  ]);
  assert.ok(!JSON.stringify(records).includes(sensitiveValue));
});

test('cleanup emits fixed failure marker, runs all tasks and never replaces primary failure', async () => {
  const { records, stages } = recorder();
  const primary = new Error('fictional private primary');
  const cleanup = new Error('fictional private cleanup');
  const done = [];
  stages.stage('installed-browser');
  stages.failure(primary);
  await runCandidateSmokeCleanup([
    async () => { done.push(1); throw cleanup; },
    async () => { done.push(2); }
  ], true, stages);
  assert.deepEqual(done, [1, 2]);
  assert.deepEqual(records.slice(-3), [
    { kind: 'candidate-smoke-stage', event: 'failure', stage: 'installed-browser' },
    { kind: 'candidate-smoke-stage', event: 'start', stage: 'cleanup' },
    { kind: 'candidate-smoke-stage', event: 'cleanup-failure', stage: 'cleanup' }
  ]);
  assert.doesNotMatch(JSON.stringify(records), /private/u);
  const second = recorder();
  await assert.rejects(runCandidateSmokeCleanup([() => { throw cleanup; }, () => { throw primary; }],
    false, second.stages), error => error === cleanup);
  const third = recorder();
  await assert.rejects(runCandidateSmokeCleanup([() => { throw undefined; }], false, third.stages),
    error => error === undefined);
  assert.equal(second.records.filter(record => record.event === 'cleanup-failure').length, 2);
});

test('candidate success kind and legacy launch/restart failure phases remain unchanged', async () => {
  const candidate = await readFile(new URL('../scripts/smoke-candidate-pair.mjs', import.meta.url), 'utf8');
  const installed = await readFile(new URL('../scripts/smoke-dev-live-installed.mjs', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../scripts/support/installed-developer-browser.mjs', import.meta.url), 'utf8');
  for (const [start, end] of [
    ["stages.stage('initial-host-launch')", 'run = await launchCandidateHost('],
    ["stages.stage('host-restart')", 'run = await restartPinnedHost(run)'],
    ["onStage('installed-browser')", 'await installedBrowserHandoff('],
    ["onStage('installed-resolution')", "kind: 'installed-dev-live-session-smoke'"]
  ]) {
    const source = start.startsWith('onStage') ? installed : candidate;
    assert.ok(source.indexOf(start) >= 0 && source.indexOf(end) > source.indexOf(start));
  }
  assert.match(candidate, /executionPhase = 'initial-host-launch'/u);
  assert.match(candidate, /executionPhase = 'host-restart'/u);
  assert.match(candidate, /kind: 'candidate-pair-isolated-smoke'/u);
  assert.ok(candidate.includes('...developerJourney.checks'));
  const orderedBrowserMarkers = ['browser-preflight', 'browser-launch', 'browser-attention-link',
    'browser-unauthenticated', 'browser-authenticated-chat', 'browser-stale', 'browser-resolve'];
  let previous = -1;
  for (const marker of orderedBrowserMarkers) {
    const position = browser.indexOf("onStage('" + marker + "')");
    assert.ok(position > previous, marker);
    previous = position;
  }
  assert.ok(browser.indexOf("onStage('browser-launch')") < browser.indexOf('await launchManagedBrowser('));
  assert.ok(browser.indexOf("onStage('browser-authenticated-chat')") < browser.indexOf('await open.click()'));
  for (const source of [candidate, installed, browser]) {
    assert.ok(source.includes('primaryFailed = true;'));
    assert.ok(source.includes('runCandidateSmokeCleanup(['));
  }
});
