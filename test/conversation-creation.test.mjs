import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';
import { createTopicPageActionsHandler } from '../src/topics/page-http.mjs';
import { createRequestScopedConversationRuntime } from '../src/bridge/gateway-method-dispatch.mjs';
import { assertFirstLiveTopicAction } from '../src/release-scope.mjs';

// Only native dispatch/catalog are external fixtures. The owner and SQLite are real.
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'conversation-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  const rows = new Map([['agent:main:dashboard:primary', { sessionId: 'primary-id', updatedAt: 10 }]]);
  const topicId = '44444444-4444-4444-8444-444444444444';
  metadata.createTopic({ topicId, name: 'Fictional', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'primary-ref', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:dashboard:primary', observedRevision: '10' }, state: { referenceId: 'primary-ref', sessionId: 'primary-id', status: 'open', isPrimary: true, displayName: 'Fictional' } });
  const sessionStore = { listSessionEntries: () => [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry })), getSessionEntry: ({ sessionKey }) => rows.get(sessionKey) };
  const service = new AuthoritativeSourceService({ metadata, capabilities: { sessions: true, notes: false, scheduler: false, search: false }, sessionStore });
  const input = { topicId, expectedTopicRevision: 0, logicalOperationId: randomUUID(), label: 'Planning', isPrimary: false };
  let calls = 0;
  const runtime = { creationAuthority: { principalId: 'fictional-operator', assertCurrent() {} }, gatewayRequest: async method => {
    assert.equal(method, 'sessions.create'); calls += 1;
    const key = `agent:main:dashboard:created-${calls}`;
    const entry = { sessionId: `created-id-${calls}`, updatedAt: 20, label: 'Planning' };
    rows.set(key, entry); return { key, sessionId: entry.sessionId, entry };
  } };
  try { await run({ stateDir, metadata, rows, service, input, runtime, sessionStore, calls: () => calls }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('conditional Conversation creation creates once and opens its exact attached native Session', async () => fixture(async ({ service, input, runtime, metadata, calls }) => {
  const result = await service.sessionsCreate(input, runtime);
  assert.equal(result.status, 'applied');
  assert.equal(result.value.sessionId, 'created-id-1');
  assert.equal(result.value.creationRevision, '20');
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'applied');
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).state, 'applied');
  const navigation = await service.sessionsNavigate({ topicId: input.topicId, referenceId: result.value.sourceReference.referenceId, nativeChat: true });
  assert.equal(navigation.sessionId, 'created-id-1');
  assert.deepEqual(await service.sessionsCreate(input, runtime), result);
  assert.equal(calls(), 1);
}));

test('native HTTP creation uses the authenticated transport contract and attaches the exact Conversation once', async () => fixture(async ({ service, input, runtime, calls }) => {
  const context = {};
  const scope = { pluginId: 'command-center', gatewayMethodDispatchAllowed: true,
    client: { authenticatedUserProfile: { profileId: 'fictional-operator' }, connect: { role: 'operator', scopes: ['operator.write'] } },
    resolveGatewayContext: () => context };
  const handler = createTopicPageActionsHandler(service, { assertAction: assertFirstLiveTopicAction,
    createConversationRuntime: () => createRequestScopedConversationRuntime({ getRequestScope: () => scope,
      dispatchGatewayMethod: async (method, params) => {
        assert.equal(params.idempotencyKey, input.logicalOperationId);
        return { ok: true, payload: await runtime.gatewayRequest(method, params) };
      } }) });
  const body = { schemaVersion: 1, action: 'conversations.create', topicId: input.topicId, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedTopicRevision, label: input.label };
  async function submit() {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
    let payload;
    const res = { setHeader() {}, end(value) { payload = JSON.parse(value); } };
    await handler(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(payload));
    return payload;
  }
  const result = await submit();
  assert.equal(result.status, 'applied');
  assert.equal((await service.sessionsNavigate({ topicId: input.topicId, referenceId: result.result.referenceId, nativeChat: true })).sessionId, 'created-id-1');
  assert.deepEqual(await submit(), result);
  assert.equal(calls(), 1);
}));

