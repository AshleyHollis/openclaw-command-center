import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTopicPageActionsHandler, topicPageActionRoute } from '../src/topics/page-http.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';

const topicId = '11111111-1111-4111-8111-111111111111';
const folderId = 'note-folder:fictional-topic';
const noteId = 'note:fictional-topic:brief';
const sessionId = 'session:fictional-topic:conversation';

function fixtureService() {
  const calls = [];
  const refs = [
    { referenceId: folderId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folderId, observedRevision: 'folder-revision' },
    { referenceId: noteId, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/notes/topic/brief.md', observedRevision: 'note-revision' },
    { referenceId: sessionId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional', observedRevision: null }
  ];
  const service = {
    calls,
    metadata: { getSourceLocator(referenceId) { return referenceId === folderId ? { referenceId, locator: '/fictional/notes/topic' } : null; } },
    topics: { get() { return { topicId, revision: 4, lifecycle: 'active', paraCategory: 'project' }; } },
    getTopicSourceReference({ topicId: requestedTopicId, referenceId }) {
      const value = refs.find((reference) => reference.referenceId === referenceId && reference.topicId === requestedTopicId);
      if (!value) throw Object.assign(new Error('missing reference'), { code: 'source-recovery' });
      return value;
    },
    listTopicSourceReferences() { return refs; },
    async sessionsCreate(input) { calls.push(['sessionsCreate', input]); return { status: 'applied', referenceId: 'session:new', sessionId: 'session-new' }; },
    async sessionsSend(input) { calls.push(['sessionsSend', input]); return { status: 'applied' }; },
    async sessionsClose(input) { calls.push(['sessionsClose', input]); return { status: 'applied', referenceId: input.referenceId }; },
    async notesCreate(input) { calls.push(['notesCreate', input]); return { status: 'applied', note: { path: input.path, revision: 'created-revision' } }; },
    async notesEdit(input) { calls.push(['notesEdit', input]); return { status: 'applied', note: { path: input.path, revision: 'note-revision-2' } }; },
    async notesRename(input) { calls.push(['notesRename', input]); return { status: 'applied', note: { path: input.destinationPath, previousPath: input.path, revision: input.expectedRevision } }; },
    async notesMove(input) { calls.push(['notesMove', input]); return { status: 'applied', note: { path: input.destinationPath, previousPath: input.path, revision: input.expectedRevision } }; }
  };
  return service;
}

async function invoke(service, { method = 'POST', body = {}, headers = { 'content-type': 'application/json' }, dispatchGatewayMethod } = {}) {
  const request = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(request, { method, headers });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  await createTopicPageActionsHandler(service, { dispatchGatewayMethod })(request, response);
  return { statusCode: response.statusCode, headers: response.headers, body: response.body ? JSON.parse(response.body) : null };
}

function base(action, fields = {}) {
  return { schemaVersion: 1, action, topicId, logicalOperationId: randomUUID(), ...fields };
}

function conversationCreate(fields = {}) {
  const logicalOperationId = fields.logicalOperationId ?? randomUUID();
  const label = fields.label ?? 'Fictional Conversation';
  return base('conversations.create', { expectedRevision: 4, ...fields, label, logicalOperationId, authoritativeSession: { key: `agent:main:dashboard:${logicalOperationId}`, sessionId: `session-${logicalOperationId}`, revision: '1', idempotencyKey: logicalOperationId, label } });
}

test('Topic Page actions are POST-only, closed, bounded, and content-free', async () => {
  const service = fixtureService();
  assert.equal(topicPageActionRoute, '/plugins/command-center/api/topic/actions');
  assert.equal((await invoke(service, { method: 'GET' })).statusCode, 405);
  const preflight = await invoke(service, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.body, null);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'null');
  assert.equal(preflight.headers['Access-Control-Allow-Credentials'], undefined);
  assert.equal(preflight.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(preflight.headers['Access-Control-Allow-Headers'], 'Content-Type');
  assert.equal(preflight.headers['Access-Control-Allow-Private-Network'], 'true');
  for (const headers of [
    { origin: 'null' },
    { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' },
    { origin: 'null', 'access-control-request-method': 'POST' },
    { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' },
    {},
    { 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' },
    { 'access-control-request-method': 'POST' },
    { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' }
  ]) {
    const malformed = await invoke(service, { method: 'OPTIONS', headers });
    assert.equal(malformed.statusCode, 403);
    assert.equal(malformed.headers['Access-Control-Allow-Origin'], undefined);
  }
  const opaqueSameSitePreflight = await invoke(service, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(opaqueSameSitePreflight.statusCode, 204);
  assert.equal(opaqueSameSitePreflight.headers['Access-Control-Allow-Origin'], 'null');
  assert.equal(opaqueSameSitePreflight.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(opaqueSameSitePreflight.headers['Access-Control-Allow-Headers'], 'Content-Type');
  assert.equal(opaqueSameSitePreflight.headers['Access-Control-Allow-Private-Network'], 'true');
  const rejectedPrivateNetwork = await invoke(service, { method: 'OPTIONS', headers: { origin: 'https://fictional.invalid', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  assert.equal(rejectedPrivateNetwork.statusCode, 403);
  assert.equal(rejectedPrivateNetwork.headers['Access-Control-Allow-Private-Network'], undefined);
  assert.equal(service.calls.length, 0);
  assert.equal((await invoke(service, { body: { ...base('conversations.create', { expectedRevision: 4 }), extra: true } })).statusCode, 400);
  for (const obsoleteAction of ['session.create', 'session.send', 'session.close', 'session.reopen', 'note.create', 'note.edit', 'note.rename', 'note.move']) {
    assert.equal((await invoke(service, { body: base(obsoleteAction, { expectedRevision: 4 }) })).statusCode, 400);
  }
  const oversized = await invoke(service, { body: JSON.stringify(base('conversations.create', { expectedRevision: 4, label: 'x'.repeat(12 * 1024 * 1024) })) });
  assert.equal(oversized.statusCode, 400);
  assert.doesNotMatch(JSON.stringify(oversized.body), /x{100}/u);
  const applied = await invoke(service, { body: conversationCreate() });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.body.result.referenceId, 'session:new');
  assert.doesNotMatch(JSON.stringify(applied.body), /fictional\/notes|agent:main|session-new/u);
  assert.equal(service.calls[0][1].isPrimary, false);

  service.sessionsCreate = async () => ({ status: 'applied', note: { path: 'x'.repeat(33 * 1024), revision: 'revision' } });
  const oversizedResponse = await invoke(service, { body: conversationCreate() });
  assert.equal(oversizedResponse.statusCode, 507);
  assert.equal(Buffer.byteLength(JSON.stringify(oversizedResponse.body)) < 32 * 1024, true);
});

test('Conversation creation remains on the service-owned plugin Gateway boundary', async () => {
  const service = fixtureService();
  let receivedRuntime = 'not-called';
  service.sessionsCreate = async (input, runtime) => {
    receivedRuntime = runtime;
    return { status: 'applied', referenceId: 'session:new' };
  };
  const response = await invoke(service, { body: conversationCreate({ label: 'Plugin Scoped Conversation' }) });
  assert.equal(response.statusCode, 200);
  assert.equal(receivedRuntime.authoritativeSession.label, 'Plugin Scoped Conversation');
});

test('a migrated canonical scale Topic creates 99 Conversations through the public route and authoritatively totals 100', async () => {
  const scaleTopicId = '22222222-2222-4222-8222-222222222222';
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migrated-scale-route-'));
  let migratedMetadata;
  try {
  const service = fixtureService();
  const catalog = new Map();
  let ordinal = 1;
  const keysByOperation = new Map();
  const operationId = (index) => `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
  for (const index of [2, 7, 11]) {
    const key = `agent:main:dashboard:bridge-preseeded-scale-${operationId(index)}`;
    catalog.set(key, { sessionId: `session-preseeded-scale-${index}`, updatedAt: index + 1, label: `Fictional scale Conversation ${index}`, pluginOwnerId: 'command-center' });
    keysByOperation.set(operationId(index), key);
  }
  const gatewayRequest = async (method, params) => {
    if (method === 'sessions.create') {
      const replayKey = keysByOperation.get(params.idempotencyKey);
      if (replayKey) return { key: replayKey, sessionId: catalog.get(replayKey).sessionId };
      const key = params.key ?? `agent:main:dashboard:bridge-scale-${params.idempotencyKey}`;
      const sessionId = `session-scale-${ordinal}`;
      catalog.set(key, { sessionId, updatedAt: ordinal, label: params.label, pluginOwnerId: 'command-center' });
      ordinal += 1;
      if (params.idempotencyKey) keysByOperation.set(params.idempotencyKey, key);
      return { key, sessionId };
    }
    if (method === 'sessions.list') return { sessions: [...catalog].map(([sessionKey, entry]) => ({ sessionKey, ...entry })) };
    throw new Error(`Unexpected Gateway method ${method}`);
  };
  migratedMetadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
  const transcriptEntries = new Map();
  const transcriptRuntime = {
    async withSessionTranscriptWriteLock(target, run) {
      return run({
        readEvents: async () => transcriptEntries.get(target.sessionKey) ?? [],
        appendMessage: async (params) => {
          const entries = transcriptEntries.get(target.sessionKey) ?? [];
          entries.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message });
          transcriptEntries.set(target.sessionKey, entries);
          return { messageId: params.eventId, appended: true };
        },
        publishUpdate: async () => undefined
      });
    },
    async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return transcriptEntries.get(sessionKey) ?? []; },
    async appendSessionTranscriptMessageByIdentityStrict(params) {
      const entries = transcriptEntries.get(params.sessionKey) ?? [];
      entries.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message });
      transcriptEntries.set(params.sessionKey, entries);
      return { kind: 'result', result: { messageId: params.eventId, appended: true } };
    }
  };
  const migration = createLegacyDiscordMigrationService({
    metadata: migratedMetadata,
    config: {
      schemaVersion: 1,
      exportPath: new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname,
      channels: [{ channelId: 'fictional-channel-alpha', topicId: scaleTopicId, paraCategory: 'resource', noteFolderPath: '/fictional/vault/scale' }]
    },
    gateway: { request: gatewayRequest },
    transcriptRuntime,
    folderVerifier: async () => undefined
  });
  const migrationResult = await migration.start();
  assert.equal(migrationResult.complete, true, JSON.stringify(migrationResult));
  const migratedTopic = migratedMetadata.getTopic(scaleTopicId);
  assert.equal(migratedTopic.lifecycle, 'active');
  assert.equal(migratedTopic.revision, 1);
  assert.equal(typeof migratedTopic.activatedAt, 'string');
  const adapter = createSessionAdapter({ metadata: migratedMetadata, topicId: scaleTopicId, gateway: { request: gatewayRequest } });
  service.metadata = migratedMetadata;
  service.topics.get = (requestedTopicId) => migratedMetadata.getTopic(requestedTopicId);
  service.sessionsCreate = async (input, runtime) => {
    service.calls.push(['sessionsCreate', input]);
    const { topicId: requestedTopicId, ...adapterInput } = input;
    assert.equal(requestedTopicId, scaleTopicId);
    return adapter.create(adapterInput, runtime);
  };

  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 1; index < 100; index += 1) {
      const logicalOperationId = operationId(index);
      const label = `Fictional scale Conversation ${index}`;
      const created = await gatewayRequest('sessions.create', { agentId: 'main', label, idempotencyKey: logicalOperationId });
      const listed = catalog.get(created.key);
      const response = await invoke(service, {
        body: { schemaVersion: 1, action: 'conversations.create', topicId: scaleTopicId, label, expectedRevision: migratedTopic.revision, logicalOperationId, authoritativeSession: { key: created.key, sessionId: listed.sessionId, revision: String(listed.updatedAt), idempotencyKey: logicalOperationId, label } },
        gatewayRequest
      });
      assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    }
  }

  const authoritativeSessions = (await gatewayRequest('sessions.list', { agentId: 'main', limit: 200 })).sessions;
  assert.equal(service.calls.filter(([method]) => method === 'sessionsCreate').length, 198);
  assert.equal(keysByOperation.size, 99);
  assert.equal(authoritativeSessions.length, 100);
  assert.equal(authoritativeSessions.some(({ sessionKey }) => sessionKey === 'agent:main:command-center:legacy-discord:fictional-channel-alpha'), true);
  assert.equal(migratedMetadata.listSourceReferences(scaleTopicId).filter(({ sourceKind }) => sourceKind === 'session').length, 100);

  const staleOperationId = randomUUID();
  const stale = await invoke(service, {
    body: { schemaVersion: 1, action: 'conversations.create', topicId: scaleTopicId, label: 'Stale revision Conversation', expectedRevision: migratedTopic.revision - 1, logicalOperationId: staleOperationId, authoritativeSession: { key: 'agent:main:dashboard:stale', sessionId: 'session-stale', revision: '1', idempotencyKey: staleOperationId, label: 'Stale revision Conversation' } },
    gatewayRequest
  });
  assert.equal(stale.statusCode, 409);
  assert.equal((await gatewayRequest('sessions.list', { agentId: 'main', limit: 200 })).sessions.length, 100);
  } finally {
    migratedMetadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Note actions verify exact Topic/source revisions and reach the guarded service', async () => {
  const service = fixtureService();
  const result = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.from('# Updated').toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(service.calls[0], ['notesEdit', { schemaVersion: 1, topicId, referenceId: noteId, path: 'brief.md', text: '# Updated', expectedRevision: 'note-revision', logicalOperationId: service.calls[0][1].logicalOperationId }]);
  assert.deepEqual(Object.keys(result.body.result).sort(), ['action', 'path', 'referenceId', 'revision', 'status', 'topicId'].sort());
  assert.equal(result.body.result.path, 'brief.md');
  const stale = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.from('stale').toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 3 }) });
  assert.equal(stale.statusCode, 409);
  assert.equal(service.calls.length, 1);
  const foreign = await invoke(service, { body: base('notes.edit', { referenceId: sessionId, path: 'brief.md', contentBase64: Buffer.from('wrong').toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(foreign.statusCode, 422);
  const folderInsteadOfNote = await invoke(service, { body: base('notes.edit', { referenceId: folderId, path: 'brief.md', contentBase64: Buffer.from('wrong').toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(folderInsteadOfNote.statusCode, 422);
  const wrongPath = await invoke(service, { body: base('notes.rename', { referenceId: noteId, path: 'other.md', destinationPath: 'renamed.md', expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(wrongPath.statusCode, 422);
  const wrongReferenceRevision = await invoke(service, { body: base('notes.move', { referenceId: noteId, path: 'brief.md', destinationPath: 'moved.md', expectedRevision: 'newer-revision', expectedTopicRevision: 4 }) });
  assert.equal(wrongReferenceRevision.statusCode, 409);

  const created = await invoke(service, { body: base('notes.create', { referenceId: folderId, path: 'created.md', contentBase64: Buffer.from('# Created').toString('base64'), expectedTopicRevision: 4 }) });
  assert.equal(created.statusCode, 200);
  const renamed = await invoke(service, { body: base('notes.rename', { referenceId: noteId, path: 'brief.md', destinationPath: 'renamed.md', expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(renamed.statusCode, 200);
  const moved = await invoke(service, { body: base('notes.move', { referenceId: noteId, path: 'brief.md', destinationPath: 'moved.md', expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(service.calls.slice(-3).map(([method]) => method), ['notesCreate', 'notesRename', 'notesMove']);

  const large = 'x'.repeat(128 * 1024 - 1) + '\n';
  const largeResult = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.from(large).toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(largeResult.statusCode, 200);
  assert.equal(service.calls.at(-1)[1].text, large);
  assert.doesNotMatch(JSON.stringify(largeResult.body), /x{100}/u);
  const escapePattern = '\"\\';
  const escapeHeavy = `${escapePattern.repeat(Math.floor((128 * 1024 - 1) / escapePattern.length)).slice(0, 128 * 1024 - 1)}\n`;
  const escapeHeavyResult = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.from(escapeHeavy).toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(escapeHeavyResult.statusCode, 200);
  const aboveAcceptanceFloor = `${'y'.repeat(129 * 1024)}\n`;
  const aboveAcceptanceFloorResult = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.from(aboveAcceptanceFloor).toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(aboveAcceptanceFloorResult.statusCode, 200);
  assert.equal(service.calls.at(-1)[1].text, aboveAcceptanceFloor);
  const tooLarge = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.alloc(8 * 1024 * 1024 + 2, 0x78).toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(tooLarge.statusCode, 400);
});

test('Conversation close uses the exact Source Reference and rejects disallowed origins', async () => {
  const service = fixtureService();
  const applied = await invoke(service, { body: base('conversations.close', { referenceId: sessionId, expectedRevision: 4 }), headers: { 'content-type': 'application/json', origin: 'null' } });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.headers['Access-Control-Allow-Origin'], 'null');
  assert.equal(service.calls[0][0], 'sessionsClose');
  const rejected = await invoke(service, { body: base('conversations.close', { referenceId: sessionId, expectedRevision: 4 }), headers: { 'content-type': 'application/json', origin: 'https://fictional.invalid' } });
  assert.equal(rejected.statusCode, 403);
});

test('Session send dispatches the exact selected Source Reference without a Topic revision', async () => {
  const service = fixtureService();
  const logicalOperationId = randomUUID();
  const dispatched = [];
  service.sessionsSend = async (input, runtime) => {
    service.calls.push(['sessionsSend', input]);
    await runtime.gatewayRequest('chat.send', { sessionKey: 'agent:main:fictional', message: input.message, idempotencyKey: input.logicalOperationId }, { requestId: input.logicalOperationId });
    return { status: 'applied' };
  };
  const applied = await invoke(service, {
    body: { schemaVersion: 1, action: 'chat.send', topicId, referenceId: sessionId, message: 'Exact fictional message', logicalOperationId },
    dispatchGatewayMethod: async (method, params, options) => {
      dispatched.push({ method, params, options });
      return { ok: true, payload: { runId: logicalOperationId } };
    }
  });
  assert.equal(applied.statusCode, 200);
  assert.deepEqual(service.calls, [['sessionsSend', { schemaVersion: 1, topicId, referenceId: sessionId, message: 'Exact fictional message', logicalOperationId }]]);
  assert.deepEqual(dispatched, [{
    method: 'chat.send',
    params: { sessionKey: 'agent:main:fictional', message: 'Exact fictional message', idempotencyKey: logicalOperationId },
    options: { expectFinal: true, timeoutMs: 45_000 }
  }]);
  assert.equal((await invoke(service, { body: { schemaVersion: 1, action: 'chat.send', topicId, referenceId: sessionId, message: 'Exact fictional message', logicalOperationId, expectedRevision: 4 } })).statusCode, 400);
});

test('production proxy delegates Note identity validation to the authoritative source service', async () => {
  const calls = [];
  const service = {
    topics: { get: () => ({ topicId, revision: 4, lifecycle: 'active' }) },
    assertExactNoteReference(input, options) { calls.push(['validate', input.referenceId, options]); return { referenceId: input.referenceId }; },
    async notesEdit(input) { calls.push(['edit', input.referenceId]); return { status: 'applied', note: { path: input.path, revision: 'next-revision' } }; }
  };
  const result = await invoke(service, { body: base('notes.edit', { referenceId: noteId, path: 'brief.md', contentBase64: Buffer.from('updated').toString('base64'), expectedRevision: 'note-revision', expectedTopicRevision: 4 }) });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, [['validate', noteId, { create: false }], ['edit', noteId]]);
});
