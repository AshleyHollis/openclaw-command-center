const separatelyOwnedTests = new Set(['real-host.acceptance.test.mjs']);
const browserHeavyTests = new Set([
  'test/conversation-keyboard-focus.test.mjs',
  'test/keyboard-paint.test.mjs',
  'test/keyboard-time-focus.test.mjs',
  'test/dashboard-operation-ui.test.mjs',
  'test/dashboard-ui.test.mjs',
  'test/dashboard-refresh-focus.test.mjs',
  'test/topic-page.acceptance.test.mjs',
  'test/topic-review-ui.test.mjs',
  'test/topic-review-focus.test.mjs',
  'test/workspace-recovery-ui.test.mjs',
  'test/topics-ui.test.mjs'
]);
const topicPageTicketTests = new Set([
  'bridge-contract.test.mjs',
  'browser-setup.test.mjs',
  'markdown-preview.test.mjs',
  'native-chat-navigation.test.mjs',
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
  'startup-authenticated-topic-analysis': Object.freeze(['pinned-host-startup', 'focused-verified-note-locator', 'startup-authenticated-topic-analysis']),
  'session-recovery-contract': Object.freeze(['pinned-host-startup', 'focused-session-recovery']),
  'combined-journey': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'scale-performance', 'verified-activity-readback', 'mobile-accessibility-journey', 'desktop-primary-journey-review']),
  'authenticated-control-ui-mount': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount']),
  'native-chat-handoff': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-native-chat-handoff']),
  'native-chat-pointer-handoff': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-native-chat-pointer-handoff']),
  'authenticated-reminder-create': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-reminder-create']),
  'closed-tab-notification': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-closed-tab-notification']),
  'topic-review-projection': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-topic-review-projection']),
  'session-create-idempotent-replay': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-session-create-idempotent-replay']),
  'migrated-scale-conversation-seeding': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding']),
  'desktop-primary-journey': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey']),
  'desktop-review-journey': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'desktop-primary-journey-review']),
  'mobile-primary-journey': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'mobile-accessibility-journey']),
  'desktop-to-scale-transition': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']),
  'heavy-desktop-to-scale-transition': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-heavy-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']),
  'full-corpus-desktop-to-scale-transition': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']),
  'full-prefix-to-second-topic': Object.freeze(['pinned-host-startup', 'startup-projection-recovery', 'invalidated-projection-recovery', 'missing-projection-recovery', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'stale-projection-recovery', 'session-create-catalog-readback', 'session-create-idempotent-replay', 'migrated-scale-conversation-seeding', 'desktop-primary-journey', 'focused-second-topic-journey']),
  'heavy-corpus-mutation-journey': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-heavy-corpus-mutation-journey']),
  'repeated-recovery-session-create': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-invalidated-projection-recovery', 'focused-missing-projection-recovery', 'focused-stale-projection-recovery', 'focused-session-create-after-recovery']),
  'scale-workspace-readiness': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'focused-scale-workspace-readiness']),
  'scale-performance': Object.freeze(['pinned-host-startup', 'focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'focused-full-corpus-fixture', 'authenticated-control-ui-mount', 'focused-scale-session-seeding', 'scale-performance', 'verified-activity-readback']),
  'ui-state-regression': Object.freeze(['focused-control-ui-migration-readiness', 'focused-control-ui-search-projection', 'authenticated-control-ui-mount', 'focused-ui-state-regression'])
});

const diagnosticSliceLanes = Object.freeze({
  'diagnostic-scale': Object.freeze(['fresh-scale']),
  'diagnostic-mobile': Object.freeze(['fresh-mobile']),
  'diagnostic-ui-desktop': Object.freeze(['fresh-desktop', 'fresh-scale', 'fresh-scale-analysis']),
  'diagnostic-compatibility-startup': Object.freeze(['host-tuple-refusal', 'build-variant']),
  'diagnostic-ui-remaining': Object.freeze(['fresh-scale', 'fresh-mobile']),
  'diagnostic-ui-data': Object.freeze(['fresh-desktop', 'fresh-scale', 'fresh-scale-analysis', 'fresh-mobile', 'fresh-review']),
  'diagnostic-security-recovery': Object.freeze(['host-tuple-refusal', 'build-variant', 'plugin-api-variant', 'bridge-protocol-variant', 'binding-mismatch', 'foreign-database-restoration', 'secure-origin', 'degraded-bridge-grants', 'degraded-source-availability', 'combined-degraded', 'recovery-only-compatibility', 'destructive-migration-restoration'])
});

export function resolveRealHostAcceptancePlan(value) {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (selected === '') return Object.freeze({ kind: 'release', scenarioIds: null });
  if (diagnosticSliceLanes[selected]) return Object.freeze({ kind: 'focused', scenarioIds: Object.freeze([]), isolatedSliceIds: diagnosticSliceLanes[selected] });
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
