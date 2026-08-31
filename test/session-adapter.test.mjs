import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';
import { createMutationCoordinator } from '../src/sources/mutation-coordinator.mjs';

function metadataFixture() {
  const refs = [];
  const states = new Map();
  return {
    refs,
    listSourceReferences: () => refs,
    createSourceReference: (reference) => { refs.push(reference); return reference; },
    getSourceReference: (id) => refs.find((reference) => reference.referenceId === id) ?? null,
    setSessionState: (value) => { states.set(value.referenceId, value); return value; },
    getSessionState: (id) => states.get(id) ?? null
  };
}

function pluginSessionBoundary({ completions } = {}) {
  const entries = new Map();
  let ordinal = 0;
  const gateway = { request: async (method, params) => {
    if (method === 'sessions.create') {
      const create = () => {
        const key = `agent:main:dashboard:command-center-${++ordinal}`;
        const entry = { sessionId: randomUUID(), updatedAt: Date.now(), label: params.label, category: params.category, pluginOwnerId: 'command-center' };
        entries.set(key, entry);
        return { key, entry };
      };
      if (completions) return new Promise((resolve) => completions.push(() => resolve(create())));
      return create();
    }
    if (method === 'sessions.list') return { sessions: [...entries].map(([sessionKey, entry]) => {
      const { pluginOwnerId: _privateOwner, ...projected } = entry;
      return { sessionKey, ...projected };
    }) };
    if (method === 'chat.history') return { messages: ['authoritative'] };
    return { runId: params.idempotencyKey };
  } };
  const sessionStore = {
    listSessionEntries: () => [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry })),
    getSessionEntry: ({ sessionKey }) => entries.get(sessionKey)
  };
  return { entries, gateway, sessionStore };
}

function pinnedSanitizedSessionBoundary() {
  const key = 'agent:main:dashboard:command-center-sanitized';
  const entry = { sessionId: 'fictional-pinned-session', updatedAt: 47, category: null };
  return {
    gateway: { async request(method, params) {
      if (method === 'sessions.create') {
        entry.category = params.category;
        return { key };
      }
      if (method === 'sessions.list') return { sessions: [{ key, sessionId: entry.sessionId, updatedAt: entry.updatedAt, category: entry.category }] };
      throw new Error(`Unexpected ${method}`);
    } },
    entry,
    key
  };
}

test('Session create/history/send use exact linked keys without transcript inheritance', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const boundary = pluginSessionBoundary();
  const gateway = { request: async (...args) => { calls.push({ method: args[0], params: args[1] }); return boundary.gateway.request(...args); } };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const logicalOperationId = randomUUID();
  const created = await adapter.create({ logicalOperationId, isPrimary: true });
  assert.match(created.value.sourceReference.externalSourceId, /^agent:main:dashboard:command-center-/u);
  assert.equal(calls[0].params.category, `command-center:${logicalOperationId}`);
  assert.equal(calls[0].params.key, undefined);
  assert.equal(calls[0].params.parentSessionKey, undefined);
  assert.equal(calls[0].params.fork, undefined);
  const history = await adapter.history({ referenceId: created.value.sourceReference.referenceId });
  assert.deepEqual(history.messages, ['authoritative']);
  const callsBeforeForeignHistory = calls.length;
  await assert.rejects(
    () => adapter.history({ referenceId: created.value.sourceReference.referenceId, sessionId: 'foreign-session-id' }),
    /unsupported.*sessionId/i
  );
  assert.equal(calls.length, callsBeforeForeignHistory);
  await adapter.send({ referenceId: created.value.sourceReference.referenceId, message: 'hello', logicalOperationId: randomUUID() });
  assert.equal(calls.at(-1).params.sessionKey, created.value.sourceReference.externalSourceId);
  assert.equal(calls.at(-1).params.idempotencyKey.length > 0, true);
  const callsBeforeAttachment = calls.length;
  await assert.rejects(() => adapter.send({ referenceId: created.value.sourceReference.referenceId, message: 'unsafe', attachments: [{ path: '/fictional/private.md' }], logicalOperationId: randomUUID() }), /unsupported.*attachments/i);
  assert.equal(calls.length, callsBeforeAttachment);
  await assert.rejects(() => adapter.history({ referenceId: 'missing' }), /exact linked Session/i);
});

