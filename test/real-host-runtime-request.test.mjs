import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { createGatewayDeviceIdentity, requestAuthenticatedGateway } from './support/real-host-runtime.mjs';

// Protocol doubles check the test transport only, not host authorization.
// The non-measuring real-host Conversation preparation proves that boundary.
function transport(t, { refusal = false } = {}) {
  const sockets = [];
  class Socket extends EventTarget {
    readyState = 1;
    requests = [];
    closed = false;
    constructor(url, options) {
      super(); this.url = url; this.options = options; sockets.push(this);
      setImmediate(() => {
        this.dispatchEvent(new Event('open'));
        this.frame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fictional-challenge' } });
      });
    }
    frame(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(raw) {
      const request = JSON.parse(raw); this.requests.push(request);
      queueMicrotask(() => this.frame({ type: 'res', id: request.id,
        ok: request.method === 'connect' || !refusal,
        payload: { accepted: request.method }, error: { code: 'FORBIDDEN', message: 'Fictional refusal' } }));
    }
    close() { this.closed = true; this.readyState = 3; }
  }
  t.mock.method(globalThis, 'WebSocket', function (...args) { return new Socket(...args); });
  return sockets;
}

const base = { gatewayUrl: 'http://127.0.0.1:12345', credential: 'fictional-test-credential',
  method: 'command-center.v1.sessions.create', params: { schemaVersion: 1, topicId: 'fictional-topic',
    expectedRevision: 17, logicalOperationId: 'fictional-operation', label: 'Fictional Conversation' },
  scopes: ['operator.read', 'operator.write'] };

test('existing CLI requests keep their client, parameters, scopes and close contract', async t => {
  const sockets = transport(t);
  await requestAuthenticatedGateway(base);
  const [socket] = sockets;
  assert.equal(socket.options, undefined);
  assert.deepEqual(socket.requests[0].params.client, { id: 'cli', version: '1', platform: 'test', mode: 'cli' });
  assert.equal(socket.requests[0].params.device, undefined);
  assert.deepEqual(socket.requests[1].params, base.params);
  assert.deepEqual(socket.requests[0].params.scopes, base.scopes);
  assert.equal(socket.closed, true);
});

test('Control UI preparation signs its actual client, nonce and scopes and sends the pinned build identity', async t => {
  const sockets = transport(t);
  await requestAuthenticatedGateway({ ...base, deviceIdentity: createGatewayDeviceIdentity(), controlUiBuildId: 'fictional-build' });
  const [socket] = sockets;
  const { client, device, scopes } = socket.requests[0].params;
  assert.deepEqual(socket.options, { headers: { Origin: base.gatewayUrl } });
  assert.deepEqual(client, { id: 'openclaw-control-ui', version: '1', platform: 'test', mode: 'ui', buildId: 'fictional-build' });
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(device.publicKey, 'base64url')]), format: 'der', type: 'spki' });
  const signed = ['v3', device.id, client.id, client.mode, 'operator', scopes.join(','), String(device.signedAt), base.credential, 'fictional-challenge', client.platform, ''].join('|');
  assert.equal(verify(null, Buffer.from(signed), publicKey, Buffer.from(device.signature, 'base64url')), true);
  assert.deepEqual(socket.requests[1].params, base.params);
  assert.equal(socket.closed, true);
});

test('Control UI preparation refuses missing signed identity before connecting', async t => {
  const sockets = transport(t);
  await assert.rejects(requestAuthenticatedGateway({ ...base, controlUiBuildId: 'fictional-build' }), /signed device identity/);
  assert.equal(sockets.length, 0);
});

test('test transport preserves refusal and closes without retrying the mutation', async t => {
  const sockets = transport(t, { refusal: true });
  await assert.rejects(requestAuthenticatedGateway(base), /FORBIDDEN/);
  assert.equal(sockets[0].requests.length, 2);
  assert.equal(sockets[0].closed, true);
});
