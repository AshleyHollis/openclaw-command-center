import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWebSocketDestination, boundedTrafficEvidence, isLoopbackDestination, TrafficGuard } from '../src/isolation.mjs';

test('allows only concrete IPv4 and IPv6 loopback destinations', () => {
  assert.equal(isLoopbackDestination('127.0.0.1'), true);
  assert.equal(isLoopbackDestination('127.12.1.9'), true);
  assert.equal(isLoopbackDestination('::1'), true);
  assert.equal(isLoopbackDestination('[::1]'), true);
  for (const target of ['0.0.0.0', 'localhost', '192.0.2.1', 'example.invalid']) assert.equal(isLoopbackDestination(target), false);
});

test('records and rejects prohibited child and browser traffic', () => {
  const guard = new TrafficGuard();
  guard.assert('127.0.0.1', 'browser');
  assert.throws(() => guard.assert('0.0.0.0', 'child'));
  assert.throws(() => guard.assert('example.invalid', 'browser'));
  let error;
  try {
    guard.assertClean();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /child -> 0\.0\.0\.0/);
  assert.match(error.message, /browser -> example\.invalid/);
  assert.deepEqual(error.diagnostics.traffic, [
    { source: 'child', destination: '0.0.0.0' },
    { source: 'browser', destination: 'example.invalid' }
  ]);
});

test('rejects a WebSocket destination before it can be connected', () => {
  const guard = new TrafficGuard();
  assertWebSocketDestination(guard, 'ws://127.0.0.1:18789/socket');
  assertWebSocketDestination(guard, 'ws://[::1]:18789/socket');
  assert.throws(() => assertWebSocketDestination(guard, 'wss://example.invalid/socket'));
  assert.throws(() => guard.assertClean());
});

test('bounds and redacts any diagnostic traffic text', () => {
  const credentialName = ['to', 'ken'].join('');
  const redacted = '[redacted]';
  const evidence = boundedTrafficEvidence([
    { source: 'browser', destination: `https://example.invalid/?${credentialName}=fictional-value` }
  ]);

  assert.deepEqual(evidence, [
    { source: 'browser', destination: `https://example.invalid/?${credentialName}=${redacted}` }
  ]);
});
