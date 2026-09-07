// Explicit isolated diagnostic: supply COMMAND_CENTER_REHEARSAL_HOST_PACKAGE.
// This is not a sealed-candidate receipt or a live Gateway test.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { preparePreservedHistoryMessages } from '../../src/migration/preserved-history-transcript.mjs';
import { createPreservationFixture } from './discord-preservation.mjs';

test('real native history destination preserves Primary and provenance, rejects revoked writes and verifies replay without appending', { timeout: 120_000 }, async t => {
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir, 'parent-owned isolated state directory is required');
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { sessions: true } });
  t.after(() => metadata.close());
  assert.ok(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE, 'explicit isolated host package is required');
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const transcripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
  const { withPreservedHistoryDestination } = await import('../../src/migration/preserved-history-destination.mjs');
  const storePath = path.join(stateDir, 'sessions.json');
  const primary = { agentId: 'main', sessionKey: 'agent:main:fictional-primary', storePath };
  await sessionStore.patchSessionEntry({ ...primary, fallbackEntry: { sessionId: 'fictional-primary-id', updatedAt: 1 }, update: entry => entry });
  const originalPrimary = sessionStore.getSessionEntry({ ...primary, readConsistency: 'latest' });
  const prepared = preparePreservedHistoryMessages({ sourceManifestSha256: 'a'.repeat(64), channel: {
    channel: { id: 'fictional-channel' }, messages: [{ id: 'fictional-message', channel_id: 'fictional-channel',
      author: { id: 'fictional-bot', username: 'Fictional bot', bot: true }, timestamp: '2026-01-01T00:00:00.000Z',
      content: '', attachments: [], embeds: [{ description: 'Fictional preserved report' }] }], reactions: [] }, attachments: [] });
  metadata.createTopic({ topicId: 'fictional-topic', name: 'Fictional Topic', paraCategory: 'area', lifecycle: 'active' });
  const reservation = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: {
    schemaVersion: 1, sourceManifestSha256: 'a'.repeat(64), trustedPublicKeySha256: 'b'.repeat(64),
    sourceChannelId: prepared.sourceChannelId, sourceDigest: prepared.sourceDigest, expectedCount: 1,
    agentId: 'main', topicId: 'fictional-topic', expectedTopicRevision: 0 } }, () => {});
  let current = true;
  const dispatched = metadata.dispatchImportedHistoryCreation({ historyId: reservation.historyId, logicalOperationId: reservation.logicalOperationId, expectedRevision: reservation.revision }, () => {});
  const options = { reservation: dispatched, sessionStore, transcripts, storePath, config: {}, allowCreate: true,
    assertCurrent: () => { if (!current) throw Object.assign(new Error('revoked'), { code: 'revoked' }); } };
  let anchor;
  await withPreservedHistoryDestination(options, async destination => {
    assert.deepEqual(await destination.read(), []);
    await assert.rejects(destination.verifyExisting(prepared.entries[0]), { code: 'history-replay-missing' });
    assert.deepEqual(await destination.read(), []);
    current = false;
    await assert.rejects(destination.appendFresh(prepared.entries[0]), { code: 'revoked' });
    current = true;
    assert.deepEqual(await destination.read(), []);
    anchor = await destination.appendFresh(prepared.entries[0]);
    assert.equal(typeof anchor.generation, 'string');
    const visible = await destination.read();
    assert.equal(visible.length, 1);
    assert.deepEqual(visible[0].message, prepared.entries[0].message);
    assert.deepEqual(await destination.verifyExisting(prepared.entries[0]), anchor);
  });
  await withPreservedHistoryDestination({ ...options, allowCreate: false }, async destination => {
    assert.deepEqual(await destination.verifyExisting(prepared.entries[0]), anchor);
    assert.equal((await destination.read()).length, 1);
  });
  const missing = { ...reservation, phase: 'verified', target: { ...reservation.target, sessionKey: 'agent:main:fictional-missing', sessionId: 'fictional-missing-id' } };
  await assert.rejects(withPreservedHistoryDestination({ ...options, reservation: missing, allowCreate: false }, async () => {}), { code: 'history-destination-rebound' });
  assert.equal(sessionStore.getSessionEntry({ ...missing.target, storePath, readConsistency: 'latest' }), undefined);
  assert.deepEqual(sessionStore.getSessionEntry({ ...primary, readConsistency: 'latest' }), originalPrimary);
  const { runPreservedHistoryImport } = await import('../../src/migration/preserved-history-import.mjs');
  const historyId = reservation.historyId;
  let interrupted = false;
  // The existing destination effect intentionally predates any local progress
  // receipt. This exercises verified-prefix recovery, not a simulated SDK.
  const completed = await runPreservedHistoryImport({ ...options, allowCreate: false, metadata, historyId, prepared });
  assert.equal(completed.phase, 'verified');
  assert.equal(completed.verifiedCount, 1);
  assert.deepEqual(await runPreservedHistoryImport({ ...options, allowCreate: false, metadata, historyId, prepared }), completed);
  const corrupted = structuredClone(prepared);
  corrupted.entries[0].message.content = 'Not the reserved source';
  await assert.rejects(runPreservedHistoryImport({ ...options, allowCreate: false, metadata, historyId, prepared: corrupted }), { code: 'history-source-conflict' });
  const mutable = structuredClone(prepared);
  const unchangedReplay = runPreservedHistoryImport({ ...options, allowCreate: false, metadata, historyId, prepared: mutable });
  mutable.entries[0].message.content = 'Changed while native work awaited';
  assert.deepEqual(await unchangedReplay, completed);
  const secondPrepared = preparePreservedHistoryMessages({ sourceManifestSha256: 'a'.repeat(64), channel: {
    channel: { id: 'fictional-second' }, messages: [{ id: 'fictional-second-message', channel_id: 'fictional-second',
      author: { id: 'fictional-person', username: 'Fictional person' }, timestamp: '2026-01-02T00:00:00.000Z', content: 'Preserve this', attachments: [] }], reactions: [] }, attachments: [] });
  const second = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: { ...reservation.intent,
    sourceChannelId: secondPrepared.sourceChannelId, sourceDigest: secondPrepared.sourceDigest } }, () => {});
  await assert.rejects(runPreservedHistoryImport({ ...options, metadata, historyId: second.historyId, prepared: secondPrepared,
    afterNativeAppend: () => { interrupted = true; throw Object.assign(new Error('lost response'), { code: 'fictional-interruption' }); } }), { code: 'fictional-interruption' });
  assert.equal(interrupted, true);
  assert.equal(metadata.getImportedHistory(second.historyId).verifiedCount, 0);
  const resumed = await runPreservedHistoryImport({ ...options, allowCreate: false, metadata, historyId: second.historyId, prepared: secondPrepared });
  assert.equal(resumed.phase, 'verified');
  assert.equal((await transcripts.readVisibleSessionTranscriptMessageEntries({ ...second.target, storePath })).length, 1);
  assert.deepEqual(sessionStore.getSessionEntry({ ...primary, readConsistency: 'latest' }), originalPrimary);
  metadata.setTopicName({ topicId: 'fictional-topic', name: 'Renamed Fictional Topic', expectedRevision: 0 });
  assert.deepEqual(await runPreservedHistoryImport({ ...options, allowCreate: false, metadata, historyId, prepared }), completed);
  const unknownPrepared = preparePreservedHistoryMessages({ sourceManifestSha256: 'a'.repeat(64), channel: {
    channel: { id: 'fictional-unknown-creation' }, messages: [], reactions: [] }, attachments: [] });
  const unknown = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: { ...reservation.intent,
    sourceChannelId: unknownPrepared.sourceChannelId, sourceDigest: unknownPrepared.sourceDigest, expectedCount: 0, topicId: null, expectedTopicRevision: null } }, () => {});
  const unknownDispatch = metadata.dispatchImportedHistoryCreation({ historyId: unknown.historyId, logicalOperationId: unknown.logicalOperationId, expectedRevision: 1 }, () => {});
  // Once dispatch is durable, a missing target could have been created/deleted.
  // Even an execution retry cannot reacquire permission to create it.
  await assert.rejects(runPreservedHistoryImport({ ...options, allowCreate: true, metadata, historyId: unknown.historyId, prepared: unknownPrepared }), { code: 'history-creation-unknown' });
  assert.equal(sessionStore.getSessionEntry({ ...unknown.target, storePath, readConsistency: 'latest' }), undefined);
  assert.deepEqual(metadata.getImportedHistory(unknown.historyId), unknownDispatch);
});

