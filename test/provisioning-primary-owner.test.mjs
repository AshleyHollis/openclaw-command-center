import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { provisioningPrimaryOperationId } from '../src/metadata/provisioning-primary.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'provisioning-primary-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const input = { logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Studio', paraCategory: 'area', folderPath: path.join(stateDir, 'vault', 'Areas', 'Studio') };
  return { metadata, input, stateDir };
}

test('conditional provisioning retains its original Topic revision even before Primary reservation', async t => {
  const { metadata, input } = await fixture(t);
  metadata.reserveConditionalProvisioning(input, () => {});
  metadata.setTopicName({ topicId: input.topicId, name: 'Temporary', expectedRevision: 0 });
  metadata.setTopicName({ topicId: input.topicId, name: input.name, expectedRevision: 1 });
  assert.throws(() => metadata.reserveConditionalProvisioning(input, () => {}), { code: 'stale-revision' });
  assert.equal(metadata.getTopic(input.topicId).revision, 2);
  assert.equal(metadata.getProvisioningPrimary(input.logicalOperationId), null);
});

test('preparation inspection is read-only and the original plan digest survives retry', async t => {
  const { metadata, input, stateDir } = await fixture(t);
  const pinned = { ...input, preparationDigest: 'a'.repeat(64) };
  const reader = openCommandCenterMetadataService({ stateDir, readOnly: true, capabilities: { notes: true, sessions: true } });
  try {
  assert.equal(reader.inspectConditionalProvisioning(pinned, () => {}).operation, null);
  assert.equal(metadata.getTopic(input.topicId), null);
  metadata.reserveConditionalProvisioning(pinned, () => {});
  assert.equal(reader.inspectConditionalProvisioning(pinned, () => {}).operation.intent.preparationDigest, pinned.preparationDigest);
  assert.throws(() => metadata.reserveConditionalProvisioning({ ...pinned, preparationDigest: 'b'.repeat(64) }, () => {}), { code: 'provisioning-primary-conflict' });
  assert.throws(() => reader.inspectConditionalProvisioning({ ...pinned, preparationDigest: 'b'.repeat(64) }, () => {}), { code: 'provisioning-primary-conflict' });
  } finally { reader.close(); }
});

test('a claimed future Primary operation prevents any Topic preparation', async t => {
  const { metadata, input } = await fixture(t);
  metadata.reserveReconciliation({ logicalOperationId: randomUUID(), planDigest: 'a'.repeat(64), children: [
    { logicalOperationId: provisioningPrimaryOperationId(input.logicalOperationId), operationKind: 'history.import.v1', intentDigest: 'b'.repeat(64) }
  ] }, () => {});
  assert.throws(() => metadata.reserveConditionalProvisioning(input, () => {}), { code: 'reconciliation-child-conflict' });
  assert.equal(metadata.getTopic(input.topicId), null);
  assert.equal(metadata.getTopicOperation(input.logicalOperationId), null);
});

test('bootstrap and conditional preparation exclude each other before either binds a folder', async t => {
  const { metadata, input } = await fixture(t);
  const bootstrap = { logicalOperationId: randomUUID(), intent: { schemaVersion: 1, mappingDigest: 'a'.repeat(64),
    topicId: randomUUID(), name: 'Existing Studio', paraCategory: 'area',
    folder: { path: input.folderPath, directoryIdentity: 'b'.repeat(64), markerIdentity: null },
    primary: { agentId: 'main', sessionKey: 'agent:main:discord:channel:fictional-studio', sessionId: 'fictional-session', lifecycleRevision: 'fictional-lifecycle' } } };
  metadata.reserveTopicBootstrap(bootstrap, () => {});
  assert.throws(() => metadata.reserveConditionalProvisioning(input, () => {}), { code: 'preparation-folder-conflict' });
  assert.equal(metadata.getTopic(input.topicId), null);
  const second = { ...input, folderPath: path.join(path.dirname(input.folderPath), 'Workshop') };
  metadata.reserveConditionalProvisioning(second, () => {});
  assert.throws(() => metadata.reserveTopicBootstrap({ ...bootstrap, logicalOperationId: randomUUID(), intent: { ...bootstrap.intent,
    topicId: randomUUID(), folder: { ...bootstrap.intent.folder, path: second.folderPath } } }, () => {}), { code: 'preparation-folder-conflict' });
  assert.throws(() => metadata.reserveConditionalProvisioning({ ...second, topicId: randomUUID(), logicalOperationId: randomUUID() }, () => {}), { code: 'preparation-folder-conflict' });
});

test('conditional folder binding requires current authority and the reserved exact path', async t => {
  const { metadata, input } = await fixture(t);
  metadata.reserveConditionalProvisioning(input, () => {});
  const binding = { topicId: input.topicId, name: input.name, paraCategory: input.paraCategory, expectedRevision: 0,
    expectedLocatorVersion: 0, expectedSourceRevision: null, locator: input.folderPath,
    observedRevision: `note-folder:1:${randomUUID()}:${'a'.repeat(64)}`, ownership: 'created' };
  assert.throws(() => metadata.bindProvisioningNoteFolder(binding), { code: 'provisioning-authority-unavailable' });
  assert.throws(() => metadata.bindProvisioningNoteFolder({ ...binding, locator: path.join(path.dirname(input.folderPath), 'Other') }, () => {}), { code: 'provisioning-primary-conflict' });
  assert.deepEqual(metadata.listSourceReferences(), []);
  metadata.bindProvisioningNoteFolder(binding, () => {});
  assert.equal(metadata.getSourceLocator(`note-folder:${input.topicId}`).locator, input.folderPath);
});

