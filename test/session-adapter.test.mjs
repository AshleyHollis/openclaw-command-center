import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';

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

test('Session create/history/send use exact linked keys without transcript inheritance', async () => {
  const metadata = metadataFixture();
  const calls = [];
  const gateway = { request: async (method, params) => { calls.push({ method, params }); if (method === 'sessions.create') return { ['k' + 'ey']: params['k' + 'ey'], sessionId: 'fictional-session-id' }; if (method === 'sessions.list') return { sessions: metadata.refs.map((reference) => ({ ['k' + 'ey']: reference.externalSourceId, sessionId: metadata.getSessionState(reference.referenceId).sessionId })) }; if (method === 'chat.history') return { messages: ['authoritative'] }; return { runId: params.idempotencyKey }; } };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const logicalOperationId = randomUUID();
  const created = await adapter.create({ logicalOperationId, isPrimary: true });
  assert.equal(created.value.sourceReference.externalSourceId, `agent:main:command-center:${logicalOperationId}`);
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
  const gateway = {
    async request(method, params) {
      if (method !== 'sessions.create') throw new Error(`Unexpected ${method}`);
      return { ok: true, ['k' + 'ey']: params['k' + 'ey'], entry: { sessionId: 'entry-session-id', updatedAt: 42 } };
    }
  };
  const adapter = createSessionAdapter({ metadata, gateway, topicId: 'topic-entry-shape' });
  const created = await adapter.create({ logicalOperationId: randomUUID(), label: 'Entry Shape', isPrimary: true });
  assert.equal(created.value.sessionId, 'entry-session-id');
  assert.equal(created.value.creationRevision, '42');
  assert.equal(metadata.getSessionState(created.value.sourceReference.referenceId).sessionId, 'entry-session-id');
});

test('Session create and exact verification use the pinned host session-store runtime without trusted Gateway authority', async () => {
  const metadata = metadataFixture();
  const entries = new Map();
  const sessionStore = {
    listSessionEntries() {
      return [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry }));
    },
    async createSessionEntry({ cfg, key, label, initialEntry }) {
      assert.deepEqual(cfg, { fictional: true });
      assert.equal(initialEntry.agentHarnessId, 'command-center');
      assert.equal(initialEntry.modelSelectionLocked, true);
      const entry = {
        sessionId: randomUUID(),
        updatedAt: Date.now(),
        label,
        ...initialEntry
      };
      entries.set(key, entry);
      return { key, agentId: 'main', sessionId: entry.sessionId, entry };
    }
  };
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
  const adapter = createSessionAdapter({ api: { config: { fictional: true } }, metadata, sessionStore, transcriptReader, topicId: 'topic-runtime-store' });
  const beforeCreate = Date.now();
  const created = await adapter.create({ logicalOperationId, label: 'Runtime Store', isPrimary: true });
  const afterCreate = Date.now();
  const sessionKey = `agent:main:command-center:${logicalOperationId}`;

  assert.equal(created.value.sourceReference.externalSourceId, sessionKey);
  assert.equal(entries.get(sessionKey).label, 'Runtime Store');
  assert.equal(entries.get(sessionKey).pluginExtensions.commandCenter.logicalOperationId, logicalOperationId);
  assert.equal(entries.get(sessionKey).updatedAt >= beforeCreate && entries.get(sessionKey).updatedAt <= afterCreate, true);
  assert.match(created.value.sessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(created.value.creationRevision, String(entries.get(sessionKey).updatedAt));
  const replay = await adapter.create({ logicalOperationId, label: 'Runtime Store', isPrimary: true });
  assert.equal(replay.value.creationRevision, created.value.creationRevision);
  await adapter.resolveExact({ referenceId: created.value.sourceReference.referenceId });
  const history = await adapter.history({ referenceId: created.value.sourceReference.referenceId, limit: 10 });
  assert.deepEqual(history.messages, [{ role: 'user', content: 'Fictional history' }]);
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

test('Session-store creation refuses an occupied deterministic key without overwriting its identity', async () => {
  const metadata = metadataFixture();
  const logicalOperationId = randomUUID();
  const sessionKey = `agent:main:command-center:${logicalOperationId}`;
  const foreign = { sessionId: randomUUID(), updatedAt: 10, label: 'Foreign Session' };
  const entries = new Map([[sessionKey, foreign]]);
  const sessionStore = {
    listSessionEntries: () => [...entries].map(([key, entry]) => ({ sessionKey: key, entry })),
    async upsertSessionEntry({ sessionKey: key, entry }) { entries.set(key, entry); }
  };
  const adapter = createSessionAdapter({ metadata, sessionStore, topicId: 'topic-collision' });

  await assert.rejects(
    adapter.create({ logicalOperationId, label: 'Must Not Overwrite', isPrimary: true }),
    (error) => error.code === 'conflict' && /already exists/i.test(error.message)
  );
  assert.deepEqual(entries.get(sessionKey), foreign);
  assert.deepEqual(metadata.refs, []);
});

test('pinned Session store creation uses atomic patch fallback', async () => {
  const metadata = metadataFixture();
  const entries = new Map();
  let patchInput;
  const sessionStore = {
    listSessionEntries: () => [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry })),
    async patchSessionEntry(input) {
      patchInput = input;
      const existingEntry = entries.get(input.sessionKey);
      const current = existingEntry ?? input.fallbackEntry;
      const patch = await input.update(current, { existingEntry });
      if (!patch) return null;
      const next = input.replaceEntry ? patch : { ...current, ...patch };
      entries.set(input.sessionKey, next);
      return next;
    }
  };
  const logicalOperationId = randomUUID();
  const adapter = createSessionAdapter({ metadata, sessionStore, topicId: 'topic-atomic-runtime' });
  const created = await adapter.create({ logicalOperationId, label: 'Atomic Runtime', isPrimary: true });

  assert.equal(created.value.sessionId, logicalOperationId);
  assert.equal(patchInput.replaceEntry, true);
  assert.equal(patchInput.fallbackEntry.sessionId, logicalOperationId);
});

