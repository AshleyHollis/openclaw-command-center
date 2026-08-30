const separatelyOwnedTests = new Set(['real-host.acceptance.test.mjs']);
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

export function selectTopicPageTicketTestFiles(entries) {
  if (!Array.isArray(entries)) throw new TypeError('test entries must be an array');
  return entries
    .filter((entry) => typeof entry === 'string' && topicPageTicketTests.has(entry))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((entry) => `test/${entry}`);
}