test('Session create reads the pinned host entry identity and revision shape', async () => {
  const metadata = metadataFixture();
  const boundary = pluginSessionBoundary();
  const adapter = createSessionAdapter({ metadata, gateway: boundary.gateway, sessionStore: boundary.sessionStore, topicId: 'topic-entry-shape' });
  const created = await adapter.create({ logicalOperationId: randomUUID(), label: 'Entry Shape', isPrimary: true });
  const entry = boundary.entries.get(created.value.key);
  assert.equal(created.value.sessionId, entry.sessionId);
  assert.equal(created.value.creationRevision, String(entry.updatedAt));
  assert.equal(metadata.getSessionState(created.value.sourceReference.referenceId).sessionId, entry.sessionId);
});

test('Session create accepts the pinned sanitized response and proves identity through plugin-scoped catalog readback', async () => {
  const metadata = metadataFixture();
  const boundary = pinnedSanitizedSessionBoundary();
  const logicalOperationId = randomUUID();
  const adapter = createSessionAdapter({ metadata, gateway: boundary.gateway, topicId: 'topic-sanitized-shape' });
  const created = await adapter.create({ logicalOperationId, label: 'Sanitized Host Shape' });
  assert.equal(created.value.key, boundary.key);
  assert.equal(created.value.sessionId, boundary.entry.sessionId);
  assert.equal(created.value.creationRevision, String(boundary.entry.updatedAt));
  assert.equal(boundary.entry.category, `command-center:${logicalOperationId}`);
});

test('Session creation uses the pinned plugin-scoped Gateway even when a detached request dispatcher is unavailable', async () => {
  const metadata = metadataFixture();
  const boundary = pinnedSanitizedSessionBoundary();
  const calls = [];
  const adapter = createSessionAdapter({
    api: { runtime: { gateway: { async request(method, params) { calls.push(method); return boundary.gateway.request(method, params); } } } },
    metadata,
    topicId: 'topic-plugin-scoped'
  });
  const created = await adapter.create(
    { logicalOperationId: randomUUID(), label: 'Plugin Scoped' },
    { gatewayRequest: async () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); } }
  );
  assert.equal(created.value.key, boundary.key);
  assert.deepEqual(calls, ['sessions.create', 'sessions.list']);
});

