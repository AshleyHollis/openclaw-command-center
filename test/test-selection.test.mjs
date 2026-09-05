import assert from 'node:assert/strict';

test('Topic Review diagnosis reuses its exact independent real-host fixture', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('diagnostic-topic-review').isolatedSliceIds, ['fresh-review']);
});
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { ordinaryTestArgv, ordinaryTestLanes, resolveRealHostAcceptancePlan, selectIssue32TicketTestFiles, selectOrdinaryTestFiles, selectTopicPageTicketTestFiles } from '../src/test-selection.mjs';

test('remaining UI diagnostics are a closed non-performance subset', () => {
  const plan = resolveRealHostAcceptancePlan('diagnostic-ui-remaining');
  assert.equal(plan.kind, 'focused');
  assert.deepEqual(plan.scenarioIds, []);
  assert.deepEqual(plan.isolatedSliceIds, ['fresh-scale']);
  assert.deepEqual(resolveRealHostAcceptancePlan('diagnostic-scale').isolatedSliceIds, ['fresh-scale']);
  assert.deepEqual(resolveRealHostAcceptancePlan('diagnostic-mobile').isolatedSliceIds, ['fresh-mobile']);
  assert.deepEqual(resolveRealHostAcceptancePlan('diagnostic-ui-desktop').isolatedSliceIds, ['fresh-desktop', 'fresh-scale', 'fresh-scale-analysis']);
  assert.deepEqual(resolveRealHostAcceptancePlan('diagnostic-compatibility-startup').isolatedSliceIds, ['host-tuple-refusal', 'build-variant']);
  const review = resolveRealHostAcceptancePlan('desktop-review-journey');
  assert.deepEqual(review.scenarioIds, ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'desktop-primary-journey-review']);
  assert.deepEqual(resolveRealHostAcceptancePlan('mobile-primary-journey').scenarioIds, ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'mobile-accessibility-journey']);
});

test('two non-performance diagnostic lanes partition every independent real-host slice', async () => {
  const plans = ['diagnostic-ui-data', 'diagnostic-security-recovery'].map(resolveRealHostAcceptancePlan);
  const ids = plans.flatMap((plan) => plan.isolatedSliceIds);
  for (const plan of plans) { assert.equal(plan.kind, 'focused'); assert.deepEqual(plan.scenarioIds, []); }
  assert.equal(new Set(ids).size, ids.length);
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/\['([^']+)', startIsolatedSlice\(/gu)].map((match) => match[1]);
  assert.deepEqual(ids.sort(), registered.sort());
  assert.equal(ids.includes('scale-performance'), false);
  assert.match(source, /if \(acceptancePlan\.kind === 'focused' && capturePerformanceBaseline\) throw/u);
});

test('real-host acceptance defaults to the complete release plan', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan(), { kind: 'release', scenarioIds: null });
  assert.deepEqual(resolveRealHostAcceptancePlan('  '), { kind: 'release', scenarioIds: null });
});

test('Session recovery diagnostic uses the exact shared revocation/replacement contract without corpus journeys', async () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('session-recovery-contract'), { kind: 'focused', scenarioIds: ['pinned-host-startup', 'focused-session-recovery'] });
  const source = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/await recoverExactPrimary\(/gu) ?? []).length, 2);
  assert.match(source, /expectedSourceRevision: recoveryReference\.expectedRevision/u);
});

test('real-host acceptance exposes one closed authenticated mount dependency plan', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('authenticated-control-ui-mount'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('authenticated-reminder-create'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-reminder-create']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('closed-tab-notification'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-closed-tab-notification']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('session-create-idempotent-replay'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-session-create-idempotent-replay']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('migrated-scale-conversation-seeding'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('desktop-primary-journey'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('heavy-corpus-mutation-journey'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-heavy-corpus-mutation-journey']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('desktop-to-scale-transition'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('heavy-desktop-to-scale-transition'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-heavy-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('full-corpus-desktop-to-scale-transition'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('full-prefix-to-second-topic'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'startup-projection-recovery', 'invalidated-projection-recovery', 'missing-projection-recovery', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'stale-projection-recovery', 'session-create-catalog-readback', 'session-create-idempotent-replay', 'migrated-scale-conversation-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('repeated-recovery-session-create'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-invalidated-projection-recovery', 'focused-missing-projection-recovery', 'focused-stale-projection-recovery', 'focused-session-create-after-recovery']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('ui-state-regression'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-ui-state-regression']
  });
  assert.deepEqual(resolveRealHostAcceptancePlan('scale-workspace-readiness'), {
    kind: 'focused',
    scenarioIds: ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'focused-scale-workspace-readiness']
  });
  for (const value of ['unknown', '*', 'authenticated-control-ui-mount,scale-performance']) {
    assert.throws(() => resolveRealHostAcceptancePlan(value), /Unsupported real-host acceptance scenario/u);
  }
});

test('migrated Topic Analysis diagnosis invokes the canonical assertion without the full capture', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('startup-authenticated-topic-analysis'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-verified-note-locator', 'startup-authenticated-topic-analysis']
  });
});

test('real-host acceptance exposes a focused Topic Review projection plan', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('topic-review-projection'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-topic-review-projection']
  });
});