test('a signed export imports two Topic histories and an empty reporting history with exact accounting', { timeout: 120_000 }, async t => {
  const { importDiscordPreservation } = await import('../../src/migration/preserved-history-batch.mjs');
  const channelIds = ['fictional-alpha', 'fictional-beta', 'fictional-empty-report'];
  const channels = channelIds.map(id => ({ id, name: id, type: 0 }));
  const attachment = Buffer.from('Fictional receipt bytes.\n');
  const messages = channelIds.map((id, index) => index === 2 ? [] : [{ id: `${id}-message`, channel_id: id,
    author: { id: `fictional-author-${index}`, username: 'Fictional author', bot: index === 1 }, timestamp: '2026-01-01T00:00:00.000000+00:00',
    content: index === 0 ? 'Preserve this receipt.' : '', embeds: index === 1 ? [{ description: 'Fictional embedded report.' }] : [],
    attachments: index === 0 ? [{ id: 'fictional-attachment', filename: 'receipt.txt', size: 100 }] : [] }]);
  const baseline = { guildStructureCount: 3, guildTextChannelCount: 3, messageCount: 2, attachmentCount: 1 };
  const summary = { ...baseline, discoveredThreadCount: 0, reactionCount: 0,
    channelReceipts: channels.map((channel, index) => ({ id: channel.id, messageCount: messages[index].length,
      firstMessageId: messages[index][0]?.id ?? null, lastMessageId: messages[index].at(-1)?.id ?? null })),
    attachments: [{ id: 'fictional-attachment', channelId: channelIds[0], messageId: messages[0][0].id, path: 'attachments/receipt.txt',
      bytes: attachment.length, sha256: createHash('sha256').update(attachment).digest('hex'), declaredBytes: 100, sizeMatches: false }] };
  const files = new Map([['channels.json', Buffer.from(JSON.stringify(channels))], ['threads.json', Buffer.from('{"threads":[],"endpointReceipts":[]}')], ['attachments/receipt.txt', attachment]]);
  channels.forEach((channel, index) => {
    files.set(`messages/${channel.id}.jsonl`, Buffer.from(messages[index].map(message => JSON.stringify(message) + '\n').join('')));
    files.set(`messages/${channel.id}.reactions.json`, Buffer.from('[]'));
  });
  const source = await createPreservationFixture(t, { files, baseline, summary });
  source.options.attachmentDispositions = [{ schemaVersion: 1, disposition: 'preserved-export-bytes', status: 'declared-representation-unverified',
    sourceManifestSha256: source.options.expectedManifestSha256, trustedPublicKeySha256: source.options.trustedPublicKeySha256,
    channelId: channelIds[0], messageId: messages[0][0].id, attachmentId: 'fictional-attachment', path: 'attachments/receipt.txt',
    storedBytes: 25, storedSha256: createHash('sha256').update(attachment).digest('hex'), declaredBytes: 100,
    declaredAttachmentSha256: createHash('sha256').update(JSON.stringify(messages[0][0].attachments[0])).digest('hex') }];
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'signed-metadata'), capabilities: { sessions: true } });
  t.after(() => metadata.close());
  metadata.createTopic({ topicId: 'fictional-signed-topic', name: 'Fictional Signed Topic', paraCategory: 'area', lifecycle: 'active' });
  const mappings = channelIds.map((sourceChannelId, index) => ({ sourceChannelId, logicalOperationId: randomUUID(), agentId: 'main',
    topicId: index < 2 ? 'fictional-signed-topic' : null, expectedTopicRevision: index < 2 ? 0 : null }));
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const transcripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
  // Exercise the same storage-neutral agent resolution used by activation,
  // rather than requiring an injected reader with a private test store path.
  const storePath = sessionStore.resolveStorePath(undefined, { agentId: 'main' });
  const options = { metadata, mappings, sourceOptions: source.options, sessionStore, transcripts, storePath, config: {}, assertCurrent: () => {} };
  // Admission and reconcile-only modes must not start a fresh import.
  await assert.rejects(importDiscordPreservation({ ...options, mode: 'execute', sourceOptions: { ...source.options, trustedPublicKeySha256: '0'.repeat(64) } }), { code: 'preservation-trust-mismatch' });
  await assert.rejects(importDiscordPreservation({ ...options, mode: 'execute', mappings: mappings.slice(1) }), { code: 'history-mapping-incomplete' });
  await assert.rejects(importDiscordPreservation({ ...options, mode: 'resume' }), { code: 'history-reservation-missing' });
  await assert.rejects(importDiscordPreservation({ ...options, mode: 'verify' }), { code: 'history-reservation-missing' });
  assert.deepEqual(metadata.listImportedHistories(), []);
  // A reservation committed before native creation was dispatched is resumable.
  const firstPrepared = preparePreservedHistoryMessages({ sourceManifestSha256: source.options.expectedManifestSha256,
    channel: { channel: channels[0], messages: messages[0], reactions: [] },
    attachments: summary.attachments.map(row => ({ ...row, preservationDisposition: source.options.attachmentDispositions[0] })) });
  metadata.beginImportedHistory({ logicalOperationId: mappings[0].logicalOperationId, intent: {
    schemaVersion: 1, sourceManifestSha256: source.options.expectedManifestSha256, trustedPublicKeySha256: source.options.trustedPublicKeySha256,
    sourceChannelId: channelIds[0], sourceDigest: firstPrepared.sourceDigest, expectedCount: 1,
    agentId: 'main', topicId: 'fictional-signed-topic', expectedTopicRevision: 0
  } }, () => {});
  // Lose the first native append response before local progress is recorded.
  // Retrying the same batch may continue later channels, but must not duplicate
  // the already committed first message or replace its reserved identity.
  await assert.rejects(importDiscordPreservation({ ...options, mode: 'execute', afterNativeAppend: () => {
    throw Object.assign(new Error('Fictional lost batch response'), { code: 'fictional-batch-interruption' });
  } }), { code: 'fictional-batch-interruption' });
  const interrupted = metadata.listImportedHistories();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].verifiedCount, 0);
  assert.equal((await transcripts.readVisibleSessionTranscriptMessageEntries({ ...interrupted[0].target, storePath })).length, 1);
  await assert.rejects(importDiscordPreservation({ ...options, mode: 'verify' }), { code: 'history-incomplete' });
  assert.deepEqual(metadata.listImportedHistories(), interrupted);
  const result = await importDiscordPreservation({ ...options, mode: 'execute' });
  assert.deepEqual(result.accounting, { sourceChannels: 3, verifiedHistories: 3, sourceMessages: 2, verifiedMessages: 2, sourceAttachments: 1, attachmentServingVerified: false });
  assert.deepEqual(result.attachmentCoverage, { preservedExportBytesVerified: 1, declaredSizeMatched: 0, declaredRepresentationUnverified: 1 });
  assert.equal(metadata.listTopics().length, 1);
  for (let index = 0; index < result.histories.length; index++) {
    const history = result.histories[index];
    assert.equal(history.phase, 'verified');
    const visible = await transcripts.readVisibleSessionTranscriptMessageEntries({ ...history.target, storePath });
    assert.deepEqual(visible.map(entry => entry.message.__openclaw.importedHistoryV1.rawMessage), messages[index]);
  }
  assert.equal(result.histories[2].transcriptGeneration, null);
  assert.deepEqual((await importDiscordPreservation({ ...options, mode: 'verify' })).histories, result.histories);
  const { createPreservedHistoryReader } = await import('../../src/migration/preserved-history-read.mjs');
  const reader = await createPreservedHistoryReader(options);
  const catalog = await reader.list({ schemaVersion: 1 }, () => {});
  assert.equal(catalog.histories.length, 3);
  assert.equal((await reader.list({ schemaVersion: 1, topicId: 'fictional-signed-topic' }, () => {})).histories.length, 2);
  const page = await reader.read({ schemaVersion: 1, historyId: result.histories[0].historyId, offset: 0, limit: 1 }, () => {});
  assert.equal(page.messages[0].text, 'Preserve this receipt.');
  assert.equal(page.messages[0].author, 'Fictional author');
  assert.equal(page.totalMessages, 1);
  assert.equal(page.hasMore, false);
  const file = page.messages[0].attachments[0];
  assert.equal(file.preservationStatus, 'declared-representation-unverified');
  assert.equal(file.declaredBytes, 100);
  const downloaded = await reader.attachmentRead({ schemaVersion: 1, historyId: page.historyId,
    messageId: page.messages[0].messageId, attachmentId: file.attachmentId, offset: 0 }, () => {});
  assert.deepEqual(Buffer.from(downloaded.contentBase64, 'base64'), attachment);
  assert.equal(downloaded.complete, true);
  assert.equal(downloaded.revision, file.revision);
  assert.equal(downloaded.preservationStatus, 'declared-representation-unverified');
  const report = await reader.read({ schemaVersion: 1, historyId: result.histories[2].historyId }, () => {});
  assert.deepEqual(report.messages, []);
  assert.equal(report.totalMessages, 0);
  assert.deepEqual(metadata.listImportedHistories(), [...result.histories].sort((a, b) => a.logicalOperationId.localeCompare(b.logicalOperationId)));
  const { createMetadataService } = await import('../../src/plugin-service.mjs');
  const { registerBridgeMethods } = await import('../../src/bridge/register.mjs');
  const methods = new Map();
  // Resolve the production loader to the actual explicitly selected host SDK;
  // no reader, source owner or native implementation is substituted.
  const sdkEntries = new Map(['openclaw/plugin-sdk/session-store-runtime', 'openclaw/plugin-sdk/session-transcript-runtime']
    .map(specifier => [specifier, pathToFileURL(require.resolve(specifier)).href]));
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    return sdkEntries.has(specifier) ? { url: sdkEntries.get(specifier), shortCircuit: true } : nextResolve(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const api = { config: {}, pluginConfig: { preservedHistorySource: structuredClone(source.options) }, logger: {},
    runtime: { state: { resolveStateDir: () => path.join(stateDir, 'signed-metadata') }, agent: { session: { listSessionEntries: () => [] } } } };
  const activation = createMetadataService(api);
  t.after(() => activation.stop());
  await activation.start();
  api.pluginConfig.preservedHistorySource.expectedManifestSha256 = '0'.repeat(64);
  const service = activation.sourceService;
  registerBridgeMethods({ registerGatewayMethod: (method, handler, contract) => methods.set(method, { handler, contract }) }, service);
  const connection = new AbortController();
  const client = { connId: 'fictional-read-connection', connect: { role: 'operator', scopes: ['operator.read'] }, connectionSignal: connection.signal };
  const readRpc = async (method, params) => {
    let response;
    await methods.get(method).handler({ req: { id: 'fictional-read-request' }, params, client,
      context: { authenticated: true, isConnectionActive: id => id === client.connId },
      respond: (ok, payload, error) => { response = { ok, payload, error }; } });
    return response;
  };
  assert.equal(methods.get('command-center.v1.histories.list').contract.scope, 'operator.read');
  const rpcCatalog = await readRpc('command-center.v1.histories.list', { schemaVersion: 1 });
  assert.equal(rpcCatalog.ok, true, JSON.stringify(rpcCatalog.error));
  assert.equal(rpcCatalog.payload.result.histories.length, 3);
  const rpcPage = await readRpc('command-center.v1.histories.read', { schemaVersion: 1, historyId: page.historyId });
  assert.equal(rpcPage.ok, true);
  assert.equal(rpcPage.payload.result.messages[0].text, 'Preserve this receipt.');
  const rpcFile = await readRpc('command-center.v1.histories.attachment-read', { schemaVersion: 1, historyId: page.historyId,
    messageId: page.messages[0].messageId, attachmentId: file.attachmentId, offset: 0 });
  assert.deepEqual(Buffer.from(rpcFile.payload.result.contentBase64, 'base64'), attachment);
  const mutableRead = { schemaVersion: 1, historyId: page.historyId };
  const pendingRead = reader.read(mutableRead, () => {});
  mutableRead.historyId = result.histories[1].historyId;
  assert.deepEqual((await pendingRead).messages[0].attachments, page.messages[0].attachments);
  const mutableServiceRead = { schemaVersion: 1, historyId: page.historyId };
  const pendingServiceRead = service.historiesRead(mutableServiceRead, { assertCurrent: () => {} });
  mutableServiceRead.historyId = result.histories[1].historyId;
  assert.equal((await pendingServiceRead).historyId, page.historyId);
  const pendingRevoked = readRpc('command-center.v1.histories.read', { schemaVersion: 1, historyId: page.historyId });
  client.connect.scopes = [];
  const revoked = await pendingRevoked;
  assert.equal(revoked.ok, false);
  assert.equal(revoked.payload, null);
  client.connect.scopes = ['operator.read'];
  const invalidSelector = await readRpc('command-center.v1.histories.attachment-read', { schemaVersion: 1, historyId: page.historyId,
    messageId: page.messages[0].messageId, attachmentId: file.attachmentId, offset: 0, path: 'attachments/receipt.txt' });
  assert.equal(invalidSelector.ok, false);
  assert.equal(invalidSelector.error.code, 'invalid-request');
  await assert.rejects(reader.attachmentRead({ schemaVersion: 1, historyId: page.historyId,
    messageId: page.messages[0].messageId, attachmentId: file.attachmentId, offset: 1, observedRevision: 'changed' }, () => {}), { code: 'history-source-conflict' });
  const { verifyPreservedHistoryBrowser } = await import('./preserved-history-browser.mjs');
  await verifyPreservedHistoryBrowser(readRpc);
  connection.abort();
  const refused = await readRpc('command-center.v1.histories.read', { schemaVersion: 1, historyId: page.historyId });
  assert.equal(refused.ok, false);
  assert.equal(refused.payload, null);
  const retiredRead = service.historiesRead({ schemaVersion: 1, historyId: page.historyId }, { assertCurrent: () => {} });
  const retired = assert.rejects(retiredRead, error => ['capability-unavailable', 'unauthenticated'].includes(error.code));
  await activation.stop();
  await retired;
});

