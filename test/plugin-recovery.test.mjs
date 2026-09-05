import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService } from '../src/plugin-service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { registerBridgeMethods } from '../src/bridge/register.mjs';

test('recovery-only startup preserves refused storage and serves safe status without starting writable consumers', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-recovery-start-'));
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const seed = new DatabaseSync(databasePath);
  seed.exec("CREATE TABLE future_owner (value TEXT); INSERT INTO future_owner VALUES ('fictional untouched data'); PRAGMA user_version=99;");
  seed.close();
  const before = await readFile(databasePath);
  const beforeEntries = await readdir(path.dirname(databasePath));
  let gatewayCalls = 0;
  const service = createMetadataService({ runtime: { state: { resolveStateDir: () => stateDir }, gateway: { request() { gatewayCalls += 1; throw new Error('Recovery must not dispatch Gateway work'); } } }, pluginConfig: {}, logger: { warn() {} } }, { searchRebuildServiceFactory() { throw new Error('Recovery must not start Search'); } });
  try {
    await service.start();
    assert.equal(service.sourceService.status().mode, 'recovery-only');
    assert.equal(service.sourceService.status().metadataSchemaVersion, null, 'unrecognized database identity must not be projected as a trusted schema');
    assert.ok(service.sourceService.status().diagnostics.length > 0);
    assert.deepEqual(service.topicService.listDestinationVerified().activeGroups, { project: [], area: [], resource: [] });
    assert.deepEqual((await service.dashboardGet({ schemaVersion: 1 })).attention, []);
    assert.deepEqual(service.topicAnalysisRead(), { schemaVersion: 1, schedule: null, runs: [], review: null });
    for (const unavailable of ['attentionService', 'searchService', 'searchRebuildService', 'notificationService', 'topicAnalysisRunner', 'maintenanceService']) assert.equal(service[unavailable], undefined);
    const methods = new Map();
    registerBridgeMethods({ registerGatewayMethod: (name, handler) => methods.set(name, handler) }, { status: () => service.sourceService.status(), topics: service.topicService, dashboardGet: (input) => service.dashboardGet(input), attentionAct: (input) => service.sourceService.attentionAct(input) });
    const invoke = async (method, params) => { let reply; await methods.get(method)({ req: { id: 'fictional-read' }, params, client: { authenticatedOperatorId: 'fictional-operator' }, context: { authenticated: true }, respond: (...args) => { reply = args; } }); return reply; };
    assert.equal((await invoke('command-center.v1.sources.status', { schemaVersion: 1 }))[1].result.mode, 'recovery-only');
    const dashboard = await invoke('command-center.v1.dashboard.get', { schemaVersion: 1, activityOffset: 0, activityLimit: 50 });
    assert.equal(dashboard[0], true, JSON.stringify(dashboard));
    const blocked = await invoke('command-center.v1.attention.act', { schemaVersion: 1, logicalOperationId: '11111111-1111-4111-8111-111111111111', episodeId: 'fictional-episode', expectedEpisodeRevision: 1, expectedSourceRevision: '1', topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', actionId: 'reminder.complete', input: { expectedConfigRevision: '1' } });
    assert.equal(blocked[0], false);
    assert.equal(blocked[2].code, 'recovery-only');
    for (const operation of [() => service.topicService.create({}), () => service.sourceService.notesCreate({}), () => service.dashboardUpdateSettings({}), () => service.topicAnalysisRun({})]) assert.throws(operation, (error) => error.code === 'recovery-only');
    await assert.rejects(service.searchRebuild({}), (error) => error.code === 'recovery-only');
    assert.equal(gatewayCalls, 0);
  } finally {
    await service.stop();
    assert.deepEqual(await readFile(databasePath), before);
    assert.deepEqual(await readdir(path.dirname(databasePath)), beforeEntries);
    await rm(stateDir, { recursive: true, force: true });
  }
});
