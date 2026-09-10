import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { readNativeHistoryInventory } from '../../src/migration/native-history-source.mjs';
import { runPreservedHistoryImport, readVerifiedPreservedHistory } from '../../src/migration/preserved-history-import.mjs';

test('native historical import recovers a lost append response and verifies original records without repeating effects', { timeout: 120_000 }, async t => {
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir, 'parent-owned isolated state is required');
  assert.ok(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE, 'explicit isolated host is required');
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const transcripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
  const sourceRoot = path.join(stateDir, 'source');
  await mkdir(sourceRoot);
  const records = [
    { type: 'session', id: 'fictional-session', version: 3, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: 'first', parentId: null, timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'fictional-call', name: 'fictional_tool', arguments: { value: 1 } }] } },
    { type: 'compaction', id: 'event', parentId: 'first', timestamp: '2026-01-01T00:02:00.000Z', summary: 'Preserved event' }
  ];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const file = { name: 'fictional-session.jsonl.bak-123-456', sizeBytes: bytes.length, sha256: hash(bytes) };
  await writeFile(path.join(sourceRoot, file.name), bytes);
  const inventoryBytes = Buffer.from(JSON.stringify({ snapshot: '/fictional/backup', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fictional/agents/main/sessions', files: [file] }));
  await writeFile(path.join(sourceRoot, 'inventory.json'), inventoryBytes);
  const prepared = (await readNativeHistoryInventory({ root: sourceRoot, expectedInventorySha256: hash(inventoryBytes), originalAgentId: 'main' })).histories[0];
  let metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { sessions: true } });
  t.after(() => metadata.close());
  const reservation = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: {
    schemaVersion: 2, sourceKind: prepared.sourceKind, sourceInventorySha256: prepared.sourceInventorySha256,
    originalAgentId: prepared.originalAgentId, originalSessionId: prepared.originalSessionId, sourceFile: prepared.sourceFile,
    sourceDigest: prepared.sourceDigest, expectedCount: prepared.expectedCount, agentId: 'main', topicId: null, expectedTopicRevision: null
  } }, () => {});
  const storePath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
  const options = { metadata, historyId: reservation.historyId, prepared, sessionStore, transcripts, storePath, config: {}, assertCurrent: () => {} };
  await assert.rejects(runPreservedHistoryImport({ ...options, allowCreate: true,
    afterNativeAppend: () => { throw Object.assign(new Error('fictional lost response'), { code: 'fictional-interruption' }); }
  }), { code: 'fictional-interruption' });
  assert.equal(metadata.getImportedHistory(reservation.historyId).verifiedCount, 0);
  metadata.close();
  metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { sessions: true } });
  options.metadata = metadata;
  const completed = await runPreservedHistoryImport({ ...options, allowCreate: false });
  assert.equal(completed.phase, 'verified');
  assert.equal(completed.verifiedCount, 2);
  assert.deepEqual(await runPreservedHistoryImport({ ...options, allowCreate: false }), completed);
  const result = await readVerifiedPreservedHistory(options);
  assert.equal(result.entries.length, 2);
  for (const [index, entry] of result.entries.entries()) {
    assert.equal(entry.message.role, 'user');
    assert.deepEqual(entry.message.__openclaw.importedNativeHistoryV1.rawEntry, records[index + 1]);
  }
  assert.equal(sessionStore.getSessionEntry({ ...reservation.target, storePath, readConsistency: 'latest' }).sendPolicy, 'deny');
  assert.equal(sessionStore.getSessionEntry({ agentId: 'main', sessionKey: 'agent:main:fictional-session', storePath, readConsistency: 'latest' }), undefined);
  const changed = structuredClone(prepared);
  changed.entries[0].message.content = 'Changed source';
  await assert.rejects(readVerifiedPreservedHistory({ ...options, prepared: changed }), { code: 'history-source-conflict' });
  await assert.rejects(readVerifiedPreservedHistory({ ...options, assertCurrent: () => { throw Object.assign(new Error('revoked'), { code: 'revoked' }); } }), { code: 'revoked' });
  assert.equal((await readVerifiedPreservedHistory(options)).entries.length, 2);
  const { createPreservedHistoryReader } = await import('../../src/migration/preserved-history-read.mjs');
  const reader = await createPreservedHistoryReader({ ...options, nativeSourceOptions: { root: sourceRoot, expectedInventorySha256: hash(inventoryBytes), originalAgentId: 'main' } });
  const listing = await reader.list({ schemaVersion: 1 }, () => {});
  assert.equal(listing.histories.length, 1);
  assert.equal(listing.histories[0].readOnly, true);
  const firstPage = await reader.read({ schemaVersion: 1, historyId: reservation.historyId, limit: 1 }, () => {});
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.messages[0].author, 'assistant');
  assert.deepEqual(JSON.parse(firstPage.messages[0].detailsJson), { session: records[0], entry: records[1] });
  assert.deepEqual(firstPage.messages[0].attachments, []);
  const secondPage = await reader.read({ schemaVersion: 1, historyId: reservation.historyId, offset: firstPage.nextOffset }, () => {});
  assert.equal(secondPage.messages[0].author, 'Session event: compaction');
  assert.equal(secondPage.hasMore, false);
  await assert.rejects(reader.read({ schemaVersion: 1, historyId: reservation.historyId }, () => { throw Object.assign(new Error('revoked'), { code: 'revoked' }); }), { code: 'revoked' });
  const sdkEntries = new Map(['openclaw/plugin-sdk/session-transcript-runtime', 'openclaw/plugin-sdk/state-paths']
    .map(specifier => [specifier, pathToFileURL(require.resolve(specifier)).href]));
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    return sdkEntries.has(specifier) ? { url: sdkEntries.get(specifier), shortCircuit: true } : nextResolve(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const { createMetadataService } = await import('../../src/plugin-service.mjs');
  const { registerBridgeMethods } = await import('../../src/bridge/register.mjs');
  const nativeSourceOptions = { root: sourceRoot, expectedInventorySha256: hash(inventoryBytes), originalAgentId: 'main' };
  const api = { config: {}, pluginConfig: { nativeHistorySource: structuredClone(nativeSourceOptions) }, logger: {},
    runtime: { state: { resolveStateDir: () => path.join(stateDir, 'metadata') }, agent: { session: { listSessionEntries: () => [] } } } };
  const activation = createMetadataService(api);
  t.after(() => activation.stop());
  await activation.start();
  api.pluginConfig.nativeHistorySource.expectedInventorySha256 = '0'.repeat(64);
  assert.equal((await activation.sourceService.historiesList({ schemaVersion: 1 }, { assertCurrent: () => {} })).histories.length, 1);
  const handlers = new Map();
  registerBridgeMethods({ registerGatewayMethod: (method, handler) => handlers.set(method, handler) }, activation.sourceService);
  const connection = new AbortController();
  const client = { connId: 'fictional-native-history-reader', connect: { role: 'operator', scopes: ['operator.read'] }, connectionSignal: connection.signal };
  async function rpc(method, params, authenticated = true) {
    let response;
    await handlers.get(method)({ req: { id: 'fictional-request' }, params, client,
      context: { authenticated, isConnectionActive: id => id === client.connId },
      respond: (ok, payload, error) => { response = { ok, payload, error }; } });
    return response;
  }
  const listed = await rpc('command-center.v1.histories.list', { schemaVersion: 1 });
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.equal(listed.payload.result.histories.length, 1);
  assert.equal((await rpc('command-center.v1.histories.list', { schemaVersion: 1 }, false)).ok, false);
  const page = await rpc('command-center.v1.histories.read', { schemaVersion: 1, historyId: reservation.historyId });
  assert.equal(page.ok, true, JSON.stringify(page.error));
  assert.equal(page.payload.result.messages.length, 2);
  const pending = rpc('command-center.v1.histories.read', { schemaVersion: 1, historyId: reservation.historyId });
  connection.abort();
  assert.equal((await pending).ok, false);
  const { createPreservationFixture } = await import('./discord-preservation.mjs');
  const { importDiscordPreservation } = await import('../../src/migration/preserved-history-batch.mjs');
  const discordMessage = { id: 'fictional-discord-message', channel_id: 'fictional-discord-channel', author: { id: 'fictional-person' },
    content: 'Original Discord text', timestamp: '2026-01-01T00:00:00.000Z', attachments: [] };
  const counts = { guildStructureCount: 1, guildTextChannelCount: 1, messageCount: 1, attachmentCount: 0 };
  const discord = await createPreservationFixture(t, { files: new Map([
    ['channels.json', Buffer.from(JSON.stringify([{ id: discordMessage.channel_id, type: 0, name: 'Fictional Discord' }]))],
    [`messages/${discordMessage.channel_id}.jsonl`, Buffer.from(JSON.stringify(discordMessage) + '\n')],
    [`messages/${discordMessage.channel_id}.reactions.json`, Buffer.from('[]')],
    ['threads.json', Buffer.from('{"threads":[],"endpointReceipts":[]}')]
  ]), baseline: counts, summary: { ...counts, discoveredThreadCount: 0, reactionCount: 0, attachments: [],
    channelReceipts: [{ id: discordMessage.channel_id, messageCount: 1, firstMessageId: discordMessage.id, lastMessageId: discordMessage.id }] } });
  const importedDiscord = await importDiscordPreservation({ ...options, sourceOptions: discord.options, mode: 'execute',
    mappings: [{ sourceChannelId: discordMessage.channel_id, logicalOperationId: randomUUID(), agentId: 'main', topicId: null, expectedTopicRevision: null }] });
  const mixed = await createPreservedHistoryReader({ ...options, sourceOptions: discord.options, nativeSourceOptions });
  assert.equal((await mixed.list({ schemaVersion: 1 }, () => {})).histories.length, 2);
  const discordPage = await mixed.read({ schemaVersion: 1, historyId: importedDiscord.histories[0].historyId }, () => {});
  assert.equal(discordPage.messages[0].text, 'Original Discord text');
  assert.deepEqual(JSON.parse(discordPage.messages[0].detailsJson).message, discordMessage);
  assert.equal((await mixed.read({ schemaVersion: 1, historyId: reservation.historyId }, () => {})).messages.length, 2);

  const { reconcilePreservedWorkspace, reconciliationPlanDigest } = await import('../../src/migration/reconcile.mjs');
  const plannedState = path.join(stateDir, 'planned-state');
  await mkdir(plannedState);
  const plannedEnv = { ...process.env, OPENCLAW_STATE_DIR: plannedState, OPENCLAW_CONFIG_PATH: path.join(plannedState, 'openclaw.json') };
  const protectedSession = { agentId: 'main', sessionKey: 'agent:main:fictional-protected', sessionId: 'fictional-protected', lifecycleRevision: null };
  await sessionStore.patchSessionEntry({ ...protectedSession, env: plannedEnv, fallbackEntry: { sessionId: protectedSession.sessionId, updatedAt: 1 }, update: entry => entry });
  const protectedBefore = sessionStore.getSessionEntry({ ...protectedSession, env: plannedEnv, readConsistency: 'latest' });
  let plannedMetadata = openCommandCenterMetadataService({ stateDir: plannedState, capabilities: { notes: true, sessions: true } });
  t.after(() => plannedMetadata.close());
  const plan = { schemaVersion: 2, logicalOperationId: randomUUID(), sourceOptions: discord.options, bootstraps: [],
    mappings: [{ sourceChannelId: discordMessage.channel_id, logicalOperationId: randomUUID(), agentId: 'main', topicId: null, expectedTopicRevision: null }],
    protectedSessions: [protectedSession], nativeHistory: { sourceOptions: nativeSourceOptions,
      mappings: [{ sourceFileName: file.name, logicalOperationId: randomUUID(), agentId: 'main', topicId: null, expectedTopicRevision: null }] } };
  const expectedPlanDigest = reconciliationPlanDigest(plan);
  const plannedOptions = { metadata: plannedMetadata, sessionStore, transcripts, env: plannedEnv, config: {}, plan, expectedPlanDigest, assertCurrent: () => {} };
  const preflight = await reconcilePreservedWorkspace({ ...plannedOptions, mode: 'preflight' });
  assert.equal(preflight.children.length, 2);
  assert.deepEqual(preflight.children.map(child => child.operationKind).sort(), ['history.import.native.v1', 'history.import.v1']);
  assert.equal(preflight.accounting.nativeHistory.sourceMessages, 1);
  assert.equal(preflight.accounting.nativeHistory.sourceOtherRecords, 1);
  assert.equal(plannedMetadata.listOperations().length, 0);
  // Durable parent before either child: a reopened owner must resume both
  // unstarted children without changing the approved operation IDs or plan.
  plannedMetadata.reserveReconciliation({ logicalOperationId: plan.logicalOperationId, planDigest: expectedPlanDigest, children: preflight.children }, () => {});
  plannedMetadata.close();
  plannedMetadata = openCommandCenterMetadataService({ stateDir: plannedState, capabilities: { notes: true, sessions: true } });
  plannedOptions.metadata = plannedMetadata;
  const applied = await reconcilePreservedWorkspace({ ...plannedOptions, mode: 'resume' });
  assert.equal(applied.phase, 'applied');
  assert.equal(applied.accounting.verifiedHistories, 1);
  assert.equal(applied.accounting.nativeHistory.verifiedHistories, 1);
  assert.equal(applied.accounting.nativeHistory.verifiedEntries, 2);
  const operationsBefore = plannedMetadata.listOperations();
  assert.deepEqual(await reconcilePreservedWorkspace({ ...plannedOptions, mode: 'verify' }), applied);
  assert.deepEqual(await reconcilePreservedWorkspace({ ...plannedOptions, mode: 'execute' }), applied);
  assert.deepEqual(plannedMetadata.listOperations(), operationsBefore);
  assert.deepEqual(sessionStore.getSessionEntry({ ...protectedSession, env: plannedEnv, readConsistency: 'latest' }), protectedBefore);
  assert.equal(plannedMetadata.listTopics().length, 0);
  const { runConfiguredReconciliation } = await import('../../src/migration/reconcile-cli.mjs');
  const planPath = path.join(plannedState, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  process.env.OPENCLAW_STATE_DIR = plannedState;
  try {
    const config = { plugins: { entries: { 'command-center': { enabled: true, config: { preservedHistorySource: discord.options } } } } };
    // A completed import is not sufficient: the operator command must confirm
    // the app's read-side configuration covers the same native source too.
    await assert.rejects(runConfiguredReconciliation({ mode: 'verify', planPath, expectedDigest: expectedPlanDigest, config }), { code: 'reconciliation-reader-not-configured' });
    const inspected = await runConfiguredReconciliation({ mode: 'preflight', planPath, expectedDigest: expectedPlanDigest, config });
    assert.equal(inspected.readerBindingReady, false);
    config.plugins.entries['command-center'].config.nativeHistorySource = nativeSourceOptions;
    const verified = await runConfiguredReconciliation({ mode: 'verify', planPath, expectedDigest: expectedPlanDigest, config });
    assert.equal(verified.readerBindingReady, true);
    assert.equal(verified.accounting.nativeHistory.verifiedEntries, 2);
    assert.equal(JSON.stringify(verified).includes(file.name), false);
    assert.deepEqual(plannedMetadata.listOperations(), operationsBefore);
  } finally { process.env.OPENCLAW_STATE_DIR = stateDir; }
});
