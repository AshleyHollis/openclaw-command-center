import assert from 'node:assert/strict';
import test from 'node:test';
import { destinationFromConnectionArguments } from '../src/child-traffic.mjs';

test('uses the host argument for numeric child TCP and TLS connection overloads', () => {
  assert.equal(destinationFromConnectionArguments(18789, ['127.0.0.1']), '127.0.0.1');
  assert.equal(destinationFromConnectionArguments(18789, ['::1']), '::1');
  assert.equal(destinationFromConnectionArguments(18789, []), undefined);
});

test('reads object and URL child connection destinations without changing them', () => {
  assert.equal(destinationFromConnectionArguments({ host: '127.0.0.1', port: 18789 }, []), '127.0.0.1');
  assert.equal(destinationFromConnectionArguments('http://127.0.0.1:18789', []), '127.0.0.1');
});

test('unwraps the normalized Socket.connect argument arrays used by the provider client', () => {
  assert.equal(destinationFromConnectionArguments([{ host: '127.0.0.1', port: 18789 }]), '127.0.0.1');
  assert.equal(destinationFromConnectionArguments([[{ hostname: '::1', port: 18789 }]]), '::1');
  assert.equal(destinationFromConnectionArguments([[{ host: '198.51.100.17', port: 18789 }]]), '198.51.100.17');
});

test('fails closed for ambiguous and Unix-socket connection forms', () => {
  assert.equal(destinationFromConnectionArguments([[{ port: 18789 }]]), undefined);
  assert.equal(destinationFromConnectionArguments([{ path: '/tmp/fictional-model.sock' }]), undefined);
  assert.equal(destinationFromConnectionArguments([18789, () => {}, { unrelated: 'value' }]), undefined);
});
