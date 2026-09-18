import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'topic-assignment-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  const topicId = '44444444-4444-4444-8444-444444444444';
  metadata.createTopic({ topicId, name: 'Fictional', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'primary', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:primary', observedRevision: '10' }, state: { referenceId: 'primary', sessionId: 'primary-id', status: 'open', isPrimary: true, displayName: 'Primary' } });
  const rows = new Map([['agent:main:primary', { sessionId: 'primary-id', updatedAt: 10 }], ['agent:main:inbox', { sessionId: 'inbox-id', updatedAt: 20 }]]);
  const sessionStore = { getSessionEntry: ({ sessionKey }) => rows.get(sessionKey), listSessionEntries: () => [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry })) };
  const service = new AuthoritativeSourceService({ api: { config: { session: { mainKey: 'general' } } }, metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  let current = true;
  const runtime = { creationAuthority: { principalId: 'fixture-operator', assertCurrent() { if (!current) throw Object.assign(new Error('retired'), { code: 'unauthenticated' }); } } };
  const input = { schemaVersion: 1, topicId, logicalOperationId: randomUUID(), sessionKey: 'agent:main:inbox', expectedSessionId: 'inbox-id', expectedSessionRevision: '20', expectedMembership: 'unassigned', expectedTopicRevision: 0 };
  try { await run({ metadata, service, rows, runtime, input, retire: () => { current = false; } }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('assignment atomically attaches an exact unassigned Conversation and replays its receipt', () => fixture(async ({ metadata, service, runtime, input }) => {
  const bridgeInput = { ...input, requestId: 'gateway-assignment-1' };
  const applied = await service.sessionsAssignTopic(bridgeInput, runtime);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.topicRevision, 1);
  assert.equal(metadata.getSourceReference(applied.referenceId).externalSourceId, input.sessionKey);
  assert.equal(metadata.getSessionState(applied.referenceId).sessionId, input.expectedSessionId);
  assert.deepEqual(await service.sessionsAssignTopic(bridgeInput, runtime), { ...applied, status: 'replayed' });
}));

test('assignment refuses a replaced native incarnation or an already owned Conversation', () => fixture(async ({ service, runtime, input, rows }) => {
  rows.get(input.sessionKey).updatedAt = 21;
  await assert.rejects(service.sessionsAssignTopic(input, runtime), { code: 'conflict' });
  rows.get(input.sessionKey).updatedAt = 20;
  await service.sessionsAssignTopic(input, runtime);
  await assert.rejects(service.sessionsAssignTopic({ ...input, logicalOperationId: randomUUID(), expectedTopicRevision: 1 }, runtime), { code: 'conflict' });
}));

test('assignment never publishes after authenticated authority retires', () => fixture(async ({ metadata, service, runtime, input, retire }) => {
  retire();
  await assert.rejects(service.sessionsAssignTopic(input, runtime), { code: 'unauthenticated' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
}));

test('assignment rejects protected or closed native entries without changing Topic ownership', () => fixture(async ({ metadata, service, runtime, input, rows }) => {
  rows.get(input.sessionKey).category = 'history';
  await assert.rejects(service.sessionsAssignTopic(input, runtime), { code: 'conflict' });
  rows.get(input.sessionKey).category = undefined;
  rows.get(input.sessionKey).status = 'closed';
  await assert.rejects(service.sessionsAssignTopic({ ...input, logicalOperationId: randomUUID() }, runtime), { code: 'conflict' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
}));

test('assignment owner rejects the configured General key even when a caller bypasses sidebar presentation flags', () => fixture(async ({ metadata, service, runtime, input, rows }) => {
  rows.set('agent:main:general', { sessionId: 'general-id', updatedAt: 22 });
  await assert.rejects(service.sessionsAssignTopic({
    ...input,
    logicalOperationId: randomUUID(),
    sessionKey: 'agent:main:general',
    expectedSessionId: 'general-id',
    expectedSessionRevision: '22'
  }, runtime), { code: 'conflict' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
}));

test('assignment owner refuses a durable Imported History target and its reused native key', () => fixture(async ({ metadata, runtime, input, rows }) => {
  const historyKey = 'agent:main:command-center:history:fictional-history';
  rows.set(historyKey, { sessionId: 'history-id', updatedAt: 30 });
  const protectedMetadata = Object.create(metadata);
  Object.defineProperty(protectedMetadata, 'listImportedHistories', { value: () => [{
    phase: 'verified', target: { agentId: 'main', sessionKey: historyKey, sessionId: 'history-id' }
  }] });
  const protectedService = new AuthoritativeSourceService({
    api: { config: { session: { mainKey: 'general' } } }, metadata: protectedMetadata,
    sessionStore: { getSessionEntry: ({ sessionKey }) => rows.get(sessionKey), listSessionEntries: () => [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry })) },
    capabilities: { sessions: true, notes: false, scheduler: false }
  });
  const historyInput = { ...input, logicalOperationId: randomUUID(), sessionKey: historyKey, expectedSessionId: 'history-id', expectedSessionRevision: '30' };
  await assert.rejects(protectedService.sessionsAssignTopic(historyInput, runtime), { code: 'conflict' });
  rows.set(historyKey, { sessionId: 'history-replacement', updatedAt: 31 });
  await assert.rejects(protectedService.sessionsAssignTopic({ ...historyInput, logicalOperationId: randomUUID(), expectedSessionId: 'history-replacement', expectedSessionRevision: '31' }, runtime), { code: 'source-recovery' });
  assert.equal(metadata.listSourceReferences(input.topicId).length, 1);
}));

test('concurrent assignment attempts publish one owner and retain a replayable receipt', () => fixture(async ({ metadata, service, runtime, input }) => {
  const otherTopicId = '55555555-5555-4555-8555-555555555555';
  metadata.createTopic({ topicId: otherTopicId, name: 'Other', paraCategory: 'area', lifecycle: 'active' });
  const other = { ...input, logicalOperationId: randomUUID(), topicId: otherTopicId };
  const outcomes = await Promise.allSettled([service.sessionsAssignTopic(input, runtime), service.sessionsAssignTopic(other, runtime)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(metadata.listTopics().flatMap(topic => metadata.listSourceReferences(topic.topicId)).filter(reference => reference.externalSourceId === input.sessionKey).length, 1);
  const winner = outcomes.find(outcome => outcome.status === 'fulfilled').value;
  const replayInput = winner.topicId === input.topicId ? input : other;
  assert.equal((await service.sessionsAssignTopic(replayInput, runtime)).status, 'replayed');
}));
