import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const sourceIntent = (sourceChannelId, topicId = null) => ({
  schemaVersion: 1, sourceManifestSha256: 'a'.repeat(64), trustedPublicKeySha256: 'b'.repeat(64),
  sourceChannelId, sourceDigest: 'c'.repeat(64), expectedCount: 2, agentId: 'main',
  topicId, expectedTopicRevision: topicId === null ? null : 0
});

test('native history uses a distinct durable identity and the same conditional recovery owner as Discord history', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-owner-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const discord = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: sourceIntent('fictional-source') }, () => {});
  const input = { logicalOperationId: randomUUID(), intent: {
    schemaVersion: 2, sourceKind: 'native-jsonl-history-v1', sourceInventorySha256: 'a'.repeat(64),
    originalAgentId: 'main', originalSessionId: 'fictional-session',
    sourceFile: { name: 'fictional-session.jsonl.bak-123-456', sizeBytes: 123, sha256: 'b'.repeat(64) },
    sourceDigest: 'c'.repeat(64), expectedCount: 2, agentId: 'main', topicId: null, expectedTopicRevision: null
  } };
  const first = metadata.beginImportedHistory(input, () => {});
  assert.equal(first.created, true);
  assert.notEqual(first.reservation.historyId, discord.historyId);
  assert.notEqual(first.reservation.target.sessionId, input.intent.originalSessionId);
  assert.notEqual(first.reservation.target.sessionKey, 'agent:main:fictional-session');
  assert.equal(metadata.getOperation(input.logicalOperationId).operationKind, 'history.import.native.v1');
  assert.throws(() => metadata.recordOperation({ ...metadata.getOperation(input.logicalOperationId), resultIdentity: '{}' }), { code: 'history-owner-required' });
  metadata.close();
  metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  assert.deepEqual(metadata.beginImportedHistory(input, () => {}), { reservation: first.reservation, created: false });
  assert.deepEqual(metadata.getImportedHistory(discord.historyId), discord);
  assert.equal(metadata.listImportedHistories().length, 2);
  assert.throws(() => metadata.reserveImportedHistory({ ...input, intent: { ...input.intent, sourceFile: { ...input.intent.sourceFile, sha256: 'd'.repeat(64) } } }, () => {}), { code: 'intent-mismatch' });
  const dispatch = { historyId: first.reservation.historyId, logicalOperationId: input.logicalOperationId, expectedRevision: 1 };
  const creating = metadata.dispatchImportedHistoryCreation(dispatch, () => {});
  assert.equal(creating.phase, 'creating');
  assert.throws(() => metadata.dispatchImportedHistoryCreation(dispatch, () => {}), { code: 'stale-revision' });
  assert.equal(metadata.listTopics().length, 0);
});

test('reservation retries preserve identity and only one durable dispatch can authorize creation', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  const competing = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { competing.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const input = { logicalOperationId: randomUUID(), intent: sourceIntent('fictional-source') };
  const first = metadata.beginImportedHistory(input, () => {});
  const retry = competing.beginImportedHistory(input, () => {});
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.reservation, first.reservation);
  assert.deepEqual(metadata.reserveImportedHistory(input, () => {}), first.reservation);
  const dispatch = { historyId: first.reservation.historyId, logicalOperationId: input.logicalOperationId, expectedRevision: 1 };
  let checks = 0;
  assert.throws(() => metadata.dispatchImportedHistoryCreation(dispatch, () => { if (++checks === 2) throw Object.assign(new Error('revoked'), { code: 'revoked' }); }), { code: 'revoked' });
  assert.deepEqual(competing.getImportedHistory(first.reservation.historyId), first.reservation);
  const creating = competing.dispatchImportedHistoryCreation(dispatch, () => {});
  assert.equal(creating.phase, 'creating');
  assert.equal(creating.revision, 2);
  assert.throws(() => metadata.dispatchImportedHistoryCreation(dispatch, () => {}), { code: 'stale-revision' });
  assert.throws(() => metadata.dispatchImportedHistoryCreation({ ...dispatch, expectedRevision: 2 }, () => {}), { code: 'history-creation-already-dispatched' });
  assert.deepEqual(metadata.getImportedHistory(first.reservation.historyId), creating);
});