test('a new creation ID cannot bypass an unacknowledged result after SQLite reopen or principal change', async () => fixture(async ({ stateDir, service, input, runtime, sessionStore, calls }) => {
  const result = await service.sessionsCreate(input, runtime);
  const second = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const reopened = new AuthoritativeSourceService({ metadata: second, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
    for (const principalId of ['fictional-operator', 'another-operator']) {
      await assert.rejects(reopened.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, { ...runtime, creationAuthority: { principalId, assertCurrent() {} } }), { code: 'source-recovery' });
    }
    assert.equal(calls(), 1);
    assert.deepEqual(await reopened.sessionsCreate(input, runtime), result);
  } finally { second.close(); }
}));

test('owned durable creation receipt can be inspected, reconciled and explicitly acknowledged after reload', async () => fixture(async ({ stateDir, service, input, runtime, sessionStore, calls }) => {
  assert.deepEqual(await service.sessionsCreationInspect({ topicId: input.topicId }, runtime), { schemaVersion: 1, status: 'clear' });
  const original = await service.sessionsCreate(input, runtime);
  const second = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const reopened = new AuthoritativeSourceService({ metadata: second, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
    const inspection = await reopened.sessionsCreationInspect({ topicId: input.topicId }, runtime);
    assert.deepEqual(inspection, { schemaVersion: 1, status: 'applied', logicalOperationId: input.logicalOperationId, expectedTopicRevision: 0, label: 'Planning', referenceId: original.value.sourceReference.referenceId });
    assert.deepEqual(await reopened.sessionsCreationReconcile({ topicId: input.topicId, logicalOperationId: input.logicalOperationId }, runtime), original);
    const ack = { topicId: input.topicId, logicalOperationId: input.logicalOperationId, referenceId: inspection.referenceId };
    assert.deepEqual(await reopened.sessionsCreationAcknowledge(ack, runtime), { schemaVersion: 1, status: 'acknowledged', logicalOperationId: input.logicalOperationId, referenceId: inspection.referenceId });
    await reopened.sessionsCreationAcknowledge(ack, runtime);
    assert.deepEqual(await reopened.sessionsCreationInspect({ topicId: input.topicId }, runtime), { schemaVersion: 1, status: 'clear' });
    assert.deepEqual(await reopened.sessionsCreate(input, runtime), original);
    assert.equal((await reopened.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime)).status, 'applied');
    assert.equal(calls(), 2);
  } finally { second.close(); }
}));

test('unknown recovery is non-dispatching and cannot be acknowledged or bypassed by a new ID', async () => fixture(async ({ service, input, runtime, metadata }) => {
  let effects = 0;
  runtime.gatewayRequest = async () => { effects += 1; throw new Error('lost reply'); };
  await service.sessionsCreate(input, runtime);
  const owned = { topicId: input.topicId, logicalOperationId: input.logicalOperationId };
  assert.deepEqual(await service.sessionsCreationInspect({ topicId: input.topicId }, runtime), { schemaVersion: 1, status: 'unknown', logicalOperationId: input.logicalOperationId, expectedTopicRevision: 0, label: 'Planning' });
  assert.deepEqual(await service.sessionsCreationReconcile(owned, runtime), { schemaVersion: 1, status: 'unknown', logicalOperationId: input.logicalOperationId });
  await assert.rejects(service.sessionsCreationAcknowledge({ ...owned, referenceId: 'primary-ref' }, runtime), { code: 'unknown' });
  await assert.rejects(service.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime), { code: 'source-recovery' });
  const missing = randomUUID();
  await assert.rejects(service.sessionsCreationReconcile({ ...owned, logicalOperationId: missing }, runtime), { code: 'source-recovery' });
  assert.equal(metadata.getTopicOperation(missing), null);
  assert.equal(metadata.getOperation(missing), null);
  assert.equal(effects, 1);
}));

