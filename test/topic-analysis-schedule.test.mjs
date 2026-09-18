import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionService } from '../src/attention/service.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { createTopicAnalysisProvider } from '../src/topics/analysis-provider.mjs';
import { createTopicAnalysisRunner } from '../src/topics/analysis-runner.mjs';
import { createTopicAnalysisScheduleService, nextAnalysisSlot, topicAnalysisCronDeclaration, TOPIC_ANALYSIS_SCHEDULE_KEY } from '../src/topics/analysis-schedule.mjs';
import { durableFictionalCron, interruptedSettingsInput } from './fixtures/analysis-settings-process-death.mjs';

const monday = '2026-08-24T07:00:00.000Z';
const uuid = '71111111-1111-4111-8111-111111111111';

function fakeCron() {
  let job;
  let revision = 0;
  return {
    async list() { return job ? [structuredClone(job)] : []; },
    async add(input) { job = { ...input, id: 'cron-fictional', configRevision: `cron-r${++revision}` }; return structuredClone(job); },
    async update(id, patch, { expectedConfigRevision }) {
      assert.equal(id, job.id);
      assert.equal(expectedConfigRevision, job.configRevision);
      job = { ...job, ...patch, configRevision: `cron-r${++revision}` };
      return structuredClone(job);
    }
  };
}

async function storedMetadata(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-schedule-owner-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { metadata, stateDir };
}

