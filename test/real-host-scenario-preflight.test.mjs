import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const command = new URL('../scripts/validate-real-host-scenarios.mjs', import.meta.url);
const run = selectors => spawnSync(process.execPath, [fileURLToPath(command), ...selectors], { encoding: 'utf8' });
test('every planned Next-2 selector resolves through the source-owned installed registry', () => {
  const selectors = ['native-control-ui-activation', 'native-chat-handoff', 'topic-notes-visual', 'desktop-keyboard-journey', 'scale-performance'];
  const result = run(selectors);
  assert.equal(result.status, 0, result.stderr);
  const plans = JSON.parse(result.stdout.trim().split('=')[1]);
  assert.deepEqual(plans.map(plan => plan.selector), selectors);
  assert.deepEqual(plans.map(plan => plan.scenarioIds), [['native-control-ui-activation'], ['native-topic-chat-handoff'], ['native-topic-files-workspace'], ['desktop-keyboard-journey'], ['scale-performance']]);
});
for (const selector of ['native-topic-chat-handoff', 'native-topic-notes-workspace', 'unknown-scenario']) test(`preflight rejects unsupported selector before runtime: ${selector}`, () => {
  const result = run(['native-control-ui-activation', selector]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported real-host acceptance scenario/);
  assert.equal(result.stdout, '');
});
for (const selectors of [[], ['native-release-prerequisites']]) test(`preflight rejects missing or non-journey plan: ${JSON.stringify(selectors)}`, () => {
  assert.notEqual(run(selectors).status, 0);
});