test('historical import reservations survive restart without taking ownership of a Topic Primary or requiring a reporting Topic', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  metadata.createTopic({ topicId: 'fictional-topic', name: 'Fictional Topic', paraCategory: 'area', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'fictional-primary-ref', topicId: 'fictional-topic', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-primary' });
  metadata.setSessionState({ referenceId: 'fictional-primary-ref', sessionId: 'fictional-primary-id', status: 'open', isPrimary: true });
  const originalReferences = metadata.listSourceReferences();
  const originalPrimary = metadata.getSessionState('fictional-primary-ref');
  const intents = [sourceIntent('fictional-one', 'fictional-topic'), sourceIntent('fictional-two', 'fictional-topic'), sourceIntent('fictional-report')];
  const reservations = intents.map(intent => metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent }, () => {}));
  assert.equal(new Set(reservations.map(item => item.target.sessionKey)).size, 3);
  assert.equal(reservations[2].intent.topicId, null);
  assert.equal(reservations.every(item => item.disposition === 'historical' && item.phase === 'reserved'), true);
  assert.deepEqual(metadata.listSourceReferences(), originalReferences);
  assert.deepEqual(metadata.getSessionState('fictional-primary-ref'), originalPrimary);
  assert.equal(metadata.listTopics().length, 1);
  metadata.close();
  metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  assert.deepEqual(metadata.listImportedHistories().map(item => item.historyId).sort(), reservations.map(item => item.historyId).sort());
  assert.deepEqual(metadata.getImportedHistory(reservations[0].historyId), reservations[0]);
  assert.deepEqual(metadata.getSessionState('fictional-primary-ref'), originalPrimary);
});

test('generic operation writes cannot replace a history owners permanent receipt', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const reservation = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: sourceIntent('fictional-report') }, () => {});
  const operation = metadata.getOperation(reservation.logicalOperationId);
  assert.throws(() => metadata.recordOperation({ ...operation, state: 'applied', resultIdentity: '{}' }), { code: 'history-owner-required' });
  assert.deepEqual(metadata.getImportedHistory(reservation.historyId), reservation);
});

test('history reservation retries preserve intent and reject another owner claiming the same source', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const input = { logicalOperationId: randomUUID(), intent: sourceIntent('fictional-report') };
  const original = metadata.reserveImportedHistory(input, () => {});
  assert.deepEqual(metadata.reserveImportedHistory(input, () => {}), original);
  assert.throws(() => metadata.reserveImportedHistory({ ...input, intent: { ...input.intent, agentId: 'other' } }, () => {}), { code: 'intent-mismatch' });
  assert.throws(() => metadata.reserveImportedHistory({ ...input, logicalOperationId: randomUUID() }, () => {}), { code: 'history-reservation-conflict' });
  assert.equal(metadata.listImportedHistories().length, 1);
});

test('stored duplicate history ownership blocks both presentation and unchanged retries', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const input = { logicalOperationId: randomUUID(), intent: sourceIntent('fictional-report') };
  const original = metadata.reserveImportedHistory(input, () => {});
  // Corrupt isolated persisted state to exercise the public recovery boundary.
  const database = new DatabaseSync(metadata.databasePath);
  try {
    const duplicateId = randomUUID();
    database.prepare(`INSERT INTO operation_journal (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
      SELECT ?, ?, intent_digest, operation_kind, state, result_status, ?, observed_revision, created_at, updated_at FROM operation_journal WHERE logical_operation_id = ?`).run(duplicateId, duplicateId, JSON.stringify({ ...original, logicalOperationId: duplicateId }), input.logicalOperationId);
  } finally { database.close(); }
  assert.throws(() => metadata.listImportedHistories(), { code: 'history-receipt-invalid' });
  assert.throws(() => metadata.reserveImportedHistory(input, () => {}), { code: 'history-receipt-invalid' });
});

