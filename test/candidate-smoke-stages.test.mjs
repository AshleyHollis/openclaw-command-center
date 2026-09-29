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

test('installed browser substages distinguish transport and first navigation with closed fields', () => {
  const phases = ['browser-preflight', 'browser-launch', 'browser-server-launch', 'browser-connect',
    'browser-context', 'browser-http-route', 'browser-websocket-route', 'browser-page',
    'browser-evidence-page', 'browser-attention-navigation'];
  for (const failedAt of phases.slice(2)) {
    const { records, stages } = recorder();
    for (const phase of phases.slice(0, phases.indexOf(failedAt) + 1)) stages.stage(phase);
    stages.failure(new Error('fictional-marker-zeta'));
    assert.deepEqual(records.map(record => record.stage), [...phases.slice(0, phases.indexOf(failedAt) + 1), failedAt]);
    assert.deepEqual(records.at(-1), { kind: 'candidate-smoke-stage', event: 'failure', stage: failedAt });
    assert.ok(records.every(record => Object.keys(record).sort().join(',') === 'event,kind,stage'));
    assert.doesNotMatch(JSON.stringify(records), /fictional-marker-zeta/u);
  }
  const direct = recorder();
  direct.stages.stage('browser-direct-launch');
  direct.stages.failure(new Error('fictional-marker-zeta'));
  assert.equal(direct.records.at(-1).stage, 'browser-direct-launch');
});

test('installed browser reports substages before operations and does not forward callback as Playwright option', async () => {
  const browser = await readFile(new URL('../scripts/support/installed-developer-browser.mjs', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('./support/real-host-runtime.mjs', import.meta.url), 'utf8');
  const ordered = [
    ["onStage('browser-context')", 'await browser.newContext('],
    ["onStage('browser-http-route')", "await context.route('**/*'"],
    ["onStage('browser-websocket-route')", "await context.routeWebSocket('**/*'"],
    ["onStage('browser-page')", 'await context.newPage()'],
    ["onStage('browser-evidence-page')", 'await configureEvidencePage(lifePage'],
    ["onStage('browser-attention-navigation')", 'await lifePage.goto(attention.href']
  ];
  let previous = browser.indexOf('await launchManagedBrowser(');
  assert.match(browser, /launchManagedBrowser\(\{ headless: true, timeout: 60_000, executablePath \}, onStage\)/u);
  for (const [marker, operation] of ordered) {
    const at = browser.indexOf(marker);
    assert.ok(at > previous && browser.indexOf(operation, at) > at, marker);
    previous = at;
  }
  assert.ok(browser.indexOf("onStage('browser-attention-link')") > previous);
  assert.match(runtime, /launchManagedBrowser\(options, onTransportStage = \(\) => \{\}\)/u);
  for (const [marker, operation] of [
    ["onTransportStage('browser-direct-launch')", 'await chromium.launch('],
    ["onTransportStage('browser-server-launch')", 'await chromium.launchServer('],
    ["onTransportStage('browser-connect')", 'await chromium.connect(']
  ]) assert.ok(runtime.indexOf(marker) < runtime.indexOf(operation), marker);
  assert.match(runtime, /chromium.launchServer\(managedChromiumOptions\(options\)\)/u);
  assert.match(runtime, /chromium.connect\(server.wsEndpoint\(\)\)/u);
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
