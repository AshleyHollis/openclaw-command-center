import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicAnalysisRunner } from '../src/topics/analysis-runner.mjs';
import { createTopicAnalysisScheduleService, nextAnalysisSlot, topicAnalysisCronDeclaration, TOPIC_ANALYSIS_SCHEDULE_KEY } from '../src/topics/analysis-schedule.mjs';

const monday = '2026-08-24T07:00:00.000Z';
const uuid = '71111111-1111-4111-8111-111111111111';

function fakeMetadata() {
  let settings;
  const operations = new Map();
  return {
    getTopicAnalysisSettings: () => settings,
    setTopicAnalysisSettings(input) {
      if (settings && input.expectedRevision !== settings.revision) throw Object.assign(new Error('stale'), { code: 'conflict' });
      settings = { ...input, settingsId: 'global', revision: input.revision ?? (settings?.revision ?? 0) + 1, initialized: input.initialized ?? true };
      return settings;
    },
    getOperation: (id) => operations.get(id) ?? null,
    recordOperation(input) { operations.set(input.logicalOperationId, input); return input; }
  };
}

test('Topic Analysis defaults to Monday at quiet-hours end and calculates the next real slot', () => {
  assert.equal(nextAnalysisSlot({ now: '2026-08-23T06:59:00Z', weekday: 1, localTime: '07:00', timeZone: 'UTC' }), monday);
  assert.equal(nextAnalysisSlot({ now: '2026-08-24T07:00:00Z', weekday: 1, localTime: '07:00', timeZone: 'UTC' }), '2026-08-31T07:00:00.000Z');
});

test('schedule edits are revision checked, preserve manual timing, and reconcile one exact Cron declaration', async () => {
  const metadata = fakeMetadata(); const calls = []; let runCount = 0;
  const gateway = { async request(method, input) {
    calls.push([method, input]);
    if (method === 'cron.list') return { jobs: [] };
    if (method === 'cron.add') return { id: 'cron-fictional', declarationKey: TOPIC_ANALYSIS_SCHEDULE_KEY, enabled: true, schedule: input.schedule, sessionTarget: input.sessionTarget, wakeMode: input.wakeMode, payload: input.payload, delivery: input.delivery, configRevision: 'cron-r1' };
    throw new Error(`unexpected ${method}`);
  } };
  const service = createTopicAnalysisScheduleService({ metadata, gateway, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-23T06:59:00Z'), runAnalysis: async (input) => { runCount += 1; return input; } });
  const initial = service.getSettings();
  assert.deepEqual({ enabled: initial.enabled, weekday: initial.weekday, localTime: initial.localTime, timeZone: initial.timeZone, nextDueAt: initial.nextDueAt }, { enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', nextDueAt: monday });
  const declaration = topicAnalysisCronDeclaration(initial);
  assert.deepEqual(declaration.schedule, { kind: 'cron', expr: '0 7 * * 1', tz: 'UTC', staggerMs: 0 });
  assert.equal(declaration.sessionTarget, 'isolated'); assert.deepEqual(declaration.delivery, { mode: 'none' }); assert.deepEqual(declaration.payload, { kind: 'systemEvent', text: 'Run the command_center_topic_analysis tool exactly once.' });
  await service.reconcile();
  assert.equal(calls.filter(([method]) => method === 'cron.add').length, 1);
  await service.manual({ logicalOperationId: uuid });
  assert.equal(runCount, 1); assert.equal(service.getSettings().nextDueAt, monday);
  const edited = await service.update({ schemaVersion: 1, logicalOperationId: 'edit-schedule', expectedRevision: initial.revision, settings: { weekday: 3, localTime: '08:15' } });
  assert.equal(edited.settings.weekday, 3); assert.equal(edited.settings.localTime, '08:15'); assert.equal(edited.settings.nextDueAt, '2026-08-26T08:15:00.000Z');
  await assert.rejects(service.update({ schemaVersion: 1, logicalOperationId: 'stale-schedule', expectedRevision: initial.revision, settings: { localTime: '09:00' } }), (error) => error.code === 'conflict');
});

test('startup claims at most one catch-up and a post-miss manual success satisfies the missed slot', async () => {
  const metadata = fakeMetadata(); metadata.listTopicAnalysisRuns = () => [];
  let runs = 0; const clock = Date.parse('2026-08-24T09:00:00Z');
  metadata.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1, nextDueAt: monday, initialized: true, updatedAt: '2026-08-23T00:00:00Z' });
  const service = createTopicAnalysisScheduleService({ metadata, now: () => clock, runAnalysis: async ({ trigger }) => { runs += 1; return { outcome: 'success', trigger }; } });
  assert.equal((await service.startupCatchUp()).trigger, 'catch-up');
  assert.equal((await service.startupCatchUp()).outcome, 'not-due');
  assert.equal(runs, 1);

  const second = fakeMetadata(); second.listTopicAnalysisRuns = () => [];
  second.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1, nextDueAt: monday, initialized: true, updatedAt: '2026-08-23T00:00:00Z' });
  const manual = createTopicAnalysisScheduleService({ metadata: second, now: () => clock, runAnalysis: async ({ trigger }) => ({ outcome: 'success', trigger }) });
  await manual.manual({}); assert.equal((await manual.startupCatchUp()).outcome, 'not-due');
});

