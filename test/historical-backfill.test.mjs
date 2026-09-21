import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoricalBackfill, withdrawHistoricalBackfill } from '../src/open-loops/historical-backfill.mjs';

const plan = { schemaVersion: 1, backfillId: 'renovation-notes-2026-09', sourceKind: 'note', scope: { topicIds: [], topicNames: ['Fictional renovation'], maxRecords: 4 } };

function harness({ failAt } = {}) {
  let state = null;
  const calls = { apply: [], receipts: [], saves: [] };
  const records = [
    { schemaVersion: 1, sourceExternalId: 'note-1', sourceVersion: 'v1', checkpoint: '001', rawText: 'fixture knowledge-only' },
    { schemaVersion: 1, sourceExternalId: 'note-2', sourceVersion: 'v1', checkpoint: '002', rawText: 'fixture completed' },
    { schemaVersion: 1, sourceExternalId: 'note-3', sourceVersion: 'v1', checkpoint: '003', rawText: 'fixture uncertain' },
    { schemaVersion: 1, sourceExternalId: 'note-4', sourceVersion: 'v1', checkpoint: '004', rawText: 'fixture actionable' }
  ];
  const service = createHistoricalBackfill({
    now: () => '2026-09-21T04:00:00.000Z',
    async readPage({ after, limit }) {
      const start = after ? records.findIndex(record => record.checkpoint === after) + 1 : 0;
      const selected = records.slice(start, start + limit);
      return { records: selected, next: selected.at(-1)?.checkpoint ?? after, done: start + selected.length >= records.length };
    },
    async classify({ record }) {
      const disposition = record.rawText.split(' ').at(-1);
      return { schemaVersion: 1, disposition, ...(disposition === 'uncertain' || disposition === 'actionable' ? { obligationId: `${record.sourceExternalId}:work`, title: 'Review fictional work' } : {}) };
    },
    async applyRecord(input) {
      calls.apply.push(input);
      if (input.record.checkpoint === failAt) throw new Error('fixture-interruption');
      if (input.classification.disposition === 'knowledge-only') return { disposition: 'unchanged' };
      return { disposition: 'created', effectId: `loop:${input.record.sourceExternalId}`, revision: 1 };
    },
    async loadState() { return state; },
    async saveState(input) { state = structuredClone(input.state); calls.saves.push(structuredClone(input)); },
    async recordReceipt(input) { calls.receipts.push(input); }
  });
  return { service, calls, getState: () => state, clearFailure: () => { failAt = null; } };
}

test('preview is bounded, content-free and performs no writes', async () => {
  const { service, calls } = harness();
  const report = await service.run({ mode: 'preview', plan });
  assert.deepEqual(report.counts, { read: 4, skipped: 1, knowledgeOnly: 1, created: 0, updated: 0, uncertain: 1, failed: 0 });
  assert.equal(calls.apply.length, 0);
  assert.equal(JSON.stringify(report).includes('fixture'), false);
  assert.equal(calls.receipts.at(-1).status, 'complete');
});

test('apply keeps completed history quiet and makes old uncertainty a suggestion', async () => {
  const { service, calls } = harness();
  const report = await service.run({ mode: 'apply', plan });
  assert.equal(report.counts.created, 2);
  assert.equal(report.counts.skipped, 2);
  const uncertain = calls.apply.find(call => call.record.checkpoint === '003');
  assert.equal(uncertain.classification.provenance, 'inferred');
  assert.equal(uncertain.classification.historicalBaseline, true);
  assert.equal(calls.apply.some(call => call.record.checkpoint === '002'), false);
});

test('resume starts after the last durably acknowledged checkpoint', async () => {
  const fixture = harness({ failAt: '003' });
  await assert.rejects(() => fixture.service.run({ mode: 'apply', plan }), error => error.message === 'fixture-interruption' && error.checkpoint === '002');
  assert.equal(fixture.getState().checkpoint, '002');
  fixture.clearFailure();
  const report = await fixture.service.run({ mode: 'apply', plan });
  assert.equal(report.complete, true);
  assert.equal(report.counts.read, 4);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.created, 2);
});

test('changed scope cannot resume an existing run identity', async () => {
  const { service } = harness({ failAt: '003' });
  await assert.rejects(() => service.run({ mode: 'apply', plan }));
  await assert.rejects(() => service.run({ mode: 'apply', plan: { ...plan, scope: { ...plan.scope, maxRecords: 3 } } }), error => error.code === 'backfill-state-conflict');
});

test('Topic-name scope is exact and rejects whitespace or duplicate selectors', async () => {
  const { service } = harness();
  await assert.rejects(() => service.run({ mode: 'preview', plan: { ...plan, scope: { ...plan.scope, topicNames: [' Fictional renovation'] } } }), error => error.code === 'backfill-scope-invalid');
  await assert.rejects(() => service.run({ mode: 'preview', plan: { ...plan, scope: { ...plan.scope, topicNames: ['Fictional renovation', 'Fictional renovation'] } } }), error => error.code === 'backfill-scope-invalid');
});

test('withdraw preserves user decisions and concurrent changes', async () => {
  const effects = [
    { effectId: 'loop:unchanged', revision: 1 },
    { effectId: 'loop:user-decided', revision: 1 },
    { effectId: 'loop:advanced', revision: 1 }
  ];
  const withdrawn = [];
  const receipts = [];
  const report = await withdrawHistoricalBackfill({
    backfillId: 'fixture-backfill',
    async loadState() { return { effects }; },
    async inspectEffect({ effectId }) {
      if (effectId.endsWith('user-decided')) return { revision: 1, userDecided: true };
      if (effectId.endsWith('advanced')) return { revision: 2, userDecided: false };
      return { revision: 1, userDecided: false };
    },
    async withdrawEffect(input) { withdrawn.push(input); },
    async recordReceipt(input) { receipts.push(input); },
    now: () => '2026-09-21T05:00:00.000Z'
  });
  assert.deepEqual(report.counts, { withdrawn: 1, preserved: 2, failed: 0 });
  assert.deepEqual(withdrawn, [{ effectId: 'loop:unchanged', expectedRevision: 1, backfillId: 'fixture-backfill' }]);
  assert.equal(receipts[0].status, 'complete');
});