test('an interrupted Settings update resumes its exact saved revision and intent after reopening SQLite', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-schedule-retry-'));
  let metadata = openCommandCenterMetadataService({ stateDir });
  const cron = fakeCron();
  const update = cron.update;
  let fail = true;
  cron.update = async (...args) => { if (fail) throw new Error('Fictional scheduler unavailable'); return update(...args); };
  try {
    const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-08-23T06:59:00Z') });
    const initial = service.getSettings();
    await service.reconcile();
    const input = { schemaVersion: 1, logicalOperationId: uuid, expectedRevision: initial.revision, settings: { weekday: 3, localTime: '08:15' } };
    await assert.rejects(service.update(input), /Fictional scheduler unavailable/);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir });
    const reopened = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-09-06T00:00:00Z') });
    fail = false;
    const result = await reopened.update(input);
    assert.equal(result.settings.revision, initial.revision + 1);
    assert.equal(result.settings.nextDueAt, '2026-08-26T08:15:00.000Z');
    assert.equal(result.job.schedule.expr, '15 8 * * 3');
    assert.deepEqual(await reopened.update(input), result);
    assert.equal(metadata.getTopicAnalysisSettings().revision, initial.revision + 1);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('startup preserves a missed catch-up while pending Settings cannot reach Cron, then runs it once after recovery', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-schedule-catch-up-retry-'));
  let metadata = openCommandCenterMetadataService({ stateDir });
  const cron = fakeCron(); const update = cron.update;
  let unavailable = false; let runs = 0;
  cron.update = async (...args) => { if (unavailable) throw new Error('Fictional scheduler unavailable'); return update(...args); };
  try {
    const initial = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-08-23T06:59:00Z') });
    await initial.reconcile();
    unavailable = true;
    await assert.rejects(initial.update({ schemaVersion: 1, logicalOperationId: uuid, expectedRevision: initial.getSettings().revision, settings: { weekday: 3, localTime: '08:15' } }), /Fictional scheduler unavailable/);
    const pendingSettings = metadata.getTopicAnalysisSettings();
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir });
    const restarted = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-08-27T09:00:00Z'), runAnalysis: async ({ trigger }) => { runs += 1; return { outcome: 'success', trigger }; } });
    await assert.rejects(restarted.reconcile(), /Fictional scheduler unavailable/);
    await assert.rejects(restarted.startupCatchUp());
    assert.deepEqual(metadata.getTopicAnalysisSettings(), pendingSettings);
    assert.equal(metadata.listOperations().filter((operation) => operation.operationKind === 'topic-analysis.catch-up.claim').length, 0);
    assert.equal(runs, 0);
    unavailable = false;
    assert.equal((await restarted.startupCatchUp()).trigger, 'catch-up');
    assert.equal((await restarted.startupCatchUp()).outcome, 'not-due');
    assert.equal(runs, 1);
    assert.equal(metadata.getPendingAnalysisSettingsUpdate(), null);
    assert.equal(JSON.parse(metadata.getOperation(uuid).resultIdentity).settings.revision, pendingSettings.revision);
    assert.deepEqual(metadata.listOperations().filter((operation) => operation.operationKind === 'topic-analysis.catch-up.claim').map((operation) => operation.state), ['applied']);
    assert.equal(restarted.getSettings().nextDueAt, '2026-09-02T08:15:00.000Z');
    assert.equal((await cron.list())[0].schedule.expr, '15 8 * * 3');
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('one pending global Settings intent fences competing connections and altered retries', async (t) => {
  const { metadata, stateDir } = await storedMetadata(t);
  const second = openCommandCenterMetadataService({ stateDir });
  t.after(() => second.close());
  const cron = fakeCron();
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const write = cron.update;
  cron.update = async (...args) => { entered.resolve(); await release.promise; return write(...args); };
  const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron });
  const initial = service.getSettings(); await service.reconcile();
  const input = { schemaVersion: 1, logicalOperationId: uuid, expectedRevision: initial.revision, settings: { localTime: '08:15' } };
  const first = service.update(input);
  try {
    await entered.promise;
    const competing = createTopicAnalysisScheduleService({ metadata: second, getCron: () => cron });
    await assert.rejects(competing.update({ ...input, settings: { localTime: '09:00' } }), (error) => error.code === 'intent-mismatch');
    await assert.rejects(competing.update({ ...input, logicalOperationId: 'fictional-competing', expectedRevision: initial.revision + 1 }), (error) => error.code === 'conflict');
    assert.throws(() => second.setTopicAnalysisSettings({ ...second.getTopicAnalysisSettings(), expectedRevision: initial.revision + 1, nextDueAt: null }), (error) => error.code === 'conflict');
    const owner = second.getPendingAnalysisSettingsUpdate();
    const frozen = JSON.parse(owner.resultIdentity);
    assert.throws(() => second.completeAnalysisSettingsUpdate({ logicalOperationId: uuid, intentDigest: owner.intentDigest, result: { ...frozen, schemaVersion: undefined, job: {} } }), (error) => error.code === 'invalid-value');
    assert.throws(() => second.completeAnalysisSettingsUpdate({ logicalOperationId: uuid, intentDigest: owner.intentDigest, result: { settings: frozen.settings, declaration: frozen.declaration, job: { ...frozen.declaration, id: 'fictional-forged', configRevision: 'fictional-r1', enabled: !frozen.settings.enabled } } }), (error) => error.code === 'source-recovery');
    const same = service.update(input);
    release.resolve();
    assert.deepEqual(await same, await first);
    assert.equal(second.getTopicAnalysisSettings().revision, initial.revision + 1);
    assert.equal(second.getPendingAnalysisSettingsUpdate(), null);
  } finally { release.resolve(); await first.catch(() => {}); }
});

test('a queued old startup Cron add cannot overwrite newer Settings from another owner', async (t) => {
  const { metadata, stateDir } = await storedMetadata(t);
  const second = openCommandCenterMetadataService({ stateDir });
  t.after(() => second.close());
  const cron = fakeCron();
  const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron });
  const initial = service.getSettings();
  const add = cron.add;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  cron.add = async (input) => { entered.resolve(); await release.promise; return add(input); };
  const older = service.reconcile();
  let pending;
  try {
    await entered.promise;
    const newer = createTopicAnalysisScheduleService({ metadata: second, getCron: () => cron });
    pending = newer.update({ schemaVersion: 1, logicalOperationId: uuid, expectedRevision: initial.revision, settings: { localTime: '08:15' } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(second.getTopicAnalysisSettings().revision, initial.revision);
    assert.deepEqual(await cron.list(), []);
    release.resolve(); await older;
    const updated = await pending;
    assert.equal(updated.settings.localTime, '08:15');
    assert.equal(updated.job.configRevision, 'cron-r2');
    assert.deepEqual((await cron.list())[0], updated.job);
  } finally { release.resolve(); await older.catch(() => {}); await pending?.catch(() => {}); }
});

