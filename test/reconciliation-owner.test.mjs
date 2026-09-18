import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authority = () => {};
const history = () => ({ logicalOperationId: randomUUID(), intent: { schemaVersion: 1,
  sourceManifestSha256: 'a'.repeat(64), trustedPublicKeySha256: 'b'.repeat(64), sourceChannelId: randomUUID(),
  sourceDigest: 'c'.repeat(64), expectedCount: 0, agentId: 'main', topicId: null, expectedTopicRevision: null } });
const claim = child => ({ logicalOperationId: child.logicalOperationId, operationKind: 'history.import.v1', intentDigest: hash(child.intent) });
const plan = child => ({ logicalOperationId: randomUUID(), planDigest: 'd'.repeat(64), children: [claim(child)] });
const generic = (id, kind = 'unrelated') => ({ logicalOperationId: id, transportRequestId: 'fixture', intentDigest: 'x', operationKind: kind, state: 'applied' });
async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reconciliation-owner-'));
  const handles = [];
  const open = () => { const value = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); handles.push(value); return value; };
  t.after(async () => { handles.forEach(handle => handle.close()); await rm(stateDir, { recursive: true, force: true }); });
  return { metadata: open(), competing: open(), open };
}

test('durable plan claims survive reopening without reserving or executing children', async t => {
  const { metadata, open } = await fixture(t);
  const child = history(); const input = plan(child);
  const reserved = metadata.reserveReconciliation(input, authority);
  assert.equal(reserved.phase, 'reserved'); assert.equal(reserved.revision, 1);
  assert.equal(metadata.getOperation(child.logicalOperationId), null);
  const reopened = open();
  assert.deepEqual(reopened.getReconciliation(input.logicalOperationId), reserved);
  assert.deepEqual(reopened.reserveReconciliation(input, authority), reserved);
  assert.throws(() => reopened.reserveReconciliation({ ...input, planDigest: 'e'.repeat(64) }, authority), { code: 'intent-mismatch' });
  assert.throws(() => reopened.recordOperation(generic(child.logicalOperationId)), { code: 'reconciliation-child-conflict' });
  assert.throws(() => reopened.recordOperation(generic(input.logicalOperationId)), { code: 'reconciliation-owner-required' });
  assert.throws(() => reopened.reserveImportedHistory({ ...child, intent: { ...child.intent, expectedCount: 1 } }, authority), { code: 'reconciliation-child-conflict' });
  assert.throws(() => reopened.reserveImportedHistory({ ...child, logicalOperationId: child.logicalOperationId.toUpperCase() }, authority), { code: 'reconciliation-child-conflict' });
  assert.equal(reopened.reserveImportedHistory(child, authority).phase, 'reserved');
});

test('competing plans cannot overlap child IDs or capture wrong existing operations', async t => {
  const { metadata, competing } = await fixture(t);
  const child = history(); const input = plan(child);
  metadata.reserveReconciliation(input, authority);
  assert.throws(() => competing.reserveReconciliation({ ...input, logicalOperationId: randomUUID() }, authority), { code: 'reconciliation-child-conflict' });
  const foreign = history(); competing.recordOperation(generic(foreign.logicalOperationId));
  const rejected = plan(foreign);
  assert.throws(() => metadata.reserveReconciliation(rejected, authority), { code: 'reconciliation-child-conflict' });
  assert.equal(metadata.getReconciliation(rejected.logicalOperationId), null);
  const existing = history(); metadata.reserveImportedHistory(existing, authority);
  assert.equal(competing.reserveReconciliation(plan(existing), authority).phase, 'reserved');
});

test('a reserved plan keeps its history capacity across restart and competing imports', async t => {
  const { metadata, competing, open } = await fixture(t);
  for (let index = 0; index < 99; index += 1) metadata.reserveImportedHistory(history(), authority);
  const child = history(); const input = plan(child);
  metadata.reserveReconciliation(input, authority);
  const outsider = history();
  assert.throws(() => competing.reserveImportedHistory(outsider, authority), { code: 'history-reservation-conflict' });
  assert.equal(competing.getOperation(outsider.logicalOperationId), null);
  const reopened = open();
  assert.equal(reopened.reserveImportedHistory(child, authority).phase, 'reserved');
  assert.equal(reopened.listImportedHistories().length, 100);
  assert.equal(reopened.reserveReconciliation(input, authority).phase, 'reserved');
  const rejected = plan(history());
  assert.throws(() => competing.reserveReconciliation(rejected, authority), { code: 'history-reservation-conflict' });
  assert.equal(competing.getReconciliation(rejected.logicalOperationId), null);
});

