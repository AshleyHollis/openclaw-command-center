import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionAdapter } from '../src/sources/sessions.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';
import { registerNativeSessionNavigation } from '../src/bridge/register.mjs';

function fixture() {
  const topic = { topicId: 'fictional-topic', lifecycle: 'active', paraCategory: 'project' };
  const reference = { version: 1, referenceId: 'fictional-reference', topicId: topic.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional', observedRevision: null };
  const state = { sessionId: 'fictional-session', status: 'open' };
  const entry = { sessionKey: reference.externalSourceId, entry: { sessionId: state.sessionId } };
  const recovery = [];
  const metadata = { getTopic: () => topic, getSourceReference: () => reference, listSourceReferences: () => [reference], getSessionState: () => state, listSourceRecovery: () => recovery };
  const sessions = createSessionAdapter({ topicId: topic.topicId, metadata, gateway: { request: async () => { throw new Error('Navigation must not send or create a Session.'); } }, sessionStore: { listSessionEntries: () => [entry] } });
  const service = Object.assign(Object.create(AuthoritativeSourceService.prototype), { metadata, capabilities: { sessions: { available: true } }, forTopic: () => ({ sessions }) });
  const input = { schemaVersion: 1, topicId: topic.topicId, referenceId: reference.referenceId, nativeChat: true };
  return { topic, reference, state, entry, recovery, service, input };
}

test('native Chat resolves the exact linked identity without sending or creating', async () => {
  const f = fixture();
  const result = await f.service.sessionsNavigate(f.input);
  assert.equal(result.sessionId, f.state.sessionId);
  assert.equal(result.sessionKey, f.reference.externalSourceId);
  assert.deepEqual(result.sourceReference, f.reference);
});

test('native Chat refuses closed Conversations but preserves read-only source resolution', async () => {
  const f = fixture(); f.state.status = 'closed';
  await assert.rejects(f.service.sessionsNavigate(f.input), { code: 'read-only' });
  assert.equal((await f.service.sessionsNavigate({ ...f.input, nativeChat: false })).sessionId, f.state.sessionId);
});

test('native Chat refuses archived Topics but preserves read-only source resolution', async () => {
  const f = fixture(); f.topic.paraCategory = 'archive';
  await assert.rejects(f.service.sessionsNavigate(f.input), { code: 'read-only' });
  assert.equal((await f.service.sessionsNavigate({ ...f.input, nativeChat: false })).sessionId, f.state.sessionId);
});

test('native Chat refuses unresolved Session recovery and same-key replacement', async () => {
  const f = fixture(); f.recovery.push({ state: 'required', sourceKind: 'session' });
  await assert.rejects(f.service.sessionsNavigate(f.input), { code: 'source-recovery' });
  f.recovery.length = 0; f.entry.entry.sessionId = 'replacement-session';
  await assert.rejects(f.service.sessionsNavigate(f.input), { code: 'source-recovery' });
});

test('native Chat rejects malformed navigation intent', async () => {
  const f = fixture();
  await assert.rejects(f.service.sessionsNavigate({ ...f.input, nativeChat: 'true' }), { code: 'invalid-request' });
});

test('registered native resolver rechecks authoritative lifecycle and identity on each host request', async () => {
  const f = fixture();
  let handler;
  registerNativeSessionNavigation({ registerGatewayMethod(_name, implementation) { handler = implementation; } }, f.service);
  const request = async () => {
    let response;
    const { nativeChat: _nativeChat, ...input } = f.input;
    await handler({ params: { ...input, expectedSessionId: f.state.sessionId }, context: { authenticated: true }, respond(ok, result, error) { response = { ok, result, error }; } });
    return response;
  };
  assert.deepEqual((await request()).result, { sessionKey: f.reference.externalSourceId });
  f.state.status = 'closed';
  assert.deepEqual(await request(), { ok: false, result: null, error: { code: 'unavailable', message: 'The authoritative source request is unavailable.', details: { schemaVersion: 1, status: 'unavailable', requestId: null, logicalOperationId: null } } });
  f.state.status = 'open'; f.topic.paraCategory = 'archive';
  assert.equal((await request()).error.code, 'unavailable');
  f.topic.paraCategory = 'project'; f.recovery.push({ state: 'required', sourceKind: 'session' });
  assert.equal((await request()).error.code, 'source-recovery');
  f.recovery.length = 0; f.entry.entry.sessionId = 'replacement-session';
  assert.equal((await request()).error.code, 'source-recovery');
});
