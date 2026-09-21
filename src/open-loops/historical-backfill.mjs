import { createHash } from 'node:crypto';

const sourceKinds = new Set(['email', 'note']);
const modes = new Set(['preview', 'apply']);
const dispositions = new Set(['knowledge-only', 'completed', 'uncertain', 'actionable', 'unchanged']);
const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function normalizePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || !nonBlank(plan.backfillId) || !sourceKinds.has(plan.sourceKind)) fail('backfill-plan-invalid');
  if (!plan.scope || typeof plan.scope !== 'object' || Array.isArray(plan.scope)) fail('backfill-scope-invalid');
  const allowed = ['topicIds', 'topicNames', 'since', 'until', 'maxRecords'];
  if (Object.keys(plan.scope).some(key => !allowed.includes(key))) fail('backfill-scope-invalid');
  const maxRecords = plan.scope.maxRecords;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000) fail('backfill-scope-invalid');
  const topicIds = plan.scope.topicIds ?? [];
  if (!Array.isArray(topicIds) || topicIds.length > 50 || topicIds.some(value => !nonBlank(value)) || new Set(topicIds).size !== topicIds.length) fail('backfill-scope-invalid');
  const topicNames = plan.scope.topicNames ?? [];
  if (!Array.isArray(topicNames) || topicNames.length > 50 || topicNames.some(value => !nonBlank(value) || value !== value.trim()) || new Set(topicNames).size !== topicNames.length) fail('backfill-scope-invalid');
  const instant = (value, field) => {
    if (value === undefined) return undefined;
    if (!nonBlank(value) || !Number.isFinite(Date.parse(value))) fail(`backfill-${field}-invalid`);
    return new Date(value).toISOString();
  };
  const since = instant(plan.scope.since, 'since');
  const until = instant(plan.scope.until, 'until');
  if (since && until && since >= until) fail('backfill-window-invalid');
  return Object.freeze({
    schemaVersion: 1,
    backfillId: plan.backfillId.trim(),
    sourceKind: plan.sourceKind,
    scope: Object.freeze({ topicIds: Object.freeze([...topicIds]), topicNames: Object.freeze([...topicNames]), ...(since ? { since } : {}), ...(until ? { until } : {}), maxRecords })
  });
}

export const historicalBackfillPlanDigest = plan => digest(normalizePlan(plan));

function emptyCounts() {
  return { read: 0, skipped: 0, knowledgeOnly: 0, created: 0, updated: 0, uncertain: 0, failed: 0 };
}

function normalizeState(value, planDigest, adapterDigest, mode) {
  if (value === null || value === undefined) return { schemaVersion: 1, planDigest, adapterDigest, mode, checkpoint: null, complete: false, counts: emptyCounts(), effects: [], pending: null };
  if (value.schemaVersion !== 1 || value.planDigest !== planDigest || value.adapterDigest !== adapterDigest || value.mode !== mode || typeof value.complete !== 'boolean' || !value.counts || !Array.isArray(value.effects) || !(value.pending === null || typeof value.pending === 'object')) fail('backfill-state-conflict');
  return { ...value, counts: { ...emptyCounts(), ...value.counts }, effects: [...value.effects], pending: value.pending ? { ...value.pending } : null };
}

function assertRecord(record) {
  if (!record || record.schemaVersion !== 1 || !nonBlank(record.sourceExternalId) || !nonBlank(record.sourceVersion) || !nonBlank(record.checkpoint)) fail('backfill-record-invalid');
}

function assertClassification(value) {
  if (!value || value.schemaVersion !== 1 || !dispositions.has(value.disposition)) fail('backfill-classification-invalid');
  if (['uncertain', 'actionable'].includes(value.disposition) && (!nonBlank(value.obligationId) || !nonBlank(value.title))) fail('backfill-classification-invalid');
}

function contentFreeReport({ mode, plan, state }) {
  return Object.freeze({
    schemaVersion: 1,
    backfillId: plan.backfillId,
    sourceKind: plan.sourceKind,
    mode,
    scope: Object.freeze({ ...(plan.scope.since ? { since: plan.scope.since } : {}), ...(plan.scope.until ? { until: plan.scope.until } : {}), maxRecords: plan.scope.maxRecords, topicSelectorCount: plan.scope.topicIds.length + plan.scope.topicNames.length }),
    checkpoint: state.checkpoint,
    complete: state.complete,
    counts: Object.freeze({ ...state.counts }),
    effectCount: state.effects.length
  });
}

