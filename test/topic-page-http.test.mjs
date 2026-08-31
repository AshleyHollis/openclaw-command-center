import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTopicPageActionsHandler, topicPageActionRoute } from '../src/topics/page-http.mjs';

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

async function invoke(service, { method = 'POST', body = {}, headers = { 'content-type': 'application/json' }, gatewayRequest = async () => ({}) } = {}) {
  const request = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(request, { method, headers });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  await createTopicPageActionsHandler(service, { gatewayRequestFactory: () => gatewayRequest })(request, response);
  return { statusCode: response.statusCode, headers: response.headers, body: response.body ? JSON.parse(response.body) : null };
}

function base(action, fields = {}) {
  return { schemaVersion: 1, action, topicId, logicalOperationId: randomUUID(), ...fields };
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
  const applied = await invoke(service, { body: base('conversations.create', { expectedRevision: 4, label: 'Fictional Conversation' }) });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.body.result.referenceId, 'session:new');
  assert.doesNotMatch(JSON.stringify(applied.body), /fictional\/notes|agent:main|session-new/u);
  assert.equal(service.calls[0][1].isPrimary, false);

  service.sessionsCreate = async () => ({ status: 'applied', note: { path: 'x'.repeat(33 * 1024), revision: 'revision' } });
  const oversizedResponse = await invoke(service, { body: base('conversations.create', { expectedRevision: 4 }) });
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
  const response = await invoke(service, {
    body: base('conversations.create', { expectedRevision: 4, label: 'Plugin Scoped Conversation' })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof receivedRuntime.gatewayRequest, 'function');
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
  const applied = await invoke(service, { body: { schemaVersion: 1, action: 'chat.send', topicId, referenceId: sessionId, message: 'Exact fictional message', logicalOperationId } });
  assert.equal(applied.statusCode, 200);
  assert.deepEqual(service.calls, [['sessionsSend', { schemaVersion: 1, topicId, referenceId: sessionId, message: 'Exact fictional message', logicalOperationId }]]);
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
