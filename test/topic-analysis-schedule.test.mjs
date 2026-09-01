import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionService } from '../src/attention/service.mjs';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { createTopicAnalysisProvider } from '../src/topics/analysis-provider.mjs';
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

test('registered analysis bridge deterministically coalesces reversed completion and replays the durable run', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-analysis-bridge-'));
  const topicId = 'topic-serial';
  const sourceId = 'source-serial';
  const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, search: true, analysis: true, attention: true };
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  let releaseAnalysis;
  let analysisEntered;
  const entered = new Promise((resolve) => { analysisEntered = resolve; });
  const released = new Promise((resolve) => { releaseAnalysis = resolve; });
  let calls = 0;
  const analyzedTopicIds = [];
  try {
    metadata.createTopic({ topicId, name: 'Fictional serialized analysis', lifecycle: 'active', paraCategory: 'area', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    metadata.createSourceReference({ version: 1, referenceId: sourceId, topicId, sourceSystem: 'fictional', sourceKind: 'record', externalSourceId: 'fictional-serial-record', observedRevision: 'fictional-serial-r1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    metadata.createTopic({ topicId: 'topic-foreign', name: 'Fictional foreign analysis', lifecycle: 'active', paraCategory: 'area', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-foreign', topicId: 'topic-foreign', sourceSystem: 'fictional', sourceKind: 'record', externalSourceId: 'fictional-foreign-record', observedRevision: 'fictional-foreign-r1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    metadata.recordTopicAnalysisRun({ runId: 'fictional-serial-prior', schemaVersion: 1, trigger: 'manual', outcome: 'success', baselineCursor: { nextTopicId: null, nextSourceId: null }, successCursor: { nextTopicId: null, nextSourceId: null }, changedCount: 0, evaluatedCount: 0, proposalCount: 0, retainedOverflowCount: 0, startedAt: '2026-08-21T00:00:00.000Z', finishedAt: '2026-08-21T00:00:01.000Z' });
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic }) => { calls += 1; analyzedTopicIds.push(topic.topicId); analysisEntered(); await released; return []; } });
    const analysisProvider = createTopicAnalysisProvider({ getRunner: () => runner, metadata });
    const attentionService = createAttentionService({ metadata });
    const source = createAuthoritativeSourceService({ metadata, capabilities, analysisProvider, attentionService });
    const methods = new Map();
    registerBridgeMethods({ registerGatewayMethod(name, handler) { methods.set(name, handler); } }, source);
    let sequence = 0;
    const request = (logicalOperationId) => new Promise((resolve, reject) => {
      sequence += 1;
      methods.get('command-center.v1.analysis.run')({
        req: { id: `fictional-analysis-request-${sequence}` },
        params: { schemaVersion: 1, topicId, input: {}, logicalOperationId },
        context: { authenticated: true },
        respond(ok, result, error) { if (ok) resolve(result); else reject(error); }
      });
    });
    const first = request('71111111-1111-4111-8111-111111111112');
    await entered;
    assert.equal(analysisProvider.reconcile('71111111-1111-4111-8111-111111111112'), null, 'a durable running row must not reconcile as a terminal failure');
    const second = request('71111111-1111-4111-8111-111111111113');
    releaseAnalysis();
    const secondResult = await second;
    const firstResult = await first;
    assert.equal(firstResult.result.value.analysisId, secondResult.result.value.analysisId);
    assert.equal(calls, 1, 'overlapping bridge requests must share the in-flight production run');
    assert.deepEqual(analyzedTopicIds, [topicId], 'authenticated Topic analysis must not inspect a foreign Topic');
    const runId = firstResult.result.value.analysisId;
    const activity = source.activityGet({ activityId: `activity:topic-analysis:${runId}` }).record;
    assert.deepEqual({ outcome: activity.outcome, topicId: activity.topicId, sourceReferenceId: activity.sourceReferenceId, verificationRevision: activity.verificationRevision }, { outcome: 'applied', topicId, sourceReferenceId: sourceId, verificationRevision: 'fictional-serial-r1' });
    const interrupted = metadata.getOperation('71111111-1111-4111-8111-111111111112');
    metadata.recordOperation({ ...interrupted, state: 'pending', resultStatus: 'pending', resultIdentity: null, observedRevision: null, updatedAt: '2026-08-22T00:00:02.000Z' });
    const interruptedInner = metadata.getOperation('analysis-provider:71111111-1111-4111-8111-111111111112');
    metadata.recordOperation({ ...interruptedInner, state: 'pending', resultStatus: 'pending', resultIdentity: null, observedRevision: null, updatedAt: '2026-08-22T00:00:02.000Z' });
    const replay = await request('71111111-1111-4111-8111-111111111112');
    assert.deepEqual(replay.result.value, firstResult.result.value);
    assert.equal(calls, 1, 'post-run interruption replay must recover the inner durable operation without redispatch');
    const interruptedSibling = metadata.getOperation('71111111-1111-4111-8111-111111111113');
    metadata.recordOperation({ ...interruptedSibling, state: 'pending', resultStatus: 'pending', resultIdentity: null, observedRevision: null, updatedAt: '2026-08-22T00:00:03.000Z' });
    const interruptedSiblingInner = metadata.getOperation('analysis-provider:71111111-1111-4111-8111-111111111113');
    metadata.recordOperation({ ...interruptedSiblingInner, state: 'pending', resultStatus: 'pending', resultIdentity: null, updatedAt: '2026-08-22T00:00:03.000Z' });
    const siblingReplay = await request('71111111-1111-4111-8111-111111111113');
    assert.deepEqual(siblingReplay.result.value, secondResult.result.value);
    assert.equal(calls, 1, 'coalesced sibling replay must retain its durable owner-run alias without redispatch');
    source.close();
    attentionService.close();
  } finally {
    releaseAnalysis?.();
    metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