test('disabled weekly and catch-up calls do not run while manual analysis remains available', async () => {
  const metadata = fakeMetadata(); let runCount = 0;
  const service = createTopicAnalysisScheduleService({ metadata, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-24T09:00:00Z'), runAnalysis: async (input) => { runCount += 1; return input; } });
  const initial = service.getSettings();
  await service.update({ schemaVersion: 1, logicalOperationId: 'disable-schedule', expectedRevision: initial.revision, settings: { enabled: false } });
  assert.equal((await service.weekly({ trigger: 'weekly' })).outcome, 'disabled');
  assert.equal((await service.weekly({ trigger: 'catch-up' })).outcome, 'disabled');
  await service.manual({});
  assert.equal(runCount, 1);
});

test('successful weekly analysis advances the next slot while disabled analysis keeps it empty', async () => {
  const metadata = fakeMetadata(); const service = createTopicAnalysisScheduleService({ metadata, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-24T09:00:00Z'), runAnalysis: async () => ({ outcome: 'success' }) });
  const initial = service.getSettings();
  await service.weekly({ trigger: 'weekly' });
  assert.equal(service.getSettings().nextDueAt, '2026-08-31T07:00:00.000Z');
  await service.update({ schemaVersion: 1, logicalOperationId: 'disable-after-weekly', expectedRevision: service.getSettings().revision, settings: { enabled: false } });
  assert.equal(service.getSettings().nextDueAt, null);
  assert.ok(initial.nextDueAt);
});

test('Cron reconciliation fails closed when the owned declaration omits its configuration revision', async () => {
  const metadata = fakeMetadata(); let declaration;
  const gateway = { async request(method) {
    if (method === 'cron.list') return { jobs: [{ id: 'cron-fictional', declarationKey: TOPIC_ANALYSIS_SCHEDULE_KEY, enabled: true, schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery }] };
    throw new Error(`unexpected ${method}`);
  } };
  const service = createTopicAnalysisScheduleService({ metadata, gateway, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-23T06:59:00Z') });
  declaration = topicAnalysisCronDeclaration(service.getSettings());
  await assert.rejects(service.reconcile(), (error) => error.code === 'conflict');
});

test('analysis runner coalesces overlapping manual and weekly triggers into one run', async () => {
  let active = 0; let maximum = 0; let calls = 0;
  const metadata = { getTopicAnalysisSettings: () => null, listTopicAnalysisRuns: () => [{ outcome: 'success' }], getTopicAnalysisCursor: () => null, recordTopicAnalysisRun: () => {}, listTopicAnalysisWatermarks: () => [], listTopics: () => [{ topicId: 'topic-serial', lifecycle: 'active', paraCategory: 'area', revision: 1 }], listSourceReferences: () => [], setTopicAnalysisWatermarks: () => [], setTopicAnalysisCursor: () => null, getTopicProposal: () => null, saveTopicProposal: () => null, setTopicAnalysisEvidence: () => [], recordActivity: () => {} };
  const runner = createTopicAnalysisRunner({ metadata, analyzer: async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; calls += 1; return []; } });
  const results = await Promise.all([runner.run({ trigger: 'manual' }), runner.run({ trigger: 'weekly' })]);
  assert.deepEqual(results.map((item) => item.outcome), ['success', 'success']); assert.equal(results[0].runId, results[1].runId); assert.equal(maximum, 1); assert.equal(calls, 1);
});
