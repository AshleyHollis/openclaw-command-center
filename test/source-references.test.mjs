import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService as openMetadataService } from '../src/metadata/service.mjs';

const openServices = new Set();
function openCommandCenterMetadataService(options) {
  const service = openMetadataService(options);
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
  referenceId: 'reference-fictional',
  topicId: 'topic-fictional',
  sourceSystem: 'openclaw',
  sourceKind: 'session',
  externalSourceId: 'session-fictional'
});

test('valid opaque Source References remain durable through public close and reopen', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    service.createTopic({ topicId: 'topic-fictional', paraCategory: 'project', lifecycle: 'active' });
    assert.equal(service.createSourceReference(fictionalReference).externalSourceId, 'session-fictional');
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.deepEqual(reopened.getSourceReference('reference-fictional'), {
      ...fictionalReference,
      createdAt: reopened.getSourceReference('reference-fictional').createdAt,
      updatedAt: reopened.getSourceReference('reference-fictional').updatedAt
    });
    reopened.close();
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
    assert.throws(() => service.updateSourceReference({ referenceId: 'reference-fictional', externalSourceId: 'session-rekeyed' }), /immutable/);
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