for (const phase of ['before-effect', 'after-effect']) test(`Settings startup recovers actual process death ${phase} without a duplicate revision or Cron write`, { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-settings-kill-'));
  let metadata = openCommandCenterMetadataService({ stateDir });
  let child;
  let exited;
  let deadline;
  let recovery;
  try {
    const cron = durableFictionalCron(stateDir);
    const initial = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-08-23T06:59:00Z') });
    await initial.reconcile();
    metadata.close();
    child = fork(new URL('./fixtures/analysis-settings-process-death.mjs', import.meta.url), [stateDir, phase], { execArgv: [...process.execArgv, '--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const boundary = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`Fixture missed its kill boundary: ${errors}`)), 10_000);
      child.once('message', (message) => { if (message.phase === phase && message.gcForced === true) resolve(); else reject(new Error('Wrong fixture boundary or missing GC proof')); });
      child.once('exit', () => reject(new Error(`Fixture exited before kill boundary: ${errors}`)));
    });
    await boundary;
    metadata = openCommandCenterMetadataService({ stateDir });
    const restarted = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-09-06T00:00:00Z') });
    let returned = false;
    recovery = restarted.reconcile().finally(() => { returned = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(returned, false, 'A second process must not resume while the original Cron writer is still alive.');
    child.kill('SIGKILL');
    assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    const result = await recovery;
    const replay = await restarted.update(interruptedSettingsInput);
    assert.deepEqual(replay, result);
    assert.equal(result.settings.revision, 2);
    assert.equal(result.settings.nextDueAt, '2026-08-26T08:15:00.000Z');
    assert.equal(result.job.configRevision, 'fictional-2');
    assert.equal(result.job.schedule.expr, '15 8 * * 3');
    assert.equal(metadata.getPendingAnalysisSettingsUpdate(), null);
    assert.equal((await stat(path.join(path.dirname(metadata.databasePath), 'analysis-settings-coordinator.sqlite'))).size, 0);
    assert.deepEqual((await cron.list())[0], result.job);
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await recovery?.catch(() => {});
    metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Settings and pending intent roll back together when their closed declaration is refused', async (t) => {
  const { metadata } = await storedMetadata(t);
  const service = createTopicAnalysisScheduleService({ metadata });
  const initial = service.getSettings();
  const next = { ...initial, expectedRevision: initial.revision, revision: initial.revision + 1, localTime: '08:15' };
  assert.throws(() => metadata.beginAnalysisSettingsUpdate({ logicalOperationId: uuid, intentDigest: 'fictional-invalid-declaration', settings: next, declaration: { ...topicAnalysisCronDeclaration(next), unexpected: 'not-admitted' } }), (error) => error.code === 'invalid-value');
  assert.deepEqual(metadata.getTopicAnalysisSettings(), initial);
  assert.equal(metadata.getOperation(uuid), null);
});

test('analysis provider waits for its completed downstream projection', async () => {
  let releaseProjection;
  const projection = new Promise((resolve) => { releaseProjection = resolve; });
  let returned = false;
  const provider = createTopicAnalysisProvider({
    getRunner: () => ({ run: async () => ({ runId: 'analysis-projection-order', outcome: 'success' }) }),
    metadata: { listTopicAnalysisRuns: () => [] },
    onCompleted: () => projection
  });
  const pending = provider.run({ topicId: 'topic-projection-order' }).then((result) => { returned = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  releaseProjection();
  assert.equal((await pending).analysisId, 'analysis-projection-order');
});

test('Topic Analysis defaults to Monday at quiet-hours end and calculates the next real slot', () => {
  assert.equal(nextAnalysisSlot({ now: '2026-08-23T06:59:00Z', weekday: 1, localTime: '07:00', timeZone: 'UTC' }), monday);
  assert.equal(nextAnalysisSlot({ now: '2026-08-24T07:00:00Z', weekday: 1, localTime: '07:00', timeZone: 'UTC' }), '2026-08-31T07:00:00.000Z');
});

test('schedule edits are revision checked, preserve manual timing, and reconcile one exact Cron declaration', async (t) => {
  const { metadata } = await storedMetadata(t); const cron = fakeCron(); let runCount = 0;
  const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-23T06:59:00Z'), runAnalysis: async (input) => { runCount += 1; return input; } });
  const initial = service.getSettings();
  assert.deepEqual({ enabled: initial.enabled, weekday: initial.weekday, localTime: initial.localTime, timeZone: initial.timeZone, nextDueAt: initial.nextDueAt }, { enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', nextDueAt: monday });
  const declaration = topicAnalysisCronDeclaration(initial);
  assert.deepEqual(declaration.schedule, { kind: 'cron', expr: '0 7 * * 1', tz: 'UTC', staggerMs: 0 });
  assert.equal(declaration.sessionTarget, 'isolated'); assert.deepEqual(declaration.delivery, { mode: 'none' }); assert.deepEqual(declaration.payload, { kind: 'agentTurn', message: 'Run the command_center_topic_analysis tool exactly once.', toolsAllow: ['command_center_topic_analysis'] });
  await service.reconcile();
  assert.equal((await cron.list()).length, 1);
  await service.manual({ logicalOperationId: uuid });
  assert.equal(runCount, 1); assert.equal(service.getSettings().nextDueAt, monday);
  const edited = await service.update({ schemaVersion: 1, logicalOperationId: 'edit-schedule', expectedRevision: initial.revision, settings: { weekday: 3, localTime: '08:15' } });
  assert.equal(edited.settings.weekday, 3); assert.equal(edited.settings.localTime, '08:15'); assert.equal(edited.settings.nextDueAt, '2026-08-26T08:15:00.000Z');
  await assert.rejects(service.update({ schemaVersion: 1, logicalOperationId: 'stale-schedule', expectedRevision: initial.revision, settings: { localTime: '09:00' } }), (error) => error.code === 'conflict');
});

test('startup claims at most one catch-up and a post-miss manual success satisfies the missed slot', async (t) => {
  const { metadata } = await storedMetadata(t);
  let runs = 0; const clock = Date.parse('2026-08-24T09:00:00Z');
  metadata.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1, nextDueAt: monday, initialized: true, updatedAt: '2026-08-23T00:00:00Z' });
  const service = createTopicAnalysisScheduleService({ metadata, now: () => clock, runAnalysis: async ({ trigger }) => { runs += 1; return { outcome: 'success', trigger }; } });
  assert.equal((await service.startupCatchUp()).trigger, 'catch-up');
  assert.equal((await service.startupCatchUp()).outcome, 'not-due');
  assert.equal(runs, 1);

  const { metadata: second } = await storedMetadata(t);
  second.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1, nextDueAt: monday, initialized: true, updatedAt: '2026-08-23T00:00:00Z' });
  const manual = createTopicAnalysisScheduleService({ metadata: second, now: () => clock, runAnalysis: async ({ trigger }) => ({ outcome: 'success', trigger }) });
  await manual.manual({}); assert.equal((await manual.startupCatchUp()).outcome, 'not-due');
});

test('disabled weekly and catch-up calls do not run while manual analysis remains available', async (t) => {
  const { metadata } = await storedMetadata(t); let runCount = 0;
  const cron = fakeCron();
  const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-24T09:00:00Z'), runAnalysis: async (input) => { runCount += 1; return input; } });
  const initial = service.getSettings();
  await service.update({ schemaVersion: 1, logicalOperationId: 'disable-schedule', expectedRevision: initial.revision, settings: { enabled: false } });
  assert.equal((await service.weekly({ trigger: 'weekly' })).outcome, 'disabled');
  assert.equal((await service.weekly({ trigger: 'catch-up' })).outcome, 'disabled');
  await service.manual({});
  assert.equal(runCount, 1);
});

test('successful weekly analysis advances the next slot while disabled analysis keeps it empty', async (t) => {
  const cron = fakeCron();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-analysis-settings-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  t.after(async () => { metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-24T09:00:00Z'), runAnalysis: async () => ({ outcome: 'success' }) });
  const initial = service.getSettings();
  await service.weekly({ trigger: 'weekly' });
  assert.equal(service.getSettings().nextDueAt, '2026-08-31T07:00:00.000Z');
  await service.update({ schemaVersion: 1, logicalOperationId: 'disable-after-weekly', expectedRevision: service.getSettings().revision, settings: { enabled: false } });
  assert.equal(service.getSettings().nextDueAt, null);
  assert.ok(initial.nextDueAt);
});

test('Cron reconciliation fails closed when the owned declaration omits its configuration revision', async (t) => {
  const { metadata } = await storedMetadata(t); let declaration;
  const cron = { async list() { return [{ ...declaration, id: 'cron-fictional' }]; } };
  const service = createTopicAnalysisScheduleService({ metadata, getCron: () => cron, notificationService: { getSettings: () => ({ quietHoursEnd: '07:00', timeZone: 'UTC' }) }, now: () => Date.parse('2026-08-23T06:59:00Z') });
  declaration = topicAnalysisCronDeclaration(service.getSettings());
  await assert.rejects(service.reconcile(), (error) => error.code === 'conflict');
});

for (const locatorRevision of [null, 'fs:fictional-verified-note-folder']) test(`deferred analysis owner coalesces and replays with ${locatorRevision ? 'verified locator' : 'source reference'} revision`, async () => {
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
    if (locatorRevision) metadata.setSourceLocator({ referenceId: sourceId, locator: 'fictional-note-folder', observedRevision: locatorRevision });
    metadata.createTopic({ topicId: 'topic-foreign', name: 'Fictional foreign analysis', lifecycle: 'active', paraCategory: 'area', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-foreign', topicId: 'topic-foreign', sourceSystem: 'fictional', sourceKind: 'record', externalSourceId: 'fictional-foreign-record', observedRevision: 'fictional-foreign-r1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
    metadata.recordTopicAnalysisRun({ runId: 'fictional-serial-prior', schemaVersion: 1, trigger: 'manual', outcome: 'success', baselineCursor: { nextTopicId: null, nextSourceId: null }, successCursor: { nextTopicId: null, nextSourceId: null }, changedCount: 0, evaluatedCount: 0, proposalCount: 0, retainedOverflowCount: 0, startedAt: '2026-08-21T00:00:00.000Z', finishedAt: '2026-08-21T00:00:01.000Z' });
    const runner = createTopicAnalysisRunner({ metadata, analyzer: async ({ topic }) => { calls += 1; analyzedTopicIds.push(topic.topicId); analysisEntered(); await released; return []; } });
    const analysisProvider = createTopicAnalysisProvider({ getRunner: () => runner, metadata });
    const attentionService = createAttentionService({ metadata });
    const source = createAuthoritativeSourceService({ metadata, capabilities, analysisProvider, attentionService });
    let sequence = 0;
    const request = async (logicalOperationId) => {
      sequence += 1;
      const result = await invokeBridgeMethod(source, 'command-center.v1.analysis.run', { schemaVersion: 1, topicId, input: {}, logicalOperationId }, `fictional-analysis-request-${sequence}`);
      return { result };
    };
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
    assert.deepEqual({ outcome: activity.outcome, topicId: activity.topicId, sourceReferenceId: activity.sourceReferenceId, verificationRevision: activity.verificationRevision }, { outcome: 'applied', topicId, sourceReferenceId: sourceId, verificationRevision: locatorRevision ?? 'fictional-serial-r1' });
    assert.equal(metadata.getSourceReference(sourceId).observedRevision, 'fictional-serial-r1', 'verification must not overwrite the durable source ownership revision');
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
