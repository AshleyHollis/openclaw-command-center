import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayFrameWaiter } from '../src/acceptance-gateway.mjs';

class FakeSocket extends EventTarget {
  readyState = 1;
  listeners = new Set();
  addEventListener(type, listener, options) { this.listeners.add(listener); super.addEventListener(type, listener, options); }
  removeEventListener(type, listener, options) { this.listeners.delete(listener); super.removeEventListener(type, listener, options); }
}

for (const kind of ['close', 'error', 'timeout', 'abort', 'already-closed']) test(`Gateway frame wait reports ${kind} with method, phase, callsite and no retained listeners`, async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const requestSite = new Error('fictional callsite');
  if (kind === 'already-closed') socket.readyState = 3;
  const wait = createGatewayFrameWaiter(socket, { method: 'fictional.read', signal: controller.signal, requestSite });
  const pending = wait(() => false, kind === 'timeout' ? 5 : 10_000, 'method-response');
  if (kind === 'close') socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, wasClean: false, reason: 'PRIVATE_REASON_MUST_NOT_ESCAPE' }));
  if (kind === 'error') socket.dispatchEvent(new Event('error'));
  if (kind === 'abort') controller.abort(requestSite);
  await assert.rejects(pending, (error) => {
    if (kind === 'abort') return error === requestSite;
    assert.equal(error.cause, requestSite);
    assert.match(error.message, /method-response.*fictional\.read/);
    assert.doesNotMatch(error.message, /PRIVATE_REASON/);
    return true;
  });
  assert.equal(socket.listeners.size, 0);
});

test('Gateway frame wait resolves the exact matching response and cleans up', async () => {
  const socket = new FakeSocket();
  const wait = createGatewayFrameWaiter(socket, { method: 'fictional.read', requestSite: new Error('fictional callsite') });
  const pending = wait((frame) => frame.id === 'fictional-request');
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 'other-request' }) }));
  const expected = { id: 'fictional-request', ok: true, payload: { fictional: true } };
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(expected) }));
  assert.deepEqual(await pending, expected);
  assert.equal(socket.listeners.size, 0);
});