test('Session creation uses the plugin-scoped Gateway and authoritative catalog without agent harness ownership', async () => {
  const metadata = metadataFixture();
  const boundary = pluginSessionBoundary();
  const transcriptReader = async ({ sessionKey, sessionId, maxMessages }) => ({
    kind: 'page',
    cursor: 'fictional-cursor',
    hasMore: false,
    serializedBytes: 20,
    entries: [{ entryId: 'message-1', parentId: null, seq: 1, role: 'user', message: { role: 'user', content: 'Fictional history' } }],
    sessionKey,
    sessionId,
    maxMessages
  });
  const logicalOperationId = randomUUID();
  const adapter = createSessionAdapter({ metadata, gateway: boundary.gateway, sessionStore: boundary.sessionStore, transcriptReader, topicId: 'topic-runtime-store' });
  const beforeCreate = Date.now();
  const created = await adapter.create({ logicalOperationId, label: 'Runtime Store', isPrimary: true });
  const afterCreate = Date.now();
  const sessionKey = created.value.key;

  assert.equal(created.value.sourceReference.externalSourceId, sessionKey);
  assert.equal(boundary.entries.get(sessionKey).label, 'Runtime Store');
  assert.equal(boundary.entries.get(sessionKey).category, `command-center:${logicalOperationId}`);
  assert.equal(boundary.entries.get(sessionKey).pluginOwnerId, 'command-center');
  assert.equal(boundary.entries.get(sessionKey).updatedAt >= beforeCreate && boundary.entries.get(sessionKey).updatedAt <= afterCreate, true);
  assert.match(created.value.sessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(created.value.creationRevision, String(boundary.entries.get(sessionKey).updatedAt));
  const replay = await adapter.create({ logicalOperationId, label: 'Runtime Store', isPrimary: true });
  assert.equal(replay.value.creationRevision, created.value.creationRevision);
  await adapter.resolveExact({ referenceId: created.value.sourceReference.referenceId });
  const history = await adapter.history({ referenceId: created.value.sourceReference.referenceId, limit: 10 });
  assert.deepEqual(history.messages, [{ role: 'user', content: 'Fictional history' }]);
});

test('overlapping Session creates preserve every distinct plugin-owned key regardless of completion order', async () => {
  const metadata = metadataFixture();
  const completions = [];
  const boundary = pluginSessionBoundary({ completions });
  const adapter = createSessionAdapter({ metadata, gateway: boundary.gateway, sessionStore: boundary.sessionStore, topicId: 'topic-overlap' });
  const operations = [randomUUID(), randomUUID(), randomUUID()];
  const pending = operations.map((logicalOperationId, index) => adapter.create({ logicalOperationId, label: `Overlap ${index}`, isPrimary: false }));
  while (completions.length < operations.length) await new Promise((resolve) => setImmediate(resolve));
  for (const complete of completions.reverse()) complete();
  const created = await Promise.all(pending);
  assert.equal(new Set(created.map((item) => item.value.sourceReference.externalSourceId)).size, operations.length);
  for (const item of created) {
    const key = item.value.sourceReference.externalSourceId;
    assert.equal(metadata.getSessionState(item.value.sourceReference.referenceId).sessionId, boundary.entries.get(key).sessionId);
    assert.equal(item.value.creationRevision, String(boundary.entries.get(key).updatedAt));
  }
});

test('overlapping equivalent Session create replays serialize to one authoritative Session', async () => {
  const metadata = metadataFixture();
  const completions = [];
  const boundary = pluginSessionBoundary({ completions });
  const logicalOperationId = randomUUID();
  const coordinator = createMutationCoordinator({ metadata });
  const first = createSessionAdapter({ metadata, coordinator, gateway: boundary.gateway, sessionStore: boundary.sessionStore, topicId: 'topic-equivalent-overlap' });
  const second = createSessionAdapter({ metadata, coordinator, gateway: boundary.gateway, sessionStore: boundary.sessionStore, topicId: 'topic-equivalent-overlap' });
  const pending = [first, second].map((adapter) => adapter.create({ logicalOperationId, label: 'Equivalent overlap' }));
  while (completions.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 1);
  completions[0]();
  const created = await Promise.all(pending);
  assert.equal(boundary.entries.size, 1);
  assert.equal(created[0].value.key, created[1].value.key);
  assert.equal(created[0].value.sessionId, created[1].value.sessionId);
});

test('Session-store reads and lifecycle writes refuse a missing exact authoritative row', async () => {
  const metadata = metadataFixture();
  const reference = {
    version: 1,
    referenceId: 'session:missing-runtime-row',
    topicId: 'topic-missing-runtime-row',
    sourceSystem: 'openclaw',
    sourceKind: 'session',
    externalSourceId: 'agent:main:command-center:missing-runtime-row',
    observedRevision: null
  };
  metadata.refs.push(reference);
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'missing-runtime-session-id', status: 'open', isPrimary: false });
  let transcriptReads = 0;
  const adapter = createSessionAdapter({
    topicId: reference.topicId,
    metadata,
    sessionStore: { listSessionEntries: () => [], async patchSessionEntry() {} },
    transcriptReader: async () => { transcriptReads += 1; return { kind: 'missing' }; }
  });

  for (const action of [
    () => adapter.history({ referenceId: reference.referenceId }),
    () => adapter.send({ referenceId: reference.referenceId, message: 'must not dispatch', logicalOperationId: randomUUID() }),
    () => adapter.close({ referenceId: reference.referenceId, logicalOperationId: randomUUID() }),
    () => adapter.reopen({ referenceId: reference.referenceId, logicalOperationId: randomUUID() })
  ]) await assert.rejects(action, (error) => error.code === 'source-recovery');
  assert.equal(transcriptReads, 0);
  assert.equal(metadata.getSessionState(reference.referenceId).status, 'open');
});

