import { createHash, randomUUID } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';
import { canonicalJson } from './analysis-evidence.mjs';

export const TOPIC_ANALYSIS_SCHEDULE_KEY = 'command-center:topic-analysis:weekly';
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function assertZone(value) { try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); } catch { throw sourceError('invalid-request', 'Topic Analysis timeZone must be a valid IANA timezone.'); } return value; }
export function validateAnalysisSettings(value = {}) {
  if (!Number.isInteger(value.weekday) || value.weekday < 1 || value.weekday > 7 || typeof value.localTime !== 'string' || !TIME.test(value.localTime)) throw sourceError('invalid-request', 'Topic Analysis weekday and localTime are invalid.');
  assertZone(value.timeZone);
  if (typeof value.enabled !== 'boolean') throw sourceError('invalid-request', 'Topic Analysis enabled must be boolean.');
  return value;
}

function parts(at, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), weekday: ({ Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[values.weekday] };
}

export function nextAnalysisSlot({ now = Date.now(), weekday = 1, localTime = '07:00', timeZone = 'UTC' } = {}) {
  validateAnalysisSettings({ enabled: true, weekday, localTime, timeZone });
  const clock = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(clock)) throw sourceError('invalid-request', 'Analysis clock is invalid.');
  const current = parts(clock, timeZone); const [hour, minute] = localTime.split(':').map(Number);
  const start = Date.UTC(current.year, current.month - 1, current.day);
  for (let day = 0; day <= 14; day += 1) {
    const date = new Date(start + day * 86_400_000); const candidateWeekday = ((date.getUTCDay() + 6) % 7) + 1;
    if (candidateWeekday !== weekday) continue;
    const localAsUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
    const observed = parts(localAsUtc, timeZone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const offset = observedAsUtc - localAsUtc;
    const instant = localAsUtc - offset;
    const exact = parts(instant, timeZone);
    if (exact.weekday !== weekday || exact.hour !== hour || exact.minute !== minute) continue;
    if (instant > clock) return new Date(instant).toISOString();
  }
  throw sourceError('invalid-request', 'The next Topic Analysis slot could not be represented.');
}

export function cronExpression({ weekday, localTime }) { validateAnalysisSettings({ enabled: true, weekday, localTime, timeZone: 'UTC' }); const [hour, minute] = localTime.split(':').map(Number); return `${minute} ${hour} * * ${weekday}`; }