test('actual process death after native append resumes without duplicates or changing Primary/main', { timeout: 180_000 }, async t => {
  const owned = [];
  function own(child) {
    const record = { child, closed: false, settled: null };
    const expire = phase => { t.diagnostic(`${phase} deadline exceeded`); child.kill('SIGKILL'); };
    // Mounted-checkout SDK import alone measured 47 seconds. Bootstrap has a
    // separate bound; the native crash/recovery budget remains 45 seconds.
    let timer = setTimeout(() => expire('SDK bootstrap'), 120_000);
    child.on('message', message => {
      if (message?.phase === 'sdk-ready') { clearTimeout(timer); timer = setTimeout(() => expire('Native crash/recovery'), 45_000); }
    });
    record.settled = new Promise(resolve => child.once('close', () => { clearTimeout(timer); record.closed = true; resolve(); }));
    owned.push(record);
    return child;
  }
  t.after(async () => {
    for (const record of owned) {
      if (!record.closed && record.child.pid && record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
      await record.settled;
    }
  });
  const env = { ...process.env, COMMAND_CENTER_REHEARSAL_STATE_DIR: path.join(process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR, 'crash-case') };
  const fixture = fileURLToPath(new URL('./preserved-history-crash-child.mjs', import.meta.url));
  let reachedBoundary = false;
  const crash = own(spawn(process.execPath, [fixture, 'crash'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  let errorText = '';
  crash.stderr.on('data', chunk => { errorText += chunk; });
  crash.on('message', message => {
    if (message?.boundary === 'native-appended-before-checkpoint') {
      reachedBoundary = true;
      env.COMMAND_CENTER_REHEARSAL_BASELINE = JSON.stringify(message.originals);
      crash.kill('SIGKILL');
    }
  });
  const killed = await new Promise((resolve, reject) => { crash.once('error', reject); crash.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(reachedBoundary, true, errorText);
  assert.equal(killed.signal, 'SIGKILL', errorText);
  const resume = own(spawn(process.execPath, [fixture, 'resume'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  let output = '';
  resume.stdout.on('data', chunk => { output += chunk; });
  resume.stderr.on('data', chunk => { output += chunk; });
  const resumed = await new Promise((resolve, reject) => { resume.once('error', reject); resume.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(resumed, { code: 0, signal: null }, output);
  assert.match(output, /verified crash recovery/);
});
