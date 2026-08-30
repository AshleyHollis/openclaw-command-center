import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { sourceOccurrenceId } from '../src/migration/occurrence.mjs';

const fixturePath = new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname;
const config = { schemaVersion: 1, exportPath: fixturePath, channels: [{ channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-provenance', paraCategory: 'project', noteFolderPath: '/fictional/vault/provenance' }] };
function runtime() {
  const sessions = new Map();
  return { sessions,
    async appendSessionTranscriptMessageByIdentityStrict(params) { const events = sessions.get(params.sessionKey) ?? []; events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message }); sessions.set(params.sessionKey, events); return { kind: 'result', result: { messageId: params.eventId, appended: true } }; },
    async withSessionTranscriptWriteLock(target, run) { return run({ readEvents: async () => sessions.get(target.sessionKey) ?? [], publishUpdate: async () => undefined }); }, async readVisibleSessionTranscriptMessageEntries({ sessionKey }) { return sessions.get(sessionKey) ?? []; }
  };
}

test('imported prefix preserves Discord provenance and ordinary messages remain distinct', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-provenance-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const transcripts = runtime();
    const gateway = { request: async (method, params) => {
      if (method === 'sessions.list') return [...transcripts.sessions.keys()].map((sessionKey) => ({ ['k' + 'ey']: sessionKey, sessionId: 'fictional-session-provenance' }));
      if (method === 'chat.send') {
        const events = transcripts.sessions.get(params.sessionKey);
        events.push({ id: params.idempotencyKey, parentId: events.at(-1).id, message: { role: 'user', text: params.message, idempotencyKey: params.idempotencyKey } });
        return { runId: params.idempotencyKey };
      }
      return { ['k' + 'ey']: params.key, sessionId: 'fictional-session-provenance' };
    } };
    const service = createLegacyDiscordMigrationService({ metadata, config, gateway, transcriptRuntime: transcripts, folderVerifier: async () => undefined });
    assert.equal((await service.start()).complete, true);
    const reference = metadata.listSourceReferences('fictional-topic-provenance').find((item) => item.sourceKind === 'session');
    const events = transcripts.sessions.get(reference.externalSourceId);
    assert.equal(events.length, 2);
    const first = events[0].message;
    assert.equal(first.role, 'user');
    assert.equal(first.text, 'Fictional opening message.');
    assert.equal(first.timestamp, '2026-08-20T10:00:00.000Z');
    assert.equal(first.__openclaw.senderId, 'fictional-user-001');
    assert.equal(first.__openclaw.senderName, 'Fictional Ada');
    assert.equal(first.__openclaw.legacyDiscordV1.immutable, true);
    assert.equal(first.__openclaw.legacyDiscordV1.occurrenceId, sourceOccurrenceId('fictional-channel-alpha', 'fictional-message-001'));
    assert.equal(first.__openclaw.legacyDiscordV1.timestamp, '2026-08-20T10:00:00.000Z');
    assert.equal(first.__openclaw.legacyDiscordV1.replyToMessageId, null);
    assert.equal(first.__openclaw.legacyDiscordV1.thread.id, 'fictional-thread-001');
    assert.equal(first.__openclaw.legacyDiscordV1.attachments[0].url, 'https://fictional.invalid/link.txt');
    assert.equal(first.__openclaw.media, undefined);
    assert.equal(events[1].message.__openclaw.legacyDiscordV1.replyToMessageId, 'fictional-message-001');
    assert.notEqual(first.__openclaw.legacyDiscordV1.occurrenceId, events[1].message.__openclaw.legacyDiscordV1.occurrenceId);
    const importedSnapshot = structuredClone(events);
    const sources = createAuthoritativeSourceService({ metadata, migration: service, gateway, capabilities: { sessions: true } });
    const logicalOperationId = crypto.randomUUID();
    const registrations = new Map();
    registerBridgeMethods({ registerGatewayMethod: (method, handler) => registrations.set(method, handler) }, sources);
    let bridgeResponse;
    await registrations.get('command-center.v1.sessions.send')({ req: { id: 'fictional-authenticated-suffix-request' }, params: { schemaVersion: 1, topicId: 'fictional-topic-provenance', referenceId: reference.referenceId, logicalOperationId, message: 'Fictional ordinary suffix.' }, context: { authenticated: true }, respond: (...args) => { bridgeResponse = args; } });
    assert.equal(bridgeResponse[0], true);
    assert.equal(bridgeResponse[1].logicalOperationId, logicalOperationId);
    assert.deepEqual(events.slice(0, 2), importedSnapshot);
    assert.equal(events.length, 3);
    assert.equal(events[2].parentId, events[1].id);
    assert.equal(events[2].message.__openclaw?.legacyDiscordV1, undefined);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
