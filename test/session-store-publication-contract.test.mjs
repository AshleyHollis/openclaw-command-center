import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';

// Real metadata owners with the same dual-method runtime shape as the host.
// Unlike a direct adapter fixture, this enters the production API wrapper.
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'session-publication-contract-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  const topicId = '44444444-4444-4444-8444-444444444444';
  const primaryKey = 'agent:main:dashboard:primary';
  const inboxKey = 'agent:main:dashboard:inbox';
  const rows = new Map([[primaryKey, { sessionId: 'primary-id', updatedAt: 10 }], [inboxKey, { sessionId: 'inbox-id', updatedAt: 15 }]]);
  metadata.createTopic({ topicId, name: 'Fictional', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'primary-ref', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: primaryKey, observedRevision: '10' },
    state: { referenceId: 'primary-ref', sessionId: 'primary-id', status: 'open', isPrimary: true, displayName: 'Primary' } });
  const reads = { sync: 0, async: 0 };
  const hooks = { beforeSync: undefined, afterAsync: undefined };
  const copy = key => rows.has(key) ? { ...rows.get(key) } : undefined;
  const store = {
    listSessionEntries: () => [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry: { ...entry } })),
    getSessionEntry(params) { reads.sync++; hooks.beforeSync?.(params); return copy(params.sessionKey); },
    async getSessionEntryAsync(params) { reads.async++; const entry = copy(params.sessionKey); await Promise.resolve(); hooks.afterAsync?.(params); return entry; }
  };
  const api = { runtime: { agent: { session: store } } };
  const service = new AuthoritativeSourceService({ metadata, api, capabilities: { sessions: true, notes: false, scheduler: false } });
  let dispatches = 0;
  const createdKey = 'agent:main:dashboard:created';
  const runtime = { creationAuthority: { principalId: 'fictional-operator', assertCurrent() {} }, gatewayRequest: async (method, params) => {
    assert.equal(method, 'sessions.create'); dispatches++;
    const entry = { sessionId: 'created-id', updatedAt: 20, label: params.label }; rows.set(createdKey, entry);
    return { key: createdKey, sessionId: entry.sessionId, entry };
  } };
  const input = { schemaVersion: 1, topicId, logicalOperationId: randomUUID(), expectedTopicRevision: 0, label: 'Planning' };
  const assignment = { schemaVersion: 1, topicId, logicalOperationId: randomUUID(), sessionKey: inboxKey, expectedSessionId: 'inbox-id', expectedSessionRevision: '15', expectedMembership: 'unassigned', expectedTopicRevision: 0 };
  try { await run({ metadata, rows, service, store, reads, hooks, runtime, input, assignment, primaryKey, inboxKey, createdKey, dispatches: () => dispatches }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('production wrapper keeps synchronous and asynchronous Session reads distinct', () => fixture(async ({ service, input, primaryKey, reads }) => {
  const wrapped = service.forTopic(input.topicId).sessions.sessionStore;
  const exact = wrapped.getSessionEntry({ agentId: 'main', sessionKey: primaryKey, readConsistency: 'latest' });
  assert.equal(exact.sessionId, 'primary-id'); assert.equal(exact.then, undefined);
  const pending = wrapped.getSessionEntryAsync({ agentId: 'main', sessionKey: primaryKey, readConsistency: 'latest' });
  assert.equal(typeof pending.then, 'function'); assert.equal((await pending).sessionId, 'primary-id');
  assert.deepEqual(reads, { sync: 1, async: 1 });
}));

test('production wrapper creates, replays and acknowledges one exact Conversation', () => fixture(async ({ service, metadata, runtime, input, reads, dispatches }) => {
  const applied = await service.sessionsCreate(input, runtime);
  assert.equal(applied.status, 'applied'); assert.equal(applied.value.sessionId, 'created-id');
  assert.deepEqual(await service.sessionsCreate(input, runtime), applied); assert.equal(dispatches(), 1);
  const referenceId = applied.value.sourceReference.referenceId;
  const acknowledgement = await service.sessionsCreationAcknowledge({ topicId: input.topicId, logicalOperationId: input.logicalOperationId, referenceId }, runtime);
  assert.equal(acknowledgement.status, 'acknowledged');
  assert.equal(metadata.getSessionState(referenceId).sessionId, 'created-id');
  assert.ok(reads.async >= 2, 'Awaitable preparation must retain the public async reader');
  assert.ok(reads.sync >= 3, 'Publication, replay and acknowledgement must retain synchronous fences');
}));

test('production wrapper assigns an exact existing Conversation and replays without a native effect', () => fixture(async ({ service, metadata, runtime, assignment, reads, dispatches }) => {
  const applied = await service.sessionsAssignTopic(assignment, runtime);
  assert.equal(applied.status, 'applied'); assert.equal(metadata.getSessionState(applied.referenceId).sessionId, assignment.expectedSessionId);
  const replay = await service.sessionsAssignTopic(assignment, runtime); assert.equal(replay.status, 'replayed');
  assert.equal(replay.referenceId, applied.referenceId); assert.equal(dispatches(), 0);
  assert.ok(reads.sync >= 2); assert.equal(reads.async, 0);
}));

for (const replaced of ['created', 'primary']) test(`production wrapper refuses ${replaced} generation drift at the final publication fence`, () => fixture(async ({ service, metadata, rows, hooks, runtime, input, primaryKey, createdKey, dispatches }) => {
  hooks.afterAsync = params => {
    if (params.sessionKey === createdKey) {
      const key = replaced === 'created' ? createdKey : primaryKey;
      rows.set(key, { ...rows.get(key), sessionId: 'replaced-id' });
    }
  };
  await assert.rejects(service.sessionsCreate(input, runtime), { code: 'source-recovery' });
  assert.equal(dispatches(), 1); assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'unknown');
  assert.equal(metadata.getTopicOperation(input.logicalOperationId).result.nativeResult.sessionId, 'created-id');
}));

test('production wrapper refuses acknowledgement after the native generation is replaced', () => fixture(async ({ service, rows, runtime, input, createdKey }) => {
  const applied = await service.sessionsCreate(input, runtime);
  rows.set(createdKey, { ...rows.get(createdKey), sessionId: 'replacement-id' });
  await assert.rejects(service.sessionsCreationAcknowledge({ topicId: input.topicId, logicalOperationId: input.logicalOperationId, referenceId: applied.value.sourceReference.referenceId }, runtime), { code: 'source-recovery' });
}));