/**
 * Runs a bounded historical reconciliation. Source enumeration, semantic
 * classification and writes remain injected ownership boundaries. Persisted
 * state contains only checkpoints, counters and effect identities.
 */
export function createHistoricalBackfill({ readPage, classify, applyRecord, reconcileRecord, loadState, saveState, recordReceipt, assertCurrent = () => {}, now = () => new Date().toISOString() } = {}) {
  if (![readPage, classify, applyRecord, reconcileRecord, loadState, saveState, recordReceipt].every(value => typeof value === 'function')) fail('backfill-adapter-invalid');
  return Object.freeze({
    async run({ mode, plan: inputPlan, adapterDigest }) {
      if (!modes.has(mode)) fail('backfill-mode-invalid');
      if (!/^sha256:[a-f0-9]{64}$/u.test(adapterDigest)) fail('backfill-adapter-digest-invalid');
      const plan = normalizePlan(inputPlan);
      const planDigest = digest(plan);
      const stateKey = `${plan.backfillId}:${mode}`;
      assertCurrent();
      const persisted = await loadState({ backfillId: plan.backfillId, mode, stateKey });
      assertCurrent();
      const state = normalizeState(persisted, planDigest, adapterDigest, mode);
      if (state.complete) return contentFreeReport({ mode, plan, state });
      let cursor = state.checkpoint;
      while (state.counts.read < plan.scope.maxRecords) {
        const remaining = plan.scope.maxRecords - state.counts.read;
        assertCurrent();
        const page = await readPage({ sourceKind: plan.sourceKind, scope: plan.scope, after: cursor, limit: Math.min(25, remaining) });
        assertCurrent();
        if (!page || !Array.isArray(page.records) || page.records.length > Math.min(25, remaining) || (page.next === cursor && page.records.length > 0)) fail('backfill-page-invalid');
        for (const record of page.records) {
          assertRecord(record);
          const beforeCounts = { ...state.counts };
          const beforeEffects = state.effects.length;
          try {
            assertCurrent();
            const classification = await classify({ sourceKind: plan.sourceKind, record, historicalBaseline: true });
            assertCurrent();
            assertClassification(classification);
            const recordDigest = digest({ sourceExternalId: record.sourceExternalId, sourceVersion: record.sourceVersion, checkpoint: record.checkpoint });
            const classificationDigest = digest(classification);
            let result;
            if (mode === 'apply' && !['completed', 'unchanged'].includes(classification.disposition)) {
              const logicalOperationId = digest({ owner: 'command-center.historical-backfill.v1', planDigest, adapterDigest, recordDigest });
              if (state.pending) {
                if (state.pending.recordDigest !== recordDigest || state.pending.classificationDigest !== classificationDigest || state.pending.logicalOperationId !== logicalOperationId) fail('backfill-pending-conflict');
                assertCurrent();
                const reconciliation = await reconcileRecord({
                  backfillId: plan.backfillId,
                  logicalOperationId,
                  recordDigest,
                  sourceKind: plan.sourceKind,
                  record,
                  classification: classification.disposition === 'uncertain'
                    ? { ...classification, provenance: 'inferred', historicalBaseline: true }
                    : { ...classification, historicalBaseline: true }
                });
                assertCurrent();
                if (!reconciliation || !['applied', 'not-applied', 'unknown', 'conflict'].includes(reconciliation.status)) fail('backfill-reconciliation-invalid');
                if (reconciliation.status === 'unknown') fail('backfill-effect-unknown');
                if (reconciliation.status === 'conflict') fail('backfill-effect-conflict');
                if (reconciliation.status === 'applied') result = reconciliation.result;
              } else {
                state.pending = { logicalOperationId, recordDigest, classificationDigest };
                await saveState({ backfillId: plan.backfillId, mode, stateKey, state: { ...state, updatedAt: now() } });
                assertCurrent();
              }
              if (!result) { assertCurrent(); result = await applyRecord({
                backfillId: plan.backfillId, logicalOperationId, sourceKind: plan.sourceKind, record,
                classification: classification.disposition === 'uncertain'
                  ? { ...classification, provenance: 'inferred', historicalBaseline: true }
                  : { ...classification, historicalBaseline: true }
              }); assertCurrent(); }
              if (!result || !['created', 'updated', 'unchanged'].includes(result.disposition)) fail('backfill-apply-result-invalid');
            }
            state.counts.read += 1;
            if (classification.disposition === 'knowledge-only') state.counts.knowledgeOnly += 1;
            if (classification.disposition === 'uncertain') state.counts.uncertain += 1;
            if (['completed', 'unchanged'].includes(classification.disposition)) state.counts.skipped += 1;
            if (result) {
              if (result.disposition === 'created') {
                if (!nonBlank(result.effectId) || !Number.isSafeInteger(result.revision) || result.revision < 1) fail('backfill-effect-invalid');
                state.counts.created += 1;
                state.effects.push({ effectId: result.effectId, revision: result.revision });
              } else if (result.disposition === 'updated') state.counts.updated += 1;
              else state.counts.skipped += 1;
            }
            state.pending = null;
            cursor = record.checkpoint;
            state.checkpoint = cursor;
            await saveState({ backfillId: plan.backfillId, mode, stateKey, state: { ...state, updatedAt: now() } });
            assertCurrent();
          } catch (error) {
            state.counts = beforeCounts;
            state.effects.length = beforeEffects;
            state.counts.failed += 1;
            await saveState({ backfillId: plan.backfillId, mode, stateKey, state: { ...state, updatedAt: now() } });
            assertCurrent();
            await recordReceipt({ ...contentFreeReport({ mode, plan, state }), status: 'failed', observedAt: now() }, { assertCurrent });
            assertCurrent();
            throw Object.assign(error instanceof Error ? error : new Error('backfill-failed'), { checkpoint: state.checkpoint, report: contentFreeReport({ mode, plan, state }) });
          }
        }
        cursor = page.next ?? cursor;
        state.checkpoint = cursor;
        if (page.done === true || page.records.length === 0 || state.counts.read >= plan.scope.maxRecords) {
          state.complete = page.done === true || page.records.length === 0;
          break;
        }
      }
      await saveState({ backfillId: plan.backfillId, mode, stateKey, state: { ...state, updatedAt: now() } });
      const report = contentFreeReport({ mode, plan, state });
      assertCurrent();
      await recordReceipt({ ...report, status: state.complete ? 'complete' : 'limit-reached', observedAt: now() }, { assertCurrent });
      assertCurrent();
      return report;
    }
  });
}

