import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { setHostNoteFilesystemCoordinator } from '../src/sources/note-filesystem-owner.mjs';
import { TopicProvisioningService } from '../src/topics/provisioning.mjs';

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
  const reserved = metadata.reserveProvisioningPrimary({ parentOperationId: input.logicalOperationId, expectedTopicRevision: 0 }, () => {});
  metadata.dispatchProvisioningPrimary(reserved, () => {});
  const primary = reserved.intent.primary;
  let entry = { sessionId: primary.sessionId, lifecycleRevision: primary.lifecycleRevision,
    updatedAt: primary.sessionUpdatedAt, pluginOwnerId: 'command-center', ...change };
  const calls = [];
  const owner = new TopicProvisioningService({ metadata, noteVaultRoot: path.join(stateDir, 'vault'),
    sessionStore: { getSessionEntry: () => entry }, gateway: { request: async (method, params) => {
      calls.push({ method, params }); entry = null; return { deleted: true };
    } } });
  return { metadata, input, primary, calls, owner, entry: () => entry };
}

test('conditional rollback passes exact native lifecycle guards and preserves an adopted folder', async t => {
  const f = await fixture(t);
  const result = await f.owner.rollback({ logicalOperationId: f.input.logicalOperationId, topicId: f.input.topicId, expectedRevision: 0 });
  assert.equal(result.status, 'not-applied');
  assert.deepEqual(f.calls, [{ method: 'sessions.delete', params: {
    key: f.primary.sessionKey, agentId: 'main', expectedSessionId: f.primary.sessionId,
    expectedLifecycleRevision: f.primary.lifecycleRevision, expectedSessionUpdatedAt: f.primary.sessionUpdatedAt,
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