test('real-host acceptance keeps exact Activity readback with its full-corpus scale action', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('scale-performance'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'scale-performance', 'verified-activity-readback']
  });
});

test('combined journey diagnostic retains dependent desktop, scale, Activity, keyboard and review checks', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('combined-journey'), {
    kind: 'focused',
    scenarioIds: ['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'scale-performance', 'verified-activity-readback', 'desktop-keyboard-journey', 'desktop-primary-journey-review']
  });
  assert.deepEqual(ordinaryTestLanes(['test/topic-review-focus.test.mjs']), [{ id: 'browser', argv: ['--test', '--test-concurrency=1', 'test/topic-review-focus.test.mjs'] }]);
});

test('ordinary suite excludes only the separately invoked real-host receipt test', () => {
  assert.deepEqual(selectOrdinaryTestFiles([
    'storage-recovery.test.mjs',
    'real-host.acceptance.test.mjs',
    'attention-service.integration.test.mjs',
    'fixtures'
  ]), [
    'test/attention-service.integration.test.mjs',
    'test/storage-recovery.test.mjs'
  ]);
});

test('ordinary suite serializes browser-heavy files without deselecting them', () => {
  assert.deepEqual(ordinaryTestLanes([
    'test/storage-recovery.test.mjs',
    'test/topic-page.acceptance.test.mjs',
    'test/dashboard-ui.test.mjs'
  ]), [
    { id: 'parallel', argv: ['--test', '--test-concurrency=4', 'test/storage-recovery.test.mjs'] },
    { id: 'browser', argv: ['--test', '--test-concurrency=1', 'test/topic-page.acceptance.test.mjs', 'test/dashboard-ui.test.mjs'] }
  ]);
});

test('ordinary suite uses bounded isolated workers on the medium evaluator', () => {
  assert.deepEqual(ordinaryTestArgv([
    'test/attention-service.integration.test.mjs',
    'test/storage-recovery.test.mjs'
  ]), [
    '--test',
    '--test-concurrency=4',
    'test/attention-service.integration.test.mjs',
    'test/storage-recovery.test.mjs'
  ]);
});

test('package test command selects every current ordinary test and preserves the dedicated receipt path', async () => {
  const entries = await readdir(new URL('./', import.meta.url));
  const selected = selectOrdinaryTestFiles(entries);
  const ordinary = entries.filter((entry) => entry.endsWith('.test.mjs') && entry !== 'real-host.acceptance.test.mjs');
  assert.equal(selected.length, ordinary.length);
  assert.equal(selected.includes('test/real-host.acceptance.test.mjs'), false);
  assert.equal(entries.includes('real-host.acceptance.test.mjs'), true);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node scripts/test.mjs');
});

test('Topic Page runner selects only its explicit ticket-owned tests', () => {
  const selected = selectTopicPageTicketTestFiles([
    'topic-page.acceptance.test.mjs',
    'topic-page-http.test.mjs',
    'dashboard-ui.test.mjs',
    'real-host.acceptance.test.mjs',
    'fixtures'
  ]);
  assert.deepEqual(selected, [
    'test/topic-page-http.test.mjs',
    'test/topic-page.acceptance.test.mjs'
  ]);
});

test('issue 32 selection keeps owning plugin contracts out of its standalone blocking set', () => {
  const entries = [
    'plugin-contract.test.mjs',
    'plugin-integration.test.mjs',
    'bridge-contract.test.mjs',
    'real-host.acceptance.test.mjs'
  ];
  assert.deepEqual(selectIssue32TicketTestFiles(entries), [
    'test/bridge-contract.test.mjs',
    'test/plugin-integration.test.mjs',
    'test/real-host.acceptance.test.mjs'
  ]);
  assert.equal(selectOrdinaryTestFiles(entries).includes('test/plugin-contract.test.mjs'), true);
  assert.equal(selectTopicPageTicketTestFiles(entries).includes('test/plugin-contract.test.mjs'), true);
});

test('Topic Page browser runner is mandatory, pinned, and included in the ordinary suite', async () => {
  const entries = await readdir(new URL('./', import.meta.url));
  assert.equal(selectOrdinaryTestFiles(entries).includes('test/topic-page.acceptance.test.mjs'), true);
  const script = await readFile(new URL('../scripts/test-topic-page.mjs', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../src/browser-setup.mjs', import.meta.url), 'utf8');
  assert.match(script, /selectTopicPageTicketTestFiles/u);
  assert.doesNotMatch(script, /skip|PLAYWRIGHT_BROWSERS_PATH\s*=|npm\s+(?:install|ci)/u);
  assert.match(setup, /PLAYWRIGHT_VERSION = '1\.62\.1'/u);
  assert.match(setup, /evaluator-provided PLAYWRIGHT_BROWSERS_PATH/u);
});
test('native Chat diagnostic requires the real authenticated mount and native round trip', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('native-chat-handoff').scenarioIds, ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-native-chat-handoff']);
  assert.deepEqual(resolveRealHostAcceptancePlan('native-chat-pointer-handoff').scenarioIds, ['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-native-chat-pointer-handoff']);
});