test('a reserved provisioning root protects its future Primary ID before folder effects', async t => {
  const { metadata, input } = await fixture(t);
  metadata.reserveConditionalProvisioning(input, () => {});
  const childId = provisioningPrimaryOperationId(input.logicalOperationId);
  assert.throws(() => metadata.reserveReconciliation({ logicalOperationId: randomUUID(), planDigest: 'a'.repeat(64), children: [
    { logicalOperationId: childId, operationKind: 'history.import.v1', intentDigest: 'b'.repeat(64) }
  ] }, () => {}), { code: 'provisioning-operation-conflict' });
  assert.throws(() => metadata.assertUnclaimedReconciliationOperation(childId), { code: 'provisioning-operation-conflict' });
});

test('legacy metadata cleanup cannot remove conditional provisioning ownership', async t => {
  const { metadata, input, stateDir } = await fixture(t);
  metadata.reserveConditionalProvisioning(input, () => {});
  const referenceId = `note-folder:${input.topicId}`;
  metadata.bindProvisioningNoteFolder({ topicId: input.topicId, name: input.name, paraCategory: input.paraCategory,
    expectedRevision: 0, expectedLocatorVersion: 0, expectedSourceRevision: null, locator: path.join(stateDir, 'vault', 'Areas', 'Studio'),
    observedRevision: `note-folder:1:${randomUUID()}:${'a'.repeat(64)}`, ownership: 'created' }, () => {});
  const reserved = metadata.reserveProvisioningPrimary({ parentOperationId: input.logicalOperationId, expectedTopicRevision: 0 }, () => {});
  metadata.dispatchProvisioningPrimary(reserved, () => {});
  assert.throws(() => metadata.deleteProvisioningSourceReference({ referenceId, topicId: input.topicId, expectedTopicRevision: 0, provisioningOperationId: input.logicalOperationId }), { code: 'provisioning-owner-required' });
  assert.throws(() => metadata.deleteTopic(input.topicId), { code: 'provisioning-owner-required' });
  assert.ok(metadata.getSourceReference(referenceId));
  assert.equal(metadata.getTopic(input.topicId).lifecycle, 'provisioning');
});

test('competing dispatch and retired completion preserve one atomic provisioning outcome', async t => {
  const { metadata, input, stateDir } = await fixture(t);
  metadata.reserveConditionalProvisioning(input, () => {});
  metadata.bindProvisioningNoteFolder({ topicId: input.topicId, name: input.name, paraCategory: input.paraCategory,
    expectedRevision: 0, expectedLocatorVersion: 0, expectedSourceRevision: null, locator: path.join(stateDir, 'vault', 'Areas', 'Studio'),
    observedRevision: `note-folder:1:${randomUUID()}:${'a'.repeat(64)}`, ownership: 'created' }, () => {});
  const reserved = metadata.reserveProvisioningPrimary({ parentOperationId: input.logicalOperationId, expectedTopicRevision: 0 }, () => {});
  const creating = metadata.dispatchProvisioningPrimary(reserved, () => {});
  const other = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  try {
    assert.throws(() => other.dispatchProvisioningPrimary(reserved, () => {}), { code: 'stale-revision' });
    let checks = 0;
    assert.throws(() => other.completeProvisioningPrimary(creating, () => { if (++checks === 2) throw new Error('retired at publication'); }), /retired at publication/);
    assert.equal(metadata.getTopic(input.topicId).lifecycle, 'provisioning');
    assert.equal(metadata.getTopicOperation(input.logicalOperationId).state, 'unknown');
    assert.equal(metadata.getSourceReference(creating.intent.primary.referenceId), null);
    assert.deepEqual(metadata.getProvisioningPrimary(input.logicalOperationId), creating);
    const applied = other.completeProvisioningPrimary(creating, () => {});
    assert.equal(applied.phase, 'applied'); assert.equal(metadata.getTopic(input.topicId).revision, 1);
    const parent = metadata.getTopicOperation(input.logicalOperationId);
    assert.throws(() => metadata.recordTopicOperation({ ...parent, state: 'unknown' }), { code: 'provisioning-owner-required' });
    assert.throws(() => metadata.completeTopicProvisioning({ logicalOperationId: input.logicalOperationId, topicId: input.topicId }), { code: 'provisioning-owner-required' });
    assert.throws(() => metadata.recordOperation({ logicalOperationId: applied.logicalOperationId, transportRequestId: applied.logicalOperationId,
      intentDigest: 'a'.repeat(64), operationKind: 'unrelated', state: 'unknown' }), { code: 'provisioning-owner-required' });
    assert.deepEqual(metadata.getTopicOperation(input.logicalOperationId), parent);
  } finally { other.close(); }
});
