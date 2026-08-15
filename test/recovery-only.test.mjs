import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersistenceService } from '../src/persistence/service.mjs';

test('Recovery-only uses the central mutation guard for every public writer while retaining diagnostics', async () => {
  const service = createPersistenceService({ stateDirectory: '/tmp/fictional-state', archiveBridge: { protocolVersion: 99 } });
  assert.equal((await service.initialize()).mode, 'Recovery-only');
  const writers = [
    () => service.createTopic({ topicId: 'topic', title: 'Topic', paraCategory: 'Project' }),
    () => service.updateTopic({ topicId: 'topic', title: 'Changed' }),
    () => service.addSourceReference({ sourceReferenceId: 'reference', topicId: 'topic', sourceKind: 'session', sourceRole: 'topic_conversation', opaqueIdentifier: 'session' }),
    () => service.setSourceVerification({ sourceReferenceId: 'reference', verificationState: 'verified' }),
    () => service.relocateSourceReference({ sourceReferenceId: 'reference', opaqueIdentifier: 'moved' }),
    () => service.replacePrimarySession({ topicId: 'topic', sourceReferenceId: 'reference' }),
    () => service.setConvention({ conventionKey: 'folder', managementState: 'managed' }),
    () => service.setPreference({ preferenceKey: 'density', preferenceValue: 'compact' }),
    () => service.linkAttentionActivity({ linkId: 'link', attentionIdentifier: 'attention', activityIdentifier: 'activity' }),
    () => service.createStructuralChangeProposal({ proposalId: 'proposal', topicId: 'topic', changeKind: 'classification' }),
    () => service.setPolicyVersion({ policyName: 'command-center-metadata', version: 1 }),
    () => service.rebuildProjections()
  ];
  for (const writer of writers) assert.throws(writer, { code: 'MUTATION_BLOCKED_RECOVERY_ONLY' });
  const diagnostics = service.getDiagnostics();
  assert.equal(diagnostics.mode, 'Recovery-only');
  assert.equal(diagnostics.checks[0].code, 'BRIDGE_PROTOCOL_INCOMPATIBLE');
});
