// Explicit isolated native-SDK regression, not release performance qualification.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createMigrationFixtureService } from './migration-folders.mjs';

test('native migration verifies a large unchanged history without a multi-second quadratic stall', { timeout: 120_000 }, async t => {
  const stateDir = process.env.COMMAND_CENTER_REHEARSAL_STATE_DIR;
  assert.ok(stateDir, 'run through the parent-owned isolated rehearsal launcher');
  const previousState = process.env.OPENCLAW_STATE_DIR;
  const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  let metadata;
  try {
    const sessionStore = await import('openclaw/plugin-sdk/session-store-runtime');
    const transcripts = await import('openclaw/plugin-sdk/session-transcript-runtime');
    const storePath = path.join(stateDir, 'configured-store', 'sessions.json');
    const fixture = JSON.parse(await readFile(new URL('./legacy-discord-export.v1.json', import.meta.url), 'utf8'));
    const channelId = 'fictional-startup-scale';
    const messages = Array.from({ length: 2_000 }, (_, index) => ({
      messageId: `fictional-startup-${index}`, displayOrder: index,
      author: { id: 'fictional-author', displayName: 'Fictional Author' },
      timestamp: new Date(Date.UTC(2026, 7, 20) + index).toISOString(),
      text: `Fictional preserved message ${index}.`, edits: [], replyToMessageId: null,
      reactions: [], thread: null, attachments: []
    }));
    fixture.channels = [{ channelId, displayName: 'Fictional Startup', messages }];
    const exportPath = path.join(stateDir, 'export.json');
    await writeFile(exportPath, JSON.stringify(fixture));
    metadata = openCommandCenterMetadataService({ stateDir: path.join(stateDir, 'metadata'), capabilities: { notes: true, sessions: true } });
    let verificationStarted;
    let originalEvents;
    let target;
    const service = createMigrationFixtureService({ metadata, sessionStore, transcriptRuntime: transcripts,
      api: { config: { session: { store: storePath } } },
      config: { schemaVersion: 1, exportPath, channels: [{ channelId, topicId: 'fictional-startup-topic', paraCategory: 'resource', noteFolderPath: '/fictional/vault/startup' }] },
      hooks: {
        afterPhase({ phase }) {
          if (phase !== 'importing') return;
          const row = metadata.getMigrationChannel(channelId);
          target = { storePath, agentId: 'main', sessionKey: metadata.getSourceReference(row.sessionReferenceId).externalSourceId, sessionId: row.sessionId };
          originalEvents = transcripts.readSessionTranscriptEvents(target);
        },
        afterVerify() { verificationStarted = performance.now(); }
      }
    });
    const result = await service.start();
    const verificationMs = performance.now() - verificationStarted;
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.equal(metadata.getMigrationCompletion().verifiedOccurrenceCount, 2_000);
    const events = await transcripts.readSessionTranscriptEvents(target);
    assert.deepEqual(events, await originalEvents, 'verification must not change native events or their identities');
    assert.equal((await transcripts.readVisibleSessionTranscriptMessageEntries(target)).length, 2_000);
    t.diagnostic(JSON.stringify({ verificationMs, occurrences: 2_000, performanceQualified: false }));
    // A generous regression ceiling for this isolated fixture, not a release SLA.
    // The real-host reproduction separately measures full startup and liveness.
    assert.ok(verificationMs < 10_000, `read-only verification stalled for ${Math.round(verificationMs)}ms`);
  } finally {
    metadata?.close();
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = previousConfig;
    // The parent removes state only after this SDK-owning process has exited.
  }
});
