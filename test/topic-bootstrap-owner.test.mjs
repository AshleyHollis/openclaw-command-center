import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const intent = () => ({ schemaVersion: 1, mappingDigest: 'a'.repeat(64), topicId: randomUUID(), name: 'Fictional Garden', paraCategory: 'area',
  folder: { path: path.resolve(os.tmpdir(), 'fictional-notes', 'areas', 'garden-alias'), directoryIdentity: 'b'.repeat(64), markerIdentity: null },
  primary: { agentId: 'main', sessionKey: 'agent:main:discord:channel:fictional-garden', sessionId: 'fictional-existing-session', lifecycleRevision: 'fictional-lifecycle' } });
const folderIdentity = `note-folder:1:11111111-1111-4111-8111-111111111111:${'c'.repeat(64)}`;
async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'topic-bootstrap-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  const competing = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  t.after(async () => { competing.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { metadata, competing };
}

test('Topic bootstrap commits an existing folder and Primary with one durable completion', async t => {
  const { metadata, competing } = await fixture(t);
  const input = { logicalOperationId: randomUUID(), intent: intent() };
  const reserved = metadata.reserveTopicBootstrap(input, () => {});
  assert.equal(reserved.phase, 'reserved');
  assert.equal(metadata.getTopic(input.intent.topicId), null);
  assert.deepEqual(competing.reserveTopicBootstrap(input, () => {}), reserved);
  const reordered = { ...input, intent: Object.fromEntries(Object.entries(input.intent).reverse()) };
  assert.equal(metadata.inspectTopicBootstrap(input, () => {}).intentDigest, metadata.inspectTopicBootstrap(reordered, () => {}).intentDigest);
  assert.deepEqual(competing.reserveTopicBootstrap(reordered, () => {}), reserved);
  const request = { logicalOperationId: input.logicalOperationId, expectedRevision: reserved.revision, folderIdentity };
  assert.throws(() => metadata.completeTopicBootstrap(request, () => { throw Object.assign(new Error('revoked'), { code: 'revoked' }); }), { code: 'revoked' });
  assert.equal(competing.getTopic(input.intent.topicId), null);
  assert.deepEqual(competing.listSourceReferences(), []);
  let checks = 0;
  assert.throws(() => metadata.completeTopicBootstrap(request, () => { if (++checks === 2) throw Object.assign(new Error('revoked at completion'), { code: 'revoked' }); }), { code: 'revoked' });
  assert.equal(competing.getTopic(input.intent.topicId), null);
  assert.deepEqual(competing.listSourceReferences(), []);
  assert.deepEqual(competing.getTopicBootstrap(input.logicalOperationId), reserved);
  const applied = metadata.completeTopicBootstrap(request, () => {});
  assert.equal(applied.phase, 'applied');
  const topic = competing.getTopic(input.intent.topicId);
  assert.equal(topic.lifecycle, 'active'); assert.equal(topic.name, 'Fictional Garden'); assert.equal(topic.revision, 0);
  const folder = competing.getSourceLocator(applied.folderReferenceId);
  assert.equal(folder.locator, input.intent.folder.path); assert.equal(folder.observedRevision, folderIdentity);
  assert.equal(folder.ownership, 'external');
  const primary = competing.getSessionState(applied.sessionReferenceId);
  assert.equal(primary.sessionId, input.intent.primary.sessionId); assert.equal(primary.isPrimary, true);
  assert.equal(competing.getSourceReference(applied.sessionReferenceId).externalSourceId, input.intent.primary.sessionKey);
  assert.deepEqual(competing.getTopicBootstrap(input.logicalOperationId), applied);
  assert.deepEqual(competing.reserveTopicBootstrap(input, () => {}), applied);
  assert.throws(() => competing.completeTopicBootstrap(request, () => {}), { code: 'stale-revision' });
  assert.throws(() => competing.reserveTopicBootstrap({ ...input, intent: { ...input.intent, name: 'Changed intent' } }, () => {}), { code: 'intent-mismatch' });
});

test('pending bootstrap owns its source identities and generic journal writes cannot change its receipt', async t => {
  const { metadata, competing } = await fixture(t);
  const input = { logicalOperationId: randomUUID(), intent: intent() };
  const reserved = metadata.reserveTopicBootstrap(input, () => {});
  assert.throws(() => competing.reserveTopicBootstrap({ logicalOperationId: randomUUID(), intent: { ...input.intent, topicId: randomUUID() } }, () => {}), { code: 'bootstrap-ownership-conflict' });
  assert.throws(() => competing.recordOperation({ logicalOperationId: input.logicalOperationId, transportRequestId: 'fictional-request', intentDigest: 'foreign-digest', operationKind: 'foreign-owner', state: 'applied' }), { code: 'bootstrap-owner-required' });
  assert.deepEqual(competing.getTopicBootstrap(input.logicalOperationId), reserved);
  metadata.createTopic({ topicId: input.intent.topicId, name: 'Foreign Topic', paraCategory: 'resource', lifecycle: 'active' });
  assert.throws(() => competing.completeTopicBootstrap({ logicalOperationId: input.logicalOperationId, expectedRevision: 1, folderIdentity }, () => {}), { code: 'bootstrap-ownership-conflict' });
  assert.equal(competing.getTopic(input.intent.topicId).name, 'Foreign Topic');
  assert.deepEqual(competing.listSourceReferences(), []);
});

