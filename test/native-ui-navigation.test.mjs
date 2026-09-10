import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeTopicNavigation } from '../src/native-ui/topic-navigation.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

const input = Object.freeze({ topicId: 'fictional-topic', referenceId: 'fictional-conversation', expectedSessionId: 'fictional-session' });
const target = () => ({ sessionKey: 'agent:fictional-agent:fictional-chat', sessionId: 'fictional-session', sourceReference: { topicId: input.topicId, referenceId: input.referenceId } });

function fixture(request = async () => ({ result: target() })) {
  const controller = new AbortController();
  const opened = [];
  const host = { signal: controller.signal, connection: { connected: true, canRead: true }, request,
    sessions: { open: (value) => opened.push(value) } };
  return { controller, opened, host, navigation: createNativeTopicNavigation(host) };
}

test('a verified Topic Conversation opens through native Chat with its owning agent', async () => {
  const f = fixture(async (method, params) => {
    assert.equal(method, 'command-center.v1.sessions.navigate');
    assert.deepEqual(params, { schemaVersion: 1, topicId: input.topicId, referenceId: input.referenceId, nativeChat: true });
    return { schemaVersion: 1, result: target() };
  });
  await f.navigation.open(input);
  assert.deepEqual(f.opened, [{ sessionKey: 'agent:fictional-agent:fictional-chat', agentId: 'fictional-agent' }]);
});

test('leaving the native view prevents a delayed resolution from opening Chat', async () => {
  const pending = Promise.withResolvers();
  const f = fixture(() => pending.promise);
  const opening = f.navigation.open(input);
  f.controller.abort();
  pending.resolve({ result: target() });
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(f.opened, []);
});

test('a Topic opens its verified Primary without a custom Session roster', async () => {
  const f = fixture(async (method) => method.endsWith('sessions.browse')
    ? { result: { topicId: input.topicId, conversations: [{ topicId: input.topicId, referenceId: input.referenceId, sessionId: input.expectedSessionId, isPrimary: true, status: 'open' }] } }
    : { result: target() });
  await f.navigation.openPrimary(input.topicId);
  assert.deepEqual(f.opened, [{ sessionKey: 'agent:fictional-agent:fictional-chat', agentId: 'fictional-agent' }]);
});

test('native navigation consumes the real public Conversation catalog, not internal rows', async () => {
  const service = {
    sessionsList: async () => ({ schemaVersion: 1, topicId: input.topicId, conversations: [{
      topicId: input.topicId, referenceId: input.referenceId, sessionId: input.expectedSessionId,
      displayName: 'Fictional conversation', status: 'open', isPrimary: true, wasPrimary: false,
      updatedAt: '2026-09-06T00:00:00Z'
    }] })
  };
  const f = fixture(async (method, params) => method.endsWith('sessions.browse')
    ? { result: await invokeBridgeMethod(service, method, params) }
    : { result: target() });
  await f.navigation.openPrimary(input.topicId);
  assert.equal(f.opened.length, 1);
});

test('an older Topic navigation cannot override the latest selection', async () => {
  const old = Promise.withResolvers();
  let first = true;
  const f = fixture(async () => {
    if (first) { first = false; return old.promise; }
    return { result: { ...target(), sessionKey: 'agent:fictional-agent:new-chat' } };
  });
  const earlier = f.navigation.open(input);
  await f.navigation.open(input);
  old.resolve({ result: target() });
  await assert.rejects(earlier, { name: 'AbortError' });
  assert.deepEqual(f.opened, [{ sessionKey: 'agent:fictional-agent:new-chat', agentId: 'fictional-agent' }]);
});

test('a cancelled navigation suppresses its delayed transport failure', async () => {
  const delayed = Promise.withResolvers();
  const f = fixture(() => delayed.promise);
  const opening = f.navigation.open(input);
  f.navigation.cancel();
  delayed.reject(new Error('Old connection failed'));
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(f.opened, []);
});

for (const change of [
  { sessionId: 'replacement' },
  { sourceReference: { topicId: 'other-topic', referenceId: input.referenceId } },
  { sourceReference: { topicId: input.topicId, referenceId: 'other-reference' } },
  { sessionKey: 'global' }
]) test(`native navigation refuses mismatched or ambiguous identity ${JSON.stringify(change)}`, async () => {
  const f = fixture(async () => ({ result: { ...target(), ...change } }));
  await assert.rejects(f.navigation.open(input), /exact Topic Conversation/);
  assert.deepEqual(f.opened, []);
});

test('losing the connection during resolution prevents native navigation', async () => {
  const pending = Promise.withResolvers();
  const f = fixture(() => pending.promise);
  const opening = f.navigation.open(input);
  f.host.connection.connected = false;
  pending.resolve({ result: target() });
  await assert.rejects(opening, /authenticated/);
  assert.deepEqual(f.opened, []);
});

for (const field of ['topicId', 'referenceId', 'expectedSessionId']) test(`native navigation rejects a missing ${field} before contacting the host`, async () => {
  let requests = 0;
  const f = fixture(async () => { requests += 1; return { result: target() }; });
  await assert.rejects(f.navigation.open({ ...input, [field]: undefined }));
  assert.equal(requests, 0);
  assert.deepEqual(f.opened, []);
});
