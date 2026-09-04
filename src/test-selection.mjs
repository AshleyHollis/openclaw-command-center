const separatelyOwnedTests = new Set(['real-host.acceptance.test.mjs']);
const browserHeavyTests = new Set([
  'test/dashboard-ui.test.mjs',
  'test/topic-page.acceptance.test.mjs',
  'test/topic-review-ui.test.mjs',
  'test/topics-ui.test.mjs'
]);
const topicPageTicketTests = new Set([
  'bridge-contract.test.mjs',
  'browser-setup.test.mjs',
  'markdown-preview.test.mjs',
  'note-adapter.test.mjs',
  'note-conflicts.test.mjs',
  'plugin-contract.test.mjs',
  'session-adapter.test.mjs',
  'source-service.integration.test.mjs',
  'test-selection.test.mjs',
  'topic-context-policy.test.mjs',
  'topic-page-http.test.mjs',
  'topic-page.acceptance.test.mjs',
  'topic-search.acceptance.test.mjs'
]);
const issue32TicketTests = new Set([
  'acceptance-finalization.test.mjs',
  'acceptance-report.test.mjs',
  'bridge-contract.test.mjs',
  'check-phases.test.mjs',
  'plugin-integration.test.mjs',
  'real-host.acceptance.test.mjs',
  'test-selection.test.mjs'
]);

const focusedRealHostScenarios = Object.freeze({
  'authenticated-control-ui-mount': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount']),
  'session-create-idempotent-replay': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-session-create-idempotent-replay']),
  'migrated-scale-conversation-seeding': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding']),
  'desktop-primary-journey': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey']),
  'heavy-corpus-mutation-journey': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-heavy-corpus-mutation-journey']),
  'repeated-recovery-session-create': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-invalidated-projection-recovery', 'focused-missing-projection-recovery', 'focused-stale-projection-recovery', 'focused-session-create-after-recovery']),
  'scale-workspace-readiness': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'focused-scale-workspace-readiness']),
  'ui-state-regression': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-ui-state-regression'])
});

export function resolveRealHostAcceptancePlan(value) {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (selected === '') return Object.freeze({ kind: 'release', scenarioIds: null });
  const scenarioIds = focusedRealHostScenarios[selected];
  if (!scenarioIds) throw new Error(`Unsupported real-host acceptance scenario: ${selected}`);
  return Object.freeze({ kind: 'focused', scenarioIds });
}

/**
 * Select the ordinary repository suite. Controller-owned receipt tests retain
 * their exact paths and fail-closed setup, but run only through their dedicated
 * commands where the required isolated runtime descriptor is available.
 */
export function selectOrdinaryTestFiles(entries) {
  if (!Array.isArray(entries)) throw new TypeError('test entries must be an array');
  return entries
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.test.mjs') && !separatelyOwnedTests.has(entry))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((entry) => `test/${entry}`);
}

/**
 * Keep ordinary qualification within the medium evaluator's resource budget.
 * Process isolation lets independent files overlap, while the explicit bound
 * prevents the browser and SQLite fixtures from exhausting the worker.
 */
export function ordinaryTestArgv(files) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) throw new TypeError('test files must be an array of strings');
  return ['--test', '--test-concurrency=4', ...files];
}

/** Keep Chromium-heavy files selected but serialize them in a separate lane. */
export function ordinaryTestLanes(files) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) throw new TypeError('test files must be an array of strings');
  const browser = files.filter((file) => browserHeavyTests.has(file));
  const parallel = files.filter((file) => !browserHeavyTests.has(file));
  return [
    ...(parallel.length ? [{ id: 'parallel', argv: ordinaryTestArgv(parallel) }] : []),
    ...(browser.length ? [{ id: 'browser', argv: ['--test', '--test-concurrency=1', ...browser] }] : [])
  ];
}

export function selectTopicPageTicketTestFiles(entries) {
  if (!Array.isArray(entries)) throw new TypeError('test entries must be an array');
  return entries
    .filter((entry) => typeof entry === 'string' && topicPageTicketTests.has(entry))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((entry) => `test/${entry}`);
}

/** Select only issue #32's receipt and indispensable integration boundaries. */
export function selectIssue32TicketTestFiles(entries) {
  if (!Array.isArray(entries)) throw new TypeError('test entries must be an array');
  return entries
    .filter((entry) => typeof entry === 'string' && issue32TicketTests.has(entry))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((entry) => `test/${entry}`);
}