test('foreign recovery reveals no private intent and cannot acknowledge an owned receipt', async () => fixture(async ({ service, input, runtime, metadata, calls }) => {
  const result = await service.sessionsCreate(input, runtime);
  const foreign = { ...runtime, creationAuthority: { principalId: 'another-operator', assertCurrent() {} } };
  assert.deepEqual(await service.sessionsCreationInspect({ topicId: input.topicId }, foreign), { schemaVersion: 1, status: 'blocked' });
  const owned = { topicId: input.topicId, logicalOperationId: input.logicalOperationId };
  await assert.rejects(service.sessionsCreationReconcile(owned, foreign), { code: 'source-recovery' });
  await assert.rejects(service.sessionsCreationAcknowledge({ ...owned, referenceId: result.value.sourceReference.referenceId }, foreign), { code: 'source-recovery' });
  await assert.rejects(service.sessionsCreationInspect({ topicId: input.topicId, principalId: 'fictional-operator' }, foreign), { code: 'invalid-request' });
  await assert.rejects(service.sessionsCreationInspect({ topicId: input.topicId }, {}), { code: 'capability-unavailable' });
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).currentStep, 'complete');
  assert.equal(calls(), 1);
}));

test('multiple historical unacknowledged creations remain generically blocked without selecting an intent', async () => fixture(async ({ service, input, runtime, metadata }) => {
  await service.sessionsCreate(input, runtime);
  const original = metadata.getTopicOperation(input.logicalOperationId);
  metadata.recordTopicOperation({ ...original, logicalOperationId: randomUUID() });
  assert.deepEqual(await service.sessionsCreationInspect({ topicId: input.topicId }, runtime), { schemaVersion: 1, status: 'blocked' });
  await assert.rejects(service.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime), { code: 'source-recovery' });
}));

test('acknowledgement requires the exact receipt and current native generation', async () => fixture(async ({ service, input, runtime, metadata, rows }) => {
  const result = await service.sessionsCreate(input, runtime);
  const ack = { topicId: input.topicId, logicalOperationId: input.logicalOperationId, referenceId: result.value.sourceReference.referenceId };
  await assert.rejects(service.sessionsCreationAcknowledge({ ...ack, referenceId: 'primary-ref' }, runtime), { code: 'conflict' });
  rows.set(result.value.key, { sessionId: 'replaced-created-id', updatedAt: 50 });
  await assert.rejects(service.sessionsCreationAcknowledge(ack, runtime), { code: 'source-recovery' });
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).currentStep, 'complete');
  await assert.rejects(service.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime), { code: 'source-recovery' });
}));

test('acknowledgement rechecks its local binding and rolls back when authority retires at publication', async () => fixture(async ({ service, input, runtime, metadata }) => {
  const result = await service.sessionsCreate(input, runtime);
  const ack = { topicId: input.topicId, logicalOperationId: input.logicalOperationId, referenceId: result.value.sourceReference.referenceId };
  runtime.creationAuthority.assertCurrent = () => {
    if (metadata.getTopicOperation(input.logicalOperationId).currentStep === 'acknowledged') throw Object.assign(new Error('retired'), { code: 'forbidden' });
  };
  await assert.rejects(service.sessionsCreationAcknowledge(ack, runtime), { code: 'forbidden' });
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).currentStep, 'complete');
  runtime.creationAuthority.assertCurrent = () => {};
  metadata.setSessionState({ referenceId: ack.referenceId, sessionId: 'rebound-id', status: 'open', isPrimary: false, displayName: 'Rebound' });
  await assert.rejects(service.sessionsCreationAcknowledge(ack, runtime), { code: 'source-recovery' });
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).currentStep, 'complete');
}));

test('reconciliation cannot attach a stored result after authority retires during native verification', async () => fixture(async ({ service, input, runtime, metadata, sessionStore, calls }) => {
  let active = true;
  runtime.creationAuthority.assertCurrent = () => { if (!active) throw Object.assign(new Error('retired'), { code: 'forbidden' }); };
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => { const result = await gateway(...args); active = false; return result; };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'forbidden' });
  active = true;
  const read = sessionStore.getSessionEntry;
  sessionStore.getSessionEntry = request => Promise.resolve().then(() => { active = false; return read(request); });
  await assert.rejects(service.sessionsCreationReconcile({ topicId: input.topicId, logicalOperationId: input.logicalOperationId }, runtime), { code: 'forbidden' });
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).state, 'unknown');
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  sessionStore.getSessionEntry = read;
  active = true;
  assert.equal((await service.sessionsCreationReconcile({ topicId: input.topicId, logicalOperationId: input.logicalOperationId }, runtime)).status, 'applied');
  assert.equal(calls(), 1);
}));

