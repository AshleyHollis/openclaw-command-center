import assert from 'node:assert/strict';
import test from 'node:test';
import { BRIDGE_CONTRACTS, READ_METHODS, WRITE_METHODS, validateBridgeRequest } from '../src/bridge/contracts.mjs';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { randomUUID } from 'node:crypto';

test('registers the complete closed versioned bridge inventory with least-privilege scopes', () => {
  const registrations = [];
  const api = { registerGatewayMethod: (...args) => registrations.push(args) };
  const service = Object.fromEntries([...READ_METHODS, ...WRITE_METHODS].map((method) => [method, async () => ({ status: 'applied' })]));
  const registered = registerBridgeMethods(api, service);
  assert.deepEqual(registered, [...READ_METHODS, ...WRITE_METHODS]);
  assert.deepEqual(registrations.map(([method, , options]) => [method, options.scope]), [
    ...READ_METHODS.map((method) => [method, 'operator.read']),
    ...WRITE_METHODS.map((method) => [method, 'operator.write'])
  ]);
  for (const method of registered) {
    assert.equal(BRIDGE_CONTRACTS[method].closed, true);
    assert.equal(BRIDGE_CONTRACTS[method].paramsSchema.additionalProperties, false);
    assert.equal(BRIDGE_CONTRACTS[method].resultSchema.additionalProperties, false);
    for (const property of Object.values(BRIDGE_CONTRACTS[method].paramsSchema.properties)) {
      assert.equal(typeof property.type === 'string' || property.const !== undefined, true);
    }
    assert.equal(BRIDGE_CONTRACTS[method].resultSchema.properties.result.additionalProperties, false);
  }
});

test('closed bridge validation rejects unversioned, extra-field, and non-UUID mutation requests', () => {
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { topicId: 'topic', path: 'a.md' }), /schemaVersion/);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 'topic', path: 'a.md', extra: true }), /unsupported.*field/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', path: 'a.md', expectedRevision: 'sha256:x', text: 'x', logicalOperationId: 'not-a-uuid' }), /canonical.*logical/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', path: 'a.md', expectedRevision: 'sha256:x', text: 'x', logicalOperationId: randomUUID() }));
  assert.throws(() => validateBridgeRequest('command-center.v1.reminders.complete', { schemaVersion: 1, topicId: 'topic', referenceId: 'reminder', expectedConfigRevision: 'revision', patch: { payload: {} }, logicalOperationId: randomUUID() }), /unsupported.*patch/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.set-enabled', { schemaVersion: 1, topicId: 'topic', referenceId: 'schedule', expectedConfigRevision: 'revision', enabled: false, patch: { schedule: {} }, logicalOperationId: randomUUID() }), /unsupported.*patch/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.send', { schemaVersion: 1, topicId: 'topic', message: 'fictional', logicalOperationId: randomUUID() }), /exact Source Reference/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.run', { schemaVersion: 1, topicId: 'topic', logicalOperationId: randomUUID() }), /exact Source Reference/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', path: 'a.md', text: 'x', logicalOperationId: randomUUID() }), /expectedRevision/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 42, path: 'a.md' }), /topicId.*string/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.set-enabled', { schemaVersion: 1, topicId: 'topic', referenceId: 'schedule', expectedConfigRevision: 'revision', enabled: 'false', logicalOperationId: randomUUID() }), /enabled.*boolean/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.search.query', { schemaVersion: 1, topicId: 'topic', query: 'fictional', limit: 0 }), /limit/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.metadata.read', { schemaVersion: 1, referenceId: 'foreign-reference' }), /topicId/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.history', { schemaVersion: 1, topicId: 'topic', referenceId: 'session', sessionId: 'foreign-session' }), /unsupported.*sessionId/i);
  for (const attachment of [{ path: '/fictional/private.md' }, { url: 'https://fictional.invalid/private' }]) {
    assert.throws(() => validateBridgeRequest('command-center.v1.sessions.send', { schemaVersion: 1, topicId: 'topic', referenceId: 'session', message: 'fictional', attachments: [attachment], logicalOperationId: randomUUID() }), /unsupported.*attachments/i);
  }
});

