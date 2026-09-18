import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSafeDirectory } from '../sources/note-path.mjs';
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
  return Object.freeze({ declarationKey: TOPIC_ANALYSIS_SCHEDULE_KEY, name: 'Command Center weekly Topic Analysis', enabled, schedule: { kind: 'cron', expr: cronExpression(settings), tz: settings.timeZone, staggerMs: 0 }, sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message, toolsAllow: ['command_center_topic_analysis'] }, delivery: { mode: 'none' } });
}

export function createTopicAnalysisScheduleService({ metadata, notificationService, getCron, now = () => Date.now(), runAnalysis } = {}) {
  async function withSettingsOwner(action) {
    if (typeof metadata.databasePath !== 'string') throw sourceError('capability-unavailable', 'Durable Topic Analysis Settings ownership is unavailable.');
    const key = path.resolve(metadata.databasePath);
    const directory = await assertSafeDirectory(path.dirname(key));
    const lockPath = path.join(directory, 'analysis-settings-coordinator.sqlite');
    const { tryAcquireExclusiveSqliteCoordinator: acquire } = await import('openclaw/plugin-sdk/sqlite-runtime');
    if (typeof acquire !== 'function') throw sourceError('capability-unavailable', 'The host Settings coordinator is unavailable.');
    let lock;
    const started = Date.now();
    while (!lock) {
      const stat = await lstat(lockPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw sourceError('source-recovery', 'The Settings coordinator path is unsafe.');
      lock = acquire(lockPath, { busyTimeoutMs: 0 });
      if (!lock) {
        if (Date.now() - started >= 30_000) throw sourceError('unavailable', 'Another Settings reconciliation still owns the coordinator.');
        await delay(20);
      }
    }
    // Every public reconciliation acquires independently. Unlike nested Note
    // filesystem calls, no Settings operation needs ambient reentrant authority.
    try { return await action(); }
    finally { lock.release(); }
  }
  const requireCron = () => {
    const cron = getCron?.();
    if (!cron) throw sourceError('unavailable', 'Topic Analysis requires the host service scheduler.');
    return cron;
  };
  const clock = () => typeof now === 'function' ? now() : now;
  const getSettings = () => {
    let current = metadata.getTopicAnalysisSettings?.();
    if (!current) {
      const notification = notificationService?.getSettings?.() ?? { quietHoursEnd: '07:00', timeZone: 'UTC' };
      try {
        current = metadata.setTopicAnalysisSettings({ schemaVersion: 1, expectedRevision: 0, enabled: true, weekday: 1, localTime: notification.quietHoursEnd, timeZone: notification.timeZone, initialized: true, nextDueAt: nextAnalysisSlot({ now: clock(), weekday: 1, localTime: notification.quietHoursEnd, timeZone: notification.timeZone }), updatedAt: new Date(clock()).toISOString() });
      } catch (error) {
        current = metadata.getTopicAnalysisSettings?.();
        if (error?.code !== 'conflict' || !current) throw error;
      }
    }
    return current;
  };
  const peekSettings = () => metadata.getTopicAnalysisSettings?.() ?? null;
  async function listOwned(cron = requireCron()) { const jobs = await cron.list({ includeDisabled: true }); return jobs.filter((job) => job?.declarationKey === TOPIC_ANALYSIS_SCHEDULE_KEY); }
  function assertSettingsOwner(settings, logicalOperationId) {
    const pending = metadata.getPendingAnalysisSettingsUpdate?.();
    if ((pending && pending.logicalOperationId !== logicalOperationId) || canonicalJson(peekSettings()) !== canonicalJson(settings)) throw sourceError('conflict', 'Topic Analysis Settings changed during Cron reconciliation.');
  }
  async function reconcileDeclaration(settings, declaration, logicalOperationId) {
    const cron = requireCron();
    assertSettingsOwner(settings, logicalOperationId);
    const owned = await listOwned(cron);
    assertSettingsOwner(settings, logicalOperationId);
    if (owned.length > 1) throw sourceError('conflict', 'Duplicate Topic Analysis Cron declarations were found.');
    let job = owned[0];
    if (!job) job = await cron.add(declaration);
    assertSettingsOwner(settings, logicalOperationId);
    if (!job?.id || job.declarationKey !== TOPIC_ANALYSIS_SCHEDULE_KEY) throw sourceError('source-recovery', 'Topic Analysis Cron declaration identity was not verified.');
    if (typeof job.configRevision !== 'string' || !job.configRevision.trim()) throw sourceError('conflict', 'Topic Analysis Cron configuration revision was not provided.');
    const expected = canonicalJson({ name: declaration.name, schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery });
    const actual = canonicalJson({ name: job.name, schedule: job.schedule, sessionTarget: job.sessionTarget, wakeMode: job.wakeMode, payload: job.payload, delivery: job.delivery });
    const patch = {};
    if (expected !== actual) Object.assign(patch, { name: declaration.name, schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery });
    if (job.enabled !== settings.enabled) patch.enabled = settings.enabled;
    if (Object.keys(patch).length) {
      const expectedJobId = job.id;
      job = await cron.update(expectedJobId, patch, { expectedConfigRevision: job.configRevision });
      assertSettingsOwner(settings, logicalOperationId);
      if (!job || job.id !== expectedJobId || job.declarationKey !== TOPIC_ANALYSIS_SCHEDULE_KEY) throw sourceError('source-recovery', 'Topic Analysis Cron update identity was not verified.');
    }
    const verified = expected;
    const observed = canonicalJson({ name: job.name, schedule: job.schedule, sessionTarget: job.sessionTarget, wakeMode: job.wakeMode, payload: job.payload, delivery: job.delivery });
    if (verified !== observed || job.enabled !== settings.enabled) throw sourceError('source-recovery', 'Topic Analysis Cron declaration was not fully verified after reconciliation.');
    return Object.freeze({ settings, declaration, job });
  }
  async function resumeSettingsUpdate(journal) {
    if (journal.operationKind !== 'schedule.update') throw sourceError('intent-mismatch', 'The operation does not own a Settings update.');
    if (journal.state === 'applied') return JSON.parse(journal.resultIdentity);
    if (journal.state !== 'pending') throw sourceError('source-recovery', 'The Settings update has no resumable pending intent.');
    const pending = JSON.parse(journal.resultIdentity);
    if (pending?.schemaVersion !== 1 || journal.observedRevision !== String(pending.settings?.revision) || canonicalJson(pending.declaration) !== canonicalJson(topicAnalysisCronDeclaration(pending.settings))) throw sourceError('source-recovery', 'The pending Settings declaration is not compatible with its saved intent.');
    const output = await reconcileDeclaration(pending.settings, pending.declaration, journal.logicalOperationId);
    const completed = metadata.completeAnalysisSettingsUpdate({ logicalOperationId: journal.logicalOperationId, intentDigest: journal.intentDigest, result: output });
    return JSON.parse(completed.resultIdentity);
  }
  async function reconcile() {
    const pending = metadata.getPendingAnalysisSettingsUpdate?.();
    if (pending) return resumeSettingsUpdate(pending);
    const settings = getSettings();
    return reconcileDeclaration(settings, topicAnalysisCronDeclaration(settings));
  }
  async function update(input = {}) {
    if (input.schemaVersion !== 1 || typeof input.logicalOperationId !== 'string' || !input.logicalOperationId.trim()) throw sourceError('invalid-request', 'Schedule updates require schemaVersion and logicalOperationId.');
    requireCron();
    const patch = input.settings ?? input.schedule ?? {}; const allowed = ['enabled', 'weekday', 'localTime', 'timeZone'];
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => !allowed.includes(key))) throw sourceError('invalid-request', 'Schedule update contains unsupported fields.');
    const intent = { action: 'schedule.update', expectedRevision: input.expectedRevision, settings: patch };
    const journal = metadata.getOperation?.(input.logicalOperationId);
    if (journal) {
      if (journal.intentDigest !== canonicalJson(intent)) throw sourceError('intent-mismatch', 'Logical operation ID was reused with different schedule intent.');
      return resumeSettingsUpdate(journal);
    }
    const current = getSettings();
    if (input.expectedRevision !== current.revision) throw sourceError('conflict', 'Topic Analysis schedule revision is stale.');
    const nextEnabled = patch.enabled ?? current.enabled;
    const next = { ...current, ...patch, revision: current.revision + 1, nextDueAt: nextEnabled ? nextAnalysisSlot({ now: clock(), weekday: patch.weekday ?? current.weekday, localTime: patch.localTime ?? current.localTime, timeZone: patch.timeZone ?? current.timeZone }) : null, initialized: true, updatedAt: new Date(clock()).toISOString() };
    const pending = metadata.beginAnalysisSettingsUpdate({ logicalOperationId: input.logicalOperationId, intentDigest: canonicalJson(intent), settings: { ...next, schemaVersion: 1, expectedRevision: current.revision }, declaration: topicAnalysisCronDeclaration(next) });
    return resumeSettingsUpdate(pending);
  }
  function advancePast(dueAt) {
    const current = getSettings();
    if (!current.enabled || current.nextDueAt !== dueAt) return current;
    return metadata.setTopicAnalysisSettings({ ...current, schemaVersion: 1, revision: current.revision, expectedRevision: current.revision, nextDueAt: nextAnalysisSlot({ now: clock(), weekday: current.weekday, localTime: current.localTime, timeZone: current.timeZone }), updatedAt: new Date(clock()).toISOString() });
  }
  async function manual(input = {}) {
    const dueAt = getSettings().nextDueAt;
    const result = runAnalysis ? await runAnalysis({ ...input, trigger: 'manual' }) : null;
    if (result?.outcome === 'success' && dueAt && Date.parse(dueAt) <= clock()) await withSettingsOwner(() => advancePast(dueAt));
    return result;
  }
  async function weekly(input = {}) {
    if (!getSettings().enabled) return Object.freeze({ schemaVersion: 1, trigger: input.trigger === 'catch-up' ? 'catch-up' : 'weekly', outcome: 'disabled' });
    const result = runAnalysis ? await runAnalysis({ ...input, trigger: input.trigger === 'catch-up' ? 'catch-up' : 'weekly' }) : null;
    if (result?.outcome === 'success') {
      await withSettingsOwner(() => {
        const current = getSettings();
        metadata.setTopicAnalysisSettings({ ...current, schemaVersion: 1, revision: current.revision, expectedRevision: current.revision, nextDueAt: current.enabled ? nextAnalysisSlot({ now: clock(), weekday: current.weekday, localTime: current.localTime, timeZone: current.timeZone }) : null, updatedAt: new Date(clock()).toISOString() });
      });
    }
    return result;
  }
  async function startupCatchUp() {
    // Startup can reach catch-up after reconciliation failed. Resolve the same
    // durable Settings owner before consuming a slot or recording its claim.
    const pending = metadata.getPendingAnalysisSettingsUpdate?.();
    if (pending) await resumeSettingsUpdate(pending);
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
  async function updateWithOwner(input = {}) {
    const pending = metadata.getPendingAnalysisSettingsUpdate?.();
    if (pending) {
      if (pending.logicalOperationId !== input.logicalOperationId) throw sourceError('conflict', 'Another unresolved Settings update owns the settings.');
      if (pending.intentDigest !== canonicalJson({ action: 'schedule.update', expectedRevision: input.expectedRevision, settings: input.settings ?? input.schedule ?? {} })) throw sourceError('intent-mismatch', 'Logical operation ID was reused with different Settings intent.');
    }
    return withSettingsOwner(() => update(input));
  }
  return Object.freeze({ getSettings, peekSettings, listOwned, reconcile: () => withSettingsOwner(reconcile), update: updateWithOwner, manual, weekly, startupCatchUp: () => withSettingsOwner(startupCatchUp), nextDueAt: () => getSettings().nextDueAt, operationId: () => randomUUID() });
}