/** Withdraws only effects created by this backfill and only at their recorded
 * revision. Updated records and later user/concurrent changes are preserved. */
export async function withdrawHistoricalBackfill({ backfillId, expectedPlanDigest, adapterDigest, loadState, loadWithdrawalState, saveWithdrawalState, inspectEffect, withdrawEffect, reconcileWithdrawal, recordReceipt, assertCurrent = () => {}, now = () => new Date().toISOString() } = {}) {
  if (!nonBlank(backfillId) || ![loadState, loadWithdrawalState, saveWithdrawalState, inspectEffect, withdrawEffect, reconcileWithdrawal, recordReceipt].every(value => typeof value === 'function')) fail('backfill-withdraw-invalid');
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedPlanDigest) || !/^sha256:[a-f0-9]{64}$/u.test(adapterDigest)) fail('backfill-withdraw-invalid');
  assertCurrent();
  const state = await loadState({ backfillId, mode: 'apply', stateKey: `${backfillId}:apply` });
  assertCurrent();
  if (!state || state.planDigest !== expectedPlanDigest || state.adapterDigest !== adapterDigest || !Array.isArray(state.effects)) fail('backfill-state-unavailable');
  const stateKey = `${backfillId}:withdraw`;
  const saved = await loadWithdrawalState({ backfillId, stateKey });
  const withdrawal = saved ?? { schemaVersion: 1, effectDigest: digest(state.effects), index: 0, counts: { withdrawn: 0, preserved: 0, failed: 0 }, pending: null, complete: false };
  if (withdrawal.schemaVersion !== 1 || withdrawal.effectDigest !== digest(state.effects) || !Number.isSafeInteger(withdrawal.index) || withdrawal.index < 0 || !withdrawal.counts || !(withdrawal.pending === null || typeof withdrawal.pending === 'object')) fail('backfill-withdraw-state-conflict');
  if (withdrawal.complete) return Object.freeze({ schemaVersion: 1, backfillId, counts: Object.freeze({ ...withdrawal.counts }), observedAt: now() });
  for (; withdrawal.index < state.effects.length;) {
    const owned = state.effects[withdrawal.index];
    assertCurrent();
    const current = await inspectEffect({ effectId: owned.effectId });
    assertCurrent();
    if (!current || current.revision !== owned.revision || current.userDecided === true) {
      withdrawal.counts.preserved += 1; withdrawal.index += 1;
      await saveWithdrawalState({ backfillId, stateKey, state: { ...withdrawal, updatedAt: now() } });
      continue;
    }
    const logicalOperationId = digest({ owner: 'command-center.historical-backfill-withdraw.v1', backfillId, effectId: owned.effectId, revision: owned.revision });
    if (withdrawal.pending) {
      if (withdrawal.pending.logicalOperationId !== logicalOperationId || withdrawal.pending.effectId !== owned.effectId || withdrawal.pending.revision !== owned.revision) fail('backfill-withdraw-pending-conflict');
      const reconciliation = await reconcileWithdrawal({ backfillId, logicalOperationId, effectId: owned.effectId, expectedRevision: owned.revision });
      assertCurrent();
      if (!reconciliation || !['applied', 'not-applied', 'unknown', 'conflict'].includes(reconciliation.status)) fail('backfill-withdraw-reconciliation-invalid');
      if (reconciliation.status === 'unknown') fail('backfill-withdraw-unknown');
      if (reconciliation.status === 'conflict') fail('backfill-withdraw-conflict');
      if (reconciliation.status === 'applied') {
        withdrawal.counts.withdrawn += 1; withdrawal.index += 1; withdrawal.pending = null;
        await saveWithdrawalState({ backfillId, stateKey, state: { ...withdrawal, updatedAt: now() } });
        continue;
      }
    } else {
      withdrawal.pending = { logicalOperationId, effectId: owned.effectId, revision: owned.revision };
      await saveWithdrawalState({ backfillId, stateKey, state: { ...withdrawal, updatedAt: now() } });
    }
    try {
      assertCurrent();
      const result = await withdrawEffect({ logicalOperationId, effectId: owned.effectId, expectedRevision: owned.revision, backfillId });
      assertCurrent();
      if (!result || result.status !== 'applied') fail('backfill-withdraw-result-invalid');
    } catch (error) {
      withdrawal.counts.failed += 1;
      await saveWithdrawalState({ backfillId, stateKey, state: { ...withdrawal, updatedAt: now() } });
      const failed = Object.freeze({ schemaVersion: 1, backfillId, counts: Object.freeze({ ...withdrawal.counts }), observedAt: now() });
      assertCurrent();
      await recordReceipt({ ...failed, mode: 'withdraw', status: 'failed' }, { assertCurrent });
      assertCurrent();
      throw Object.assign(error instanceof Error ? error : new Error('backfill-withdraw-failed'), { report: failed });
    }
    withdrawal.counts.withdrawn += 1; withdrawal.index += 1; withdrawal.pending = null;
    await saveWithdrawalState({ backfillId, stateKey, state: { ...withdrawal, updatedAt: now() } });
  }
  withdrawal.complete = true;
  await saveWithdrawalState({ backfillId, stateKey, state: { ...withdrawal, updatedAt: now() } });
  const report = Object.freeze({ schemaVersion: 1, backfillId, counts: Object.freeze({ ...withdrawal.counts }), observedAt: now() });
  assertCurrent();
  await recordReceipt({ ...report, mode: 'withdraw', status: 'complete' }, { assertCurrent });
  assertCurrent();
  return report;
}