test('handlers preserve authenticated request context and echo request and logical IDs', async () => {
  const registrations = [];
  const api = { registerGatewayMethod: (...args) => registrations.push(args) };
  const service = { status: () => ({ mode: 'ready' }) };
  registerBridgeMethods(api, service);
  const statusHandler = registrations.find(([method]) => method === 'command-center.v1.sources.status')[1];
  let response;
  await statusHandler({ req: { id: 'gateway-frame-1' }, params: { schemaVersion: 1 }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.deepEqual(response[1], { schemaVersion: 1, status: 'applied', requestId: 'gateway-frame-1', logicalOperationId: null, result: { mode: 'ready' } });
});

test('handlers bound raw provider failures without exposing their messages', async () => {
  const registrations = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, { status: () => { throw new Error('fictional-secret /private/path'); } });
  const handler = registrations.find(([method]) => method === 'command-center.v1.sources.status')[1];
  let response;
  await handler({ req: { id: 'gateway-frame-raw' }, params: { schemaVersion: 1 }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], false);
  assert.equal(response[2].code, 'unavailable');
  assert.doesNotMatch(JSON.stringify(response[2]), /fictional-secret|private\/path/);
});

test('handlers enforce closed result schemas and withhold unexpected provider fields', async () => {
  const registrations = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
    sessionsHistory: async () => ({ sessionKey: 'fictional-session', messages: [], unexpectedPrivateField: '/fictional/private/path' }),
    schedulesCreate: async () => ({ status: 'applied', value: { job: { id: 'fictional-job', configRevision: 'revision', sessionKey: 'agent:main:foreign', lastRunError: 'secret /fictional/private', schedule: { kind: 'every', everyMs: 1000, privatePath: '/fictional/private' }, payload: { kind: 'systemEvent', text: 'fictional', secretUrl: 'https://fictional.invalid' }, providerSecret: 'private' }, sourceReference: { version: 1, referenceId: 'schedule:new', topicId: 'topic', sourceSystem: 'scheduler', sourceKind: 'schedule', externalSourceId: 'fictional-job', observedRevision: 'revision', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z', ['sec' + 'ret']: 'private' }, unexpectedNested: 'private' } })
  });
  const handler = registrations.find(([method]) => method === 'command-center.v1.sessions.history')[1];
  let response;
  await handler({ req: { id: 'gateway-frame-history' }, params: { schemaVersion: 1, topicId: 'topic', referenceId: 'session' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.deepEqual(response[1].result, { sessionKey: 'fictional-session', messages: [] });
  assert.doesNotMatch(JSON.stringify(response), /unexpectedPrivateField|private\/path/);

  const scheduleHandler = registrations.find(([method]) => method === 'command-center.v1.schedules.create')[1];
  response = undefined;
  const logicalOperationId = randomUUID();
  await scheduleHandler({ req: { id: 'gateway-frame-schedule' }, params: { schemaVersion: 1, topicId: 'topic', referenceId: 'schedule:new', logicalOperationId, declaration: { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' } } }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.doesNotMatch(JSON.stringify(response), /privatePath|secretUrl|providerSecret|unexpectedNested|lastRunError|sessionKey|foreign|fictional\/private|"secret"/);
});

test('bridge rejects path, URL, and unsupported nested scheduler provider inputs', () => {
  const base = { schemaVersion: 1, topicId: 'topic', referenceId: 'schedule:new', logicalOperationId: randomUUID() };
  for (const declaration of [
    { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional' }, path: '/fictional/private' },
    { name: 'fictional', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'fictional', url: 'https://fictional.invalid' } },
    { name: 'fictional', schedule: { kind: 'stream', command: ['fictional'] }, payload: { kind: 'systemEvent', text: 'fictional' } }
  ]) assert.throws(() => validateBridgeRequest('command-center.v1.schedules.create', { ...base, declaration }), /unsupported/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.update', { ...base, expectedConfigRevision: 'revision', patch: { delivery: { mode: 'webhook', to: 'https://fictional.invalid' } } }), /unsupported/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.analysis.run', { schemaVersion: 1, topicId: 'topic', logicalOperationId: randomUUID(), input: { url: 'https://fictional.invalid' } }), /does not support/i);
});
