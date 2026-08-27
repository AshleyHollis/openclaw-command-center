import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeInitialTopicSnapshot, inlineShellAssets, injectInitialTopicSnapshot, loadInitialTopicDestination, publicTopicDestination } from '../src/topics/snapshot.mjs';

test('initial Topic snapshot is bounded, public, and safe inside an HTML script element', () => {
  const topic = { topicId: '11111111-1111-4111-8111-111111111111', name: '</script><script>unsafe()</script>', revision: 2, paraCategory: 'project', lifecycle: 'active', health: 'ready', usable: true, recovery: [], privateLocator: '/private' };
  const encoded = encodeInitialTopicSnapshot({ activeGroups: { project: [topic], area: [], resource: [] }, provisioning: [], recovery: [], archived: [] });
  assert.doesNotMatch(encoded, /<\/script|privateLocator|\/private/u);
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.result.activeGroups.project[0].name, topic.name);
  assert.deepEqual(Object.keys(parsed.result.activeGroups.project[0]), ['topicId', 'name', 'revision', 'paraCategory', 'lifecycle', 'health', 'usable', 'recovery']);
});

test('authenticated shell inlines verified assets without executable closing-tag injection', () => {
  const html = '<link rel="stylesheet" href="/plugins/command-center/styles.css"><script defer src="/plugins/command-center/app.js"></script>';
  const result = inlineShellAssets(html, { styles: 'body::after{content:"</style>"}', app: 'globalThis.value="</script>";' });
  assert.doesNotMatch(result, /(?:href|src)="\/plugins\/command-center\/(?:styles\.css|app\.js)"/u);
  assert.match(result, /<style>body::after/u);
  assert.match(result, /<script>globalThis\.value=/u);
  assert.doesNotMatch(result, /<\/style>"|<\/script>"/u);
});

test('shell injection supplies exactly one bounded application/json snapshot', () => {
  const html = '<!doctype html><html><head></head><body><main></main></body></html>';
  const result = injectInitialTopicSnapshot(html, { groups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [] });
  assert.match(result, /<script id="command-center-initial-topics" type="application\/json">/u);
  assert.equal(result.match(/command-center-initial-topics/gu)?.length, 1);
  assert.ok(result.indexOf('command-center-initial-topics') < result.indexOf('<body>'));
});

test('public Topic snapshot preserves a bounded continuation cursor', () => {
  const snapshot = publicTopicDestination({ groups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], nextCursor: '100' });
  assert.equal(snapshot.nextCursor, '100');
});

test('initial Topic snapshot tolerates the registered service starting after the first shell request', async () => {
  const destination = { groups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [], nextCursor: null };
  let calls = 0;
  const service = { topics: { async listDestinationPageVerified(input) {
    calls += 1;
    if (calls === 1) throw new Error('Command Center Topic service is not ready.');
    assert.deepEqual(input, { cursor: 0, limit: 100 });
    return destination;
  } } };

  assert.equal(await loadInitialTopicDestination(service, { attempts: 2, delay: async () => {} }), destination);
  assert.equal(calls, 2);
});
