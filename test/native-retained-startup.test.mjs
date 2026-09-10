import assert from 'node:assert/strict';
import test from 'node:test';
import { readRetainedNativeBootstrap } from './support/first-live-native-journey.mjs';

// Orchestration only: real-host diagnostic-scale-startup also exercises this
// exact owner with the full corpus, authenticated readback and retained state.
test('retained startup cannot read migration before authenticated readiness or report readiness early', async () => {
  const controller = new AbortController();
  let ready;
  let reads = 0;
  let reported = 0;
  const gate = new Promise(resolve => { ready = resolve; });
  const options = { world: {}, host: {}, signal: controller.signal, bootstrap: {},
    expectedConversationCount: 100, onReady: () => { reported += 1; } };
  const expected = { completion: { verified: true } };
  const result = readRetainedNativeBootstrap(options, {
    waitForReady: async input => { assert.deepEqual(input, { ...options, scale: false }); await gate; },
    readBootstrap: async input => { reads += 1; assert.equal(input, options); input.onReady(); return expected; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(reported, 0);
  ready();
  assert.equal(await result, expected);
  assert.equal(reads, 1);
  assert.equal(reported, 1);
});

for (const code of ['unauthenticated', 'readiness-timeout', 'host-exited', 'aborted']) {
  test(`retained startup propagates ${code} without probing migration or retrying an operation`, async () => {
    const failure = Object.assign(new Error('Fictional readiness refusal'), { code });
    let reads = 0;
    await assert.rejects(readRetainedNativeBootstrap({}, {
      waitForReady: async () => { throw failure; },
      readBootstrap: async () => { reads += 1; }
    }), error => error === failure);
    assert.equal(reads, 0);
  });
}

test('retained migration refusal remains fatal after readiness', async () => {
  const failure = new Error('Fictional migration identity mismatch');
  let reads = 0;
  await assert.rejects(readRetainedNativeBootstrap({}, {
    waitForReady: async () => {}, readBootstrap: async () => { reads += 1; throw failure; }
  }), error => error === failure);
  assert.equal(reads, 1);
});
