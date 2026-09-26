import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'topic-rollback-metadata-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const input = { logicalOperationId: randomUUID(), topicId: randomUUID(), name: 'Fictional Studio', paraCategory: 'area',
    folderPath: path.join(stateDir, 'vault', 'Areas', 'Fictional Studio') };
  return { input, get metadata() { return metadata; }, reopen() { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); } };
}

test('folder creation receipt survives SQLite reopen and pins one staging directory', async t => {
  const f = await fixture(t);
  f.metadata.reserveConditionalProvisioning(f.input, () => {});
  const stagePath = path.join(path.dirname(f.input.folderPath), `.command-center-provisioning-${f.input.logicalOperationId}-${randomUUID()}`);
  const prepared = f.metadata.prepareConditionalFolderCreation({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0, stagePath }, () => {});
  assert.equal(prepared.phase, 'prepared');
  f.reopen();
  assert.deepEqual(f.metadata.getConditionalFolderCreation(f.input.logicalOperationId), prepared);
  assert.deepEqual(f.metadata.prepareConditionalFolderCreation({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0, stagePath }, () => {}), prepared);
  assert.throws(() => f.metadata.prepareConditionalFolderCreation({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0, stagePath: `${stagePath}-other` }, () => {}), { code: 'provisioning-primary-conflict' });
  const witness = { parentOperationId: f.input.logicalOperationId, stagePath, directoryIdentity: 'a'.repeat(64), markerIdentity: `note-folder:2:${randomUUID()}:${'b'.repeat(64)}` };
  const identified = f.metadata.identifyConditionalFolderCreation(witness, () => {});
  assert.equal(identified.phase, 'identified');
  f.reopen();
  assert.deepEqual(f.metadata.getConditionalFolderCreation(f.input.logicalOperationId), identified);
  assert.throws(() => f.metadata.publishConditionalFolderCreation({ ...witness, directoryIdentity: 'c'.repeat(64) }, () => {}), { code: 'provisioning-primary-conflict' });
  const published = f.metadata.publishConditionalFolderCreation(witness, () => {});
  assert.equal(published.phase, 'published');
  assert.deepEqual(f.metadata.publishConditionalFolderCreation(witness, () => {}), published);
});

test('rollback checkpoints preserve exact evidence and prevent creation from resuming', async t => {
  const f = await fixture(t);
  f.metadata.reserveConditionalProvisioning(f.input, () => {});
  const stagePath = path.join(path.dirname(f.input.folderPath), `.command-center-provisioning-${f.input.logicalOperationId}-${randomUUID()}`);
  f.metadata.prepareConditionalFolderCreation({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0, stagePath }, () => {});
  const rollback = f.metadata.beginConditionalProvisioningRollback({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0 }, () => {});
  assert.equal(rollback.phase, 'prepared');
  assert.equal(rollback.folderCreation.stagePath, stagePath);
  f.reopen();
  assert.deepEqual(f.metadata.beginConditionalProvisioningRollback({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0 }, () => {}), rollback);
  assert.throws(() => f.metadata.reserveConditionalProvisioning(f.input, () => {}), { code: 'provisioning-primary-conflict' });
  assert.throws(() => f.metadata.inspectConditionalProvisioning(f.input, () => {}), { code: 'provisioning-primary-conflict' });
  assert.throws(() => f.metadata.prepareConditionalFolderCreation({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0, stagePath }, () => {}), { code: 'provisioning-primary-conflict' });
  const session = f.metadata.advanceConditionalProvisioningRollback(rollback, 'session-cleared', () => {});
  assert.equal(session.phase, 'session-cleared');
  assert.throws(() => f.metadata.advanceConditionalProvisioningRollback(rollback, 'session-cleared', () => {}), { code: 'stale-revision' });
  f.reopen();
  const cleaning = f.metadata.advanceConditionalProvisioningRollback(session, 'folder-cleaning', () => {});
  assert.equal(f.metadata.getConditionalProvisioningRollback(f.input.logicalOperationId).phase, 'folder-cleaning');
  const folder = f.metadata.advanceConditionalProvisioningRollback(cleaning, 'folder-cleared', () => {});
  assert.equal(folder.phase, 'folder-cleared');
  const done = f.metadata.finishConditionalProvisioningRollback(folder, () => {});
  assert.equal(done.phase, 'rolled-back');
  assert.equal(f.metadata.getTopic(f.input.topicId), null);
  assert.equal(f.metadata.getTopicOperation(f.input.logicalOperationId).state, 'not-applied');
  assert.throws(() => f.metadata.reserveConditionalProvisioning(f.input, () => {}), { code: 'provisioning-primary-conflict' });
});

test('dispatched Primary is frozen by rollback and a bound adopted folder is removed only from metadata', async t => {
  const f = await fixture(t);
  f.metadata.reserveConditionalProvisioning(f.input, () => {});
  const referenceId = `note-folder:${f.input.topicId}`;
  const identity = `note-folder:2:${randomUUID()}:${'c'.repeat(64)}`;
  f.metadata.bindProvisioningNoteFolder({ topicId: f.input.topicId, name: f.input.name, paraCategory: f.input.paraCategory,
    expectedRevision: 0, expectedLocatorVersion: 0, expectedSourceRevision: null, locator: f.input.folderPath,
    observedRevision: identity, ownership: 'adopted' }, () => {});
  const primary = f.metadata.reserveProvisioningPrimary({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0 }, () => {});
  assert.equal(primary.intent.primary.sessionUpdatedAt, Date.parse(f.metadata.getTopicOperation(f.input.logicalOperationId).createdAt));
  const creating = f.metadata.dispatchProvisioningPrimary(primary, () => {});
  const rollback = f.metadata.beginConditionalProvisioningRollback({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0 }, () => {});
  assert.deepEqual(rollback.primaryReceipt, creating);
  assert.equal(rollback.folderLocator.ownership, 'adopted');
  assert.throws(() => f.metadata.completeProvisioningPrimary(creating, () => {}), { code: 'provisioning-primary-conflict' });
  assert.throws(() => f.metadata.reserveProvisioningPrimary({ parentOperationId: f.input.logicalOperationId, expectedTopicRevision: 0 }, () => {}), { code: 'provisioning-primary-conflict' });
  const session = f.metadata.advanceConditionalProvisioningRollback(rollback, 'session-cleared', () => {});
  assert.equal(f.metadata.getSourceReference(referenceId).externalSourceId, referenceId);
  assert.equal(f.metadata.getSourceLocator(referenceId).locator, f.input.folderPath);
  const cleaning = f.metadata.advanceConditionalProvisioningRollback(session, 'folder-cleaning', () => {});
  assert.equal(f.metadata.getSourceReference(referenceId).externalSourceId, referenceId);
  const folder = f.metadata.advanceConditionalProvisioningRollback(cleaning, 'folder-cleared', () => {});
  assert.equal(f.metadata.getSourceReference(referenceId), null);
  f.metadata.finishConditionalProvisioningRollback(folder, () => {});
  assert.equal(f.metadata.getTopic(f.input.topicId), null);
  assert.equal(f.metadata.getProvisioningPrimary(f.input.logicalOperationId).phase, 'rolled-back');
});