function stableUuid(value) { const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split(''); hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]; return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`; }

export function topicAnalysisCronDeclaration(settings, { message = 'Run the command_center_topic_analysis tool exactly once.', enabled = settings.enabled } = {}) {
  validateAnalysisSettings(settings);
  return Object.freeze({ declarationKey: TOPIC_ANALYSIS_SCHEDULE_KEY, name: 'Command Center weekly Topic Analysis', enabled, schedule: { kind: 'cron', expr: cronExpression(settings), tz: settings.timeZone, staggerMs: 0 }, sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'systemEvent', text: message }, delivery: { mode: 'none' } });
}

export function createTopicAnalysisScheduleService({ metadata, notificationService, gateway, api, now = () => Date.now(), runAnalysis } = {}) {
  const cron = gateway ?? api?.runtime?.gateway;
  const clock = () => typeof now === 'function' ? now() : now;
  const getSettings = () => {
    let current = metadata.getTopicAnalysisSettings?.();
    if (!current) {
      const notification = notificationService?.getSettings?.() ?? { quietHoursEnd: '07:00', timeZone: 'UTC' };
      current = metadata.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: notification.quietHoursEnd, timeZone: notification.timeZone, initialized: true, nextDueAt: nextAnalysisSlot({ now: clock(), weekday: 1, localTime: notification.quietHoursEnd, timeZone: notification.timeZone }), updatedAt: new Date(clock()).toISOString() });
    }
    return current;
  };
  const peekSettings = () => metadata.getTopicAnalysisSettings?.() ?? null;
  async function listOwned() { if (!cron?.request) return []; const response = await cron.request('cron.list', { includeDisabled: true }); const jobs = Array.isArray(response) ? response : response?.jobs ?? response?.items ?? []; return jobs.filter((job) => job?.declarationKey === TOPIC_ANALYSIS_SCHEDULE_KEY); }
  async function reconcile() {
    const settings = getSettings(); const owned = await listOwned();
    if (owned.length > 1) throw sourceError('conflict', 'Duplicate Topic Analysis Cron declarations were found.');
    const declaration = topicAnalysisCronDeclaration(settings);
    let job = owned[0];
    if (!cron?.request) return Object.freeze({ settings, declaration, job: null });
    if (!job) { const added = await cron.request('cron.add', declaration); job = added?.job ?? added; }
    if (!job?.id || job.declarationKey !== TOPIC_ANALYSIS_SCHEDULE_KEY) throw sourceError('source-recovery', 'Topic Analysis Cron declaration identity was not verified.');
    if (typeof job.configRevision !== 'string' || !job.configRevision.trim()) throw sourceError('conflict', 'Topic Analysis Cron configuration revision was not provided.');
    const expected = JSON.stringify({ schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery });
    const actual = JSON.stringify({ schedule: job.schedule, sessionTarget: job.sessionTarget, wakeMode: job.wakeMode, payload: job.payload, delivery: job.delivery });
    const patch = {};
    if (expected !== actual) Object.assign(patch, { schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery });
    if (job.enabled !== settings.enabled) patch.enabled = settings.enabled;
    if (Object.keys(patch).length) {
      const updated = await cron.request('cron.update', { id: job.id, expectedConfigRevision: job.configRevision, patch });
      job = updated?.job ?? updated;
      if (!job || job.id !== owned[0].id || job.declarationKey !== TOPIC_ANALYSIS_SCHEDULE_KEY) throw sourceError('source-recovery', 'Topic Analysis Cron update identity was not verified.');
    }
    const verified = JSON.stringify({ schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery });
    const observed = JSON.stringify({ schedule: job.schedule, sessionTarget: job.sessionTarget, wakeMode: job.wakeMode, payload: job.payload, delivery: job.delivery });
    if (verified !== observed || job.enabled !== settings.enabled) throw sourceError('source-recovery', 'Topic Analysis Cron declaration was not fully verified after reconciliation.');
    return Object.freeze({ settings: getSettings(), declaration, job });
  }
  async function update(input = {}) {
    if (input.schemaVersion !== 1 || typeof input.logicalOperationId !== 'string' || !input.logicalOperationId.trim()) throw sourceError('invalid-request', 'Schedule updates require schemaVersion and logicalOperationId.');
    const current = getSettings();
    const patch = input.settings ?? input.schedule ?? {}; const allowed = ['enabled', 'weekday', 'localTime', 'timeZone'];
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some((key) => !allowed.includes(key))) throw sourceError('invalid-request', 'Schedule update contains unsupported fields.');
    const intent = { action: 'schedule.update', expectedRevision: input.expectedRevision, settings: patch };
    const journal = metadata.getOperation?.(input.logicalOperationId);
    if (journal) {
      if (journal.intentDigest !== canonicalJson(intent)) throw sourceError('intent-mismatch', 'Logical operation ID was reused with different schedule intent.');
      if (journal.resultIdentity) return JSON.parse(journal.resultIdentity);
    }
    if (input.expectedRevision !== current.revision) throw sourceError('conflict', 'Topic Analysis schedule revision is stale.');
    const nextEnabled = patch.enabled ?? current.enabled;
    const next = { ...current, ...patch, revision: current.revision + 1, nextDueAt: nextEnabled ? nextAnalysisSlot({ now: clock(), weekday: patch.weekday ?? current.weekday, localTime: patch.localTime ?? current.localTime, timeZone: patch.timeZone ?? current.timeZone }) : null, initialized: true, updatedAt: new Date(clock()).toISOString() };
    const saved = metadata.setTopicAnalysisSettings({ ...next, schemaVersion: 1, expectedRevision: current.revision });
    const result = await reconcile(); const output = { ...result, settings: saved };
    metadata.recordOperation?.({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest: canonicalJson(intent), operationKind: 'schedule.update', state: 'applied', resultStatus: 'applied', resultIdentity: JSON.stringify(output), observedRevision: String(saved.revision), createdAt: saved.updatedAt, updatedAt: saved.updatedAt });
    return output;
  }
  function advancePast(dueAt) {
    const current = getSettings();
    if (!current.enabled || current.nextDueAt !== dueAt) return current;
    return metadata.setTopicAnalysisSettings({ ...current, schemaVersion: 1, revision: current.revision, expectedRevision: current.revision, nextDueAt: nextAnalysisSlot({ now: clock(), weekday: current.weekday, localTime: current.localTime, timeZone: current.timeZone }), updatedAt: new Date(clock()).toISOString() });
  }
  async function manual(input = {}) {
    const dueAt = getSettings().nextDueAt;
    const result = runAnalysis ? await runAnalysis({ ...input, trigger: 'manual' }) : null;
    if (result?.outcome === 'success' && dueAt && Date.parse(dueAt) <= clock()) advancePast(dueAt);
    return result;
  }
  async function weekly(input = {}) {
    if (!getSettings().enabled) return Object.freeze({ schemaVersion: 1, trigger: input.trigger === 'catch-up' ? 'catch-up' : 'weekly', outcome: 'disabled' });
    const result = runAnalysis ? await runAnalysis({ ...input, trigger: input.trigger === 'catch-up' ? 'catch-up' : 'weekly' }) : null;
    if (result?.outcome === 'success') {
      const current = getSettings();
      metadata.setTopicAnalysisSettings({ ...current, schemaVersion: 1, revision: current.revision, expectedRevision: current.revision, nextDueAt: current.enabled ? nextAnalysisSlot({ now: clock(), weekday: current.weekday, localTime: current.localTime, timeZone: current.timeZone }) : null, updatedAt: new Date(clock()).toISOString() });
    }
    return result;
  }
  async function startupCatchUp() {
    const settings = getSettings(); const dueAt = settings.nextDueAt;
    if (!settings.enabled || !dueAt || Date.parse(dueAt) > clock()) return Object.freeze({ outcome: 'not-due' });
    const satisfied = (metadata.listTopicAnalysisRuns?.() ?? []).some((run) => run.outcome === 'success' && run.finishedAt && Date.parse(run.finishedAt) >= Date.parse(dueAt));
    if (satisfied) { advancePast(dueAt); return Object.freeze({ outcome: 'satisfied', dueAt }); }
    const claimId = stableUuid(`topic-analysis-catch-up-claim:${dueAt}`); const runOperationId = stableUuid(`topic-analysis-catch-up-run:${dueAt}`);
    const intent = { action: 'analysis.catch-up', dueAt };
    const existing = metadata.getOperation?.(claimId);
    if (existing) { if (existing.intentDigest !== canonicalJson(intent)) throw sourceError('intent-mismatch', 'Catch-up claim intent changed.'); return Object.freeze({ outcome: 'claimed', dueAt }); }
    const claimedAt = new Date(clock()).toISOString();
    metadata.recordOperation?.({ logicalOperationId: claimId, transportRequestId: claimId, intentDigest: canonicalJson(intent), operationKind: 'topic-analysis.catch-up.claim', state: 'pending', resultStatus: 'claimed', resultIdentity: null, observedRevision: dueAt, createdAt: claimedAt, updatedAt: claimedAt });
    advancePast(dueAt);
    const result = runAnalysis ? await runAnalysis({ schemaVersion: 1, logicalOperationId: runOperationId, trigger: 'catch-up' }) : null;
    metadata.recordOperation?.({ logicalOperationId: claimId, transportRequestId: claimId, intentDigest: canonicalJson(intent), operationKind: 'topic-analysis.catch-up.claim', state: result?.outcome === 'success' ? 'applied' : 'not-applied', resultStatus: result?.outcome ?? 'unavailable', resultIdentity: JSON.stringify(result ?? { outcome: 'unavailable' }), observedRevision: dueAt, createdAt: claimedAt, updatedAt: new Date(clock()).toISOString() });
    return result;
  }
  return Object.freeze({ getSettings, peekSettings, listOwned, reconcile, update, manual, weekly, startupCatchUp, nextDueAt: () => getSettings().nextDueAt, operationId: () => randomUUID() });
}
