import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService as openMetadataService } from '../src/metadata/service.mjs';
import { createMutationCoordinator } from '../src/sources/mutation-coordinator.mjs';
import { createSourceReference, validateSourceReference } from '../src/sources/reference.mjs';

const openServices = new Set();
function openCommandCenterMetadataService(options) {
  const service = openMetadataService({ ...options, capabilities: { sessions: true, ...(options.capabilities ?? {}) } });
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-references-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

const fictionalReference = Object.freeze({
  version: 1,
  referenceId: 'reference-fictional',
  topicId: 'topic-fictional',
  sourceSystem: 'openclaw',
  sourceKind: 'session',
  externalSourceId: 'session-fictional'
});

test('Source Reference v1 is exact, rejects unknown or future shapes, and preserves opaque revisions', () => {
  const reference = createSourceReference({ ...fictionalReference, observedRevision: 'opaque-source-revision' });
  assert.deepEqual(reference, { ...fictionalReference, observedRevision: 'opaque-source-revision', createdAt: reference.createdAt, updatedAt: reference.updatedAt });
  assert.match(reference.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.throws(() => validateSourceReference({ ...reference, extra: true }), /unsupported field/i);
  assert.throws(() => validateSourceReference({ ...reference, version: 2 }), /version/);
  assert.throws(() => validateSourceReference({ ...reference, observedRevision: '' }), /revision/i);
});

test('valid opaque Source References remain durable through public close and reopen', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    service.createTopic({ topicId: 'topic-fictional', paraCategory: 'project', lifecycle: 'active' });
    assert.equal(service.createSourceReference({ ...fictionalReference, observedRevision: 'opaque-observed-revision' }).externalSourceId, 'session-fictional');
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    const reopenedReference = reopened.getSourceReference('reference-fictional');
    assert.deepEqual(reopenedReference, { ...fictionalReference, observedRevision: 'opaque-observed-revision', createdAt: reopenedReference.createdAt, updatedAt: reopenedReference.updatedAt });
    reopened.close();
  });
});

test('schema-2 operation, Session, and Activity state remains durable and deduplicated after reopen', async () => {
  await withState(async (stateDir) => {
    let service = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    service.createTopic({ topicId: 'topic-durable-state', paraCategory: 'project', lifecycle: 'active' });
    service.createSourceReference({ version: 1, referenceId: 'session-durable-state', topicId: 'topic-durable-state', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'fictional-durable-session', observedRevision: 'opaque-session-revision' });
    const logicalOperationId = 'b5493bb7-5164-447c-9f62-6d2c419bdc4a';
    const intent = { operation: 'fictional durable replay' };
    const coordinator = createMutationCoordinator({ metadata: service });
    await coordinator.mutate({ operationKind: 'metadata.fictional', requestId: 'frame-durable', logicalOperationId, intent, execute: async () => ({ id: 'durable-result' }) });
    service.setSessionState({ referenceId: 'session-durable-state', sessionId: 'fictional-session-id', status: 'closed', isPrimary: false, wasPrimary: true, displayName: 'Fictional Durable Conversation' });
    service.recordActivity({ activityId: 'activity-durable-state', topicId: 'topic-durable-state', logicalOperationId: '78c27e72-8c8e-4144-b24c-4a845764b61e', transportRequestId: 'activity-frame', operationKind: 'notes.maintenance', outcome: 'conflict', observedRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    service.close();

    service = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    let replayExecuted = false;
    const replay = await createMutationCoordinator({ metadata: service }).mutate({ operationKind: 'metadata.fictional', requestId: 'frame-replay', logicalOperationId, intent, execute: async () => { replayExecuted = true; return {}; }, reconcile: async () => ({ outcome: 'applied', value: { id: 'durable-result' } }) });
    assert.equal(replay.status, 'applied');
    assert.equal(replay.value.id, 'durable-result');
    assert.equal(replayExecuted, false);
    const durableSessionState = service.getSessionState('session-durable-state');
    assert.equal(durableSessionState.referenceId, 'session-durable-state');
    assert.equal(durableSessionState.sessionId, 'fictional-session-id');
    assert.equal(durableSessionState.status, 'closed');
    assert.equal(durableSessionState.isPrimary, false);
    assert.equal(durableSessionState.wasPrimary, true);
    assert.equal(durableSessionState.displayName, 'Fictional Durable Conversation');
    assert.match(durableSessionState.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(service.getSourceReference('session-durable-state').observedRevision, 'opaque-session-revision');
    assert.equal(service.listActivity('topic-durable-state').length, 1);
    service.recordActivity({ activityId: 'activity-duplicate-delivery', topicId: 'topic-durable-state', logicalOperationId: '78c27e72-8c8e-4144-b24c-4a845764b61e', transportRequestId: 'activity-frame-retry', operationKind: 'notes.maintenance', outcome: 'conflict', observedRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.equal(service.listActivity('topic-durable-state').length, 1);
    service.close();
  });
});

test('Source References reject missing metadata, duplicate identity, rekeying, and dependent Topic deletion without partial effects', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    service.createTopic({ topicId: 'topic-fictional', paraCategory: 'project', lifecycle: 'active' });
    service.createTopic({ topicId: 'topic-other', paraCategory: 'area', lifecycle: 'active' });
    for (const field of ['referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId']) {
      assert.throws(() => service.createSourceReference({ ...fictionalReference, [field]: '   ' }), /non-blank/);
    }
    assert.throws(() => service.createSourceReference({ ...fictionalReference, referenceId: 'missing-topic', topicId: 'topic-missing' }), /Topic was not found/);
    assert.throws(() => service.createSourceReference({ ...fictionalReference, payload: 'not-authoritative-content' }), /unsupported field/);
    service.createSourceReference(fictionalReference);
    assert.throws(() => service.createSourceReference({ ...fictionalReference, referenceId: 'duplicate-source', topicId: 'topic-other' }), /UNIQUE|constraint/i);
    assert.throws(() => service.createSourceReference({ ...fictionalReference }), /UNIQUE|constraint/i);
    assert.throws(() => service.updateSourceReference({ version: 1, referenceId: 'reference-fictional', externalSourceId: 'session-rekeyed' }), /immutable/);
    assert.throws(() => service.deleteTopic('topic-fictional'), /still referenced/);
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.equal(reopened.getSourceReference('reference-fictional').externalSourceId, 'session-fictional');
    assert.equal(reopened.getSourceReference('duplicate-source'), null);
    assert.ok(reopened.getTopic('topic-fictional'));
    reopened.close();
  });
});

test('deleting a Source Reference exercises the public connection foreign-key cascade durably', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    service.createTopic({ topicId: 'topic-fictional', paraCategory: 'project', lifecycle: 'active' });
    service.createSourceReference(fictionalReference);
    service.setSourceConventionState({ referenceId: 'reference-fictional', aspect: 'location', state: 'managed' });
    assert.equal(service.getSourceConventionState('reference-fictional').length, 1);
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.equal(reopened.getSourceConventionState('reference-fictional').length, 1);
    assert.equal(reopened.deleteSourceReference('reference-fictional'), true);
    reopened.close();

    const verified = openCommandCenterMetadataService({ stateDir });
    assert.equal(verified.getSourceReference('reference-fictional'), null);
    assert.deepEqual(verified.getSourceConventionState('reference-fictional'), []);
    assert.ok(verified.getTopic('topic-fictional'));
    verified.close();
  });
});
