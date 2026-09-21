import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoricalBackfill, withdrawHistoricalBackfill } from '../src/open-loops/historical-backfill.mjs';

const plan = { schemaVersion: 1, backfillId: 'renovation-notes-2026-09', sourceKind: 'note', scope: { topicIds: [], topicNames: ['Fictional renovation'], maxRecords: 4 } };
const adapterDigest = `sha256:${'a'.repeat(64)}`;
const run = (service, mode = 'apply', selectedPlan = plan) => service.run({ mode, plan: selectedPlan, adapterDigest });

function harness({ failAt, loseReplyAt } = {}) {
  const states = new Map();
  const effects = new Map();
  const calls = { apply: [], reconcile: [], receipts: [], saves: [] };
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
      const result = { disposition: 'created', effectId: `loop:${input.record.sourceExternalId}`, revision: 1 };
      effects.set(input.logicalOperationId, result);
      if (input.record.checkpoint === loseReplyAt) { loseReplyAt = null; throw new Error('fixture-lost-reply'); }
      return result;
    },
    async reconcileRecord(input) { calls.reconcile.push(input); return effects.has(input.logicalOperationId) ? { status: 'applied', result: effects.get(input.logicalOperationId) } : { status: 'not-applied' }; },
    async loadState({ stateKey }) { return states.get(stateKey) ?? null; },
    async saveState(input) { states.set(input.stateKey, structuredClone(input.state)); calls.saves.push(structuredClone(input)); },
    async recordReceipt(input) { calls.receipts.push(input); }
  });
  return { service, calls, getState: (mode = 'apply') => states.get(`${plan.backfillId}:${mode}`), clearFailure: () => { failAt = null; } };
}

test('preview is bounded, content-free and performs no writes', async () => {
  const { service, calls } = harness();
  const report = await run(service, 'preview');
  assert.deepEqual(report.counts, { read: 4, skipped: 1, knowledgeOnly: 1, created: 0, updated: 0, uncertain: 1, failed: 0 });
  assert.equal(calls.apply.length, 0);
  assert.equal(JSON.stringify(report).includes('fixture'), false);
  assert.equal(JSON.stringify(report).includes('Fictional renovation'), false);
  assert.equal(calls.receipts.at(-1).status, 'complete');
});

test('a completed preview does not consume apply authority', async () => {
  const { service, calls } = harness();
  await run(service, 'preview');
  const applied = await run(service);
  assert.equal(applied.counts.created, 2);
  assert.equal(calls.apply.length, 3);
});

test('apply keeps completed history quiet and makes old uncertainty a suggestion', async () => {
  const { service, calls } = harness();
  const report = await run(service);
  assert.equal(report.counts.created, 2);
  assert.equal(report.counts.skipped, 2);
  const uncertain = calls.apply.find(call => call.record.checkpoint === '003');
  assert.equal(uncertain.classification.provenance, 'inferred');
  assert.equal(uncertain.classification.historicalBaseline, true);
  assert.equal(calls.apply.some(call => call.record.checkpoint === '002'), false);
});

test('resume starts after the last durably acknowledged checkpoint', async () => {
  const fixture = harness({ failAt: '003' });
  await assert.rejects(() => run(fixture.service), error => error.message === 'fixture-interruption' && error.checkpoint === '002');
  assert.equal(fixture.getState().checkpoint, '002');
  fixture.clearFailure();
  const report = await run(fixture.service);
  assert.equal(report.complete, true);
  assert.equal(report.counts.read, 4);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.created, 2);
});

test('a lost effect reply reconciles its durable operation instead of dispatching again', async () => {
  const fixture = harness({ loseReplyAt: '003' });
  await assert.rejects(() => run(fixture.service), error => error.message === 'fixture-lost-reply' && error.checkpoint === '002');
  const report = await run(fixture.service);
  assert.equal(report.complete, true);
  assert.equal(fixture.calls.apply.filter(call => call.record.checkpoint === '003').length, 1);
  assert.equal(fixture.calls.reconcile.some(call => call.recordDigest), true);
});

test('changed scope cannot resume an existing run identity', async () => {
  const { service } = harness({ failAt: '003' });
  await assert.rejects(() => run(service));
  await assert.rejects(() => run(service, 'apply', { ...plan, scope: { ...plan.scope, maxRecords: 3 } }), error => error.code === 'backfill-state-conflict');
});

test('changed adapter identity cannot resume an existing run', async () => {
  const { service } = harness({ failAt: '003' });
  await assert.rejects(() => run(service));
  await assert.rejects(() => service.run({ mode: 'apply', plan, adapterDigest: `sha256:${'d'.repeat(64)}` }), { code: 'backfill-state-conflict' });
});

test('central cancellation fences an effect even when the adapter does not', async () => {
  const controller = new AbortController();
  let applied = false;
  let receipts = 0;
  const states = new Map();
  const service = createHistoricalBackfill({
    assertCurrent: () => controller.signal.throwIfAborted(),
    async readPage() { return { records: [{ schemaVersion: 1, sourceExternalId: 'one', sourceVersion: '1', checkpoint: '001' }], next: '001', done: true }; },
    async classify() { controller.abort(); return { schemaVersion: 1, disposition: 'actionable', obligationId: 'one', title: 'Fixture' }; },
    async applyRecord() { applied = true; return { disposition: 'created', effectId: 'one', revision: 1 }; },
    async reconcileRecord() { return { status: 'not-applied' }; },
    async loadState({ stateKey }) { return states.get(stateKey) ?? null; },
    async saveState({ stateKey, state }) { states.set(stateKey, state); },
    async recordReceipt() { receipts += 1; }
  });
  await assert.rejects(() => run(service), { name: 'AbortError' });
  assert.equal(applied, false);
  assert.equal(receipts, 0);
});

