import assert from 'node:assert/strict';
import test from 'node:test';
import { BRIDGE_CONTRACTS, READ_METHODS, WRITE_METHODS, validateBridgeRequest } from '../src/bridge/contracts.mjs';
import { invokeBridgeMethod, registerBridgeMethods } from '../src/bridge/register.mjs';
import { randomUUID } from 'node:crypto';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';

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
  for (const method of ['command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.close', 'command-center.v1.sessions.reopen']) {
    assert.equal(BRIDGE_CONTRACTS[method].paramsSchema.required.includes('referenceId'), true);
  }
});

test('closed bridge validation rejects unversioned, extra-field, and non-UUID mutation requests', () => {
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { topicId: 'topic', referenceId: 'note:a', path: 'a.md' }), /schemaVersion/);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 'topic', referenceId: 'note:a', path: 'a.md', extra: true }), /unsupported.*field/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 'topic', path: 'a.md' }), /referenceId/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 'topic', referenceId: 'note:a', path: 'a.md' }), /offset/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 'topic', referenceId: 'note:a', path: 'a.md', offset: 0 }));
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', referenceId: 'note:a', path: 'a.md', expectedRevision: 'sha256:x', text: 'x', logicalOperationId: 'not-a-uuid' }), /canonical.*logical/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', referenceId: 'note:a', path: 'a.md', expectedRevision: 'sha256:x', text: 'x', logicalOperationId: randomUUID() }));
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', path: 'a.md', expectedRevision: 'sha256:x', text: 'x', logicalOperationId: randomUUID() }), /referenceId/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.reminders.complete', { schemaVersion: 1, topicId: 'topic', referenceId: 'reminder', expectedConfigRevision: 'revision', patch: { payload: {} }, logicalOperationId: randomUUID() }), /unsupported.*patch/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.reminders.create', { schemaVersion: 1, topicId: 'topic', declaration: { name: 'Fictional reminder', schedule: { kind: 'at', at: '2026-08-30T00:00:00.000Z' }, payload: { kind: 'systemEvent', text: 'Fictional reminder' } }, logicalOperationId: randomUUID() }));
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.set-enabled', { schemaVersion: 1, topicId: 'topic', referenceId: 'schedule', expectedConfigRevision: 'revision', enabled: false, patch: { schedule: {} }, logicalOperationId: randomUUID() }), /unsupported.*patch/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.send', { schemaVersion: 1, topicId: 'topic', message: 'fictional', logicalOperationId: randomUUID() }), /exact Source Reference/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.run', { schemaVersion: 1, topicId: 'topic', logicalOperationId: randomUUID() }), /exact Source Reference/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.edit', { schemaVersion: 1, topicId: 'topic', referenceId: 'note:a', path: 'a.md', text: 'x', logicalOperationId: randomUUID() }), /expectedRevision/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.notes.read', { schemaVersion: 1, topicId: 42, referenceId: 'note:a', path: 'a.md', offset: 0 }), /topicId.*string/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.schedules.set-enabled', { schemaVersion: 1, topicId: 'topic', referenceId: 'schedule', expectedConfigRevision: 'revision', enabled: 'false', logicalOperationId: randomUUID() }), /enabled.*boolean/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.search.query', { schemaVersion: 1, topicId: 'topic', query: 'fictional', limit: 0 }), /limit/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.search.prepare-rebuild', { schemaVersion: 1, topicId: randomUUID(), logicalOperationId: randomUUID() }));
  assert.throws(() => validateBridgeRequest('command-center.v1.search.prepare-rebuild', { schemaVersion: 1, topicId: randomUUID(), logicalOperationId: randomUUID(), credential: 'forbidden' }), /unsupported.*credential/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.metadata.read', { schemaVersion: 1, referenceId: 'foreign-reference' }), /topicId/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.history', { schemaVersion: 1, topicId: 'topic', referenceId: 'session', sessionId: 'foreign-session' }), /unsupported.*sessionId/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: 'topic' }));
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: 'topic', includeClosed: true }));
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.create', { schemaVersion: 1, topicId: 'topic', label: 'Authenticated Conversation', isPrimary: false, logicalOperationId: randomUUID() }), /authoritativeSession/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.topics.create', { schemaVersion: 1, topicId: randomUUID(), name: 'Authenticated Topic', paraCategory: 'project', logicalOperationId: randomUUID() }), /authoritativeSession/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: 'topic', includeClosed: 'true' }), /includeClosed.*boolean/i);
  assert.throws(() => validateBridgeRequest('command-center.v1.sessions.list', { schemaVersion: 1, topicId: 'topic' }), /unsupported.*bridge method/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.topics.structural-change.confirm', { schemaVersion: 1, topicId: randomUUID(), structuralChangeId: randomUUID(), paraCategory: 'area', previewDigest: 'sha256:preview', expectedRevision: 4, expectedRevisions: [], logicalOperationId: randomUUID() }));
  assert.throws(() => validateBridgeRequest('command-center.v1.topics.rename', { schemaVersion: 1, topicId: randomUUID(), name: 'Fictional rename', logicalOperationId: randomUUID() }), /expectedRevision/i);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.topics.recovery.verify', { schemaVersion: 1, topicId: randomUUID(), referenceId: 'note-folder:fictional', expectedRevision: 4, expectedSourceRevision: 'fs:1:2:3', logicalOperationId: randomUUID() }));
  for (const attachment of [{ path: '/fictional/private.md' }, { url: 'https://fictional.invalid/private' }]) {
    assert.throws(() => validateBridgeRequest('command-center.v1.sessions.send', { schemaVersion: 1, topicId: 'topic', referenceId: 'session', message: 'fictional', attachments: [attachment], logicalOperationId: randomUUID() }), /unsupported.*attachments/i);
  }
});

