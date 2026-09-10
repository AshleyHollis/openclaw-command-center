import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMutationCoordinator } from '../src/sources/mutation-coordinator.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { validateMutationEnvelope } from '../src/sources/operation-journal.mjs';

test('reconcile-only joins an active effect then verifies it without executing another write', async () => {
  const coordinator = createMutationCoordinator();
  let release; const held = new Promise((resolve) => { release = resolve; });
  let effects = 0; let verifications = 0;
  const input = { operationKind: 'notes.edit', requestId: 'save', logicalOperationId: randomUUID(), intent: { text: 'submitted' },
    execute: async () => { effects++; await held; return { path: 'brief.md', revision: 'r2' }; },
    reconcile: async () => { verifications++; return { outcome: 'applied', value: { path: 'brief.md', revision: 'r2' } }; } };
  const save = coordinator.mutate(input);
  const check = coordinator.reconcile({ ...input, requestId: 'check', execute: () => { throw new Error('Read-only reconciliation executed a write'); } });
  try { await new Promise((resolve) => setImmediate(resolve)); assert.equal(effects, 1); assert.equal(verifications, 0); }
  finally { release(); await save; }
  assert.equal((await check).status, 'applied');
  assert.equal((await check).requestId, 'check');
  assert.equal(effects, 1); assert.equal(verifications, 1);
});

test('an explicit write waiting for a not-applied reconciliation is not mistaken for a completed write', async () => {
  const coordinator = createMutationCoordinator();
  let release; const held = new Promise((resolve) => { release = resolve; });
  let effects = 0;
  const input = { operationKind: 'notes.edit', requestId: 'check', logicalOperationId: randomUUID(), intent: { text: 'submitted' },
    execute: async () => { effects++; return { revision: 'r2' }; }, reconcile: async () => { await held; return { outcome: 'not-applied' }; } };
  const check = coordinator.reconcile(input);
  const save = coordinator.mutate({ ...input, requestId: 'explicit-save' });
  release();
  assert.equal((await check).status, 'not-applied');
  assert.equal((await save).status, 'applied'); assert.equal(effects, 1);
});

test('concurrent retries wait for their logical operation without reconciling an active write', async () => {
  const coordinator = createMutationCoordinator();
  const logicalOperationId = randomUUID();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0; let reconciles = 0;
  const input = { operationKind: 'notes.edit', requestId: 'first', logicalOperationId, intent: { text: 'new' }, execute: async () => { calls++; await wait; return { id: 'saved' }; }, reconcile: async () => { reconciles++; return { outcome: 'not-applied' }; } };
  const first = coordinator.mutate(input);
  const retry = coordinator.mutate({ ...input, requestId: 'retry' });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(reconciles, 0);
    await assert.rejects(coordinator.mutate({ ...input, intent: { text: 'different' } }), (error) => error.code === 'intent-mismatch');
  } finally { release(); await Promise.allSettled([first, retry]); }
  assert.equal((await first).requestId, 'first');
  assert.equal((await retry).requestId, 'retry');
  assert.equal((await retry).value.id, 'saved');
});

test('MutationEnvelopeV1 is closed and retains caller transport and logical IDs', () => {
  const logicalOperationId = randomUUID();
  const envelope = validateMutationEnvelope({ version: 1, transportRequestId: 'frame-1', logicalOperationId, action: 'notes.edit', topicId: 'topic-1', referenceId: 'note-1', input: { expectedRevision: 'opaque' } });
  assert.equal(envelope.transportRequestId, 'frame-1');
  assert.equal(envelope.logicalOperationId, logicalOperationId);
  assert.throws(() => validateMutationEnvelope({ ...envelope, extra: true }), /unsupported field/i);
});

test('joining an active mutation still validates the retry transport identity', async () => {
  const coordinator = createMutationCoordinator();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const input = { operationKind: 'notes.edit', requestId: 'first', logicalOperationId: randomUUID(), intent: { text: 'new' }, execute: async () => { await wait; return { id: 'saved' }; } };
  const first = coordinator.mutate(input);
  const rejectedRetry = assert.rejects(coordinator.mutate({ ...input, requestId: ' ' }), (error) => error.code === 'invalid-request');
  release();
  await first;
  await rejectedRetry;
});

