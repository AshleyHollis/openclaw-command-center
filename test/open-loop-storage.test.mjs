import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { applyV8ToV9Migration, validateMigrationLedger } from '../src/metadata/migration-ledger.mjs';
import { inspectSchema, metadataSchemaV8Sql } from '../src/metadata/schema.mjs';

const at = '2026-09-19T02:00:00.000Z';
const bill = ({ id = 'obs-electricity-v1', version = 'message-v1', historicalBaseline = false } = {}) => ({
  schemaVersion: 1,
  observationId: id,
  source: { system: 'fictional-mail', kind: 'message', externalId: 'fictional-message-42', version },
  type: 'bill',
  occurredAt: '2026-09-18T01:00:00.000Z',
  observedAt: at,
  historicalBaseline,
  entityRefs: [{ kind: 'invoice', id: 'INV-FICTIONAL-42' }],
  facts: { invoiceId: 'INV-FICTIONAL-42', amountMinor: 12900, currency: 'AUD', dueAt: '2026-09-21T13:59:59.000Z' }
});

const paymentLoop = ({ revision = 1, evidence = ['obs-electricity-v1'], state = 'confirmed' } = {}) => ({
  schemaVersion: 1,
  loopId: 'loop-electricity',
  kind: 'payment',
  stableSubjectId: 'invoice:INV-FICTIONAL-42',
  title: 'Review fictional electricity bill',
  state,
  paymentState: 'unpaid',
  amount: 12900,
  currency: 'AUD',
  dueAt: '2026-09-21T13:59:59.000Z',
  attention: { reason: 'due-window', whyNow: 'The accepted bill is due within three days.', actions: ['Open source bill', 'Mark payment pending'], activated: true, currentEvidence: true },
  evidenceObservationIds: evidence,
  revision
});

async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-open-loops-'));
  let service;
  try {
    service = openCommandCenterMetadataService({ stateDir });
    await run(service, stateDir);
  } finally {
    service?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('source observations and payment loops survive restart and project one quiet attention item', async () => {
  await withService(async (service, stateDir) => {
    const observe = { schemaVersion: 1, logicalOperationId: 'observe-electricity-v1', observation: bill() };
    assert.equal(service.ingestOpenLoopObservation(observe).disposition, 'inserted');
    assert.equal(service.ingestOpenLoopObservation(observe).disposition, 'inserted');
    assert.equal(service.ingestOpenLoopObservation({ ...observe, logicalOperationId: 'observe-electricity-copy' }).disposition, 'duplicate');

    const reconciliation = { schemaVersion: 1, logicalOperationId: 'reconcile-electricity-v1', expectedRevision: 0, loop: paymentLoop(), evidenceRoles: { 'obs-electricity-v1': 'origin' }, updatedAt: at };
    assert.equal(service.reconcileOpenLoop(reconciliation).disposition, 'created');
    assert.equal(service.reconcileOpenLoop(reconciliation).disposition, 'created');
    const inbox = service.getQuietAttentionInbox({ now: at });
    assert.equal(inbox.attention.length, 1);
    assert.equal(inbox.attention[0].loop.paymentState, 'unpaid');
    assert.deepEqual(inbox.attention[0].actions, ['Open source bill', 'Mark payment pending']);

    service.close();
    service = undefined;
    const reopened = openCommandCenterMetadataService({ stateDir });
    try {
      assert.equal(reopened.getOpenLoop('loop-electricity').revision, 1);
      assert.equal(reopened.getOpenLoopObservation('obs-electricity-v1').source.externalId, 'fictional-message-42');
      assert.equal(reopened.getQuietAttentionInbox({ now: at }).attention.length, 1);
    } finally { reopened.close(); }
  });
});

test('immutable source versions, optimistic revisions and append-only evidence fail closed', async () => {
  await withService(async service => {
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'observe-1', observation: bill() });
    assert.throws(() => service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'observe-conflict', observation: { ...bill(), facts: { ...bill().facts, amountMinor: 99900 } } }), error => error.code === 'open-loop-observation-conflict');
    service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: 'reconcile-1', expectedRevision: 0, loop: paymentLoop(), updatedAt: at });
    assert.throws(() => service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: 'reconcile-stale', expectedRevision: 0, loop: paymentLoop({ revision: 1 }), updatedAt: at }), error => error.code === 'open-loop-stale-revision');
    assert.throws(() => service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: 'reconcile-removal', expectedRevision: 1, loop: paymentLoop({ revision: 2, evidence: [] }), updatedAt: at }), error => error.code === 'open-loop-evidence-removal');
  });
});

test('historical bill evidence remains out of Attention until current evidence activates it', async () => {
  await withService(async service => {
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'observe-history', observation: bill({ historicalBaseline: true }) });
    const loop = paymentLoop();
    loop.attention.currentEvidence = false;
    service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: 'reconcile-history', expectedRevision: 0, loop, updatedAt: at });
    const inbox = service.getQuietAttentionInbox({ now: '2026-10-01T00:00:00.000Z' });
    assert.equal(inbox.attention.length, 0);
    assert.equal(inbox.waiting.length, 1);
  });
});

test('direct reconciliation preserves evidence-backed calendar timing', async () => {
  await withService(async service => {
    const observation = { ...bill(), observationId: 'obs-calendar-date', facts: { ...bill().facts, dueAt: undefined, dueDate: '2026-10-04', dueTimeZone: 'Australia/Brisbane' } };
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'observe-calendar-date', observation });
    const { dueAt: _dueAt, ...withoutInstant } = paymentLoop({ evidence: ['obs-calendar-date'] });
    const loop = { ...withoutInstant, dueDate: '2026-10-04', dueTimeZone: 'Australia/Brisbane' };
    const result = service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: 'reconcile-calendar-date', expectedRevision: 0, loop, evidenceRoles: { 'obs-calendar-date': 'origin' }, updatedAt: at });
    assert.equal(result.loop.dueAt, undefined);
    assert.equal(result.loop.dueDate, '2026-10-04');
    assert.equal(service.getOpenLoop(loop.loopId).dueTimeZone, 'Australia/Brisbane');
  });
});

test('schema 8 upgrades additively to schema 9 with a contiguous durable receipt', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(metadataSchemaV8Sql);
    applyV8ToV9Migration(database, { snapshotId: 'fictional-schema-8-snapshot', appliedAt: at });
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(inspectSchema(database).valid, true);
    assert.equal(validateMigrationLedger(database, { snapshotId: 'fictional-schema-8-snapshot' }).valid, true);
    assert.deepEqual({ ...database.prepare('SELECT from_version AS fromVersion, to_version AS toVersion FROM schema_migrations').get() }, { fromVersion: 8, toVersion: 9 });
  } finally { database.close(); }
});
