import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService, runNoteMaintenance } from '../src/plugin-service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { enrollNoteFolderIdentity } from '../src/sources/note-folder-identity.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';

const topicId = 'fictional-existing-topic';
const folderReferenceId = 'fictional-existing-folder';
const sessionReferenceId = 'fictional-existing-primary';
const sessionKey = 'agent:main:fictional-existing-topic';
const sessionId = 'fictional-existing-session';

test('first-live startup serves existing Topics, Notes and exact Conversations without starting deferred capabilities', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'first-live-startup-'));
  const vault = path.join(stateDir, 'vault'); const folder = path.join(vault, 'Projects', 'Fictional');
  let service; let sdkRequests = 0;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'openclaw/plugin-sdk/session-transcript-runtime') { sdkRequests += 1; throw new Error('The native transcript SDK is deliberately unavailable.'); }
    return nextResolve(specifier, context);
  } });
  const nativeJobs = [{ id: 'fictional-existing-automation', configRevision: 'unchanged-native-revision', enabled: true }];
  const originalJobs = structuredClone(nativeJobs);
  try {
    await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'Overview.md'), '# Fictional Topic\nExisting readable content.\n');
    const seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
    try {
      seed.createTopic({ topicId, name: 'Fictional Topic', paraCategory: 'project', lifecycle: 'active' });
      seed.createSourceReference({ version: 1, referenceId: folderReferenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
      seed.setSourceLocator({ referenceId: folderReferenceId, locator: folder, ownership: 'external', observedRevision: await enrollNoteFolderIdentity(folder) });
      seed.createSourceReference({ version: 1, referenceId: sessionReferenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
      seed.setSessionState({ referenceId: sessionReferenceId, sessionId, status: 'open', isPrimary: true });
    } finally { seed.close(); }
    const forbidden = label => () => { assert.fail(`Deferred ${label} capability was used during core startup.`); };
    const api = {
      runtime: {
        state: { resolveStateDir: () => stateDir },
        agent: { session: { listSessionEntries: () => [{ sessionKey, entry: { sessionId, updatedAt: 1 } }] } },
        gateway: { request: forbidden('Gateway'), isAvailable: forbidden('Gateway availability') },
        get events() { return forbidden('transcript event subscription')(); }
      },
      get notifications() { return forbidden('notifications')(); },
      // A previous broad-release configuration cannot turn deferred features on.
      pluginConfig: { topics: { noteRoot: vault }, sourceCapabilities: { notes: true, sessions: true, scheduler: true, search: true, analysis: true, attention: true } },
      logger: { warn() {} }
    };
    t.mock.method(globalThis, 'setInterval', forbidden('periodic work'));
    service = createMetadataService(api, { notificationEmitter: new Proxy({}, { get: forbidden('notification emitter') }), searchRebuildServiceFactory: forbidden('Search factory'), topicAnalyzerFactory: forbidden('Analysis factory') });
    await service.start({ getCron: forbidden('native Cron') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sdkRequests, 0, 'core startup must not load the history/index transcript runtime');
    for (const name of ['attentionService', 'maintenanceService', 'searchService', 'searchRebuildService', 'dashboardService', 'notificationService', 'topicAnalysisRunner', 'topicAnalysisSchedule', 'topicReview']) assert.equal(service[name], undefined, name);
    assert.equal(service.topicService.listDestination().activeGroups.project[0].topicId, topicId);
    const note = await service.sourceService.notesRead({ schemaVersion: 1, topicId, path: 'Overview.md' });
    assert.equal(note.text, '# Fictional Topic\nExisting readable content.\n');
    const conversation = await service.sourceService.sessionsNavigate({ schemaVersion: 1, topicId, referenceId: sessionReferenceId });
    assert.equal(conversation.sessionKey, sessionKey); assert.equal(conversation.sessionId, sessionId);
    await assert.rejects(service.sourceService.sessionsHistory({ schemaVersion: 1, topicId, referenceId: sessionReferenceId, limit: 10 }), /native transcript SDK is deliberately unavailable/);
    assert.equal(sdkRequests, 1, 'a requested history read must load its real runtime or report failure, never fake empty history');
    for (const name of ['scheduler', 'search', 'analysis', 'attention']) assert.equal(service.sourceService.capabilities[name].available, false);
    assert.deepEqual(nativeJobs, originalJobs);
    for (const invoke of [() => service.topicAnalysisRun({}), () => service.topicContextRetrieve({}), () => service.notificationReconcile({}), () => runNoteMaintenance({})]) assert.throws(invoke, error => error.code === 'capability-unavailable');
    await assert.rejects(service.dashboardGet({}), error => error.code === 'capability-unavailable');
    await assert.rejects(service.searchRebuild({}), error => error.code === 'capability-unavailable');
    const reopened = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
    try { assert.equal(reopened.getTopicAnalysisSettings(), null); assert.equal(reopened.getTopic(topicId).revision, 0); } finally { reopened.close(); }
  } finally { await service?.stop(); hooks.deregister(); await rm(stateDir, { recursive: true, force: true }); }
});

test('first-live recovery-only startup preserves refused metadata and exposes a clear core recovery status', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'first-live-refused-'));
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  let service;
  try {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE future_owner (value TEXT); INSERT INTO future_owner VALUES ('fictional untouched data'); PRAGMA user_version=99;"); database.close();
    const before = await readFile(databasePath); const entries = await readdir(path.dirname(databasePath));
    service = createMetadataService({ runtime: { state: { resolveStateDir: () => stateDir } }, pluginConfig: {}, logger: {} });
    const result = await service.start({ getCron() { assert.fail('Recovery opened Cron.'); } });
    assert.equal(result.mode, 'recovery-only'); assert.ok(result.diagnostics.length > 0);
    assert.equal(service.sourceService.status().metadataSchemaVersion, null);
    assert.deepEqual(service.topicService.listDestination().activeGroups, { project: [], area: [], resource: [] });
    assert.throws(() => service.sourceService.notesRead({ topicId, path: 'Overview.md' }), error => error.code === 'recovery-only');
    for (const name of ['attentionService', 'searchService', 'dashboardService', 'notificationService', 'topicAnalysisSchedule']) assert.equal(service[name], undefined);
    await service.stop();
    assert.deepEqual(await readFile(databasePath), before); assert.deepEqual(await readdir(path.dirname(databasePath)), entries);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('first-live startup retains required existing-data bootstrap failures instead of claiming an empty successful import', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'first-live-bootstrap-'));
  let service;
  try {
    const api = { runtime: { state: { resolveStateDir: () => stateDir } }, logger: {}, pluginConfig: { legacyDiscordMigration: { schemaVersion: 1, exportPath: path.join(stateDir, 'missing-fictional-export.json'), channels: [{ channelId: 'fictional-channel', topicId, paraCategory: 'project', noteFolderPath: path.join(stateDir, 'existing-folder') }] } } };
    service = createMetadataService(api);
    const result = await service.start();
    assert.equal(result.enabled, true); assert.equal(result.complete, false); assert.equal(result.phase, 'review'); assert.ok(result.failures.length > 0);
    await service.stop();
    service = createMetadataService(api);
    const resumed = await service.start();
    assert.equal(resumed.complete, false); assert.equal(resumed.phase, 'review');
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    try { assert.equal(metadata.getMigrationState().phase, 'review'); assert.equal(metadata.getMigrationCompletion(), null); assert.equal(metadata.getTopic(topicId), null); } finally { metadata.close(); }
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});
