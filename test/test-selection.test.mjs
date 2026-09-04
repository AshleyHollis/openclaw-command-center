import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { ordinaryTestArgv, ordinaryTestLanes, resolveRealHostAcceptancePlan, selectIssue32TicketTestFiles, selectOrdinaryTestFiles, selectTopicPageTicketTestFiles } from '../src/test-selection.mjs';

test('real-host acceptance defaults to the complete release plan', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan(), { kind: 'release', scenarioIds: null });
  assert.deepEqual(resolveRealHostAcceptancePlan('  '), { kind: 'release', scenarioIds: null });
});

test('real-host acceptance exposes one closed authenticated mount dependency plan', () => {
  assert.deepEqual(resolveRealHostAcceptancePlan('authenticated-control-ui-mount'), {
    kind: 'focused',
    scenarioIds: ['authenticated-control-ui-mount']
  });
  for (const value of ['unknown', '*', 'authenticated-control-ui-mount,scale-performance']) {
    assert.throws(() => resolveRealHostAcceptancePlan(value), /Unsupported real-host acceptance scenario/u);
  }
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
