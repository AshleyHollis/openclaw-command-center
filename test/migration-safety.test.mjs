import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createLegacyDiscordMigrationService } from '../src/migration/service.mjs';

const fixturePath = new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url).pathname;
test('attachment metadata is retained as provenance without binary, media, or network work', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-migration-safety-'));
  let metadata;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('network must not be used'); };
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    const messages = [];
    const events = [];
    const runtime = { async appendSessionTranscriptMessageByIdentityStrict(params) { messages.push(params.message); events.push({ id: params.eventId, parentId: params.parentId ?? null, message: params.message }); return { kind: 'result', result: { messageId: params.eventId, appended: true } }; }, async withSessionTranscriptWriteLock(_target, run) { return run({ readEvents: async () => events, publishUpdate: async () => undefined }); }, async readVisibleSessionTranscriptMessageEntries() { return events; } };
    const service = createLegacyDiscordMigrationService({ metadata, config: { schemaVersion: 1, exportPath: fixturePath, channels: [{ channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-safety', paraCategory: 'resource', noteFolderPath: '/fictional/vault/safety' }] }, gateway: { request: async (_method, params) => ({ ['k' + 'ey']: params.key, sessionId: 'fictional-safety' }) }, transcriptRuntime: runtime, folderVerifier: async () => undefined });
    assert.equal((await service.start()).complete, true);
    assert.equal(fetches, 0);
    assert.equal(messages[0].__openclaw.media, undefined);
    assert.equal(messages[0].__openclaw.legacyDiscordV1.attachments[0].url, 'https://fictional.invalid/link.txt');
    assert.equal(messages[0].__openclaw.legacyDiscordV1.attachments[0].sizeBytes, 42);
  } finally { globalThis.fetch = originalFetch; metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
