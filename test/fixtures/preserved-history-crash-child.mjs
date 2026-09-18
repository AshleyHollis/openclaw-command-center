import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { preparePreservedHistoryMessages } from '../../src/migration/preserved-history-transcript.mjs';
import { runPreservedHistoryImport } from '../../src/migration/preserved-history-import.mjs';

const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
assert.ok(stateDir && process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE, 'explicit isolated fixture configuration is required');
assert.ok(['crash', 'resume'].includes(process.argv[2]));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
const require = createRequire(process.env.COMMAND_CENTER_REHEARSAL_HOST_PACKAGE);
const sessionStore = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
const transcripts = await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-transcript-runtime')).href);
process.send?.({ phase: 'sdk-ready' });
const metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { sessions: true } });
const storePath = path.join(stateDir, 'sessions.json');
const prepared = preparePreservedHistoryMessages({ sourceManifestSha256: 'a'.repeat(64), channel: {
  channel: { id: 'fictional-crash-channel' }, messages: [1, 2].map(index => ({ id: `fictional-message-${index}`, channel_id: 'fictional-crash-channel',
    author: { id: 'fictional-person', username: 'Fictional person' }, timestamp: `2026-01-0${index}T00:00:00.000Z`,
    content: `Preserved message ${index}`, attachments: [] })), reactions: [] }, attachments: [] });
try {
  if (process.argv[2] === 'crash') {
    assert.equal(metadata.listImportedHistories().length, 0);
    for (const name of ['primary', 'main']) {
      await sessionStore.patchSessionEntry({ agentId: 'main', sessionKey: `agent:main:${name}`, storePath,
        fallbackEntry: { sessionId: `fictional-existing-${name}`, updatedAt: 1 }, preserveActivity: true, update: entry => entry });
      const seeded = await transcripts.appendSessionTranscriptMessageByIdentityStrict({ agentId: 'main', sessionKey: `agent:main:${name}`,
        sessionId: `fictional-existing-${name}`, storePath, config: {}, eventId: `fictional-existing-${name}-message`,
        message: { role: 'user', content: `Existing ${name} conversation — keep this history.`, timestamp: 1767225600000 }, now: 1767225600000 });
      assert.equal(seeded.kind, 'result');
    }
    metadata.reserveImportedHistory({ logicalOperationId: '7dd05358-3734-4317-86f0-e7d34d823889', intent: {
      schemaVersion: 1, sourceManifestSha256: 'a'.repeat(64), trustedPublicKeySha256: 'b'.repeat(64),
      sourceChannelId: prepared.sourceChannelId, sourceDigest: prepared.sourceDigest, expectedCount: 2,
      agentId: 'main', topicId: null, expectedTopicRevision: null } }, () => {});
  }
  const reservation = metadata.listImportedHistories()[0];
  assert.ok(reservation);
  const originals = process.argv[2] === 'crash' ? Object.fromEntries(['primary', 'main'].map(name => [name,
    sessionStore.getSessionEntry({ agentId: 'main', sessionKey: `agent:main:${name}`, storePath, readConsistency: 'latest' })]))
    : JSON.parse(process.env.COMMAND_CENTER_REHEARSAL_BASELINE);
  if (process.argv[2] === 'resume') {
    assert.equal(reservation.phase, 'importing');
    assert.equal(reservation.verifiedCount, 0);
    assert.equal((await transcripts.readVisibleSessionTranscriptMessageEntries({ ...reservation.target, storePath })).length, 1);
  }
  const result = await runPreservedHistoryImport({ metadata, historyId: reservation.historyId, prepared, sessionStore, transcripts, storePath,
    config: {}, allowCreate: process.argv[2] === 'crash', assertCurrent: () => {},
    afterNativeAppend: process.argv[2] === 'crash' ? async ({ index }) => {
      assert.equal(index, 0);
      assert.ok(process.send, 'crash fixture requires parent IPC');
      process.send({ boundary: 'native-appended-before-checkpoint', originals });
      await new Promise(() => {});
    } : undefined });
  assert.equal(result.phase, 'verified');
  const visible = await transcripts.readVisibleSessionTranscriptMessageEntries({ ...reservation.target, storePath });
  assert.deepEqual(visible.map(entry => entry.message.content), ['Preserved message 1', 'Preserved message 2']);
  for (const name of ['primary', 'main']) {
    const existing = sessionStore.getSessionEntry({ agentId: 'main', sessionKey: `agent:main:${name}`, storePath, readConsistency: 'latest' });
    assert.deepEqual(existing, originals[name]);
    const history = await transcripts.readVisibleSessionTranscriptMessageEntries({ agentId: 'main', sessionKey: `agent:main:${name}`, sessionId: existing.sessionId, storePath });
    assert.deepEqual(history.map(entry => entry.message.content), [`Existing ${name} conversation — keep this history.`]);
  }
  console.log('verified crash recovery: two exact messages, no duplicates, existing Primary/main unchanged');
} finally { metadata.close(); }
