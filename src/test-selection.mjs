const separatelyOwnedTests = new Set(['real-host.acceptance.test.mjs']);

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