test('Topic bootstrap refuses an Imported History as an active Primary', async t => {
  const { metadata } = await fixture(t);
  const historical = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: {
    schemaVersion: 1, sourceManifestSha256: 'a'.repeat(64), trustedPublicKeySha256: 'b'.repeat(64), sourceChannelId: 'fictional-history',
    sourceDigest: 'c'.repeat(64), expectedCount: 0, agentId: 'main', topicId: null, expectedTopicRevision: null
  } }, () => {});
  const adopted = intent(); adopted.primary = { ...historical.target, lifecycleRevision: historical.logicalOperationId };
  assert.throws(() => metadata.reserveTopicBootstrap({ logicalOperationId: randomUUID(), intent: adopted }, () => {}), { code: 'bootstrap-ownership-conflict' });
});

test('Topic bootstrap refuses relocating an already owned folder into a new adoption', async t => {
  const { metadata } = await fixture(t);
  const other = randomUUID(); metadata.createTopic({ topicId: other, name: 'Existing owner', paraCategory: 'area', lifecycle: 'active' });
  const oldPath = path.resolve(os.tmpdir(), 'fictional-notes', 'previous-folder-location');
  metadata.createSourceReference({ version: 1, referenceId: 'existing-folder', topicId: other, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: oldPath });
  metadata.setSourceLocator({ referenceId: 'existing-folder', locator: oldPath, ownership: 'external', observedRevision: folderIdentity });
  const adopted = intent(); adopted.folder.markerIdentity = folderIdentity;
  assert.throws(() => metadata.reserveTopicBootstrap({ logicalOperationId: randomUUID(), intent: adopted }, () => {}), { code: 'bootstrap-ownership-conflict' });
  adopted.folder.markerIdentity = null;
  const reserved = metadata.reserveTopicBootstrap({ logicalOperationId: randomUUID(), intent: adopted }, () => {});
  assert.throws(() => metadata.completeTopicBootstrap({ logicalOperationId: reserved.logicalOperationId, expectedRevision: 1, folderIdentity }, () => {}), { code: 'bootstrap-ownership-conflict' });
  assert.equal(metadata.getTopic(adopted.topicId), null);
});

test('bootstrap reserves a first Primary identity and grants native dispatch only once before atomic activation', async t => {
  const { metadata, competing } = await fixture(t);
  const logicalOperationId = randomUUID();
  const proposed = intent();
  proposed.primary = { agentId: 'main', sessionKey: `agent:main:command-center:topic:${proposed.topicId}:primary`, sessionId: logicalOperationId,
    lifecycleRevision: logicalOperationId, creation: 'if-absent' };
  const input = { logicalOperationId, intent: proposed };
  const reserved = metadata.reserveTopicBootstrap(input, () => {});
  assert.equal(reserved.phase, 'reserved');
  assert.equal(metadata.getTopic(proposed.topicId), null);
  assert.throws(() => metadata.completeTopicBootstrap({ logicalOperationId, expectedRevision: 1, folderIdentity }, () => {}), { code: 'bootstrap-incomplete' });
  const dispatch = { logicalOperationId, expectedRevision: 1 };
  assert.throws(() => metadata.dispatchTopicBootstrapPrimary(dispatch, () => { throw Object.assign(new Error('revoked'), { code: 'revoked' }); }), { code: 'revoked' });
  assert.deepEqual(competing.getTopicBootstrap(logicalOperationId), reserved);
  const creating = metadata.dispatchTopicBootstrapPrimary(dispatch, () => {});
  assert.equal(creating.phase, 'creating'); assert.equal(creating.revision, 2);
  assert.throws(() => competing.dispatchTopicBootstrapPrimary(dispatch, () => {}), { code: 'stale-revision' });
  assert.throws(() => competing.dispatchTopicBootstrapPrimary({ ...dispatch, expectedRevision: 2 }, () => {}), { code: 'bootstrap-creation-already-dispatched' });
  assert.deepEqual(competing.reserveTopicBootstrap(input, () => {}), creating, 'retry must not issue a second dispatch permit');
  const applied = metadata.completeTopicBootstrap({ logicalOperationId, expectedRevision: 2, folderIdentity }, () => {});
  assert.equal(applied.phase, 'applied'); assert.equal(applied.revision, 3);
  assert.equal(competing.getSessionState(applied.sessionReferenceId).sessionId, logicalOperationId);
  assert.equal(competing.getTopic(proposed.topicId).lifecycle, 'active');
  const altered = { ...proposed, primary: { ...proposed.primary, sessionKey: 'agent:main:main' } };
  assert.throws(() => metadata.reserveTopicBootstrap({ logicalOperationId: randomUUID(), intent: altered }, () => {}), { code: 'bootstrap-intent-invalid' });
});
