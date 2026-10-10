import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { FIRST_LIVE_FEATURES, FIRST_LIVE_COMMANDS, assertFirstLiveCommand } from '../src/release-scope.mjs';
import { FIRST_LIVE_FEATURES as browser } from '../src/native-ui/release-scope.mjs';

test('isolated enabled TEST identity admits only the requested existing feature owners', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.commandCenter.testCandidate.productionAdmission, false);
  assert.equal(pkg.commandCenter.testCandidate.kind, 'isolated-enabled-feature-test');
  for (const feature of pkg.commandCenter.testCandidate.features) {
    assert.equal(FIRST_LIVE_FEATURES[feature], true);
    assert.equal(browser[feature], true);
  }
  for (const feature of ['noteWrite', 'noteMaintenance', 'notifications', 'search', 'topicProvisioning']) {
    assert.equal(FIRST_LIVE_FEATURES[feature], false);
    assert.equal(browser[feature], false);
  }
  assert.deepEqual(FIRST_LIVE_COMMANDS.topicAction.filter(name => name.startsWith('documents.')),
    ['documents.attachments.list', 'documents.attachment.review', 'documents.attachment.prepare', 'documents.attachment.file', 'documents.attachment.check', 'documents.attachment.reopen']);
  for (const method of ['start', 'specify', 'decompose', 'resolve']) assert.throws(() =>
    assertFirstLiveCommand('bridge', `command-center.v1.conversation-plans.${method}`));
});