test('coordinator retains logical IDs, retries one idempotent ambiguous mutation, and records intent', async () => {
  const calls = [];
  const journal = new Map();
  const coordinator = createMutationCoordinator({
    journal: { get: (id) => journal.get(id) ?? null, record: (value) => { journal.set(value.logicalOperationId, { ...journal.get(value.logicalOperationId), ...value }); return journal.get(value.logicalOperationId); } }
  });
  const logicalOperationId = randomUUID();
  const result = await coordinator.mutate({ operationKind: 'chat.send', requestId: 'frame-1', logicalOperationId, intent: { text: 'fictional' }, idempotent: true, execute: async (ids) => { calls.push(ids); if (calls.length === 1) { const error = new Error('delivery unknown'); error.code = 'unavailable'; error.ambiguous = true; throw error; } return { id: 'result-1' }; } });
  assert.equal(result.status, 'applied');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].logicalOperationId, logicalOperationId);
  assert.equal(calls[1].logicalOperationId, logicalOperationId);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.deepEqual(calls.map((call) => call.attempt), [0, 1]);
  await assert.rejects(() => coordinator.mutate({ operationKind: 'chat.send', requestId: 'frame-2', logicalOperationId, intent: { text: 'different' }, idempotent: true, execute: async () => ({}) }), /different intent/i);
});

test('non-idempotent ambiguous mutations reconcile without a blind retry', async () => {
  const calls = [];
  const coordinator = createMutationCoordinator();
  const result = await coordinator.mutate({ operationKind: 'sessions.create', requestId: 'frame-1', logicalOperationId: randomUUID(), intent: { ['k' + 'ey']: 'fictional' }, execute: async (ids) => { calls.push(ids); const error = new Error('timeout'); error.code = 'timeout'; error.ambiguous = true; throw error; }, reconcile: async () => ({ matched: true, value: { id: 'existing' } }) });
  assert.equal(result.status, 'applied');
  assert.equal(calls.length, 1);
});

test('unknown delivery is durable and an explicit retry reconciles again before dispatch', async () => {
  const journal = new Map();
  const coordinator = createMutationCoordinator({
    journal: { get: (id) => journal.get(id) ?? null, record: (value) => { journal.set(value.logicalOperationId, { ...journal.get(value.logicalOperationId), ...value }); return journal.get(value.logicalOperationId); } }
  });
  const logicalOperationId = randomUUID();
  let dispatches = 0;
  let observations = 0;
  const execute = async () => { dispatches += 1; const error = new Error('timeout'); error.ambiguous = true; throw error; };
  const reconcile = async () => ({ outcome: ++observations === 1 ? 'unknown' : 'applied', value: { id: 'eventually-visible' } });
  await assert.rejects(() => coordinator.mutate({ operationKind: 'cron.run', requestId: 'frame-1', logicalOperationId, intent: { jobId: 'job-1' }, execute, reconcile }), (error) => error.code === 'unknown');
  assert.equal(journal.get(logicalOperationId).state, 'unknown');
  const retry = await coordinator.mutate({ operationKind: 'cron.run', requestId: 'frame-2', logicalOperationId, intent: { jobId: 'job-1' }, execute, reconcile });
  assert.equal(retry.status, 'applied');
  assert.equal(dispatches, 1);
  assert.equal(observations, 2);
});

test('terminal applied replay reconstructs the authoritative result without redispatch', async () => {
  const journal = new Map();
  const coordinator = createMutationCoordinator({
    journal: { get: (id) => journal.get(id) ?? null, record: (value) => { journal.set(value.logicalOperationId, { ...journal.get(value.logicalOperationId), ...value }); return journal.get(value.logicalOperationId); } }
  });
  const logicalOperationId = randomUUID();
  let dispatches = 0;
  const intent = { path: 'fictional.md' };
  await coordinator.mutate({
    operationKind: 'notes.create',
    requestId: 'frame-first',
    logicalOperationId,
    intent,
    execute: async () => { dispatches += 1; return { note: { path: 'fictional.md', revision: 'revision-1' } }; },
    reconcile: async () => ({ outcome: 'applied', value: { note: { path: 'fictional.md', revision: 'revision-1' } } })
  });

  const replay = await coordinator.mutate({
    operationKind: 'notes.create',
    requestId: 'frame-replay',
    logicalOperationId,
    intent,
    execute: async () => { dispatches += 1; throw new Error('must not redispatch'); },
    reconcile: async ({ applied, retry }) => {
      assert.equal(applied, true);
      assert.equal(retry, true);
      return { outcome: 'applied', value: { note: { path: 'fictional.md', revision: 'revision-1' } } };
    }
  });

  assert.equal(dispatches, 1);
  assert.equal(replay.requestId, 'frame-replay');
  assert.deepEqual(replay.value, { note: { path: 'fictional.md', revision: 'revision-1' } });
  assert.equal('intentDigest' in replay, false);
});

