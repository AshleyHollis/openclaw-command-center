import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { setHostNoteFilesystemCoordinator } from '../src/sources/note-filesystem-owner.mjs';
import { TopicProvisioningService } from '../src/topics/provisioning.mjs';

test('preparation resolves the host configured Session store selector', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'topic-store-selector-'));
  const vault = path.join(stateDir, 'vault');
  await mkdir(vault);
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const reads = [];
  const owner = new TopicProvisioningService({ metadata, noteVaultRoot: vault,
    sessionStoreSelector: path.join(stateDir, 'native', '{agentId}', 'sessions.json'),
    sessionStore: { getSessionEntry: params => { reads.push(params); return undefined; } } });
  const input = { logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Fictional Studio', paraCategory: 'area',
    folderPath: path.join(vault, 'Areas', 'Fictional Studio') };
  const result = await owner.prepare(input, { provisioningAuthority: { assertCurrent() {} } }, 'preflight');
  assert.equal(result.status, 'preflight');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].storePath, path.join(stateDir, 'native', 'main', 'sessions.json'));
});

async function fixture(t, change = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'topic-rollback-service-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  const release = setHostNoteFilesystemCoordinator(() => ({ release() {} }));
  t.after(async () => { release(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const input = { logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Fictional Studio', paraCategory: 'area',
    folderPath: path.join(stateDir, 'vault', 'Areas', 'Fictional Studio') };
  metadata.reserveConditionalProvisioning(input, () => {});
  const identity = `note-folder:2:${randomUUID()}:${'c'.repeat(64)}`;
  metadata.bindProvisioningNoteFolder({ topicId: input.topicId, name: input.name, paraCategory: input.paraCategory,
    expectedRevision: 0, expectedLocatorVersion: 0, expectedSourceRevision: null, locator: input.folderPath,
    observedRevision: identity, ownership: 'adopted' }, () => {});
  const reserved = metadata.reserveProvisioningPrimary({ parentOperationId: input.logicalOperationId, expectedTopicRevision: 0,
    sessionStorePath: path.join(stateDir, 'sessions.json') }, () => {});
  metadata.dispatchProvisioningPrimary(reserved, () => {});
  const primary = reserved.intent.primary;
  let entry = { sessionId: primary.sessionId, lifecycleRevision: primary.lifecycleRevision,
    updatedAt: primary.sessionUpdatedAt, pluginOwnerId: 'command-center', ...change };
  const calls = [];
  const owner = new TopicProvisioningService({ metadata, noteVaultRoot: path.join(stateDir, 'vault'),
    sessionStore: { getSessionEntry: () => entry }, gateway: { request: async (method, params) => {
      calls.push({ method, params }); entry = null; return { deleted: true };
    } } });
  return { metadata, input, primary, calls, owner, entry: () => entry, removeSession: () => { entry = null; } };
}

test('dispatched but absent Session leaves folder and rollback checkpoint intact', async t => {
  const f = await fixture(t);
  f.removeSession();
  await assert.rejects(() => f.owner.rollback({ logicalOperationId: f.input.logicalOperationId,
    topicId: f.input.topicId, expectedRevision: 0 }), error => error.code === 'provisioning-creation-unknown');
  assert.equal(f.calls.length, 0);
  assert.equal(f.metadata.getConditionalProvisioningRollback(f.input.logicalOperationId).phase, 'prepared');
  assert.equal(f.metadata.getSourceLocator(`note-folder:${f.input.topicId}`).ownership, 'adopted');
});

test('conditional rollback passes exact native lifecycle guards and preserves an adopted folder', async t => {
  const f = await fixture(t);
  const result = await f.owner.rollback({ logicalOperationId: f.input.logicalOperationId, topicId: f.input.topicId, expectedRevision: 0 });
  assert.equal(result.status, 'not-applied');
  assert.deepEqual(f.calls, [{ method: 'sessions.delete', params: {
    key: f.primary.sessionKey, agentId: 'main', expectedSessionId: f.primary.sessionId,
    expectedLifecycleRevision: f.primary.lifecycleRevision, expectedSessionUpdatedAt: f.primary.sessionUpdatedAt,
    expectedStorePath: f.primary.sessionStorePath,
    requireEmptyHistory: true, deleteTranscript: true } }]);
  assert.equal(f.metadata.getSourceReference(`note-folder:${f.input.topicId}`), null);
  assert.equal(f.metadata.getTopic(f.input.topicId), null);
  assert.deepEqual(await f.owner.rollback({ logicalOperationId: f.input.logicalOperationId, topicId: f.input.topicId, expectedRevision: 0 }), result);
});

for (const change of [{ updatedAt: 99 }, { sessionId: randomUUID() }, { pluginOwnerId: 'foreign' }])
  test(`conditional rollback refuses changed or replaced Session ${JSON.stringify(change)}`, async t => {
    const f = await fixture(t, change);
    await assert.rejects(() => f.owner.rollback({ logicalOperationId: f.input.logicalOperationId,
      topicId: f.input.topicId, expectedRevision: 0 }), error => error.code === 'source-recovery');
    assert.equal(f.calls.length, 0);
    assert.equal(f.metadata.getConditionalProvisioningRollback(f.input.logicalOperationId).phase, 'prepared');
    assert.equal(f.metadata.getSourceLocator(`note-folder:${f.input.topicId}`).ownership, 'adopted');
  });

test('native nonempty-history refusal leaves folder and rollback checkpoint intact', async t => {
  const f = await fixture(t);
  f.owner.gateway.request = async () => { throw Object.assign(new Error('history present'), { code: 'INVALID_REQUEST' }); };
  await assert.rejects(() => f.owner.rollback({ logicalOperationId: f.input.logicalOperationId,
    topicId: f.input.topicId, expectedRevision: 0 }));
  assert.equal(f.metadata.getConditionalProvisioningRollback(f.input.logicalOperationId).phase, 'prepared');
  assert.equal(f.metadata.getSourceLocator(`note-folder:${f.input.topicId}`).ownership, 'adopted');
  assert.ok(f.entry());
});
