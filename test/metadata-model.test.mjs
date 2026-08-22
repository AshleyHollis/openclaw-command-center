import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService as openMetadataService, CommandCenterMetadataError } from '../src/metadata/service.mjs';

const openServices = new Set();
function openCommandCenterMetadataService(options) {
  const service = openMetadataService(options);
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-model-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('public typed operations cover convention, presentation, linkage, proposal, policy, and bookkeeping metadata', async () => {
  await withState(async (stateDir) => {
    const service = openCommandCenterMetadataService({ stateDir });
    service.createTopic({ topicId: 'topic-model', paraCategory: 'resource', lifecycle: 'provisioning' });
    service.createTopic({ topicId: 'topic-other', paraCategory: 'area', lifecycle: 'active' });
    service.createSourceReference({ referenceId: 'reference-model', topicId: 'topic-model', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'folder-model' });
    service.setSourceConventionState({ referenceId: 'reference-model', aspect: 'location', state: 'managed' });
    service.setPresentationPreferences({ topicId: 'topic-model', displayLabel: 'Model Topic', sortOrder: 7, collapsed: true });
    service.linkAttentionActivity({ linkId: 'link-model', attentionId: 'attention-fictional', activityId: 'activity-fictional', topicId: 'topic-model' });
    service.setProposalState({ proposalId: 'proposal-model', topicId: 'topic-model', state: 'pending', revision: 1 });
    service.setPolicyVersion({ policyId: 'policy-model', version: 'v1', digest: 'digest-model' });
    service.setProjectionBookkeeping({ projectionId: 'projection-model', sourceRevision: 'revision-model', inputDigest: 'digest-model' });

    assert.equal(service.getPresentationPreferences('topic-model').collapsed, true);
    assert.equal(service.getAttentionActivityLink('link-model').activityId, 'activity-fictional');
    assert.equal(service.getProposalState('proposal-model').revision, 1);
    assert.equal(service.getPolicyVersion('policy-model').digest, 'digest-model');
    assert.equal(service.getProjectionBookkeeping('projection-model').sourceRevision, 'revision-model');
    assert.throws(() => service.setProposalState({ proposalId: 'proposal-model', topicId: 'topic-other', state: 'accepted' }), /identity/i);
    assert.throws(() => service.createTopic({ topicId: 'bad', paraCategory: 'not-para', lifecycle: 'active' }), (error) => error instanceof CommandCenterMetadataError && error.code === 'invalid-enum');
    assert.throws(() => service.setPresentationPreferences({ topicId: 'topic-model', collapsed: true, arbitrary: 'payload' }), /unsupported field/);
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.equal(reopened.getSourceReference('reference-model').externalSourceId, 'folder-model');
    assert.equal(reopened.getSourceConventionState('reference-model')[0].state, 'managed');
    assert.equal(reopened.getPresentationPreferences('topic-model').displayLabel, 'Model Topic');
    assert.deepEqual(reopened.getAttentionActivityLink('link-model'), {
      linkId: 'link-model', attentionId: 'attention-fictional', activityId: 'activity-fictional',
      topicId: 'topic-model', createdAt: reopened.getAttentionActivityLink('link-model').createdAt
    });
    assert.deepEqual(reopened.getProposalState('proposal-model'), {
      proposalId: 'proposal-model', topicId: 'topic-model', state: 'pending', revision: 1,
      createdAt: reopened.getProposalState('proposal-model').createdAt,
      updatedAt: reopened.getProposalState('proposal-model').updatedAt
    });
    assert.equal(reopened.getPolicyVersion('policy-model').digest, 'digest-model');
    assert.equal(reopened.getProjectionBookkeeping('projection-model').sourceRevision, 'revision-model');
    reopened.close();
  });
});