test('inspection validates authority again before disclosing the stored intent', async () => fixture(async ({ service, input, runtime }) => {
  await service.sessionsCreate(input, runtime);
  let checks = 0;
  runtime.creationAuthority.assertCurrent = () => { if (++checks === 3) throw Object.assign(new Error('retired'), { code: 'forbidden' }); };
  await assert.rejects(service.sessionsCreationInspect({ topicId: input.topicId }, runtime), { code: 'forbidden' });
}));

test('lost native reply remains unknown across reopened SQLite and never creates again', async () => fixture(async ({ stateDir, service, input, runtime, metadata }) => {
  let effects = 0;
  runtime.gatewayRequest = async () => { effects += 1; throw Object.assign(new Error('lost reply'), { code: 'timeout' }); };
  assert.equal((await service.sessionsCreate(input, runtime)).status, 'unknown');
  const second = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const resumed = new AuthoritativeSourceService({ metadata: second, capabilities: { sessions: true, notes: false, scheduler: false }, sessionStore: service.defaults.sessionStore });
    assert.equal((await resumed.sessionsCreate(input, runtime)).status, 'unknown');
    assert.equal(effects, 1);
    assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
    assert.equal(second.getOperation(input.logicalOperationId).state, 'unknown');
  } finally { second.close(); }
}));

test('same ID competing owner cannot dispatch while its original native request is pending', async () => fixture(async ({ stateDir, service, input, runtime, sessionStore }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => { started(); await pending; return gateway(...args); };
  const creating = service.sessionsCreate(input, runtime);
  await ready;
  const second = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const competing = new AuthoritativeSourceService({ metadata: second, capabilities: { sessions: true, notes: false, scheduler: false }, sessionStore });
    assert.equal((await competing.sessionsCreate(input, { ...runtime, gatewayRequest: () => { throw new Error('duplicate native dispatch'); } })).status, 'unknown');
  } finally { second.close(); release(); }
  assert.equal((await creating).status, 'applied');
}));

test('changed label, original revision or operator cannot adopt an existing creation ID', async () => fixture(async ({ service, input, runtime }) => {
  await service.sessionsCreate(input, runtime);
  await assert.rejects(service.sessionsCreate({ ...input, label: 'Different' }, runtime), { code: 'intent-mismatch' });
  await assert.rejects(service.sessionsCreate({ ...input, expectedTopicRevision: 1 }, runtime), { code: 'intent-mismatch' });
  await assert.rejects(service.sessionsCreate(input, { ...runtime, creationAuthority: { principalId: 'another-operator', assertCurrent() {} } }), { code: 'intent-mismatch' });
}));

test('missing original revision or trusted authority never falls through to legacy creation', async () => fixture(async ({ service, input, runtime, calls }) => {
  const { expectedTopicRevision: _revision, ...missing } = input;
  await assert.rejects(service.sessionsCreate(missing, runtime), { code: 'invalid-request' });
  await assert.rejects(service.sessionsCreate(input, { gatewayRequest: runtime.gatewayRequest }), { code: 'capability-unavailable' });
  assert.equal(calls(), 0);
}));

for (const drift of ['Topic', 'Primary']) test(`${drift} changes during native creation retain an unattached result, not a fresh CAS base`, async () => fixture(async ({ service, input, runtime, metadata, calls }) => {
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => {
    const result = await gateway(...args);
    if (drift === 'Topic') metadata.setTopicName({ topicId: input.topicId, name: 'Later edit', expectedRevision: 0 });
    else metadata.setSessionState({ referenceId: 'primary-ref', sessionId: 'replacement-primary-id', status: 'open', isPrimary: true, displayName: 'Changed' });
    return result;
  };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'conflict' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).result.nativeResult.sessionId, 'created-id-1');
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'conflict' });
  await assert.rejects(service.sessionsCreationReconcile({ topicId: input.topicId, logicalOperationId: input.logicalOperationId }, runtime), { code: 'conflict' });
  assert.equal(calls(), 1);
}));

test('retired authority after native response retains evidence but never attaches', async () => fixture(async ({ service, input, runtime, metadata }) => {
  let active = true;
  runtime.creationAuthority.assertCurrent = () => { if (!active) throw Object.assign(new Error('retired'), { code: 'forbidden' }); };
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => { const result = await gateway(...args); active = false; return result; };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'forbidden' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).result.nativeResult.sessionId, 'created-id-1');
}));