test('Session browse bridge invokes the closed exact Topic listing without a Session locator', async () => {
  const calls = [];
  const conversation = { referenceId: 'session:fictional', topicId: 'topic-fictional', sessionId: 'session-id', displayName: 'Fictional Conversation', status: 'open', isPrimary: true, wasPrimary: false, updatedAt: '2026-08-27T00:00:00.000Z' };
  const result = await invokeBridgeMethod({ sessionsList: async (input) => { calls.push(input); return { schemaVersion: 1, topicId: input.topicId, conversations: [conversation] }; } }, 'command-center.v1.sessions.browse', { schemaVersion: 1, topicId: 'topic-fictional', includeClosed: true });
  assert.deepEqual(calls, [{ schemaVersion: 1, topicId: 'topic-fictional', includeClosed: true }]);
  assert.deepEqual(result, { schemaVersion: 1, topicId: 'topic-fictional', conversations: [{ referenceId: conversation.referenceId, sessionId: conversation.sessionId, displayName: conversation.displayName, status: conversation.status, isPrimary: true, wasPrimary: false, updatedAt: conversation.updatedAt }] });
  await assert.rejects(
    () => invokeBridgeMethod({ sessionsList: async () => ({ schemaVersion: 1, topicId: 'topic-fictional', conversations: [{ ...conversation, displayName: undefined, name: 'Legacy label' }] }) }, 'command-center.v1.sessions.browse', { schemaVersion: 1, topicId: 'topic-fictional' }),
    /displayName|unsupported.*name/i
  );
  assert.equal('sessionKey' in result.conversations[0], false);
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

test('registered Session send preserves the live authenticated host turn principal', async () => {
  const registrations = [];
  const dispatched = [];
  const logicalOperationId = randomUUID();
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
    sessionsSend: async (input, runtime) => ({
      schemaVersion: 1,
      status: 'applied',
      logicalOperationId: input.logicalOperationId,
      value: await runtime.agentTurnDispatch({
        sessionKey: 'agent:main:dashboard:bridge-fictional',
        sessionId: 'fictional-session-id',
        message: input.message,
        runId: input.logicalOperationId
      })
    })
  });
  const handler = registrations.find(([method]) => method === 'command-center.v1.sessions.send')[1];
  let response;
  const client = { authenticatedUserId: 'fictional-operator' };
  const isWebchatConnect = () => false;
  await handler({
    req: { id: 'gateway-send-1' },
    params: { schemaVersion: 1, topicId: 'fictional-topic', referenceId: 'session:fictional', message: 'Fictional authenticated message', logicalOperationId },
    client,
    isWebchatConnect,
    context: {
      authenticated: true,
      getGatewayMethodRegistry: () => ({
        getHandler: (method) => {
          assert.equal(method, 'sessions.send');
          return async (request) => {
            assert.equal(request.client, client);
            assert.equal(request.isWebchatConnect, isWebchatConnect);
            dispatched.push(request);
            request.respond(true, { runId: logicalOperationId, status: 'started' });
          };
        }
      })
    },
    respond: (...args) => { response = args; }
  });
  assert.equal(response[0], true);
  assert.deepEqual(dispatched[0].params, {
    key: 'agent:main:dashboard:bridge-fictional',
    agentId: 'main',
    message: 'Fictional authenticated message',
    idempotencyKey: logicalOperationId
  });
  assert.equal(response[1].result.value.runId, logicalOperationId);
});

