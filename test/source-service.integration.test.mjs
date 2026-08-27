import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';

const fsSafeRootFactory = async (rootDir) => ({ rootDir, rootReal: rootDir, resolve: async (relative) => path.join(rootDir, relative), open: async (relative) => ({ handle: await (await import('node:fs/promises')).open(path.join(rootDir, relative), 'r') }) });

test('normal metadata listings omit an active configured Topic whose authoritative bindings conflict', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-readiness-list-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    metadata.createTopic({ topicId: 'fictional-topic-conflicting', paraCategory: 'project', lifecycle: 'active' });
    const migration = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname, channels: [{ channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-conflicting', paraCategory: 'project', noteFolderPath: '/fictional/vault/conflicting' }] }, folderVerifier: async (value) => value });
    assert.equal((await migration.start()).complete, false);
    const service = createAuthoritativeSourceService({ metadata, migration, capabilities: { notes: true, sessions: true } });
    assert.deepEqual(service.metadataRead({ schemaVersion: 1 }).topics, []);
    assert.throws(() => service.metadataRead({ schemaVersion: 1, topicId: 'fictional-topic-conflicting' }), (error) => error.code === 'source-recovery');
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-conflicting-folder', topicId: 'fictional-topic-conflicting', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/elsewhere', observedRevision: null });
    assert.throws(() => service.metadataRead({ schemaVersion: 1, topicId: 'fictional-topic-conflicting', referenceId: 'fictional-conflicting-folder' }), (error) => error.code === 'source-recovery');
    assert.throws(() => service.requireTopicService({ topicId: 'fictional-topic-conflicting' }), (error) => error.code === 'source-recovery');
    assert.equal((await service.migrationReview()).actions.length, 2);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('direct normal metadata reads reject a Provisioning Topic even without configured migration', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-provisioning-readiness-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    metadata.createTopic({ topicId: 'fictional-topic-provisioning-direct', paraCategory: 'project', lifecycle: 'provisioning' });
    metadata.createSourceReference({ version: 1, referenceId: 'fictional-provisioning-folder', topicId: 'fictional-topic-provisioning-direct', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/vault/provisioning', observedRevision: null });
    const service = createAuthoritativeSourceService({ metadata, capabilities: { notes: true, sessions: true } });
    assert.throws(() => service.metadataRead({ schemaVersion: 1, topicId: 'fictional-topic-provisioning-direct' }), (error) => error.code === 'source-recovery');
    assert.throws(() => service.metadataRead({ schemaVersion: 1, topicId: 'fictional-topic-provisioning-direct', referenceId: 'fictional-provisioning-folder' }), (error) => error.code === 'source-recovery');
    await assert.rejects(() => service.metadataWrite({ schemaVersion: 1, topicId: 'fictional-topic-provisioning-direct', operation: 'preferences', value: { topicId: 'fictional-topic-provisioning-direct', displayLabel: 'Must not write', sortOrder: 1, collapsed: false, updatedAt: '2026-08-23T00:00:00.000Z' } }), (error) => error.code === 'source-recovery');
    await assert.rejects(() => service.metadataWrite({ schemaVersion: 1, topicId: 'fictional-topic-active-decoy', operation: 'preferences', value: { topicId: 'fictional-topic-provisioning-direct', displayLabel: 'Must not write', sortOrder: 1, collapsed: false, updatedAt: '2026-08-23T00:00:00.000Z' } }), (error) => error.code === 'invalid-request');
    assert.equal(metadata.getPresentationPreferences('fictional-topic-provisioning-direct'), null);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('Archived Topics deny every public mutation while retaining public read eligibility', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-archived-guards-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true, analysis: true, attention: true } });
    const topicId = 'fictional-topic-archived-guards';
    metadata.createTopic({ topicId, paraCategory: 'archive', lifecycle: 'active' });
    const dispatched = [];
    const service = createAuthoritativeSourceService({
      metadata,
      capabilities: { notes: true, sessions: true, scheduler: true, analysis: true, attention: true },
      gateway: { request: async (method) => { dispatched.push(method); throw new Error('Archived write reached the Gateway.'); } },
      analysisProvider: { status: () => ({}), run: () => { dispatched.push('analysis.run'); } },
      attentionService: { act: () => { dispatched.push('attention.act'); } }
    });
    const mutationId = () => randomUUID();
    const mutations = [
      () => service.notesCreate({ topicId, path: 'blocked.md', text: 'blocked', logicalOperationId: mutationId() }),
      () => service.notesEdit({ topicId, path: 'blocked.md', text: 'blocked', expectedRevision: 'blocked', logicalOperationId: mutationId() }),
      () => service.notesRename({ topicId, path: 'blocked.md', newPath: 'still-blocked.md', expectedRevision: 'blocked', logicalOperationId: mutationId() }),
      () => service.notesMove({ topicId, path: 'blocked.md', destinationPath: 'still-blocked.md', expectedRevision: 'blocked', logicalOperationId: mutationId() }),
      () => service.sessionsCreate({ topicId, label: 'Blocked', logicalOperationId: mutationId() }),
      () => service.sessionsSend({ topicId, referenceId: 'session:blocked', message: 'blocked', logicalOperationId: mutationId() }),
      () => service.sessionsClose({ topicId, referenceId: 'session:blocked', logicalOperationId: mutationId() }),
      () => service.sessionsReopen({ topicId, referenceId: 'session:blocked', logicalOperationId: mutationId() }),
      () => service.remindersSnooze({ topicId, referenceId: 'reminder:blocked', expectedConfigRevision: 'blocked', patch: {}, logicalOperationId: mutationId() }),
      () => service.remindersComplete({ topicId, referenceId: 'reminder:blocked', expectedConfigRevision: 'blocked', logicalOperationId: mutationId() }),
      () => service.schedulesCreate({ topicId, referenceId: 'schedule:blocked', declaration: {}, logicalOperationId: mutationId() }),
      () => service.schedulesUpdate({ topicId, referenceId: 'schedule:blocked', expectedConfigRevision: 'blocked', patch: {}, logicalOperationId: mutationId() }),
      () => service.schedulesSetEnabled({ topicId, referenceId: 'schedule:blocked', expectedConfigRevision: 'blocked', enabled: false, logicalOperationId: mutationId() }),
      () => service.schedulesRun({ topicId, referenceId: 'schedule:blocked', logicalOperationId: mutationId() }),
      () => service.analysisRun({ topicId, input: {}, logicalOperationId: mutationId() }),
      () => service.attentionAct({ topicId, logicalOperationId: mutationId() })
    ];
    for (const mutate of mutations) await assert.rejects(Promise.resolve().then(mutate), (error) => error.code === 'read-only');
    await assert.rejects(service.metadataWrite({ topicId, operation: 'preferences', value: { topicId, displayLabel: 'Blocked' }, logicalOperationId: mutationId() }), (error) => error.code === 'read-only');
    assert.deepEqual(dispatched, []);
    assert.equal(service.metadataRead({ topicId }).topic.paraCategory, 'archive');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('conversation creation verifies the exact Primary Session and records recovery before dispatch', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-missing-primary-create-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    const topicId = 'fictional-topic-missing-primary-create';
    const referenceId = 'session:fictional-primary-create';
    const sessionKey = 'agent:main:command-center:fictional-primary-create';
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: null });
    metadata.setSessionState({ referenceId, sessionId: 'fictional-primary-session-id', status: 'open', isPrimary: true });
    const entries = new Map([[sessionKey, { sessionId: 'fictional-primary-session-id', updatedAt: 1 }]]);
    let creations = 0;
    const sessionStore = {
      listSessionEntries: () => [...entries].map(([storedKey, entry]) => ({ sessionKey: storedKey, entry })),
      async createSessionEntry() { creations += 1; throw new Error('Missing Primary allowed a new Session creation.'); }
    };
    const gatewayCalls = [];
    const service = createAuthoritativeSourceService({
      metadata, sessionStore, capabilities: { sessions: true },
      gateway: { request: async (...args) => { gatewayCalls.push(args); return {}; } }
    });
    entries.delete(sessionKey);
    await assert.rejects(
      service.sessionsCreate({ topicId, label: 'Must not be created', logicalOperationId: randomUUID() }),
      (error) => error.code === 'source-recovery'
    );
    assert.equal(creations, 0);
    assert.deepEqual(gatewayCalls, []);
    assert.deepEqual(metadata.listSourceReferences(topicId).map((reference) => reference.referenceId), [referenceId]);
    const recovery = metadata.listSourceRecovery(topicId);
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].referenceId, referenceId);
    assert.equal(recovery[0].sourceKind, 'session');
    assert.equal(recovery[0].state, 'required');
    assert.equal(recovery[0].lastLocator, null);
    assert.equal(recovery[0].lastIdentity, null);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('public source service writes durable authoritative Markdown and keeps metadata free of content', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-integration-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'command-center-vault-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true } });
    metadata.createTopic({ topicId: 'topic-integration', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder-integration', topicId: 'topic-integration', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    const service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true, sessions: true, scheduler: true, activity: true, search: true, analysis: false, attention: false } });
    const logicalOperationId = randomUUID();
    const created = await service.notesCreate({ schemaVersion: 1, topicId: 'topic-integration', path: 'nested/note.md', text: 'authoritative text', logicalOperationId, requestId: 'frame-integration' });
    assert.equal(created.status, 'applied');
    assert.equal(await readFile(path.join(vault, 'nested/note.md'), 'utf8'), 'authoritative text');
    const metadataRows = metadata.listOperations();
    assert.equal(metadataRows.length, 1);
    assert.equal(JSON.stringify(metadataRows).includes('authoritative text'), false);
    assert.equal((await service.notesRead({ schemaVersion: 1, topicId: 'topic-integration', path: 'nested/note.md' })).text, 'authoritative text');
    assert.throws(() => service.analysisRead({ schemaVersion: 1, topicId: 'topic-integration' }), (error) => error.code === 'capability-unavailable');
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test('a moved Note receives a new immutable Source Reference across reopen and later edit', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-moved-note-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'command-center-moved-vault-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-moved-note', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder-moved-note', topicId: 'topic-moved-note', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    let service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true } });
    const created = await service.notesCreate({ schemaVersion: 1, topicId: 'topic-moved-note', path: 'before.md', text: 'before', logicalOperationId: randomUUID(), requestId: 'frame-create' });
    const moved = await service.notesMove({ schemaVersion: 1, topicId: 'topic-moved-note', path: 'before.md', destinationPath: 'after.md', expectedRevision: created.value.note.revision, logicalOperationId: randomUUID(), requestId: 'frame-move' });
    const referenceId = moved.value.note.sourceReference.referenceId;
    assert.notEqual(referenceId, created.value.note.sourceReference.referenceId);
    metadata.close();

    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true } });
    const reopened = await service.notesRead({ schemaVersion: 1, topicId: 'topic-moved-note', path: 'after.md' });
    assert.equal(reopened.sourceReference.referenceId, referenceId);
    const edited = await service.notesEdit({ schemaVersion: 1, topicId: 'topic-moved-note', path: 'after.md', expectedRevision: reopened.revision, text: 'after', logicalOperationId: randomUUID(), requestId: 'frame-edit' });
    assert.equal(edited.value.note.sourceReference.referenceId, referenceId);
    assert.equal(await readFile(path.join(vault, 'after.md'), 'utf8'), 'after');
    assert.equal(metadata.listSourceReferences('topic-moved-note').filter((reference) => reference.sourceKind === 'note').length, 2);
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test('move then recreate uses distinct durable Note identities without partial metadata failure', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-recreate-note-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'command-center-recreate-vault-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-recreate-note', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder-recreate-note', topicId: 'topic-recreate-note', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    const service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true } });
    const created = await service.notesCreate({ schemaVersion: 1, topicId: 'topic-recreate-note', path: 'before.md', text: 'first', logicalOperationId: randomUUID(), requestId: 'frame-first' });
    const moved = await service.notesMove({ schemaVersion: 1, topicId: 'topic-recreate-note', path: 'before.md', destinationPath: 'after.md', expectedRevision: created.value.note.revision, logicalOperationId: randomUUID(), requestId: 'frame-move' });
    const recreated = await service.notesCreate({ schemaVersion: 1, topicId: 'topic-recreate-note', path: 'before.md', text: 'second', logicalOperationId: randomUUID(), requestId: 'frame-second' });
    const movedReferenceId = moved.value.note.sourceReference.referenceId;
    const recreatedReferenceId = recreated.value.note.sourceReference.referenceId;
    assert.notEqual(recreatedReferenceId, movedReferenceId);
    assert.equal(await readFile(path.join(vault, 'before.md'), 'utf8'), 'second');
    assert.equal(await readFile(path.join(vault, 'after.md'), 'utf8'), 'first');
    assert.equal(metadata.listSourceReferences('topic-recreate-note').filter((reference) => reference.sourceKind === 'note').length, 2);
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    const reopenedService = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true } });
    assert.equal((await reopenedService.notesRead({ schemaVersion: 1, topicId: 'topic-recreate-note', path: 'after.md' })).sourceReference.referenceId, movedReferenceId);
    assert.equal((await reopenedService.notesRead({ schemaVersion: 1, topicId: 'topic-recreate-note', path: 'before.md' })).sourceReference.referenceId, recreatedReferenceId);
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test('external Note reads persist current observations across metadata restart', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-observed-note-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'command-center-observed-vault-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-observed-note', paraCategory: 'resource', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder-observed-note', topicId: 'topic-observed-note', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    await writeFile(path.join(vault, 'external.md'), 'external revision one');
    let service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true } });
    const observed = await service.notesRead({ schemaVersion: 1, topicId: 'topic-observed-note', path: 'external.md' });
    await writeFile(path.join(vault, 'browsed.md'), 'browse observation');
    const browsed = (await service.notesBrowse({ schemaVersion: 1, topicId: 'topic-observed-note' })).find((note) => note.path === 'browsed.md');
    metadata.close();

    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    assert.equal(metadata.getSourceReference(observed.sourceReference.referenceId).observedRevision, observed.revision);
    assert.equal(metadata.getSourceReference(browsed.sourceReference.referenceId).observedRevision, browsed.revision);
    await writeFile(path.join(vault, 'external.md'), 'external revision two');
    service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true } });
    const updated = await service.notesRead({ schemaVersion: 1, topicId: 'topic-observed-note', path: 'external.md' });
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    assert.equal(metadata.getSourceReference(observed.sourceReference.referenceId).observedRevision, updated.revision);
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test('registered authenticated bridge persists request-bound Note effects across reopen without side effects', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-bridge-integration-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'command-center-bridge-vault-'));
  let metadata;
  const registrations = new Map();
  const sideEffects = { attention: 0, push: 0 };
  const api = { registerGatewayMethod: (method, handler, options) => registrations.set(method, { handler, options }) };
  const invoke = async (method, params, requestId) => {
    let response;
    await registrations.get(method).handler({ req: { id: requestId }, params, context: { authenticated: true, operator: 'fictional' }, respond: (...args) => { response = args; } });
    assert.equal(response[0], true);
    return response[1];
  };
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    metadata.createTopic({ topicId: 'topic-bridge-integration', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder-bridge-integration', topicId: 'topic-bridge-integration', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    let service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true }, attentionDelivery: () => { sideEffects.attention += 1; }, push: () => { sideEffects.push += 1; } });
    registerBridgeMethods(api, service);
    const logicalOperationId = randomUUID();
    const created = await invoke('command-center.v1.notes.create', { schemaVersion: 1, topicId: 'topic-bridge-integration', path: 'bridge.md', text: 'bridge authoritative text', logicalOperationId }, 'gateway-frame-create');
    assert.equal(created.requestId, 'gateway-frame-create');
    assert.equal(created.logicalOperationId, logicalOperationId);
    assert.equal(await readFile(path.join(vault, 'bridge.md'), 'utf8'), 'bridge authoritative text');
    assert.equal(JSON.stringify(metadata.listOperations()).includes('bridge authoritative text'), false);
    metadata.close();

    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    service = createAuthoritativeSourceService({ fsSafeRootFactory, metadata, root: vault, capabilities: { notes: true }, attentionDelivery: () => { sideEffects.attention += 1; }, push: () => { sideEffects.push += 1; } });
    registrations.clear();
    registerBridgeMethods(api, service);
    const replayed = await invoke('command-center.v1.notes.create', { schemaVersion: 1, topicId: 'topic-bridge-integration', path: 'bridge.md', text: 'bridge authoritative text', logicalOperationId }, 'gateway-frame-replay');
    assert.equal(replayed.requestId, 'gateway-frame-replay');
    assert.equal(replayed.result.value.note.path, 'bridge.md');
    assert.equal(replayed.result.value.note.text, 'bridge authoritative text');
    assert.equal('intentDigest' in replayed.result, false);
    const read = await invoke('command-center.v1.notes.read', { schemaVersion: 1, topicId: 'topic-bridge-integration', path: 'bridge.md' }, 'gateway-frame-read');
    assert.equal(read.requestId, 'gateway-frame-read');
    assert.equal(read.result.text, 'bridge authoritative text');
    assert.equal(metadata.listOperations().length, 1);
    assert.deepEqual(metadata.listActivity(), []);
    assert.deepEqual(sideEffects, { attention: 0, push: 0 });
  } finally {
    metadata?.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test('derived search and Topic Analysis use only injected providers', async () => {
  const metadata = { getTopic: (topicId) => topicId === 'topic-provider' ? { topicId, lifecycle: 'active' } : null, getOperatingStatus: () => ({ mode: 'ready', schemaVersion: 3, diagnostics: [] }), listSourceReferences: () => [] };
  const unavailable = createAuthoritativeSourceService({ metadata, capabilities: { notes: false, sessions: false, scheduler: false, activity: true, search: false, analysis: false, attention: false } });
  await assert.rejects(() => unavailable.searchQuery({ schemaVersion: 1, topicId: 'topic-provider', query: 'fictional' }), (error) => error.code === 'capability-unavailable');
  const noteFolderReference = { version: 1, referenceId: 'note-folder:provider', topicId: 'topic-provider', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional/topic-provider', observedRevision: 'revision-provider' };
  const groupedSearch = {
    schemaVersion: 1,
    topicId: 'topic-provider',
    query: 'fictional',
    notes: { results: [{ kind: 'note', topicId: 'topic-provider', sourceReference: noteFolderReference, path: 'provider.md', heading: 'Provider', snippet: 'fictional', highlights: [{ start: 0, end: 9 }], contextBefore: '', contextAfter: '', navigation: { kind: 'note', topicId: 'topic-provider', referenceId: noteFolderReference.referenceId, path: 'provider.md', heading: 'Provider', observedRevision: 'revision-provider' } }] },
    conversations: { results: [] }
  };
  const service = createAuthoritativeSourceService({
    metadata,
    capabilities: { notes: false, sessions: false, scheduler: false, activity: true, search: true, analysis: true, attention: false },
    searchProvider: { query: async () => groupedSearch },
    analysisProvider: { status: async () => ({ status: 'idle' }), run: async () => ({ status: 'queued' }) }
  });
  const search = await service.searchQuery({ schemaVersion: 1, topicId: 'topic-provider', query: 'fictional' });
  assert.equal(search.notes.results[0].path, 'provider.md');
  assert.deepEqual(search.conversations.results, []);
  assert.equal((await service.analysisRead({ topicId: 'topic-provider' })).status, 'idle');
  assert.equal((await service.analysisRun({ topicId: 'topic-provider', input: {}, logicalOperationId: randomUUID() })).value.status, 'queued');
});

test('authoritative creates reject a missing Topic before provider dispatch', async () => {
  const metadata = {
    getTopic: () => null,
    getOperatingStatus: () => ({ mode: 'ready', schemaVersion: 2, diagnostics: [] }),
    listSourceReferences: () => []
  };
  const calls = [];
  const gateway = { request: async (...args) => { calls.push(args); return {}; } };
  const service = createAuthoritativeSourceService({ metadata, gateway, capabilities: { sessions: true, scheduler: true } });
  await assert.rejects(
    () => service.sessionsCreate({ topicId: 'missing-topic', logicalOperationId: randomUUID() }),
    (error) => error.code === 'source-recovery'
  );
  await assert.rejects(
    () => service.schedulesCreate({ topicId: 'missing-topic', referenceId: 'schedule:missing', declaration: {}, logicalOperationId: randomUUID() }),
    (error) => error.code === 'source-recovery'
  );
  assert.deepEqual(calls, []);
});

test('migration-configured Topics require exact authoritative bindings and completion before normal admission', () => {
  const metadata = {
    getTopic: () => ({ topicId: 'topic-migrated', lifecycle: 'active' }),
    listSourceReferences: () => [
      { referenceId: 'folder', sourceSystem: 'obsidian', sourceKind: 'note_folder' },
      { referenceId: 'primary', sourceSystem: 'openclaw', sourceKind: 'session' }
    ],
    getSessionState: (referenceId) => referenceId === 'primary' ? { sessionId: 'fictional-session', status: 'open', isPrimary: true } : null,
    getOperatingStatus: () => ({ mode: 'ready', schemaVersion: 3, diagnostics: [] }),
    getMigrationCompletion: () => null
  };
  const migration = { normalizedConfig: () => ({ channels: [{ topicId: 'topic-migrated' }] }) };
  const service = createAuthoritativeSourceService({ metadata, migration, capabilities: { notes: false, sessions: false, scheduler: false, analysis: true } });
  assert.throws(() => service.requireTopicService({ topicId: 'topic-migrated' }), (error) => error.code === 'source-recovery');
  assert.throws(() => service.analysisRead({ topicId: 'topic-migrated' }), (error) => error.code === 'source-recovery');
  metadata.getMigrationCompletion = () => ({ completionId: 'legacy-discord-v1' });
  metadata.listSourceReferences = () => [
    { referenceId: 'folder', sourceSystem: 'obsidian', sourceKind: 'note_folder' },
    { referenceId: 'primary', sourceSystem: 'openclaw', sourceKind: 'session' },
    { referenceId: 'ordinary-secondary', sourceSystem: 'openclaw', sourceKind: 'session' }
  ];
  assert.doesNotThrow(() => service.requireTopicService({ topicId: 'topic-migrated' }));
});

test('a disabled migration service leaves unrelated active Topics on normal capability gating', () => {
  const metadata = {
    getTopic: () => ({ topicId: 'fictional-unrelated-topic', paraCategory: 'resource', lifecycle: 'active' }),
    getOperatingStatus: () => ({ mode: 'ready', schemaVersion: 3, diagnostics: [] }),
    listSourceReferences: () => []
  };
  const service = createAuthoritativeSourceService({
    metadata,
    capabilities: { notes: true },
    migration: { normalizedConfig: () => null }
  });

  assert.doesNotThrow(() => service.requireTopicService({ topicId: 'fictional-unrelated-topic' }));
});