test('memory-journal terminal writes preserve the durable pending creation timestamp', async () => {
  const ticks = [
    '2026-08-23T15:00:00.000Z',
    '2026-08-23T15:00:01.000Z',
    '2026-08-23T15:00:02.000Z',
    '2026-08-23T15:00:03.000Z'
  ];
  const coordinator = createMutationCoordinator({ now: () => ticks.shift() ?? '2026-08-23T15:00:04.000Z' });
  const logicalOperationId = randomUUID();
  let createdAtDuringEffect;
  await coordinator.mutate({
    operationKind: 'sessions.create',
    requestId: 'frame-created-at',
    logicalOperationId,
    intent: { sessionKey: 'agent:main:command-center:fictional' },
    execute: async ({ operationCreatedAt }) => {
      createdAtDuringEffect = operationCreatedAt;
      return { id: 'fictional-session' };
    },
    reconcile: async () => ({ outcome: 'applied', value: { id: 'fictional-session' } })
  });
  assert.equal(coordinator.journal.get(logicalOperationId).createdAt, createdAtDuringEffect);
});

test('ambiguous Note move never adopts an identical unrelated destination', async () => {
  for (const sourcePresent of [true, false]) {
    const logicalOperationId = randomUUID();
    const coordinator = createMutationCoordinator();
    const notes = {
      moveCalls: 0,
      async read({ path }) {
        if (path === 'source.md' && !sourcePresent) { const error = new Error('missing'); error.code = 'not-found'; throw error; }
        return { path, revision: 'sha256:identical', text: 'fictional', sourceReference: { referenceId: `note:${path}` } };
      },
      async move() { this.moveCalls += 1; throw new Error('must not dispatch'); }
    };
    const metadata = {
      getTopic: (topicId) => topicId === 'topic-move' ? { topicId, lifecycle: 'active', paraCategory: 'project', activatedAt: '2026-08-27T00:00:00.000Z' } : null,
      getOperatingStatus: () => ({ mode: 'normal', schemaVersion: 2, diagnostics: [] }),
      listSourceReferences: () => []
    };
    const service = createAuthoritativeSourceService({ metadata, coordinator, capabilities: { notes: true } });
    service.forTopic = () => ({ notes });
    const input = {
      schemaVersion: 1,
      topicId: 'topic-move',
      path: 'source.md',
      destinationPath: 'destination.md',
      expectedRevision: 'sha256:identical',
      logicalOperationId,
      requestId: 'frame-replay'
    };
    const { requestId: _requestId, schemaVersion: _schemaVersion, ...intent } = input;
    await assert.rejects(
      () => coordinator.mutate({
        operationKind: 'notes.move',
        requestId: 'frame-pending',
        logicalOperationId,
        intent,
        execute: async () => { const error = new Error('delivery unknown'); error.ambiguous = true; throw error; },
        reconcile: async () => ({ outcome: 'unknown' })
      }),
      (error) => error.code === 'unknown'
    );

    await assert.rejects(() => service.notesMove(input), (error) => error.code === (sourcePresent ? 'conflict' : 'unknown'));
    assert.equal(notes.moveCalls, 0);
    assert.equal(coordinator.journal.get(logicalOperationId).state, sourcePresent ? 'conflict' : 'unknown');
  }
});

test('applied Note move replay proves the exact durable destination identity without redispatch', async () => {
  const logicalOperationId = randomUUID();
  const coordinator = createMutationCoordinator();
  let moved = false;
  let moveCalls = 0;
  const destination = { path: 'destination.md', revision: 'sha256:moved', text: 'fictional', sourceReference: { referenceId: 'note:destination' } };
  const notes = {
    async read({ path }) {
      if (path === 'source.md' && !moved) return { ...destination, path: 'source.md', sourceReference: { referenceId: 'note:source' } };
      if (path === 'destination.md' && moved) return destination;
      const error = new Error('missing'); error.code = 'not-found'; throw error;
    },
    async move() { moveCalls += 1; moved = true; return { schemaVersion: 1, status: 'applied', note: destination }; }
  };
  const metadata = {
    getTopic: (topicId) => topicId === 'topic-move' ? { topicId, lifecycle: 'active', paraCategory: 'project', activatedAt: '2026-08-27T00:00:00.000Z' } : null,
    getOperatingStatus: () => ({ mode: 'normal', schemaVersion: 2, diagnostics: [] }),
    listSourceReferences: () => []
  };
  const service = createAuthoritativeSourceService({ metadata, coordinator, capabilities: { notes: true } });
  service.forTopic = () => ({ notes });
  const input = { schemaVersion: 1, topicId: 'topic-move', path: 'source.md', destinationPath: 'destination.md', expectedRevision: 'sha256:moved', logicalOperationId };
  await service.notesMove({ ...input, requestId: 'frame-first' });
  const replay = await service.notesMove({ ...input, requestId: 'frame-replay' });
  assert.equal(moveCalls, 1);
  assert.equal(replay.value.note.sourceReference.referenceId, 'note:destination');
});