test('Session-store history refuses transcript and post-read catalog identity mismatches without disclosure', async () => {
  const metadata = metadataFixture();
  const reference = {
    version: 1,
    referenceId: 'session:stable-history',
    topicId: 'topic-stable-history',
    sourceSystem: 'openclaw',
    sourceKind: 'session',
    externalSourceId: 'agent:main:command-center:stable-history',
    observedRevision: null
  };
  metadata.refs.push(reference);
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'stable-session-id', status: 'open', isPrimary: false });
  let rows = [{ sessionKey: reference.externalSourceId, entry: { sessionId: 'stable-session-id' } }];
  let transcriptPage;
  let holdRead = false;
  let releaseRead;
  let markReadStarted;
  const adapter = createSessionAdapter({
    topicId: reference.topicId,
    metadata,
    sessionStore: { listSessionEntries: () => rows },
    transcriptReader: async () => {
      if (holdRead) {
        markReadStarted();
        await new Promise((resolve) => { releaseRead = resolve; });
      }
      return transcriptPage;
    }
  });

  for (const page of [
    { kind: 'page', sessionKey: 'agent:main:command-center:foreign', sessionId: 'stable-session-id', entries: [{ message: 'private mismatched key transcript' }] },
    { kind: 'page', sessionKey: reference.externalSourceId, sessionId: 'foreign-session-id', entries: [{ message: 'private mismatched ID transcript' }] }
  ]) {
    transcriptPage = page;
    let caught;
    try { await adapter.history({ referenceId: reference.referenceId }); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'source-recovery');
    assert.equal(String(caught?.message).includes('private'), false);
  }

  transcriptPage = { kind: 'page', sessionKey: reference.externalSourceId, sessionId: 'stable-session-id', entries: [{ message: 'private replaced transcript' }] };
  holdRead = true;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const pending = adapter.history({ referenceId: reference.referenceId });
  await readStarted;
  rows = [{ sessionKey: reference.externalSourceId, entry: { sessionId: 'replacement-session-id' } }];
  releaseRead();
  let caught;
  try { await pending; } catch (error) { caught = error; }
  assert.equal(caught?.code, 'source-recovery');
  assert.equal(String(caught?.message).includes('private'), false);
});

test('Session creation refuses the rejected runtime store and agent-harness ownership path', async () => {
  const metadata = metadataFixture();
  let storeMutationAttempted = false;
  const sessionStore = {
    listSessionEntries: () => [],
    createSessionEntry: async () => { storeMutationAttempted = true; },
    patchSessionEntry: async () => { storeMutationAttempted = true; },
    upsertSessionEntry: async () => { storeMutationAttempted = true; }
  };
  const adapter = createSessionAdapter({ metadata, sessionStore, topicId: 'topic-no-harness' });
  await assert.rejects(adapter.create({ logicalOperationId: randomUUID(), label: 'Forbidden Harness' }), (error) => error.code === 'capability-unavailable');
  assert.equal(storeMutationAttempted, false);
  assert.deepEqual(metadata.refs, []);
  const production = await readFile(new URL('../src/sources/sessions.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(production, /createSessionEntry|agentHarnessId/u);
  assert.match(production, /this\.creationGateway/u);
  assert.doesNotMatch(production, /runtime\?\.gatewayRequest/u);
});

test('Session history withholds an explicitly mismatched authoritative identity', async () => {
  const metadata = metadataFixture();
  const reference = {
    version: 1,
    referenceId: 'session:owned',
    topicId: 'topic-session',
    sourceSystem: 'openclaw',
    sourceKind: 'session',
    externalSourceId: 'agent:main:command-center:owned',
    observedRevision: null
  };
  metadata.refs.push(reference);
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'owned-session-id', status: 'open', isPrimary: false });
  let response = { sessionKey: 'agent:main:command-center:foreign', sessionId: 'foreign-session-id', messages: ['private foreign transcript'] };
  const gateway = { request: async () => response };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });

  for (const providerResponse of [
    response,
    { sessionKey: reference.externalSourceId, sessionId: 'foreign-session-id', messages: ['another private transcript'] }
  ]) {
    response = providerResponse;
    let caught;
    try { await adapter.history({ referenceId: reference.referenceId }); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'source-recovery');
    assert.equal(String(caught?.message).includes('private transcript'), false);
  }
});

