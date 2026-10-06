import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createCommitmentCaptureService } from '../src/open-loops/commitment-capture.mjs';
import { commitmentCaptureToolFactory } from '../src/open-loops/commitment-tool.mjs';
import { sourceCommitmentCaptureToolFactory } from '../src/open-loops/source-intake-tool.mjs';

const originalTime = '2026-09-20T01:00:00.000Z';
const chatContext = { sessionKey: 'agent:main:fictional', sessionId: 'session-fictional' };
const params = { title: 'Research fictional storage', obligationId: 'fictional-storage', provenance: 'explicit' };
const sourceParams = { ...params, topicId: 'topic-fictional', sourceKind: 'email', sourceExternalId: 'fictional-message', sourceVersion: 'message-v1', sourceReferenceId: 'note:fictional', sourcePath: 'Inbox/Fictional.md', sourceReferenceVersion: 'note-v1' };

function legacyOperationId(parts, version) {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

for (const kind of ['chat', 'email']) {
  test(`${kind} tool replays a legacy receipt at a later clock after SQLite reopen and refuses changed intent`, async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-tool-replay-'));
    let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    const sourceService = {
      sessionTopicContext: async () => ({ status: 'bound', sessionId: chatContext.sessionId, topicId: 'topic-fictional' }),
      notesRead: async () => ({ revision: 'note-v1' })
    };
    try {
      metadata.createTopic({ topicId: 'topic-fictional', paraCategory: 'area', lifecycle: 'active', createdAt: originalTime, updatedAt: originalTime });
      metadata.createSourceReference({ version: 1, referenceId: 'note:fictional', topicId: 'topic-fictional', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/Inbox/Fictional.md', observedRevision: 'note-v1' });
      const logicalOperationId = kind === 'chat'
        ? legacyOperationId(['command-center.capture.v1', chatContext.sessionKey, chatContext.sessionId, 'original-call'], '5')
        : legacyOperationId(['command-center.source-capture.v1', 'email', sourceParams.sourceExternalId, sourceParams.sourceVersion, params.obligationId], '4');
      // Seed the exact pre-fix owner input, including its original timestamped
      // intent digest. Replays must work without rewriting existing receipts.
      const legacyInput = {
        schemaVersion: 1, logicalOperationId,
        ...(kind === 'chat' ? { ...params, topicId: 'topic-fictional', sourceKind: 'chat', sourceExternalId: chatContext.sessionKey, sourceVersion: `tool:${logicalOperationId}` } : sourceParams),
        occurredAt: originalTime, observedAt: originalTime, historicalBaseline: false
      };
      const original = await createCommitmentCaptureService({ metadata, sourceService }).capture(legacyInput);
      metadata.close();
      metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse(originalTime) + 86_400_000 });
      const tool = kind === 'chat'
        ? commitmentCaptureToolFactory({ getOwners: () => ({ metadata, sourceService }) })(chatContext)
        : sourceCommitmentCaptureToolFactory({ getOwners: () => ({ metadata, sourceService }) })();
      const selectedParams = kind === 'chat' ? params : sourceParams;
      // The source tool intentionally receives a changed transport call ID.
      const callId = kind === 'chat' ? 'original-call' : 'new-transport-call';
      const replay = await tool.execute(callId, selectedParams);
      assert.deepEqual(replay.details, original);
      t.mock.timers.tick(60_000);
      assert.deepEqual((await tool.execute(callId, selectedParams)).details, original);
      await assert.rejects(() => tool.execute(callId, { ...selectedParams, title: 'Different fictional request' }), error => error.code === 'open-loop-intent-mismatch');
      await assert.rejects(() => tool.execute(callId, { ...selectedParams, provenance: 'idea' }), error => error.code === 'open-loop-intent-mismatch');
      assert.equal(metadata.listOpenLoops().length, 1);
      assert.equal(metadata.listOpenLoopObservations().length, 1);
      assert.equal(metadata.getOpenLoop(original.loop.loopId).revision, original.loop.revision);
      if (kind === 'chat') {
        sourceService.sessionTopicContext = async () => ({ status: 'unbound' });
        await assert.rejects(() => tool.execute(callId, selectedParams), error => error.code === 'source-recovery');
      } else {
        sourceService.notesRead = async () => { throw new Error('fictional-note-authority-revoked'); };
        await assert.rejects(() => tool.execute(callId, selectedParams), /fictional-note-authority-revoked/u);
      }
    } finally {
      metadata.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
