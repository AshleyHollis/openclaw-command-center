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
  const sessionStore = { listSessionEntries: () => [{ sessionKey, entry }] };
  const service = new AuthoritativeSourceService({ metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  const read = (key = sessionKey) => invokeBridgeMethod(service, 'command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey: key });
  try { await run({ metadata, service, entry, read }); }
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