test('authenticated Search rebuild preparation exposes only bounded operation evidence', async () => {
  const logicalOperationId = randomUUID();
  const result = await invokeBridgeMethod({
    searchPrepareRebuild: async () => ({ schemaVersion: 1, status: 'prepared', topicIds: ['fictional-topic'] })
  }, 'command-center.v1.search.prepare-rebuild', { schemaVersion: 1, topicId: 'fictional-topic', logicalOperationId });
  assert.deepEqual(result, { schemaVersion: 1, status: 'prepared', topicIds: ['fictional-topic'] });
});

test('registered Session create bridge preserves independent durable identities under reversed completion', async () => {
  const registrations = [];
  const completions = [];
  let releaseReady;
  const ready = Promise.race([
    new Promise((resolve) => { releaseReady = resolve; }),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000))
  ]);
  const durable = new Map();
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
    sessionsCreate: ({ topicId, logicalOperationId }) => new Promise((resolve) => { completions.push(() => {
      const ordinal = durable.size + 1;
      const value = { key: `agent:main:dashboard:bridge-${ordinal}`, sessionId: `fictional-bridge-session-${ordinal}`, creationRevision: String(ordinal), sourceReference: { version: 1, referenceId: `session:${topicId}:bridge-${ordinal}`, topicId, sourceSystem: 'openclaw', sourceKind: 'session' } };
      durable.set(logicalOperationId, value);
      resolve({ schemaVersion: 1, status: 'applied', logicalOperationId, value });
    }); if (completions.length === 3) releaseReady(true); })
  });
    const handler = registrations.find(([method]) => method === 'command-center.v1.sessions.create')[1];
    const operations = Array.from({ length: 3 }, () => randomUUID());
    const responses = [];
  const pending = operations.map((logicalOperationId, index) => handler({ req: { id: `bridge-create-${index}` }, params: { schemaVersion: 1, topicId: 'topic-bridge-interleaving', label: `Bridge ${index}`, isPrimary: false, logicalOperationId, authoritativeSession: { key: `agent:main:dashboard:${index}`, sessionId: `session-${index}`, revision: String(index + 1), idempotencyKey: logicalOperationId, label: `Bridge ${index}` } }, context: { authenticated: true }, respond: (...args) => { responses[index] = args; } }));
  assert.equal(await ready, true, 'registered Session creates did not reach the controlled completion barrier');
  for (const complete of completions.reverse()) complete();
  await Promise.all(pending);
    assert.equal(responses.every(([ok]) => ok === true), true);
    assert.equal(new Set(responses.map(([, payload]) => payload.result.value.key)).size, operations.length);
  for (const operationId of operations) assert.ok(durable.has(operationId));
});

test('Reminder creation uses the authenticated scheduler declaration boundary without a pre-existing reference', async () => {
  const registrations = [];
  const calls = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
    remindersCreate: async (input) => { calls.push(input); return { schemaVersion: 1, status: 'applied', logicalOperationId: input.logicalOperationId, value: { job: { id: 'fictional-reminder', enabled: true, schedule: { kind: 'at', at: '2026-08-30T00:00:00.000Z' }, payload: { kind: 'systemEvent', text: 'Fictional reminder' } } } }; }
  });
  const handler = registrations.find(([method]) => method === 'command-center.v1.reminders.create')[1];
  const logicalOperationId = randomUUID();
  let response;
  await handler({ req: { id: 'gateway-reminder-create' }, params: { schemaVersion: 1, topicId: 'topic-fictional', declaration: { name: 'Fictional reminder', enabled: true, schedule: { kind: 'at', at: '2026-08-30T00:00:00.000Z' }, payload: { kind: 'systemEvent', text: 'Fictional reminder' } }, logicalOperationId }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.equal(calls[0].topicId, 'topic-fictional');
  assert.equal(response[1].result.value.job.id, 'fictional-reminder');
});

