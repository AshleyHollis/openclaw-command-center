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

function emptyCounts() {
  return { read: 0, skipped: 0, knowledgeOnly: 0, created: 0, updated: 0, uncertain: 0, failed: 0 };
}

function normalizeState(value, planDigest) {
  if (value === null || value === undefined) return { schemaVersion: 1, planDigest, checkpoint: null, complete: false, counts: emptyCounts(), effects: [] };
  if (value.schemaVersion !== 1 || value.planDigest !== planDigest || typeof value.complete !== 'boolean' || !value.counts || !Array.isArray(value.effects)) fail('backfill-state-conflict');
  return { ...value, counts: { ...emptyCounts(), ...value.counts }, effects: [...value.effects] };
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
    scope: plan.scope,
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
export function createHistoricalBackfill({ readPage, classify, applyRecord, loadState, saveState, recordReceipt, now = () => new Date().toISOString() } = {}) {
  if (![readPage, classify, applyRecord, loadState, saveState, recordReceipt].every(value => typeof value === 'function')) fail('backfill-adapter-invalid');
  return Object.freeze({
    async run({ mode, plan: inputPlan }) {
      if (!modes.has(mode)) fail('backfill-mode-invalid');
      const plan = normalizePlan(inputPlan);
      const planDigest = digest(plan);
      const persisted = await loadState({ backfillId: plan.backfillId });
      const state = normalizeState(persisted, planDigest);
      if (state.complete) return contentFreeReport({ mode, plan, state });
      let cursor = state.checkpoint;
      while (state.counts.read < plan.scope.maxRecords) {
        const remaining = plan.scope.maxRecords - state.counts.read;
        const page = await readPage({ sourceKind: plan.sourceKind, scope: plan.scope, after: cursor, limit: Math.min(25, remaining) });
        if (!page || !Array.isArray(page.records) || page.records.length > Math.min(25, remaining) || (page.next === cursor && page.records.length > 0)) fail('backfill-page-invalid');
        for (const record of page.records) {
          assertRecord(record);
          const beforeCounts = { ...state.counts };
          const beforeEffects = state.effects.length;
          try {
            const classification = await classify({ sourceKind: plan.sourceKind, record, historicalBaseline: true });
            assertClassification(classification);
            state.counts.read += 1;
            if (classification.disposition === 'knowledge-only') state.counts.knowledgeOnly += 1;
            if (classification.disposition === 'uncertain') state.counts.uncertain += 1;
            if (['completed', 'unchanged'].includes(classification.disposition)) state.counts.skipped += 1;
            if (mode === 'apply' && !['completed', 'unchanged'].includes(classification.disposition)) {
              const result = await applyRecord({
                backfillId: plan.backfillId,
                sourceKind: plan.sourceKind,
                record,
                classification: classification.disposition === 'uncertain'
                  ? { ...classification, provenance: 'inferred', historicalBaseline: true }
                  : { ...classification, historicalBaseline: true }
              });
              if (!result || !['created', 'updated', 'unchanged'].includes(result.disposition)) fail('backfill-apply-result-invalid');
              if (result.disposition === 'created') {
                if (!nonBlank(result.effectId) || !Number.isSafeInteger(result.revision) || result.revision < 1) fail('backfill-effect-invalid');
                state.counts.created += 1;
                state.effects.push({ effectId: result.effectId, revision: result.revision });
              } else if (result.disposition === 'updated') state.counts.updated += 1;
              else state.counts.skipped += 1;
            }
            cursor = record.checkpoint;
            state.checkpoint = cursor;
            await saveState({ backfillId: plan.backfillId, state: { ...state, updatedAt: now() } });
          } catch (error) {
            state.counts = beforeCounts;
            state.effects.length = beforeEffects;
            state.counts.failed += 1;
            await saveState({ backfillId: plan.backfillId, state: { ...state, updatedAt: now() } });
            await recordReceipt({ ...contentFreeReport({ mode, plan, state }), status: 'failed', observedAt: now() });
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
      await saveState({ backfillId: plan.backfillId, state: { ...state, updatedAt: now() } });
      const report = contentFreeReport({ mode, plan, state });
      await recordReceipt({ ...report, status: state.complete ? 'complete' : 'limit-reached', observedAt: now() });
      return report;
    }
  });
}

/** Withdraws only effects created by this backfill and only at their recorded
 * revision. Updated records and later user/concurrent changes are preserved. */
export async function withdrawHistoricalBackfill({ backfillId, loadState, inspectEffect, withdrawEffect, recordReceipt, now = () => new Date().toISOString() } = {}) {
  if (!nonBlank(backfillId) || ![loadState, inspectEffect, withdrawEffect, recordReceipt].every(value => typeof value === 'function')) fail('backfill-withdraw-invalid');
  const state = await loadState({ backfillId });
  if (!state || !Array.isArray(state.effects)) fail('backfill-state-unavailable');
  const counts = { withdrawn: 0, preserved: 0, failed: 0 };
  for (const owned of state.effects) {
    try {
      const current = await inspectEffect({ effectId: owned.effectId });
      if (!current || current.revision !== owned.revision || current.userDecided === true) { counts.preserved += 1; continue; }
      await withdrawEffect({ effectId: owned.effectId, expectedRevision: owned.revision, backfillId });
      counts.withdrawn += 1;
    } catch {
      counts.failed += 1;
    }
  }
  const report = Object.freeze({ schemaVersion: 1, backfillId, counts: Object.freeze(counts), observedAt: now() });
  await recordReceipt({ ...report, status: counts.failed ? 'failed' : 'complete' });
  return report;
}
