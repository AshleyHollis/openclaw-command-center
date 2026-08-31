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

test('bounds a stalled cleanup phase and continues every final assertion with progress', async () => {
  const calls = [];
  const progress = [];
  const errors = await finalizeAcceptanceJourney({
    closeBrowser: async () => new Promise(() => {}),
    stopHost: async () => calls.push('host-stop'),
    assertBrowserTraffic: () => calls.push('browser-traffic'),
    assertHostTraffic: () => calls.push('host-traffic'),
    assertChildTraffic: () => calls.push('child-traffic'),
    assertBuildDigest: () => calls.push('build-digest'),
    timeoutMs: 20,
    onProgress: (event) => progress.push(event)
  });

  assert.deepEqual(calls, ['host-stop', 'build-digest']);
  assert.equal(errors.length, 4);
  assert.equal(errors[0].phase, 'browser-close');
  assert.match(errors[0].error.message, /exceeded its 20 ms deadline/u);
  assert.deepEqual(progress.filter(({ status }) => status === 'started').map(({ phase }) => phase), [
    'browser-close', 'host-stop', 'browser-traffic', 'host-traffic', 'child-traffic', 'build-digest'
  ]);
  assert.deepEqual(progress.filter(({ status }) => status === 'passed').map(({ phase }) => phase), ['host-stop', 'build-digest']);
});
