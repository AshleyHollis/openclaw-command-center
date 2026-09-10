import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { inspectNoteFolderCandidate } from '../../src/sources/note-folder-identity.mjs';
import { adoptExistingTopic } from '../../src/topics/bootstrap.mjs';
import { createMetadataService } from '../../src/plugin-service.mjs';

test('existing-folder bootstrap preserves populated native Primary/main/reporting and serves real Notes and navigation', { timeout: 150_000 }, async t => {
  assert.equal(process.platform, 'linux', 'descriptor-anchored bootstrap qualification requires Linux');
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  process.env.OPENCLAW_STATE_DIR = stateDir; process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const transcripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
  const sqliteUrl = pathToFileURL(require.resolve('openclaw/plugin-sdk/sqlite-runtime')).href;
  const hooks = registerHooks({ resolve: (specifier, context, nextResolve) => specifier === 'openclaw/plugin-sdk/sqlite-runtime' ? { url: sqliteUrl, shortCircuit: true } : nextResolve(specifier, context) });
  t.after(() => hooks.deregister());
  const originals = new Map();
  for (const name of ['garden', 'main', 'reports']) {
    const scope = { agentId: 'main', sessionKey: `agent:main:${name}` };
    await sessionStore.patchSessionEntry({ ...scope, fallbackEntry: { sessionId: `fictional-${name}`, lifecycleRevision: `fictional-life-${name}`, updatedAt: 1 }, update: entry => entry });
    const appended = await transcripts.appendSessionTranscriptMessageByIdentityStrict({ ...scope, sessionId: `fictional-${name}`, config: {},
      eventId: `fictional-${name}-message`, message: { role: 'user', content: `Existing ${name} history`, timestamp: 1767225600000 }, now: 1767225600000 });
    assert.equal(appended.kind, 'result');
    originals.set(name, sessionStore.getSessionEntry({ ...scope, readConsistency: 'latest' }));
  }
  const vault = path.join(stateDir, 'vault'); const folder = path.join(vault, 'areas', 'garden-alias');
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'Overview.md'), '# Existing Garden\nKeep these Notes.\n');
  let metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { notes: true, sessions: true } });
  t.after(() => metadata.close());
  const input = { logicalOperationId: randomUUID(), intent: { schemaVersion: 1, mappingDigest: 'a'.repeat(64), topicId: randomUUID(), name: 'Garden knowledge', paraCategory: 'area',
    folder: await inspectNoteFolderCandidate(folder), primary: { agentId: 'main', sessionKey: 'agent:main:garden', sessionId: 'fictional-garden', lifecycleRevision: 'fictional-life-garden' } } };
  const options = { metadata, sessionStore, input, assertCurrent: () => {} };
  await assert.rejects(adoptExistingTopic({ ...options, mode: 'verify' }), { code: 'bootstrap-reservation-missing' });
  const applied = await adoptExistingTopic({ ...options, mode: 'execute' });
  assert.equal(applied.phase, 'applied');
  metadata.close();
  metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { notes: true, sessions: true } });
  assert.deepEqual(await adoptExistingTopic({ ...options, metadata, mode: 'verify' }), applied);
  const activation = createMetadataService({ config: {}, pluginConfig: { topics: { noteRoot: vault } }, logger: {},
    runtime: { state: { resolveStateDir: () => path.join(stateDir, 'metadata') }, agent: { session: { listSessionEntries: () => sessionStore.listSessionEntries({ agentId: 'main' }) } } } });
  t.after(() => activation.stop()); await activation.start();
  const destination = await activation.topicService.listDestinationVerified();
  assert.equal(destination.activeGroups.area[0].topicId, input.intent.topicId);
  assert.equal((await activation.sourceService.notesRead({ schemaVersion: 1, topicId: input.intent.topicId, path: 'Overview.md' })).text, '# Existing Garden\nKeep these Notes.\n');
  const navigation = await activation.sourceService.sessionsNavigate({ schemaVersion: 1, topicId: input.intent.topicId, referenceId: applied.sessionReferenceId });
  assert.equal(navigation.sessionKey, 'agent:main:garden'); assert.equal(navigation.sessionId, 'fictional-garden');
  assert.equal(await readFile(path.join(folder, 'Overview.md'), 'utf8'), '# Existing Garden\nKeep these Notes.\n');
  for (const [name, entry] of originals) {
    const scope = { agentId: 'main', sessionKey: `agent:main:${name}` };
    assert.deepEqual(sessionStore.getSessionEntry({ ...scope, readConsistency: 'latest' }), entry);
    assert.deepEqual((await transcripts.readVisibleSessionTranscriptMessageEntries({ ...scope, sessionId: entry.sessionId })).map(row => row.message.content), [`Existing ${name} history`]);
  }
  const newFolder = path.join(vault, 'resources', 'cookbook');
  await mkdir(newFolder, { recursive: true }); await writeFile(path.join(newFolder, 'Overview.md'), '# Existing Cookbook\n');
  const createId = randomUUID(); const createTopicId = randomUUID();
  const createInput = { logicalOperationId: createId, intent: { schemaVersion: 1, mappingDigest: 'a'.repeat(64), topicId: createTopicId, name: 'Cookbook', paraCategory: 'resource',
    folder: await inspectNoteFolderCandidate(newFolder), primary: { agentId: 'main', sessionKey: `agent:main:command-center:topic:${createTopicId}:primary`, sessionId: createId, lifecycleRevision: createId, creation: 'if-absent' } } };
  const created = await adoptExistingTopic({ ...options, metadata, input: createInput, mode: 'execute' });
  assert.equal(created.phase, 'applied');
  const createdEntry = sessionStore.getSessionEntry({ agentId: 'main', sessionKey: createInput.intent.primary.sessionKey, readConsistency: 'latest' });
  assert.equal(createdEntry.sessionId, createId); assert.equal(createdEntry.lifecycleRevision, createId);
  assert.notEqual(createdEntry.sendPolicy, 'deny');
  assert.deepEqual(await adoptExistingTopic({ ...options, metadata, input: createInput, mode: 'resume' }), created);
  assert.deepEqual(sessionStore.getSessionEntry({ agentId: 'main', sessionKey: createInput.intent.primary.sessionKey, readConsistency: 'latest' }), createdEntry, 'unchanged retry does not rewrite or replace its native Primary');
  assert.equal((await activation.sourceService.notesRead({ schemaVersion: 1, topicId: createTopicId, path: 'Overview.md' })).text, '# Existing Cookbook\n');
  assert.equal((await activation.sourceService.sessionsNavigate({ schemaVersion: 1, topicId: createTopicId, referenceId: created.sessionReferenceId })).sessionId, createId);
  const originalLocator = metadata.getSourceLocator(applied.sessionReferenceId);
  metadata.setSourceLocator({ referenceId: applied.sessionReferenceId, locator: 'agent:main:reports', observedRevision: originalLocator.observedRevision });
  const redirectedLocator = metadata.getSourceLocator(applied.sessionReferenceId);
  await assert.rejects(adoptExistingTopic({ ...options, metadata, mode: 'verify' }), { code: 'bootstrap-ownership-conflict' });
  assert.deepEqual(metadata.getSourceLocator(applied.sessionReferenceId), redirectedLocator, 'verification must not undo a subsequent source relocation');
  assert.deepEqual(metadata.getTopicBootstrap(input.logicalOperationId), applied);
  metadata.setSourceLocator({ referenceId: applied.sessionReferenceId, locator: originalLocator.locator, observedRevision: originalLocator.observedRevision });
  await sessionStore.patchSessionEntry({ agentId: 'main', sessionKey: 'agent:main:garden', update: entry => ({ ...entry, lifecycleRevision: 'foreign-generation' }) });
  await assert.rejects(adoptExistingTopic({ ...options, metadata, mode: 'resume' }), { code: 'bootstrap-source-conflict' });
  assert.deepEqual(metadata.getTopicBootstrap(input.logicalOperationId), applied);
});
