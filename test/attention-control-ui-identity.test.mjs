import assert from 'node:assert/strict';
import test from 'node:test';
import { readAttentionControlUiBuildId } from './support/attention-startup-readiness.mjs';
import { waitForConsecutiveReadiness } from '../src/host-harness.mjs';

const world = { gateway: { url: 'http://127.0.0.1:12345' }, gatewayCredential: 'fictional-owner-token' };

test('Attention reads only the exact authenticated host build identity and preserves its bytes', async () => {
  const controller = new AbortController();
  const value = await readAttentionControlUiBuildId({ world, signal: controller.signal }, { fetchImpl: async (url, options) => {
    assert.equal(url, `${world.gateway.url}/__openclaw__/control-ui-config.json`);
    assert.deepEqual(options.headers, { authorization: 'Bearer fictional-owner-token' });
    assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, false);
    return new Response('{"serverBuildId":"fictional-build-1"}', { status: 200 });
  } });
  assert.equal(value, 'fictional-build-1');
});

for (const status of [401, 403, 404, 500]) {
  test(`Attention build identity refuses HTTP ${status} without retry`, async () => {
    let calls = 0;
    await assert.rejects(waitForConsecutiveReadiness(signal => readAttentionControlUiBuildId({ world, signal }, {
      fetchImpl: async () => { calls += 1; return new Response('{}', { status }); }
    }), new Promise(() => {}), { deadlineMs: 1_000 }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  });
}

for (const body of ['not JSON', '{}', '{"serverBuildId":null}', '{"serverBuildId":17}', '{"serverBuildId":" "}']) {
  test(`Attention rejects unproven build identity: ${body}`, async () => {
    await assert.rejects(readAttentionControlUiBuildId({ world }, {
      fetchImpl: async () => new Response(body, { status: 200 })
    }), /build identity is invalid/);
  });
}

test('Attention rereads the host build identity after restart', async () => {
  let generation = 0;
  const fetchImpl = async () => new Response(JSON.stringify({ serverBuildId: `fictional-build-${++generation}` }), { status: 200 });
  assert.equal(await readAttentionControlUiBuildId({ world }, { fetchImpl }), 'fictional-build-1');
  assert.equal(await readAttentionControlUiBuildId({ world }, { fetchImpl }), 'fictional-build-2');
});

test('Attention build identity remains inside original cancellation/deadline', async () => {
  let innerSignal;
  await assert.rejects(waitForConsecutiveReadiness(signal => readAttentionControlUiBuildId({ world, signal }, {
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      innerSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  }), new Promise(() => {}), { deadlineMs: 20 }), error => error.category === 'readiness-timeout');
  assert.equal(innerSignal.aborted, true);
  const failure = new Error('Fictional cancellation');
  await assert.rejects(readAttentionControlUiBuildId({ world, signal: AbortSignal.abort(failure) }, {
    fetchImpl: async () => assert.fail('Cancelled build preparation must not send a request')
  }), error => error === failure);
});