test('native reset at the returned key is not mistaken for the created Conversation', async () => fixture(async ({ service, input, runtime, metadata, rows }) => {
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => { const result = await gateway(...args); rows.set(result.key, { sessionId: 'replacement-id', updatedAt: 30 }); return result; };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'source-recovery' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  assert.equal(metadata.getOperation(input.logicalOperationId).observedRevision, '20');
}));

test('native Primary replacement during creation prevents local publication', async () => fixture(async ({ service, input, runtime, metadata, rows }) => {
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => { const result = await gateway(...args); rows.set('agent:main:dashboard:primary', { sessionId: 'replaced-primary', updatedAt: 30 }); return result; };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'source-recovery' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
}));

for (const phase of ['before-dispatch', 'lost-reply', 'before-attachment']) test(`process death ${phase} never redispatches the claimed Conversation`, async () => fixture(async ({ stateDir, service, input, runtime, metadata, rows, calls }) => {
  const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/conversation-creation-interrupted.mjs', stateDir, JSON.stringify(input), phase], { encoding: 'utf8', timeout: 45000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  if (phase === 'before-dispatch') await assert.rejects(access(path.join(stateDir, 'fictional-native-effect.json')), { code: 'ENOENT' });
  else {
    const effect = JSON.parse(await readFile(path.join(stateDir, 'fictional-native-effect.json'), 'utf8'));
    rows.set(effect.key, effect.entry);
  }
  const resumed = await service.sessionsCreate(input, runtime);
  assert.equal(calls(), 0);
  if (phase === 'before-attachment') {
    assert.equal(resumed.status, 'applied');
    assert.equal(resumed.value.sessionId, 'interrupted-id');
    assert.equal(resumed.value.creationRevision, '20');
    assert.equal(metadata.listSourceReferences(input.topicId).length, 2);
  } else {
    assert.equal(resumed.status, 'unknown');
    assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  }
  assert.equal((await service.sessionsCreationInspect({ topicId: input.topicId }, runtime)).status, resumed.status);
  assert.deepEqual(await service.sessionsCreationReconcile({ topicId: input.topicId, logicalOperationId: input.logicalOperationId }, runtime), resumed);
  await assert.rejects(service.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime), { code: 'source-recovery' });
  assert.equal(calls(), 0);
}));

for (const phase of ['after-completion', 'after-acknowledgement']) test(`process death ${phase} preserves durable acknowledgement ownership after reopening SQLite`, async () => fixture(async ({ stateDir, input, runtime, sessionStore, rows, calls }) => {
  const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/conversation-creation-interrupted.mjs', stateDir, JSON.stringify(input), phase], { encoding: 'utf8', timeout: 45000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const effect = JSON.parse(await readFile(path.join(stateDir, 'fictional-native-effect.json'), 'utf8'));
  rows.set(effect.key, effect.entry);
  const second = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const reopened = new AuthoritativeSourceService({ metadata: second, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
    const before = second.getTopicOperation(input.logicalOperationId);
    assert.equal(before.state, 'applied');
    const lookup = { topicId: input.topicId, logicalOperationId: input.logicalOperationId };
    if (phase === 'after-completion') {
      assert.equal((await reopened.sessionsCreationInspect({ topicId: input.topicId }, runtime)).status, 'applied');
      await assert.rejects(reopened.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime), { code: 'source-recovery' });
      const recovered = await reopened.sessionsCreationReconcile(lookup, runtime);
      assert.deepEqual(recovered.value, before.result.value);
      assert.equal(recovered.value.sessionId, 'interrupted-id');
      await reopened.sessionsCreationAcknowledge({ ...lookup, referenceId: recovered.value.sourceReference.referenceId }, runtime);
    }
    assert.deepEqual(await reopened.sessionsCreationInspect({ topicId: input.topicId }, runtime), { schemaVersion: 1, status: 'clear' });
    assert.deepEqual((await reopened.sessionsCreate(input, runtime)).value, before.result.value);
    assert.deepEqual(second.getTopicOperation(input.logicalOperationId).result, before.result);
    assert.equal(calls(), 0);
    assert.equal((await reopened.sessionsCreate({ ...input, logicalOperationId: randomUUID() }, runtime)).status, 'applied');
    assert.equal(calls(), 1);
  } finally { second.close(); }
}));