test('Topic mutation handlers await the public service and return sanitized durable results', async () => {
  const registrations = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
    topics: {
      create: async () => ({ status: 'applied', logicalOperationId: 'logical-topic-create', topic: { topicId: 'topic-fictional', name: 'Fictional Topic', activatedAt: '2026-08-30T12:00:00.000Z', sourceReferences: [{ version: 1, referenceId: 'session:fictional', topicId: 'topic-fictional', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:private-session' }], locators: [{ referenceId: 'note-folder:fictional', locatorVersion: 1, locator: '/fictional/private/Topics/Fictional Topic', observedRevision: 'fs:1:2:3' }], privateField: 'withheld' } })
    }
  });
  const handler = registrations.find(([method]) => method === 'command-center.v1.topics.create')[1];
  let response;
  const logicalOperationId = randomUUID();
  await handler({ req: { id: 'gateway-frame-topic' }, params: { schemaVersion: 1, topicId: randomUUID(), name: 'Fictional Topic', paraCategory: 'project', logicalOperationId, authoritativeSession: { key: 'agent:main:dashboard:topic', sessionId: 'session-topic', revision: '1', idempotencyKey: logicalOperationId, label: 'Fictional Topic' } }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  assert.equal(response[1].result.value.status, 'applied');
  assert.equal(response[1].result.value.topic.topicId, 'topic-fictional');
  assert.equal(response[1].result.value.topic.activatedAt, '2026-08-30T12:00:00.000Z');
  assert.equal(response[1].result.value.topic.privateField, undefined);
  assert.equal(response[1].result.value.topic.sourceReferences[0].externalSourceId, undefined);
  assert.equal(response[1].result.value.topic.locators[0].locator, undefined);
  assert.doesNotMatch(JSON.stringify(response), /private-session|fictional\/private/);
});

test('Topic get withholds raw locators and external source identities', async () => {
  const topicId = randomUUID();
  const topic = {
    topicId,
    name: 'Fictional Topic',
    revision: 4,
    paraCategory: 'project',
    lifecycle: 'active',
    activatedAt: '2026-08-30T12:00:00.000Z',
    sourceReferences: [{ version: 1, referenceId: 'note-folder:fictional', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/private/Topics/Fictional Topic', observedRevision: 'fs:1:2:3' }],
    locators: [{ referenceId: 'note-folder:fictional', locatorVersion: 2, locator: '/fictional/private/Topics/Fictional Topic', ownership: 'managed', observedRevision: 'fs:1:2:3' }]
  };
  const result = await invokeBridgeMethod({ topics: { getVerified: async () => topic } }, 'command-center.v1.topics.get', { schemaVersion: 1, topicId });
  assert.equal(result.topic.activatedAt, topic.activatedAt);
  assert.equal(result.topic.sourceReferences[0].externalSourceId, undefined);
  assert.equal(result.topic.locators[0].locator, undefined);
  assert.equal(result.topic.locators[0].observedRevision, 'fs:1:2:3');
  assert.doesNotMatch(JSON.stringify(result), /fictional\/private/);
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

test('generic metadata writes cannot bypass Topic provisioning', async () => {
  const service = new AuthoritativeSourceService({ metadata: { createTopic() { throw new Error('must not dispatch'); } }, capabilities: {} });
  await assert.rejects(service.metadataWrite({ schemaVersion: 1, operation: 'topic', value: { topicId: 'corrupt', lifecycle: 'active' }, logicalOperationId: randomUUID() }), /Unsupported metadata operation/);
});

test('generic Topic-owned metadata writes honor archived read-only policy', async () => {
  let dispatched = false;
  const service = new AuthoritativeSourceService({
    metadata: {
      getTopic() { return { topicId: 'archived-topic', lifecycle: 'active', paraCategory: 'archive' }; },
      setPresentationPreferences() { dispatched = true; }
    },
    capabilities: {}
  });
  await assert.rejects(service.metadataWrite({ schemaVersion: 1, operation: 'preferences', value: { topicId: 'archived-topic', displayLabel: 'Forbidden' }, logicalOperationId: randomUUID() }), /read-only/i);
  assert.equal(dispatched, false);
});

test('Topics list sanitizes active, provisioning, recovery, archived, and retired collections', async () => {
  const topic = { topicId: 'topic-list', name: 'Fictional', revision: 'r1', paraCategory: 'project', lifecycle: 'active', activatedAt: '2026-08-30T12:00:00.000Z', usable: true, noteFolderReferenceId: 'note-folder:fictional', recovery: [], sourceReferences: [], locators: [], privateField: 'withheld' };
  const result = await invokeBridgeMethod({ topics: { listDestination: () => ({ activeGroups: { project: [topic], area: [], resource: [] }, provisioning: [topic], recovery: [topic], archived: [topic], retired: [topic] }) } }, 'command-center.v1.topics.list', { schemaVersion: 1 });
  assert.deepEqual(Object.keys(result).sort(), ['activeGroups', 'archived', 'provisioning', 'recovery', 'retired']);
  for (const publicTopic of [result.activeGroups.project[0], result.provisioning[0], result.recovery[0], result.archived[0], result.retired[0]]) {
    assert.equal(publicTopic.activatedAt, topic.activatedAt);
    assert.equal(publicTopic.noteFolderReferenceId, topic.noteFolderReferenceId);
  }
  assert.equal(result.archived[0].privateField, undefined);
  assert.equal(result.retired[0].privateField, undefined);
});

test('Source Recovery status is bounded and omits authoritative identities', async () => {
  const registrations = [];
  const topicId = randomUUID();
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, { topics: {
    async inspectSourceRecovery() {
      return { recoveryId: 'recovery:fictional', topicId, referenceId: 'note-folder:fictional', sourceKind: 'note_folder', state: 'required', lastLocator: '/fictional/private', lastIdentity: 'private-identity', failure: 'private failure', diagnostics: [{ check: 'exact-folder-resolution', lastLocator: '/fictional/private' }] };
    }
  } });
  const handler = registrations.find(([method]) => method === 'command-center.v1.topics.recovery.status')[1];
  let response;
  await handler({ req: { id: 'gateway-recovery-status' }, params: { schemaVersion: 1, topicId, referenceId: 'note-folder:fictional' }, context: { authenticated: true }, respond: (...args) => { response = args; } });
  assert.equal(response[0], true);
  const serialized = JSON.stringify(response[1]);
  assert.doesNotMatch(serialized, /fictional\/private|private-identity|private failure/);
  assert.deepEqual(response[1].result.recovery.diagnostics[0], { topicId, referenceId: 'note-folder:fictional', sourceKind: 'note_folder', expectedIdentity: 'exact Note Folder identity', check: 'exact-folder-resolution', status: 'recovery-required', retryable: true });
});

test('Session recovery replacement exposes only the durable replacement reference identity', async () => {
  const topicId = randomUUID();
  const replacementReferenceId = `session:${topicId}:replacement`;
  const result = await invokeBridgeMethod({ topics: { recoveryReplace: async () => ({ schemaVersion: 1, status: 'replaced', replacementReferenceId, privateLocator: 'agent:main:private' }) } }, 'command-center.v1.topics.recovery.replace', {
    schemaVersion: 1, topicId, referenceId: `session:${topicId}:revoked`, sessionKey: 'agent:main:dashboard:replacement', sessionId: 'fictional-replacement-session', expectedRevision: 4, expectedSourceRevision: 'fictional-revoked-session', logicalOperationId: randomUUID()
  });
  assert.deepEqual(result, { schemaVersion: 1, status: 'replaced', replacementReferenceId });
});

test('Structural Change bridge previews omit private Note Folder locators', async () => {
  const topicId = randomUUID();
  const preview = (kind, from, to) => ({
        kind, topicId, structuralChangeId: randomUUID(), from, to, digest: `sha256:fictional-${kind}-preview`,
        expectedRevisions: [{ source: 'topic', id: topicId, revision: 1 }],
        changes: [
          { aspect: 'category', from, to },
          { aspect: 'note-folder-location', from: `/fictional/private/${from}/Topic`, to: `/fictional/private/${to}/Topic`, managed: true }
        ]
      });
  const service = { topics: {
    recategorizationPreview: () => preview('recategorization', 'project', 'area'),
    archivePreview: async () => preview('archive', 'area', 'archive'),
    restorePreview: () => preview('restore', 'archive', 'resource')
  } };
  for (const [method, params] of [
    ['command-center.v1.topics.structural-change.preview', { paraCategory: 'area' }],
    ['command-center.v1.topics.archive.preview', {}],
    ['command-center.v1.topics.restore.preview', { paraCategory: 'resource' }]
  ]) {
    const result = await invokeBridgeMethod(service, method, { schemaVersion: 1, topicId, expectedRevision: 1, logicalOperationId: randomUUID(), ...params });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /fictional\/private|\/(?:project|area|archive|resource)\/Topic/);
    assert.deepEqual(result.preview.changes[1], { aspect: 'note-folder-location', managed: true, fromConvention: 'current-managed', toConvention: 'target-conventional' });
  }
});