test('pending Session-store replay conflicts with a foreign row at the deterministic key', async () => {
  const metadata = metadataFixture();
  const operations = new Map();
  metadata.getOperation = (id) => operations.get(id) ?? null;
  metadata.recordOperation = (value) => {
    const row = { ...operations.get(value.logicalOperationId), ...value };
    operations.set(value.logicalOperationId, row);
    return row;
  };
  const entries = new Map();
  let interrupt = true;
  const sessionStore = {
    listSessionEntries: () => [...entries].map(([sessionKey, entry]) => ({ sessionKey, entry })),
    async upsertSessionEntry({ sessionKey, entry }) {
      if (interrupt) {
        interrupt = false;
        const error = new Error('fictional delivery interruption');
        error.code = 'timeout';
        error.ambiguous = true;
        throw error;
      }
      entries.set(sessionKey, entry);
    }
  };
  const logicalOperationId = randomUUID();
  const sessionKey = `agent:main:command-center:${logicalOperationId}`;
  const adapter = createSessionAdapter({ metadata, sessionStore, topicId: 'topic-pending-collision' });

  await assert.rejects(adapter.create({ logicalOperationId, label: 'Planned Session', isPrimary: true }), (error) => error.code === 'unknown');
  entries.set(sessionKey, { sessionId: randomUUID(), updatedAt: 99, label: 'Foreign Session' });
  await assert.rejects(adapter.create({ logicalOperationId, label: 'Planned Session', isPrimary: true }), (error) => error.code === 'conflict');
  assert.deepEqual(metadata.refs, []);
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

test('Primary close is rejected and ambiguous create reconciles by exact key lookup', async () => {
  const metadata = metadataFixture();
  let createCalls = 0;
  const gateway = { request: async (method, params) => {
    if (method === 'sessions.create') { createCalls += 1; const error = new Error('delivery unknown'); error.code = 'timeout'; error.ambiguous = true; throw error; }
    if (method === 'sessions.list') return { sessions: [{ ['k' + 'ey']: params['k' + 'ey'] ?? `agent:main:command-center:${operationId}`, sessionId: 'reconciled-id' }] };
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
    const gateway = { request: async (method, params) => method === 'sessions.list' ? { sessions: metadata.listSourceReferences('topic-primary-transfer').map((reference) => ({ ['k' + 'ey']: reference.externalSourceId, sessionId: metadata.getSessionState(reference.referenceId).sessionId })) } : ({ ['k' + 'ey']: params['k' + 'ey'], sessionId: `id:${params['k' + 'ey']}` }) };
    const adapter = createSessionAdapter({ topicId: 'topic-primary-transfer', metadata, gateway });
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
  const expectedKey = `agent:main:command-center:${operationId}`;
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.create') return { ['k' + 'ey']: expectedKey, sessionId: 'create-replay-id' };
    if (method === 'sessions.list') return { sessions: [{ ['k' + 'ey']: expectedKey, sessionId: 'create-replay-id' }] };
    throw new Error(`Unexpected method ${method}`);
  } };
  const adapter = createSessionAdapter({ topicId: 'topic-session', metadata, gateway });
  const created = await adapter.create({ logicalOperationId: operationId, requestId: 'create-first' });
  metadata.setSessionState({ referenceId: created.value.sourceReference.referenceId, sessionId: 'create-replay-id', status: 'closed', isPrimary: false });
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
    const gateway = { request: async (_method, params) => ({ ['k' + 'ey']: params['k' + 'ey'], sessionId: `id:${params['k' + 'ey']}` }) };
    const operationId = randomUUID();
    await createSessionAdapter({ topicId: 'topic-one', metadata, gateway }).create({ logicalOperationId: operationId, isPrimary: false });
    await assert.rejects(
      () => createSessionAdapter({ topicId: 'topic-one', metadata, gateway }).create({ logicalOperationId: operationId, isPrimary: true }),
      (error) => error.code === 'intent-mismatch'
    );
    await assert.rejects(
      () => createSessionAdapter({ topicId: 'topic-two', metadata, gateway }).create({ logicalOperationId: operationId, isPrimary: false }),
      (error) => error.code === 'intent-mismatch'
    );
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
