import assert from 'node:assert/strict';
import test from 'node:test';
import { createProducerIntakeAdapter } from '../src/open-loops/producer-intake.mjs';

function harness({ failCapture = false } = {}) {
  const calls = { extract: [], save: [], source: [], chat: [], receipt: [] };
  const adapter = createProducerIntakeAdapter({
    now: (() => { let tick = 0; return () => `2026-09-21T00:0${tick++}:00.000Z`; })(),
    async extract(input) {
      calls.extract.push(input);
      if (input.rawText.includes('information only')) return { schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/information.md', knowledgeMarkdown: '# Information\n', obligations: [] };
      if (input.rawText.includes('uncertain topic')) return { schemaVersion: 1, proposedTopic: null, notePath: '', knowledgeMarkdown: '', obligations: [] };
      return { schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/invoice.md', knowledgeMarkdown: '# Fictional invoice\n', obligations: [
        { obligationId: 'invoice-42:payment', title: 'Pay the fictional invoice', provenance: 'explicit', dueAt: '2026-09-30T00:00:00.000Z', importance: 'high', importanceOrigin: 'source' },
        { obligationId: 'invoice-42:reply', title: 'Reply with the fictional remittance', provenance: 'explicit', importance: 'normal', importanceOrigin: 'processing' }
      ] };
    },
    async resolveTopic({ proposedTopic }) { return proposedTopic ? { topicId: 'topic-home', noteFolderReferenceId: 'folder-home' } : null; },
    async saveSourceNote(input) { calls.save.push(input); return { topicId: input.topicId, sourceReferenceId: 'note:fictional', sourcePath: input.path, sourceVersion: input.sourceVersion, replayed: calls.save.length > 1 }; },
    async captureSourceCommitment(input) { calls.source.push(input); if (failCapture && calls.source.length === 2) throw new Error('fictional-capture-failed'); return { status: 'applied' }; },
    async captureChatCommitment(input) { calls.chat.push(input); return { status: 'applied' }; },
    async recordIntakeReceipt(input) { calls.receipt.push(input); return { status: input.status }; }
  });
  return { adapter, calls };
}

test('email producer extracts natural-language input, saves evidence once and captures each distinct obligation', async () => {
  const { adapter, calls } = harness();
  const result = await adapter.process({ runId: 'email-run-1', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-42', sourceVersion: 'change-key-7', checkpoint: 'message-42', rawText: 'Please pay the fictional invoice and reply with remittance by 30 September.' }] });
  assert.deepEqual({ processed: result.processedCount, actionable: result.actionableCount, notes: result.noteCount }, { processed: 1, actionable: 2, notes: 1 });
  assert.equal(calls.extract.length, 1); assert.equal(calls.save.length, 1); assert.equal(calls.source.length, 2);
  assert.deepEqual(calls.source.map(call => call.obligationId), ['invoice-42:payment', 'invoice-42:reply']);
  assert.equal(calls.source.every(call => call.sourceReferenceId === 'note:fictional'), true);
  assert.deepEqual(calls.receipt.map(call => [call.status, call.checkpoint]), [['pending', 'start'], ['healthy-processed', 'message-42']]);
});

test('information-only input remains quiet and existing evidence is reused without manufacturing a Note', async () => {
  const { adapter, calls } = harness();
  await adapter.process({ runId: 'note-run-1', nextExpectedAt: '2026-09-28T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'note', sourceExternalId: 'note-1', sourceVersion: 'v1', checkpoint: 'note-1', rawText: 'information only', existingEvidence: { topicId: 'topic-home', sourceReferenceId: 'note:existing', sourcePath: 'Reference/existing.md', sourceVersion: 'v1' } }] });
  assert.equal(calls.save.length, 0); assert.equal(calls.source.length, 0); assert.equal(calls.receipt.at(-1).actionableCount, 0);
});

test('ambiguous Topic ownership creates no Note or obligation and remains visible in receipt counters', async () => {
  const { adapter, calls } = harness();
  const result = await adapter.process({ runId: 'email-run-ambiguous', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-uncertain', sourceVersion: 'v1', checkpoint: 'message-uncertain', rawText: 'uncertain topic' }] });
  assert.equal(result.uncertainCount, 1); assert.equal(calls.save.length, 0); assert.equal(calls.source.length, 0);
});

test('Chat commitments use the supported Chat capture boundary with exact existing evidence', async () => {
  const { adapter, calls } = harness();
  await adapter.process({ runId: 'chat-run-1', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'chat', sourceExternalId: 'session-1:message-9', sourceVersion: 'message-v1', checkpoint: 'message-9', rawText: 'Please pay the fictional invoice and reply.', existingEvidence: { topicId: 'topic-home', sourceReferenceId: 'session:1', sourcePath: 'message:9', sourceVersion: 'message-v1' } }] });
  assert.equal(calls.source.length, 0); assert.equal(calls.chat.length, 2); assert.equal(calls.chat.every(call => call.sourceReferenceId === 'session:1'), true);
});

test('partial failure reports the last acknowledged checkpoint and never publishes a healthy receipt', async () => {
  const { adapter, calls } = harness({ failCapture: true });
  await assert.rejects(() => adapter.process({ runId: 'email-run-failure', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-42', sourceVersion: 'v1', checkpoint: 'message-42', rawText: 'Please pay the fictional invoice and reply.' }] }), error => error.message === 'fictional-capture-failed' && error.checkpoint === 'start' && error.counts.failedCount === 1);
  assert.deepEqual(calls.receipt.map(call => call.status), ['pending', 'failed']);
  assert.equal(calls.receipt.at(-1).checkpoint, 'start');
});
