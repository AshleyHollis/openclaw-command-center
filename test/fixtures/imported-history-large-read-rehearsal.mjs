import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('a 1,415-message Imported History page is bounded and leaves health work responsive', { timeout: 600_000 }, async t => {
  const expectLegacyScan = process.env.COMMAND_CENTER_EXPECT_LEGACY_SCAN === '1';
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir, 'parent-owned isolated state is required');
  assert.ok(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE, 'explicit isolated host is required');
  const implementationRoot = process.env.COMMAND_CENTER_REHEARSAL_IMPLEMENTATION_ROOT
    ? path.resolve(process.env.COMMAND_CENTER_REHEARSAL_IMPLEMENTATION_ROOT)
    : fileURLToPath(new URL('../..', import.meta.url));
  const implementation = relative => import(pathToFileURL(path.join(implementationRoot, relative)).href);
  const [{ openCommandCenterMetadataService }, { readNativeHistoryInventory }, { runPreservedHistoryImport }, { createPreservedHistoryReader }] = await Promise.all([
    implementation('src/metadata/service.mjs'), implementation('src/migration/native-history-source.mjs'),
    implementation('src/migration/preserved-history-import.mjs'), implementation('src/migration/preserved-history-read.mjs')
  ]);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
  const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
  const nativeTranscripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
  const sourceRoot = path.join(stateDir, 'source');
  await mkdir(sourceRoot);
  const count = 1_415;
  const records = [{ type: 'session', id: 'fictional-large-session', version: 3, timestamp: '2026-01-01T00:00:00.000Z' }];
  for (let index = 0; index < count; index += 1) {
    records.push({
      type: 'message', id: `fictional-entry-${String(index).padStart(4, '0')}`,
      parentId: index === 0 ? null : `fictional-entry-${String(index - 1).padStart(4, '0')}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `Fictional preserved message ${index}` }
    });
  }
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const file = { name: 'fictional-large-session.jsonl.bak-123-456', sizeBytes: bytes.length, sha256: hash(bytes) };
  await writeFile(path.join(sourceRoot, file.name), bytes);
  const inventoryBytes = Buffer.from(JSON.stringify({ snapshot: '/fictional/backup', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fictional/agents/main/sessions', files: [file] }));
  await writeFile(path.join(sourceRoot, 'inventory.json'), inventoryBytes);
  const sourceOptions = { root: sourceRoot, expectedInventorySha256: hash(inventoryBytes), originalAgentId: 'main' };
  const prepared = (await readNativeHistoryInventory(sourceOptions)).histories[0];
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { sessions: true } });
  t.after(() => metadata.close());
  const reservation = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: {
    schemaVersion: 2, sourceKind: prepared.sourceKind, sourceInventorySha256: prepared.sourceInventorySha256,
    originalAgentId: prepared.originalAgentId, originalSessionId: prepared.originalSessionId, sourceFile: prepared.sourceFile,
    sourceDigest: prepared.sourceDigest, expectedCount: prepared.expectedCount, agentId: 'main', topicId: null, expectedTopicRevision: null
  } }, () => {});
  const storePath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
  await runPreservedHistoryImport({ metadata, historyId: reservation.historyId, prepared, sessionStore,
    transcripts: nativeTranscripts, storePath, config: {}, assertCurrent: () => {}, allowCreate: true });

  const counters = { pages: 0, replayAppends: 0 };
  const transcripts = {
    ...nativeTranscripts,
    async readSessionTranscriptVisibleMessageDelta(input) {
      counters.pages += 1;
      return nativeTranscripts.readSessionTranscriptVisibleMessageDelta(input);
    },
    async withSessionTranscriptWriteLock(input, run) {
      return nativeTranscripts.withSessionTranscriptWriteLock(input, locked => run({
        ...locked,
        async appendMessage(options) {
          counters.replayAppends += 1;
          return locked.appendMessage(options);
        }
      }));
    }
  };
  const reader = await createPreservedHistoryReader({ metadata, sessionStore, transcripts, storePath, config: {}, nativeSourceOptions: sourceOptions });
  const started = performance.now();
  const health = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 0));
  const [first, healthMs] = await Promise.all([
    reader.read({ schemaVersion: 1, historyId: reservation.historyId, limit: 50 }, () => {}),
    health
  ]);
  const firstMs = performance.now() - started;
  assert.equal(first.messages.length, 50);
  assert.equal(first.totalMessages, count);
  assert.equal(first.nextOffset, 50);
  if (expectLegacyScan) {
    assert.equal(counters.replayAppends, count);
    assert.ok(counters.pages >= Math.ceil(count / 200));
    t.diagnostic(JSON.stringify({ count, firstMs, healthMs, projectionPages: counters.pages, replayAppends: counters.replayAppends }));
    return;
  }
  assert.equal(counters.pages, 1);
  assert.equal(counters.replayAppends, 0);
  assert.ok(healthMs < 500, `health callback took ${healthMs.toFixed(1)}ms`);
  assert.ok(firstMs < 2_000, `first page took ${firstMs.toFixed(1)}ms`);

  const deepStarted = performance.now();
  const deep = await reader.read({ schemaVersion: 1, historyId: reservation.historyId, offset: 1_400, limit: 15 }, () => {});
  const deepMs = performance.now() - deepStarted;
  assert.equal(deep.messages.length, 15);
  assert.equal(JSON.parse(deep.messages[0].detailsJson).entry.id, 'fictional-entry-1400');
  assert.equal(deep.hasMore, false);
  assert.equal(counters.pages, 2);
  assert.equal(counters.replayAppends, 0);
  assert.ok(deepMs < 2_000, `deep page took ${deepMs.toFixed(1)}ms`);

  await nativeTranscripts.appendSessionTranscriptMessageByIdentity({
    ...reservation.target, storePath, eventId: 'fictional-foreign-entry',
    parentId: prepared.entries.at(-1).eventId,
    message: { role: 'user', content: 'Foreign append must invalidate the durable count proof' }
  });
  await assert.rejects(
    reader.read({ schemaVersion: 1, historyId: reservation.historyId, limit: 1 }, () => {}),
    { code: 'history-proof-conflict' }
  );
  await sessionStore.patchSessionEntry({ ...reservation.target, storePath, preserveActivity: true,
    update: () => ({ lifecycleRevision: 'fictional-rebound-owner' }) });
  await assert.rejects(
    reader.read({ schemaVersion: 1, historyId: reservation.historyId, limit: 1 }, () => {}),
    { code: 'history-destination-rebound' }
  );

  t.diagnostic(JSON.stringify({ count, firstMs, deepMs, healthMs, projectionPages: counters.pages, replayAppends: counters.replayAppends }));
});
