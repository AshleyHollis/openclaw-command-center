import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeAcceptanceJourney } from '../src/acceptance-finalization.mjs';

test('stops browser and host before inspecting final traffic and preserves every failure', async () => {
  const calls = [];
  const failure = new Error('late prohibited traffic');
  const errors = await finalizeAcceptanceJourney({
    closeBrowser: async () => calls.push('browser-close'),
    stopHost: async () => calls.push('host-stop'),
    assertBrowserTraffic: () => calls.push('browser-traffic'),
    assertHostTraffic: () => calls.push('host-traffic'),
    assertChildTraffic: async () => {
      calls.push('child-traffic');
      throw failure;
    },
    assertBuildDigest: async () => calls.push('build-digest')
  });

  assert.deepEqual(calls, [
    'browser-close',
    'host-stop',
    'browser-traffic',
    'host-traffic',
    'child-traffic',
    'build-digest'
  ]);
  assert.deepEqual(errors, [{ phase: 'child-traffic', error: failure }]);
});
