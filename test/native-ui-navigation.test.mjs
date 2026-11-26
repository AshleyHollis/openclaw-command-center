import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeTopicNavigation } from '../src/native-ui/topic-navigation.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

const input = Object.freeze({ topicId: 'fictional-topic', referenceId: 'fictional-conversation', expectedSessionId: 'fictional-session' });
const resolverTarget = () => ({ sessionKey: 'agent:fictional-agent:fictional-chat' });

function fixture(request = async () => ({ result: resolverTarget() })) {
  const controller = new AbortController();
  const opened = [];
  const host = { signal: controller.signal, connection: { connected: true, canRead: true }, request,
    sessions: { openChat: (value) => opened.push(value) } };
  return { controller, opened, host, navigation: createNativeTopicNavigation(host) };
}

test('a verified Topic Conversation opens through native Chat with its owning agent', async () => {
  const f = fixture(async (method, params) => {
    assert.equal(method, 'command-center.v1.sessions.resolve-native');
    assert.deepEqual(params, { schemaVersion: 1, topicId: input.topicId, referenceId: input.referenceId, expectedSessionId: input.expectedSessionId });
    return { schemaVersion: 1, result: resolverTarget() };
  });
  await f.navigation.open(input);
  assert.deepEqual(f.opened, [{ sessionKey: 'agent:fictional-agent:fictional-chat', agentId: 'fictional-agent' }]);
});

test('leaving the native view prevents a delayed resolution from opening Chat', async () => {
  const pending = Promise.withResolvers();
  const f = fixture(() => pending.promise);
  const opening = f.navigation.open(input);
  f.controller.abort();
  pending.resolve({ result: resolverTarget() });
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(f.opened, []);
});

test('Topic conversation navigation uses Chat even when the host also supports Files', async () => {
  const f = fixture();
  const files = [];
  f.host.sessions.openFiles = value => files.push(value);
  await f.navigation.open(input);
  assert.deepEqual(f.opened, [{ sessionKey: 'agent:fictional-agent:fictional-chat', agentId: 'fictional-agent' }]);
  assert.deepEqual(files, [], 'reserve the one-shot Files request for the explicit Files action');
});

test('late Topic resolution cannot open Chat after a newer conversation was selected', async () => {
  const pending = Promise.withResolvers();
  const f = fixture(() => pending.promise);
  const opening = f.navigation.open(input);
  f.navigation.cancel();
  pending.resolve({ result: resolverTarget() });
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(f.opened, []);
});

test('a Topic opens its verified Primary without a custom Session roster', async () => {
  const f = fixture(async (method) => method.endsWith('sessions.browse')
    ? { result: { topicId: input.topicId, conversations: [{ topicId: input.topicId, referenceId: input.referenceId, sessionId: input.expectedSessionId, isPrimary: true, status: 'open' }] } }
    : { result: resolverTarget() });
  await f.navigation.openPrimary(input.topicId);
  assert.deepEqual(f.opened, [{ sessionKey: 'agent:fictional-agent:fictional-chat', agentId: 'fictional-agent' }]);
});

test('a Topic opens its verified Primary directly in the native Files pane', async () => {
  const f = fixture(async (method) => method.endsWith('sessions.browse')
    ? { result: { topicId: input.topicId, conversations: [{ referenceId: input.referenceId, sessionId: input.expectedSessionId, isPrimary: true, status: 'open' }] } }
    : { result: resolverTarget() });
  const files = [];
  f.host.sessions.openFiles = value => files.push(value);
  await f.navigation.openPrimaryFiles(input.topicId);
  assert.deepEqual(files, [{ sessionKey: 'agent:fictional-agent:fictional-chat', agentId: 'fictional-agent' }]);
  assert.deepEqual(f.opened, []);
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
    : { result: resolverTarget() });
  await f.navigation.openPrimary(input.topicId);
  assert.equal(f.opened.length, 1);
});

test('an older Topic navigation cannot override the latest selection', async () => {
  const old = Promise.withResolvers();
  let first = true;
  const f = fixture(async () => {
    if (first) { first = false; return old.promise; }
    return { result: { ...resolverTarget(), sessionKey: 'agent:fictional-agent:new-chat' } };
  });
  const earlier = f.navigation.open(input);
  await f.navigation.open(input);
  old.resolve({ result: resolverTarget() });
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
  const f = fixture(async () => ({ result: { ...resolverTarget(), ...change } }));
  await assert.rejects(f.navigation.open(input), /exact Topic Conversation/);
  assert.deepEqual(f.opened, []);
});