test('history recovery refuses inconsistent status and unknown receipt fields', async (t) => {
  for (const corruption of ['status', 'extra-field']) {
    await t.test(corruption, async (t) => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
      const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
      t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
      const input = { logicalOperationId: randomUUID(), intent: sourceIntent('fictional-report') };
      const original = metadata.reserveImportedHistory(input, () => {});
      const database = new DatabaseSync(metadata.databasePath);
      try {
        if (corruption === 'status') database.prepare("UPDATE operation_journal SET result_status = 'completed' WHERE logical_operation_id = ?").run(input.logicalOperationId);
        else database.prepare('UPDATE operation_journal SET result_identity = ? WHERE logical_operation_id = ?').run(JSON.stringify({ ...original, unrecognizedProof: true }), input.logicalOperationId);
      } finally { database.close(); }
      assert.throws(() => metadata.getImportedHistory(original.historyId), { code: 'history-receipt-invalid' });
      assert.throws(() => metadata.reserveImportedHistory(input, () => {}), { code: 'history-receipt-invalid' });
    });
  }
});

test('history checkpoints advance conditionally and survive restart without accepting a different generation', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const reserved = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: sourceIntent('fictional-report') }, () => {});
  const input = { historyId: reserved.historyId, logicalOperationId: reserved.logicalOperationId, expectedRevision: 2,
    proof: { sessionLifecycleRevision: reserved.logicalOperationId, transcriptGeneration: 'fictional-native-generation', anchorDigest: 'd'.repeat(64), verifiedCount: 1 } };
  assert.throws(() => metadata.checkpointImportedHistory({ ...input, expectedRevision: 1 }, () => {}), { code: 'history-creation-not-dispatched' });
  metadata.dispatchImportedHistoryCreation({ historyId: reserved.historyId, logicalOperationId: reserved.logicalOperationId, expectedRevision: 1 }, () => {});
  const progress = metadata.checkpointImportedHistory(input, () => {});
  assert.equal(progress.phase, 'importing');
  assert.equal(progress.revision, 3);
  assert.equal(progress.verifiedCount, 1);
  metadata.close();
  metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  assert.deepEqual(metadata.getImportedHistory(reserved.historyId), progress);
  assert.throws(() => metadata.checkpointImportedHistory(input, () => {}), { code: 'stale-revision' });
  assert.throws(() => metadata.checkpointImportedHistory({ ...input, expectedRevision: 3, proof: { ...input.proof, transcriptGeneration: 'replaced-generation' } }, () => {}), { code: 'history-proof-conflict' });
  assert.throws(() => metadata.completeImportedHistory({ ...input, expectedRevision: 3 }, () => {}), { code: 'history-incomplete' });
  assert.throws(() => metadata.checkpointImportedHistory({ ...input, expectedRevision: 3 }, () => { throw Object.assign(new Error('revoked'), { code: 'revoked' }); }), { code: 'revoked' });
  const completed = metadata.completeImportedHistory({ ...input, expectedRevision: 3, proof: { ...input.proof, anchorDigest: 'e'.repeat(64), verifiedCount: 2 } }, () => {});
  assert.equal(completed.phase, 'verified');
  assert.equal(completed.revision, 4);
  assert.equal(metadata.getOperation(reserved.logicalOperationId).state, 'applied');
  assert.throws(() => metadata.checkpointImportedHistory({ ...input, expectedRevision: 4 }, () => {}), { code: 'history-terminal' });
});

test('empty histories record native Session lifecycle evidence without inventing a transcript generation', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-history-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const reserved = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: { ...sourceIntent('fictional-empty'), expectedCount: 0 } }, () => {});
  metadata.dispatchImportedHistoryCreation({ historyId: reserved.historyId, logicalOperationId: reserved.logicalOperationId, expectedRevision: 1 }, () => {});
  const input = { historyId: reserved.historyId, logicalOperationId: reserved.logicalOperationId, expectedRevision: 2,
    proof: { sessionLifecycleRevision: reserved.logicalOperationId, transcriptGeneration: null, anchorDigest: 'd'.repeat(64), verifiedCount: 0 } };
  const bound = metadata.checkpointImportedHistory(input, () => {});
  assert.equal(bound.transcriptGeneration, null);
  assert.equal(bound.sessionLifecycleRevision, reserved.logicalOperationId);
  const verified = metadata.completeImportedHistory({ ...input, expectedRevision: bound.revision }, () => {});
  assert.equal(verified.phase, 'verified');
  assert.equal(verified.verifiedCount, 0);
});
