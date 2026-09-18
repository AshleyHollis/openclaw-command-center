import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

const topicId = '44444444-4444-4444-8444-444444444444';
const sessionKey = 'agent:main:dashboard:fictional';
async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'session-topic-context-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  metadata.createTopic({ topicId, name: 'Sample Project', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'primary-ref', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: '10' }, state: { referenceId: 'primary-ref', sessionId: 'original', status: 'open', isPrimary: true, displayName: 'Overview' } });
  const entry = { sessionId: 'original', updatedAt: 10, category: 'Unrelated group name' };
  const rows = [{ sessionKey, entry }];
  const sessionStore = { listSessionEntries: () => rows };
  const service = new AuthoritativeSourceService({ metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  const read = (key = sessionKey) => invokeBridgeMethod(service, 'command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey: key });
  try { await run({ metadata, service, sessionStore, entry, rows, read }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('native Session context resolves durable Topic ownership independently of native group labels', () => fixture(async ({ read, entry }) => {
  assert.deepEqual(await read(), { schemaVersion: 1, status: 'bound', sessionKey, sessionId: 'original', topicId, referenceId: 'primary-ref', name: 'Sample Project' });
  entry.category = 'Another group';
  assert.equal((await read()).topicId, topicId);
  assert.deepEqual(await read('agent:main:dashboard:unbound'), { schemaVersion: 1, status: 'unbound', sessionKey: 'agent:main:dashboard:unbound' });
}));

test('a reused native key cannot acquire the original Topic Notes', () => fixture(async ({ read, entry }) => {
  entry.sessionId = 'replacement';
  await assert.rejects(read(), /missing or replaced/);
}));

test('a binding replaced during context lookup cannot publish stale ownership', () => fixture(async ({ read, metadata }) => {
  const pending = read();
  metadata.setSessionState({ referenceId: 'primary-ref', sessionId: 'replacement', status: 'open', isPrimary: true, displayName: 'Overview' });
  await assert.rejects(pending, /identity changed/);
}));

test('verified Imported History is protected from Inbox assignment only while its exact native identity exists', () => fixture(async ({ metadata, sessionStore, rows }) => {
  const historyKey = 'agent:main:command-center:history:fictional-history';
  const historyEntry = { sessionId: 'history-original', updatedAt: 20 };
  rows.push({ sessionKey: historyKey, entry: historyEntry });
  const protectedMetadata = Object.create(metadata);
  Object.defineProperty(protectedMetadata, 'listImportedHistories', { value: () => [{ phase: 'verified', target: { agentId: 'main', sessionKey: historyKey, sessionId: 'history-original' }, intent: { topicId } }] });
  const protectedService = new AuthoritativeSourceService({ metadata: protectedMetadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  const protectedRead = (key) => invokeBridgeMethod(protectedService, 'command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey: key });
  assert.deepEqual(await protectedRead(historyKey), {
    schemaVersion: 1, status: 'protected', sessionKey: historyKey, sessionId: 'history-original',
    topicId, name: 'Imported History'
  });
  historyEntry.sessionId = 'history-replacement';
  assert.deepEqual(await protectedRead(historyKey), {
    schemaVersion: 1, status: 'protected-unavailable', sessionKey: historyKey,
    topicId, name: 'Imported History'
  });
  rows.splice(rows.findIndex((row) => row.sessionKey === historyKey), 1);
  assert.equal((await protectedRead(historyKey)).status, 'protected-unavailable');
}));

test('a malformed Imported History agent identity remains unavailable rather than assignable', () => fixture(async ({ metadata, sessionStore, rows }) => {
  const historyKey = 'agent:main:command-center:history:fictional-history';
  rows.push({ sessionKey: historyKey, entry: { sessionId: 'history-original', updatedAt: 20 } });
  const protectedMetadata = Object.create(metadata);
  Object.defineProperty(protectedMetadata, 'listImportedHistories', { value: () => [{ phase: 'verified', target: { agentId: 'other', sessionKey: historyKey, sessionId: 'history-original' }, intent: { topicId } }] });
  const protectedService = new AuthoritativeSourceService({ metadata: protectedMetadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  const result = await invokeBridgeMethod(protectedService, 'command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey: historyKey });
  assert.equal(result.status, 'protected-unavailable');
}));