test('losing the connection during resolution prevents native navigation', async () => {
  const pending = Promise.withResolvers();
  const f = fixture(() => pending.promise);
  const opening = f.navigation.open(input);
  f.host.connection.connected = false;
  pending.resolve({ result: resolverTarget() });
  await assert.rejects(opening, /authenticated/);
  assert.deepEqual(f.opened, []);
});

for (const field of ['topicId', 'referenceId', 'expectedSessionId']) test(`native navigation rejects a missing ${field} before contacting the host`, async () => {
  let requests = 0;
  const f = fixture(async () => { requests += 1; return { result: resolverTarget() }; });
  await assert.rejects(f.navigation.open({ ...input, [field]: undefined }));
  assert.equal(requests, 0);
  assert.deepEqual(f.opened, []);
});

const linked = { referenceId: 'fictional-linked', sessionId: 'fictional-linked-session', status: 'open', isPrimary: false };
const primary = { referenceId: input.referenceId, sessionId: input.expectedSessionId, status: 'open', isPrimary: true };
function filesFixture(conversations = [primary, linked], resolve = async params => ({ result: { sessionKey: `agent:fictional-agent:${params.expectedSessionId}` } })) {
  const files = [];
  const requests = [];
  const f = fixture(async (method, params) => {
    requests.push({ method, params });
    return method.endsWith('sessions.browse')
      ? { result: { topicId: input.topicId, conversations } }
      : resolve(params);
  });
  f.host.sessions.openFiles = value => files.push(value);
  return { ...f, files, requests };
}

test('Files prefers the exact eligible linked Conversation without selecting Chat or touching its draft', async () => {
  const f = filesFixture();
  const draft = { text: 'Fictional unsent draft', selectedSession: 'another-conversation' };
  const before = structuredClone(draft);
  f.host.sessions.openChat = value => { f.opened.push(value); draft.selectedSession = value.sessionKey; draft.text = ''; };
  assert.deepEqual(await f.navigation.openPreferredFiles(input.topicId, linked), { referenceId: linked.referenceId, sessionId: linked.sessionId });
  assert.deepEqual(f.files, [{ sessionKey: `agent:fictional-agent:${linked.sessionId}`, agentId: 'fictional-agent' }]);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(draft, before);
  assert.equal(f.requests[1].params.referenceId, linked.referenceId);
});

for (const stale of [
  { ...linked, status: 'closed' },
  { ...linked, sessionId: 'replacement' },
  null
]) test(`Files falls back to Primary when the remembered exact membership is unavailable: ${JSON.stringify(stale)}`, async () => {
  const f = filesFixture(stale ? [primary, stale] : [primary]);
  await f.navigation.openPreferredFiles(input.topicId, linked);
  assert.equal(f.files[0].sessionKey, `agent:fictional-agent:${primary.sessionId}`);
  assert.deepEqual(f.opened, []);
});

for (const reason of ['membership changed', 'Source Recovery required']) test(`Files refuses a late authoritative resolver refusal: ${reason}`, async () => {
  const f = filesFixture(undefined, async () => { throw new Error(reason); });
  await assert.rejects(f.navigation.openPreferredFiles(input.topicId, linked), new RegExp(reason));
  assert.deepEqual(f.files, []);
  assert.deepEqual(f.opened, []);
});

for (const change of ['abort', 'cancel', 'permission', 'newer']) test(`Files never opens a stale target after ${change}`, async () => {
  const pending = Promise.withResolvers();
  const f = filesFixture(undefined, () => pending.promise);
  const opening = f.navigation.openPreferredFiles(input.topicId, linked);
  // Wait until the resolver owns the asynchronous boundary.
  while (f.requests.length < 2) await Promise.resolve();
  if (change === 'abort') f.controller.abort();
  if (change === 'cancel') f.navigation.cancel();
  if (change === 'permission') f.host.connection.canRead = false;
  if (change === 'newer') { f.host.request = async () => ({ result: resolverTarget() }); await f.navigation.open(input); }
  pending.resolve({ result: resolverTarget() });
  await assert.rejects(opening, change === 'permission' ? /authenticated/ : { name: 'AbortError' });
  assert.deepEqual(f.files, []);
});

test('Files rejects unreadable admission before any host request', async () => {
  const f = filesFixture();
  f.host.connection.canRead = false;
  await assert.rejects(f.navigation.openPreferredFiles(input.topicId, linked), /authenticated/);
  assert.deepEqual(f.requests, []);
});
