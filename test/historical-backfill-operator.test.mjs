import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createHistoricalBackfillOperator } from '../src/open-loops/historical-backfill-operator.mjs';

const capture = overrides => ({
  schemaVersion: 1,
  sourceKind: 'email',
  sourceExternalId: 'fictional-message-1',
  sourceVersion: 'message-v1',
  topicId: 'topic-fictional-home',
  title: 'Review fictional council invoice',
  obligationId: 'fictional-council-invoice',
  provenance: 'explicit',
  occurredAt: '2026-09-20T01:00:00.000Z',
  observedAt: '2026-09-21T01:00:00.000Z',
  ...overrides
});

async function withOwner(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-backfill-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  metadata.createTopic({ topicId: 'topic-fictional-home', name: 'Fictional Home', paraCategory: 'area', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-home', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/private/home' });
  const sourceService = {
    async notesRead(input) {
      return { text: '# Fictional invoice\n', path: input.path, revision: 'note-v1', sourceReference: { referenceId: 'note:fictional-invoice', topicId: input.topicId, sourceKind: 'note' } };
    }
  };
  try { return await run({ metadata, sourceService, operator: createHistoricalBackfillOperator({ metadata, sourceService, now: () => '2026-09-21T02:00:00.000Z' }) }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('operator resolves exact Topic ownership and returns bounded Note evidence', async () => {
  await withOwner(async ({ operator }) => {
    assert.deepEqual(operator.resolveTopic({ topicName: 'Fictional Home' }), { status: 'resolved', topicId: 'topic-fictional-home', noteFolderReferenceId: 'folder:fictional-home' });
    assert.deepEqual(await operator.readNote({ topicId: 'topic-fictional-home', noteFolderReferenceId: 'folder:fictional-home', path: 'Invoices/Fictional.md' }), {
      text: '# Fictional invoice\n', path: 'Invoices/Fictional.md', revision: 'note-v1', sourceReferenceId: 'note:fictional-invoice'
    });
    assert.equal(operator.resolveTopic({ topicName: 'Unknown' }).status, 'unresolved');
    assert.equal(JSON.stringify(operator.resolveTopic({ topicName: 'Fictional Home' })).includes('/fictional/private'), false);
  });
});

test('operator captures and reconciles one historical commitment through the durable owner', async () => {
  await withOwner(async ({ metadata, operator }) => {
    const logicalOperationId = `sha256:${'a'.repeat(64)}`;
    const first = await operator.captureCommitment({ logicalOperationId, capture: capture() });
    assert.deepEqual(first, { disposition: 'created', effectId: first.effectId, revision: 1 });
    assert.equal(metadata.getOpenLoop(first.effectId).attention.currentEvidence, false);
    assert.deepEqual(operator.reconcileCommitment({ logicalOperationId, capture: capture() }), { status: 'applied', result: first });
    assert.equal(metadata.listOpenLoops().length, 1);
  });
});

test('operator preserves user-decided effects and selectively withdraws an unchanged effect', async () => {
  await withOwner(async ({ metadata, operator }) => {
    const created = await operator.captureCommitment({ logicalOperationId: `sha256:${'b'.repeat(64)}`, capture: capture() });
    assert.deepEqual(operator.inspectEffect({ effectId: created.effectId }), { revision: 1, userDecided: false });
    const withdrawalId = `sha256:${'c'.repeat(64)}`;
    assert.deepEqual(operator.reconcileWithdrawal({ logicalOperationId: withdrawalId, effectId: created.effectId, expectedRevision: 1 }), { status: 'not-applied' });
    assert.deepEqual(operator.withdrawEffect({ logicalOperationId: withdrawalId, effectId: created.effectId, expectedRevision: 1 }), { status: 'applied' });
    assert.equal(metadata.getOpenLoop(created.effectId).state, 'cancelled');
    assert.deepEqual(operator.reconcileWithdrawal({ logicalOperationId: withdrawalId, effectId: created.effectId, expectedRevision: 1 }), { status: 'applied' });

    const suggested = await operator.captureCommitment({ logicalOperationId: `sha256:${'d'.repeat(64)}`, capture: capture({ sourceExternalId: 'fictional-message-2', obligationId: 'fictional-review', provenance: 'inferred' }) });
    metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-user-confirm', loopId: suggested.effectId, expectedRevision: 1, decision: 'confirm', actorId: 'fictional-operator', rationale: 'The fictional evidence is accepted.', updatedAt: '2026-09-21T03:00:00.000Z' });
    assert.deepEqual(operator.inspectEffect({ effectId: suggested.effectId }), { revision: 2, userDecided: true });
  });
});
