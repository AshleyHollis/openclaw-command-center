import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createHistoricalBackfillStore } from '../src/open-loops/historical-backfill-store.mjs';

const timestamp = '2026-09-21T06:00:00.000Z';

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-backfill-store-'));
  try { await run(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('backfill checkpoint survives closing and reopening real SQLite metadata', async () => fixture(async stateDir => {
  const firstMetadata = openCommandCenterMetadataService({ stateDir });
  const first = createHistoricalBackfillStore({ metadata: firstMetadata });
  assert.equal(await first.loadState({ stateKey: 'fixture:apply' }), null);
  await first.saveState({ stateKey: 'fixture:apply', state: { schemaVersion: 1, checkpoint: '002', updatedAt: timestamp } });
  firstMetadata.close();

  const reopenedMetadata = openCommandCenterMetadataService({ stateDir });
  try {
    const reopened = createHistoricalBackfillStore({ metadata: reopenedMetadata });
    assert.deepEqual(await reopened.loadState({ stateKey: 'fixture:apply' }), { schemaVersion: 1, checkpoint: '002', updatedAt: timestamp });
    await reopened.saveState({ stateKey: 'fixture:apply', state: { schemaVersion: 1, checkpoint: '003', updatedAt: timestamp } });
    assert.equal(reopenedMetadata.getHistoricalBackfillState('fixture:apply').sequence, 2);
  } finally { reopenedMetadata.close(); }
}));

test('competing SQLite owners cannot advance a stale checkpoint', async () => fixture(async stateDir => {
  const leftMetadata = openCommandCenterMetadataService({ stateDir });
  const rightMetadata = openCommandCenterMetadataService({ stateDir });
  try {
    const left = createHistoricalBackfillStore({ metadata: leftMetadata });
    const right = createHistoricalBackfillStore({ metadata: rightMetadata });
    assert.equal(await left.loadState({ stateKey: 'fixture:apply' }), null);
    assert.equal(await right.loadState({ stateKey: 'fixture:apply' }), null);
    await left.saveState({ stateKey: 'fixture:apply', state: { schemaVersion: 1, checkpoint: '001', updatedAt: timestamp } });
    await assert.rejects(
      () => right.saveState({ stateKey: 'fixture:apply', state: { schemaVersion: 1, checkpoint: '002', updatedAt: timestamp } }),
      { code: 'historical-backfill-state-conflict' }
    );
    assert.equal(rightMetadata.getHistoricalBackfillState('fixture:apply').state.checkpoint, '001');
  } finally { rightMetadata.close(); leftMetadata.close(); }
}));

test('generic operation writes cannot take over the backfill checkpoint owner', async () => fixture(async stateDir => {
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    const store = createHistoricalBackfillStore({ metadata });
    await store.loadState({ stateKey: 'fixture:withdraw' });
    await store.saveWithdrawalState({ stateKey: 'fixture:withdraw', state: { schemaVersion: 1, index: 0, updatedAt: timestamp } });
    const operation = metadata.listOperations().find(item => item.operationKind === 'historical-backfill.state.v1');
    assert.throws(() => metadata.recordOperation({ ...operation, state: 'applied' }), { code: 'historical-backfill-owner-required' });
  } finally { metadata.close(); }
}));

test('a real process death after the external effect resumes by reconciliation without redispatch', async () => fixture(async stateDir => {
  const child = fileURLToPath(new URL('./fixtures/historical-backfill-crash-child.mjs', import.meta.url));
  const first = spawnSync(process.execPath, [child, stateDir], { encoding: 'utf8' });
  assert.equal(first.status, 23, first.stderr);
  const second = spawnSync(process.execPath, [child, stateDir], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout.trim());
  assert.equal(report.complete, true);
  assert.equal(report.counts.created, 1);
}));