test('another process with a new ID cannot bypass an in-flight Conversation dispatch claim', async () => fixture(async ({ stateDir, service, input, runtime }) => {
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => {
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/conversation-creation-interrupted.mjs', stateDir, JSON.stringify({ ...input, logicalOperationId: randomUUID() }), 'competing-new'], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { code: 'source-recovery' });
    await assert.rejects(access(path.join(stateDir, 'fictional-native-effect.json')), { code: 'ENOENT' });
    return gateway(...args);
  };
  assert.equal((await service.sessionsCreate(input, runtime)).status, 'applied');
}));

test('another process cannot execute a claimed Conversation while its caller is awaiting native creation', async () => fixture(async ({ stateDir, service, input, runtime }) => {
  const gateway = runtime.gatewayRequest;
  runtime.gatewayRequest = async (...args) => {
    const child = spawnSync(process.execPath, ['--import', './test/fixtures/note-runtime-loader.mjs', './test/fixtures/conversation-creation-interrupted.mjs', stateDir, JSON.stringify(input), 'competing'], { encoding: 'utf8', timeout: 45000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, 'unknown');
    await assert.rejects(access(path.join(stateDir, 'fictional-native-effect.json')), { code: 'ENOENT' });
    return gateway(...args);
  };
  assert.equal((await service.sessionsCreate(input, runtime)).status, 'applied');
}));

test('applied creation receipt does not acquire a later native revision or local Topic base', async () => fixture(async ({ service, input, runtime, metadata, rows }) => {
  const result = await service.sessionsCreate(input, runtime);
  rows.get(result.value.key).updatedAt = 99;
  metadata.setTopicName({ topicId: input.topicId, name: 'Later change', expectedRevision: 0 });
  assert.deepEqual(await service.sessionsCreate(input, runtime), result);
  assert.equal(metadata.getOperation(input.logicalOperationId).observedRevision, '20');
}));

test('stale original Topic base is rejected before any native creation or dispatch claim', async () => fixture(async ({ service, input, runtime, metadata, calls }) => {
  metadata.setTopicName({ topicId: input.topicId, name: 'Already changed', expectedRevision: 0 });
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'conflict' });
  assert.equal(calls(), 0);
  assert.equal(metadata.getTopicOperation(input.logicalOperationId), null);
}));

test('authority retirement during delayed result verification preserves unknown without attachment', async () => fixture(async ({ service, input, runtime, metadata, sessionStore }) => {
  let active = true;
  runtime.creationAuthority.assertCurrent = () => { if (!active) throw Object.assign(new Error('retired'), { code: 'forbidden' }); };
  const read = sessionStore.getSessionEntry;
  sessionStore.getSessionEntry = request => {
    const entry = read(request);
    if (request.sessionKey.includes('created')) return Promise.resolve().then(() => { active = false; return entry; });
    return entry;
  };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'forbidden' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'unknown');
}));

test('a final authority refusal rolls back attachment, Session state and completion receipts together', async () => fixture(async ({ service, input, runtime, metadata }) => {
  runtime.creationAuthority.assertCurrent = () => {
    if (metadata.listSourceReferences(input.topicId).length > 1) throw Object.assign(new Error('publication refused'), { code: 'forbidden' });
  };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'forbidden' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  assert.equal(metadata.listSessionStates().length, 1);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'unknown');
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).state, 'unknown');
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).result.nativeResult.sessionId, 'created-id-1');
}));

test('read-only replay of completed creation does not reapply the original Primary precondition', async () => fixture(async ({ service, input, runtime, metadata, rows }) => {
  const result = await service.sessionsCreate(input, runtime);
  rows.set('agent:main:dashboard:primary', { sessionId: 'later-primary-id', updatedAt: 30 });
  metadata.setSessionState({ referenceId: 'primary-ref', sessionId: 'later-primary-id', status: 'open', isPrimary: true, displayName: 'Later Primary' });
  assert.deepEqual(await service.sessionsCreate(input, runtime), result);
}));