test('Discord and native plan claims share capacity without double-counting existing children', async t => {
  const { metadata, competing } = await fixture(t);
  for (let index = 0; index < 98; index += 1) metadata.reserveImportedHistory(history(), authority);
  const discord = history();
  const native = { logicalOperationId: randomUUID(), intent: {
    schemaVersion: 2, sourceKind: 'native-jsonl-history-v1', sourceInventorySha256: 'a'.repeat(64),
    originalAgentId: 'main', originalSessionId: 'fictional-session',
    sourceFile: { name: 'fictional-session.jsonl', sizeBytes: 123, sha256: 'b'.repeat(64) },
    sourceDigest: 'c'.repeat(64), expectedCount: 0, agentId: 'main', topicId: null, expectedTopicRevision: null
  } };
  metadata.reserveImportedHistory(discord, authority);
  const input = { ...plan(discord), children: [claim(discord), { ...claim(native), operationKind: 'history.import.native.v1' }] };
  metadata.reserveReconciliation(input, authority);
  assert.throws(() => competing.reserveReconciliation(plan(history()), authority), { code: 'history-reservation-conflict' });
  assert.equal(competing.inspectImportedHistory(native, authority).receipt, null);
  assert.equal(competing.reserveImportedHistory(native, authority).phase, 'reserved');
  assert.equal(competing.listImportedHistories().length, 100);
  assert.equal(metadata.reserveReconciliation(input, authority).phase, 'reserved');
});

test('completion requires exact completed children, current authority and original plan revision', async t => {
  const { metadata, competing } = await fixture(t);
  const child = history(); const input = plan(child);
  metadata.reserveReconciliation(input, authority);
  const complete = { logicalOperationId: input.logicalOperationId, expectedRevision: 1, planDigest: input.planDigest };
  assert.throws(() => metadata.completeReconciliation(complete, authority), { code: 'reconciliation-incomplete' });
  let row = metadata.reserveImportedHistory(child, authority);
  row = metadata.dispatchImportedHistoryCreation({ historyId: row.historyId, logicalOperationId: child.logicalOperationId, expectedRevision: row.revision }, authority);
  assert.throws(() => metadata.completeReconciliation(complete, authority), { code: 'reconciliation-incomplete' });
  const proof = { sessionLifecycleRevision: child.logicalOperationId, transcriptGeneration: null, anchorDigest: 'f'.repeat(64), verifiedCount: 0 };
  row = metadata.checkpointImportedHistory({ historyId: row.historyId, logicalOperationId: child.logicalOperationId, expectedRevision: row.revision, proof }, authority);
  metadata.completeImportedHistory({ historyId: row.historyId, logicalOperationId: child.logicalOperationId, expectedRevision: row.revision, proof }, authority);
  let calls = 0;
  assert.throws(() => metadata.completeReconciliation(complete, () => { if (++calls === 2) throw new Error('revoked'); }), /revoked/);
  assert.equal(competing.getReconciliation(input.logicalOperationId).phase, 'reserved');
  assert.equal(metadata.completeReconciliation(complete, authority).phase, 'applied');
  assert.throws(() => competing.completeReconciliation(complete, authority), { code: 'stale-revision' });
  assert.equal(competing.reserveReconciliation(input, authority).phase, 'applied');
});

test('plan validation is closed and a revoked reservation leaves no partial claims', async t => {
  const { metadata } = await fixture(t);
  const child = history(); const input = plan(child);
  for (const invalid of [{ ...input, extra: true }, { ...input, children: [] }, { ...input, children: [claim(child), claim(child)] },
    { ...input, logicalOperationId: input.logicalOperationId.toUpperCase() }, { ...input, children: [{ ...claim(child), logicalOperationId: child.logicalOperationId.toUpperCase() }] },
    { ...input, children: [{ ...claim(child), operationKind: 'unrelated' }] }, { ...input, children: [{ ...claim(child), logicalOperationId: input.logicalOperationId }] }]) {
    assert.throws(() => metadata.reserveReconciliation(invalid, authority), { code: 'reconciliation-intent-invalid' });
  }
  let calls = 0;
  assert.throws(() => metadata.reserveReconciliation(input, () => { if (++calls === 2) throw new Error('revoked'); }), /revoked/);
  assert.equal(metadata.getReconciliation(input.logicalOperationId), null);
  metadata.recordOperation(generic(child.logicalOperationId));
});

test('all dedicated journal writers refuse an unstarted plan child before their effects', async t => {
  const { metadata } = await fixture(t);
  const child = history(); metadata.reserveReconciliation(plan(child), authority);
  assert.throws(() => metadata.beginAnalysisSettingsUpdate({ logicalOperationId: child.logicalOperationId, intentDigest: 'foreign', settings: {}, declaration: {} }), { code: 'reconciliation-child-conflict' });
  assert.equal(metadata.getTopicAnalysisSettings(), null);
  assert.throws(() => metadata.claimTopicConversationCreation({ logicalOperationId: child.logicalOperationId,
    request: { topicId: randomUUID(), expectedTopicRevision: 0, principalId: 'fixture', label: 'Fixture' } }, authority), { code: 'reconciliation-child-conflict' });
  assert.equal(metadata.getTopicOperation(child.logicalOperationId), null);
  const notifications = createNotificationService({ metadata });
  try {
    const settings = notifications.getSettings();
    assert.throws(() => notifications.updateSettings({ schemaVersion: 1, logicalOperationId: child.logicalOperationId, expectedRevision: settings.revision, settings: { dueReminders: false } }), { code: 'reconciliation-child-conflict' });
    assert.deepEqual(notifications.getSettings(), settings);
    assert.equal(metadata.getOperation(child.logicalOperationId), null);
  } finally { notifications.close(); }
});