test('cancellation during receipt publication is fenced at the owner commit', async () => {
  const controller = new AbortController();
  const states = new Map();
  let releaseReceipt;
  let receipts = 0;
  const enteredReceipt = new Promise(resolve => { releaseReceipt = resolve; });
  let acknowledgeReceipt;
  const receiptBlocked = new Promise(resolve => { acknowledgeReceipt = resolve; });
  const service = createHistoricalBackfill({
    assertCurrent: () => controller.signal.throwIfAborted(),
    async readPage() { return { records: [], next: null, done: true }; },
    async classify() { throw new Error('not reached'); },
    async applyRecord() { throw new Error('not reached'); },
    async reconcileRecord() { throw new Error('not reached'); },
    async loadState({ stateKey }) { return states.get(stateKey) ?? null; },
    async saveState({ stateKey, state }) { states.set(stateKey, state); },
    async recordReceipt(_receipt, authority) {
      acknowledgeReceipt();
      await enteredReceipt;
      authority.assertCurrent();
      receipts += 1;
    }
  });
  const running = run(service);
  await receiptBlocked;
  controller.abort();
  releaseReceipt();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(receipts, 0);
});

test('Topic-name scope is exact and rejects whitespace or duplicate selectors', async () => {
  const { service } = harness();
  await assert.rejects(() => run(service, 'preview', { ...plan, scope: { ...plan.scope, topicNames: [' Fictional renovation'] } }), error => error.code === 'backfill-scope-invalid');
  await assert.rejects(() => run(service, 'preview', { ...plan, scope: { ...plan.scope, topicNames: ['Fictional renovation', 'Fictional renovation'] } }), error => error.code === 'backfill-scope-invalid');
});

test('withdraw preserves user decisions and concurrent changes', async () => {
  const effects = [
    { effectId: 'loop:unchanged', revision: 1 },
    { effectId: 'loop:user-decided', revision: 1 },
    { effectId: 'loop:advanced', revision: 1 }
  ];
  const withdrawn = [];
  const receipts = [];
  let withdrawalState = null;
  const report = await withdrawHistoricalBackfill({
    backfillId: 'fixture-backfill',
    expectedPlanDigest: `sha256:${'b'.repeat(64)}`,
    adapterDigest,
    async loadState() { return { planDigest: `sha256:${'b'.repeat(64)}`, adapterDigest, effects }; },
    async inspectEffect({ effectId }) {
      if (effectId.endsWith('user-decided')) return { revision: 1, userDecided: true };
      if (effectId.endsWith('advanced')) return { revision: 2, userDecided: false };
      return { revision: 1, userDecided: false };
    },
    async loadWithdrawalState() { return withdrawalState; },
    async saveWithdrawalState({ state }) { withdrawalState = structuredClone(state); },
    async withdrawEffect(input) { withdrawn.push(input); return { status: 'applied' }; },
    async reconcileWithdrawal() { return { status: 'not-applied' }; },
    async recordReceipt(input) { receipts.push(input); },
    now: () => '2026-09-21T05:00:00.000Z'
  });
  assert.deepEqual(report.counts, { withdrawn: 1, preserved: 2, failed: 0 });
  assert.equal(withdrawn.length, 1);
  assert.deepEqual({ effectId: withdrawn[0].effectId, expectedRevision: withdrawn[0].expectedRevision, backfillId: withdrawn[0].backfillId }, { effectId: 'loop:unchanged', expectedRevision: 1, backfillId: 'fixture-backfill' });
  assert.match(withdrawn[0].logicalOperationId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(receipts[0].status, 'complete');
});

test('withdraw reconciles a lost successful reply without repeating the effect', async () => {
  const effects = [{ effectId: 'loop:created', revision: 1 }];
  let withdrawalState = null;
  let appliedOperation;
  let dispatches = 0;
  const adapters = {
    backfillId: 'fixture-lost-withdrawal',
    expectedPlanDigest: `sha256:${'b'.repeat(64)}`,
    adapterDigest,
    async loadState() { return { planDigest: `sha256:${'b'.repeat(64)}`, adapterDigest, effects }; },
    async loadWithdrawalState() { return withdrawalState; },
    async saveWithdrawalState({ state }) { withdrawalState = structuredClone(state); },
    async inspectEffect() { return { revision: 1, userDecided: false }; },
    async withdrawEffect(input) { dispatches += 1; appliedOperation = input.logicalOperationId; throw new Error('fixture-lost-withdrawal-reply'); },
    async reconcileWithdrawal({ logicalOperationId }) { return { status: logicalOperationId === appliedOperation ? 'applied' : 'unknown' }; },
    async recordReceipt() {},
    now: () => '2026-09-21T05:00:00.000Z'
  };
  await assert.rejects(() => withdrawHistoricalBackfill(adapters), /fixture-lost-withdrawal-reply/u);
  const report = await withdrawHistoricalBackfill(adapters);
  assert.equal(report.counts.withdrawn, 1);
  assert.equal(dispatches, 1);
});

test('withdrawal refuses a different pinned plan or adapter identity', async () => {
  const base = {
    backfillId: 'fixture-bound-withdrawal', expectedPlanDigest: `sha256:${'b'.repeat(64)}`, adapterDigest,
    async loadState() { return { planDigest: `sha256:${'e'.repeat(64)}`, adapterDigest, effects: [] }; },
    async loadWithdrawalState() { return null; }, async saveWithdrawalState() {}, async inspectEffect() {},
    async withdrawEffect() {}, async reconcileWithdrawal() {}, async recordReceipt() {}
  };
  await assert.rejects(() => withdrawHistoricalBackfill(base), { code: 'backfill-state-unavailable' });
});