test('Session list returns exact Topic-linked records with open default and explicit Closed filters', async () => {
  const metadata = metadataFixture();
  const primary = { version: 1, referenceId: 'session:list-primary', topicId: 'topic-list', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:primary', observedRevision: null };
  const secondary = { version: 1, referenceId: 'session:list-secondary', topicId: 'topic-list', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:secondary', observedRevision: null };
  const closed = { version: 1, referenceId: 'session:list-closed', topicId: 'topic-list', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:closed', observedRevision: null };
  const foreign = { ...closed, referenceId: 'session:list-foreign', topicId: 'other-topic', externalSourceId: 'agent:main:foreign' };
  metadata.refs.push(primary, secondary, closed, foreign);
  metadata.setSessionState({ referenceId: primary.referenceId, sessionId: 'primary-id', status: 'open', isPrimary: true, displayName: 'Primary', updatedAt: '2026-08-27T00:00:00.000Z' });
  metadata.setSessionState({ referenceId: secondary.referenceId, sessionId: 'secondary-id', status: 'open', isPrimary: false, displayName: 'Secondary', updatedAt: '2026-08-27T00:00:00.000Z' });
  metadata.setSessionState({ referenceId: closed.referenceId, sessionId: 'closed-id', status: 'closed', isPrimary: false, wasPrimary: false, displayName: 'Closed', updatedAt: '2026-08-27T00:00:00.000Z' });
  metadata.setSessionState({ referenceId: foreign.referenceId, sessionId: 'foreign-id', status: 'open', isPrimary: false, displayName: 'Foreign', updatedAt: '2026-08-27T00:00:00.000Z' });
  const entries = [
    { sessionKey: primary.externalSourceId, entry: { sessionId: 'primary-id' } },
    { sessionKey: secondary.externalSourceId, entry: { sessionId: 'secondary-id' } },
    { sessionKey: closed.externalSourceId, entry: { sessionId: 'closed-id' } },
    { sessionKey: foreign.externalSourceId, entry: { sessionId: 'foreign-id' } }
  ];
  const adapter = createSessionAdapter({ topicId: 'topic-list', metadata, sessionStore: { listSessionEntries: () => entries } });
  const open = await adapter.list({ schemaVersion: 1 });
  assert.deepEqual(open.conversations.map((item) => item.referenceId), [primary.referenceId, secondary.referenceId]);
  const closedView = await adapter.list({ schemaVersion: 1, status: 'closed' });
  assert.deepEqual(closedView.conversations.map((item) => item.referenceId), [closed.referenceId]);
  const all = await adapter.list({ schemaVersion: 1, status: 'all' });
  assert.deepEqual(all.conversations.map((item) => item.referenceId), [primary.referenceId, closed.referenceId, secondary.referenceId]);
  assert.deepEqual(all.conversations.map((item) => item.displayName), ['Primary', 'Closed', 'Secondary']);
  assert.equal(all.conversations.every((item) => !('name' in item)), true);
  assert.deepEqual(all.conversations.map((item) => item.sessionId), ['primary-id', 'closed-id', 'secondary-id']);
  assert.equal(all.conversations.every((item) => !('topicId' in item) && !('sessionKey' in item)), true);
  metadata.setSessionState({ referenceId: closed.referenceId, sessionId: 'closed-id', status: 'invalid', isPrimary: false, displayName: 'Closed', updatedAt: '2026-08-27T00:00:00.000Z' });
  await assert.rejects(() => adapter.list({ schemaVersion: 1, status: 'all' }), (error) => error.code === 'source-recovery');
});

test('Session send, list, and lifecycle mutations revalidate state after authoritative resolution', async () => {
  const metadata = metadataFixture();
  const reference = { version: 1, referenceId: 'session:resolution-race', topicId: 'topic-resolution-race', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:resolution-race', observedRevision: null };
  metadata.refs.push(reference);
  const openState = { referenceId: reference.referenceId, sessionId: 'stable-session-id', status: 'open', isPrimary: false, displayName: 'Resolution Race', updatedAt: '2026-08-27T00:00:00.000Z' };
  metadata.setSessionState(openState);
  let race = 'close';
  let sends = 0;
  const gateway = {
    async request(method, params) {
      if (method === 'sessions.list') {
        if (race === 'close') metadata.setSessionState({ ...openState, status: 'closed' });
        if (race === 'replace') metadata.setSessionState({ ...openState, sessionId: 'replacement-session-id' });
        return { sessions: [{ sessionKey: reference.externalSourceId, sessionId: 'stable-session-id' }] };
      }
      if (method === 'chat.send') { sends += 1; return { runId: params.idempotencyKey }; }
      throw new Error(`Unexpected ${method}`);
    }
  };
  const adapter = createSessionAdapter({ topicId: reference.topicId, metadata, gateway });
  await assert.rejects(() => adapter.send({ referenceId: reference.referenceId, message: 'must remain isolated', logicalOperationId: randomUUID() }), (error) => error.code === 'conflict');
  assert.equal(sends, 0);

  metadata.setSessionState(openState); race = 'replace';
  await assert.rejects(() => adapter.list({ schemaVersion: 1, status: 'all' }), (error) => error.code === 'source-recovery');
  assert.equal(metadata.getSessionState(reference.referenceId).sessionId, 'replacement-session-id');

  metadata.setSessionState(openState);
  await assert.rejects(() => adapter.close({ referenceId: reference.referenceId, logicalOperationId: randomUUID() }), (error) => error.code === 'source-recovery');
  assert.equal(metadata.getSessionState(reference.referenceId).sessionId, 'replacement-session-id');
});

test('Gateway close and reopen refuse a missing persisted Session state before mutation', async () => {
  const metadata = metadataFixture();
  const reference = { version: 1, referenceId: 'session:missing-state', topicId: 'topic-missing-state', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:missing-state', observedRevision: null };
  metadata.refs.push(reference);
  let gatewayCalls = 0;
  const adapter = createSessionAdapter({ topicId: reference.topicId, metadata, gateway: { request: async () => { gatewayCalls += 1; return { sessions: [{ sessionKey: reference.externalSourceId, sessionId: 'missing-state-id' }] }; } } });
  await assert.rejects(() => adapter.close({ referenceId: reference.referenceId, logicalOperationId: randomUUID() }), (error) => error.code === 'source-recovery');
  await assert.rejects(() => adapter.reopen({ referenceId: reference.referenceId, logicalOperationId: randomUUID() }), (error) => error.code === 'source-recovery');
  assert.equal(gatewayCalls, 0);
});

test('Primary close is rejected and ambiguous create reconciles by operation category catalog readback', async () => {
  const metadata = metadataFixture();
  let createCalls = 0;
  const entries = new Map();
  const gateway = { request: async (method, params) => {
    if (method === 'sessions.create') {
      createCalls += 1;
      entries.set('agent:main:dashboard:reconciled', { sessionId: 'reconciled-id', updatedAt: 10, category: params.category, pluginOwnerId: 'command-center' });
      const error = new Error('delivery unknown'); error.code = 'timeout'; error.ambiguous = true; throw error;
    }
    if (method === 'sessions.list') return { sessions: [...entries].map(([sessionKey, entry]) => ({ sessionKey, ...entry })) };
    return {};
  } };
  const operationId = randomUUID();
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const created = await adapter.create({ logicalOperationId: operationId, isPrimary: true });
  assert.equal(created.status, 'applied');
  assert.equal(createCalls, 1);
  await assert.rejects(() => adapter.close({ referenceId: created.value.sourceReference.referenceId, logicalOperationId: randomUUID() }), /Primary Session|Primary/i);
});

test('creating a replacement Primary atomically demotes and permits closing the former Primary', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-primary-transfer-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    metadata.createTopic({ topicId: 'topic-primary-transfer', paraCategory: 'project', lifecycle: 'active' });
    const boundary = pluginSessionBoundary();
    const gateway = boundary.gateway;
    const adapter = createSessionAdapter({ topicId: 'topic-primary-transfer', metadata, gateway, sessionStore: boundary.sessionStore });
    const first = await adapter.create({ logicalOperationId: randomUUID(), isPrimary: true });
    const second = await adapter.create({ logicalOperationId: randomUUID(), isPrimary: true });
    assert.equal(metadata.getSessionState(first.value.sourceReference.referenceId).isPrimary, false);
    assert.equal(metadata.getSessionState(second.value.sourceReference.referenceId).isPrimary, true);
    assert.equal(metadata.listSessionStates().filter((state) => state.isPrimary).length, 1);
    const closed = await adapter.close({ referenceId: first.value.sourceReference.referenceId, logicalOperationId: randomUUID() });
    assert.equal(closed.value.status, 'closed');
    let dispatched = false;
    gateway.request = async (method) => { if (method === 'chat.send') dispatched = true; if (method === 'sessions.list') return { sessions: [{ ['k' + 'ey']: first.value.sourceReference.externalSourceId, sessionId: metadata.getSessionState(first.value.sourceReference.referenceId).sessionId }] }; return {}; };
    await assert.rejects(
      () => adapter.send({ referenceId: first.value.sourceReference.referenceId, message: '   ', logicalOperationId: randomUUID() }),
      (error) => error.code === 'invalid-request' && /non-blank/i.test(error.message)
    );
    await assert.rejects(
      () => adapter.send({ referenceId: first.value.sourceReference.referenceId, message: 'must not dispatch', logicalOperationId: randomUUID() }),
      (error) => error.code === 'conflict' && /Closed Conversation/i.test(error.message)
    );
    assert.equal(dispatched, false);
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('close and reopen are journaled and replay without repeating metadata effects', async () => {
  const metadata = metadataFixture();
  const reference = {
    version: 1,
    referenceId: 'session:journaled',
    topicId: 'topic-session',
    sourceSystem: 'openclaw',
    sourceKind: 'session',
    externalSourceId: 'agent:main:command-center:journaled',
    observedRevision: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  metadata.refs.push(reference);
  let writes = 0;
  const originalSet = metadata.setSessionState;
  metadata.setSessionState = (value) => { writes += 1; return originalSet(value); };
  const operations = new Map();
  metadata.getOperation = (id) => operations.get(id) ?? null;
  metadata.recordOperation = (value) => { const row = { ...operations.get(value.logicalOperationId), ...value }; operations.set(value.logicalOperationId, row); return row; };
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'fictional-session', status: 'open', isPrimary: false, updatedAt: new Date().toISOString() });
  writes = 0;
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway: { request: async (method) => method === 'sessions.list' ? { sessions: [{ ['k' + 'ey']: reference.externalSourceId, sessionId: 'fictional-session' }] } : ({}) } });
  const closeId = randomUUID();
  const first = await adapter.close({ referenceId: reference.referenceId, logicalOperationId: closeId, requestId: 'transport-close-1' });
  assert.equal(first.value.status, 'closed');
  assert.equal(operations.get(closeId).state, 'applied');
  await adapter.close({ referenceId: reference.referenceId, logicalOperationId: closeId, requestId: 'transport-close-2' });
  assert.equal(writes, 1);
  const reopenId = randomUUID();
  const reopened = await adapter.reopen({ referenceId: reference.referenceId, logicalOperationId: reopenId, requestId: 'transport-open-1' });
  assert.equal(reopened.value.status, 'open');
  assert.equal(operations.get(reopenId).state, 'applied');
});

test('applied Session send replay reconciles history without redispatch', async () => {
  const metadata = metadataFixture();
  const reference = { version: 1, referenceId: 'session:send-replay', topicId: 'topic-session', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:command-center:send-replay', observedRevision: null };
  metadata.refs.push(reference);
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'send-replay-id', status: 'open', isPrimary: false });
  const calls = [];
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'chat.send') return { runId: params.idempotencyKey, status: 'started' };
    if (method === 'sessions.list') return { sessions: [{ ['k' + 'ey']: reference.externalSourceId, sessionId: 'send-replay-id' }] };
    if (method === 'chat.history') return { sessionId: 'send-replay-id', messages: [{ role: 'user', __openclaw: { idempotencyKey: `${operationId}:user` } }] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const operationId = randomUUID();
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  await adapter.send({ referenceId: reference.referenceId, message: 'fictional', logicalOperationId: operationId, requestId: 'send-first' });
  metadata.setSessionState({ referenceId: reference.referenceId, sessionId: 'send-replay-id', status: 'closed', isPrimary: false });
  const replay = await adapter.send({ referenceId: reference.referenceId, message: 'fictional', logicalOperationId: operationId, requestId: 'send-replay' });
  assert.equal(replay.value.runId, operationId);
  assert.equal(calls.filter((call) => call.method === 'chat.send').length, 1);
  assert.equal(calls.filter((call) => call.method === 'chat.history').length, 1);
  await assert.rejects(
    () => adapter.send({ referenceId: reference.referenceId, message: 'changed intent', logicalOperationId: operationId, requestId: 'send-changed-intent' }),
    (error) => error.code === 'intent-mismatch'
  );
});

test('applied Session create replay preserves a later Closed state', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const operationId = randomUUID();
  const boundary = pluginSessionBoundary();
  const gateway = { request: async (...args) => { calls.push({ method: args[0], params: args[1] }); return boundary.gateway.request(...args); } };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway, sessionStore: boundary.sessionStore });
  const created = await adapter.create({ logicalOperationId: operationId, requestId: 'create-first' });
  metadata.setSessionState({ referenceId: created.value.sourceReference.referenceId, sessionId: created.value.sessionId, status: 'closed', isPrimary: false });
  await adapter.create({ logicalOperationId: operationId, requestId: 'create-replay' });
  assert.equal(metadata.getSessionState(created.value.sourceReference.referenceId).status, 'closed');
  assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 1);
});

test('Session create rejects logical operation reuse with changed primary or Topic intent', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-session-intent-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    metadata.createTopic({ topicId: 'topic-one', paraCategory: 'project', lifecycle: 'active' });
    metadata.createTopic({ topicId: 'topic-two', paraCategory: 'project', lifecycle: 'active' });
    const boundary = pluginSessionBoundary();
    const gateway = boundary.gateway;
    const operationId = randomUUID();
    await createSessionAdapter({ topicId: 'topic-one', metadata, gateway, sessionStore: boundary.sessionStore }).create({ logicalOperationId: operationId, isPrimary: false });
    await assert.rejects(
      () => createSessionAdapter({ topicId: 'topic-one', metadata, gateway, sessionStore: boundary.sessionStore }).create({ logicalOperationId: operationId, isPrimary: true }),
      (error) => error.code === 'intent-mismatch'
    );
    await assert.rejects(
      () => createSessionAdapter({ topicId: 'topic-two', metadata, gateway, sessionStore: boundary.sessionStore }).create({ logicalOperationId: operationId, isPrimary: false }),
      (error) => error.code === 'intent-mismatch'
    );
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
