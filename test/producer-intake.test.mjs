import assert from 'node:assert/strict';
import test from 'node:test';
import { createProducerIntakeAdapter } from '../src/open-loops/producer-intake.mjs';

function harness({ failCapture = false } = {}) {
  const calls = { extract: [], save: [], source: [], chat: [], plans: [], outcomes: [], receipt: [] };
  const plans = new Map(); const completed = new Map();
  const keyFor = input => `${input.sourceKind}:${input.sourceExternalId}:${input.sourceVersion}`;
  const durableFor = input => {
    const plan = plans.get(keyFor(input));
    return plan ? { plan, account: { outcomes: plan.outcomes.map(item => ({ ...item, status: completed.get(`${keyFor(input)}:${item.outcomeId}`) ?? 'missing' })) } } : null;
  };
  const adapter = createProducerIntakeAdapter({
    processorVersion: 'fictional-processor-v1',
    now: (() => { let tick = 0; return () => `2026-09-21T00:0${tick++}:00.000Z`; })(),
    async extract(input) {
      calls.extract.push(input);
      if (input.rawText.includes('no action')) return { schemaVersion: 1, proposedTopic: 'home', notePath: '', knowledgeMarkdown: '', obligations: [], noAction: { outcomeId: 'notice:no-action', summary: 'Fictional notice requires no action' } };
      if (input.rawText.includes('information only')) return { schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/information.md', knowledgeMarkdown: '# Information\n', obligations: [] };
      if (input.rawText.includes('uncertain topic')) return { schemaVersion: 1, proposedTopic: null, notePath: '', knowledgeMarkdown: '', obligations: [] };
      return { schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/invoice.md', knowledgeMarkdown: '# Fictional invoice\n', knowledgeOutcomeId: 'invoice-42:information', obligations: [
        { obligationId: 'invoice-42:payment', title: 'Pay the fictional invoice', provenance: 'explicit', dueAt: '2026-09-30T00:00:00.000Z', importance: 'high', importanceOrigin: 'source' },
        { obligationId: 'invoice-42:reply', title: 'Reply with the fictional remittance', provenance: 'explicit', importance: 'normal', importanceOrigin: 'processing' },
        { obligationId: 'invoice-42:delivery-choice', title: 'Choose the fictional delivery window', classification: 'decision', provenance: 'inferred', importance: 'normal', importanceOrigin: 'processing' }
      ] };
    },
    async loadIntakeSourceAccount(input) { return durableFor(input); },
    async resolveTopic({ proposedTopic }) { return proposedTopic ? { topicId: 'topic-home', noteFolderReferenceId: 'folder-home' } : null; },
    async saveSourceNote(input) { calls.save.push(input); return { topicId: input.topicId, sourceReferenceId: 'note:fictional', sourcePath: input.path, sourceReferenceVersion: 'note-revision-3', replayed: calls.save.length > 1 }; },
    async captureSourceCommitment(input) { calls.source.push(input); if (failCapture && calls.source.length === 2) throw new Error('fictional-capture-failed'); return { status: 'applied', loop: { loopId: `loop:${input.obligationId}` } }; },
    async captureChatCommitment(input) { calls.chat.push(input); return { status: 'applied', loop: { loopId: `loop:${input.obligationId}` } }; },
    async recordIntakeSourcePlan(input) { calls.plans.push(input); const plan = { schemaVersion: 1, ...input }; plans.set(keyFor(input), plan); return durableFor(input); },
    async recordIntakeOutcome(input) { calls.outcomes.push(input); completed.set(`${keyFor(input)}:${input.outcomeId}`, input.status); return { status: 'recorded' }; },
    async recordIntakeReceipt(input) { calls.receipt.push(input); return { status: input.status }; }
  });
  return { adapter, calls };
}

test('email producer extracts natural-language input, saves evidence once and captures each distinct obligation', async () => {
  const { adapter, calls } = harness();
  const result = await adapter.process({ runId: 'email-run-1', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-42', sourceVersion: 'change-key-7', checkpoint: 'message-42', rawText: 'Please pay the fictional invoice and reply with remittance by 30 September.' }] });
  assert.deepEqual({ processed: result.processedCount, actionable: result.actionableCount, notes: result.noteCount }, { processed: 1, actionable: 3, notes: 1 });
  assert.equal(calls.extract.length, 1); assert.equal(calls.save.length, 1); assert.equal(calls.source.length, 3);
  assert.deepEqual(calls.source.map(call => call.obligationId), ['invoice-42:payment', 'invoice-42:reply', 'invoice-42:delivery-choice']);
  assert.equal(calls.source.every(call => call.sourceReferenceId === 'note:fictional'), true);
  assert.equal(calls.source.every(call => call.topicId === 'topic-home' && call.sourceKind === 'email' && call.sourceExternalId === 'message-42' && call.sourcePath === 'Inbox/invoice.md'), true);
  assert.equal(calls.source.every(call => call.sourceVersion === 'change-key-7'), true);
  assert.equal(calls.outcomes.find(call => call.status === 'quiet').sourceReferenceVersion, 'note-revision-3');
  assert.equal(calls.source.every(call => call.classification === undefined), true);
  assert.deepEqual(calls.plans[0].outcomes, [{ outcomeId: 'invoice-42:payment', kind: 'obligation' }, { outcomeId: 'invoice-42:reply', kind: 'obligation' }, { outcomeId: 'invoice-42:delivery-choice', kind: 'decision' }, { outcomeId: 'invoice-42:information', kind: 'information' }]);
  assert.deepEqual(calls.outcomes.map(call => [call.outcomeId, call.status]), [['invoice-42:information', 'quiet'], ['invoice-42:payment', 'applied'], ['invoice-42:reply', 'applied'], ['invoice-42:delivery-choice', 'pending-decision']]);
  assert.deepEqual(calls.receipt.map(call => [call.status, call.checkpoint]), [['pending', 'start'], ['healthy-processed', 'message-42']]);
});

test('a producer-supplied accepted extraction is durably planned without re-extracting source content', async () => {
  const { adapter, calls } = harness();
  const acceptedExtraction = { schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/accepted.md', knowledgeMarkdown: '# Accepted fictional evidence\n', knowledgeOutcomeId: 'accepted:information', obligations: [
    { obligationId: 'accepted:pay', title: 'Pay the accepted fictional invoice', provenance: 'explicit', importance: 'high', importanceOrigin: 'source' }
  ] };
  const result = await adapter.process({ runId: 'email-accepted-1', sourceKind: 'email', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-accepted', sourceVersion: 'change-key-accepted', checkpoint: 'accepted-1', acceptedExtraction }] });
  assert.equal(result.status, 'healthy-processed'); assert.equal(calls.extract.length, 0); assert.equal(calls.save.length, 1); assert.equal(calls.source.length, 1);
  assert.equal(calls.plans[0].acceptedExtraction.knowledgeOutcomeId, 'accepted:information');
  assert.equal(calls.source[0].sourceVersion, 'change-key-accepted');
});

test('an empty bounded producer run records healthy coverage using the declared source kind', async () => {
  const { adapter, calls } = harness();
  const scope = { accountBinding: 'sha256:fictional-account', folders: ['inbox'], sinceUtc: '2026-09-20T00:00:00.000Z', beforeUtc: '2026-09-21T00:00:00.000Z', maxMessages: 50, batchKind: 'bounded' };
  const enumeration = { scope: 'complete', scannedCount: 0, remainingCount: 0, failedReadCount: 0, scanCapReached: false };
  const result = await adapter.process({ runId: 'email-empty-1', sourceKind: 'email', nextExpectedAt: '2026-09-22T00:00:00.000Z', scope, enumeration, records: [] });
  assert.equal(result.status, 'healthy-empty'); assert.deepEqual(calls.receipt.map(item => item.status), ['pending', 'healthy-empty']);
  assert.deepEqual(calls.receipt.at(-1).scope, scope);
  assert.deepEqual(calls.receipt.at(-1).enumeration, enumeration);
});

test('information-only input remains quiet and existing evidence is reused without manufacturing a Note', async () => {
  const { adapter, calls } = harness();
  await adapter.process({ runId: 'note-run-1', nextExpectedAt: '2026-09-28T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'note', sourceExternalId: 'note-1', sourceVersion: 'v1', checkpoint: 'note-1', rawText: 'information only', existingEvidence: { topicId: 'topic-home', sourceReferenceId: 'note:existing', sourcePath: 'Reference/existing.md', sourceReferenceVersion: 'note-revision-1' } }] });
  assert.equal(calls.save.length, 0); assert.equal(calls.source.length, 0); assert.equal(calls.receipt.at(-1).actionableCount, 0);
  assert.equal(calls.outcomes[0].status, 'quiet');
});

test('accepted extraction cannot introduce fields that overwrite upstream or retained evidence identity', async () => {
  const unsafe = createProducerIntakeAdapter({
    processorVersion: 'fictional-processor-v1', now: () => '2026-09-21T00:00:00.000Z',
    extract: async () => ({ schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/invoice.md', knowledgeMarkdown: '# Fictional invoice\n', obligations: [{ obligationId: 'unsafe', title: 'Unsafe', provenance: 'explicit', sourceVersion: 'note-revision-should-not-overwrite' }] }),
    loadIntakeSourceAccount: async () => null, resolveTopic: async () => ({ topicId: 'topic-home', noteFolderReferenceId: 'folder-home' }), saveSourceNote: async () => { throw new Error('must reject before effects'); },
    captureSourceCommitment: async () => { throw new Error('must reject before effects'); }, captureChatCommitment: async () => { throw new Error('must reject before effects'); },
    recordIntakeSourcePlan: async () => { throw new Error('must reject before planning'); }, recordIntakeOutcome: async () => { throw new Error('must reject before outcomes'); }, recordIntakeReceipt: async input => ({ receipt: input })
  });
  await assert.rejects(() => unsafe.process({ runId: 'unsafe-run', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-unsafe', sourceVersion: 'email-change-key', checkpoint: 'message-unsafe', rawText: 'Unsafe extraction' }] }), { code: 'producer-extraction-invalid' });
});

test('an explicit no-action result is durably planned and accounted without creating work', async () => {
  const { adapter, calls } = harness();
  const result = await adapter.process({ runId: 'email-run-no-action', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'notice-1', sourceVersion: 'v1', checkpoint: 'notice-1', rawText: 'no action' }] });
  assert.deepEqual(calls.plans[0].outcomes, [{ outcomeId: 'notice:no-action', kind: 'no-action' }]);
  assert.deepEqual(calls.outcomes.map(item => [item.outcomeId, item.kind, item.status]), [['notice:no-action', 'no-action', 'no-action']]);
  assert.deepEqual({ processed: result.processedCount, skipped: result.skippedCount, actionable: result.actionableCount, notes: result.noteCount }, { processed: 1, skipped: 1, actionable: 0, notes: 0 });
});

test('ambiguous Topic ownership creates no Note or obligation and remains visible in receipt counters', async () => {
  const { adapter, calls } = harness();
  await assert.rejects(() => adapter.process({ runId: 'email-run-ambiguous', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-uncertain', sourceVersion: 'v1', checkpoint: 'message-uncertain', rawText: 'uncertain topic' }] }), error => error.code === 'producer-outcomes-unsettled' && error.counts.uncertainCount === 1);
  assert.equal(calls.save.length, 0); assert.equal(calls.source.length, 0); assert.equal(calls.receipt.at(-1).status, 'failed');
  assert.equal(calls.outcomes[0].status, 'unresolved-topic');
});

test('Chat commitments use the supported Chat capture boundary with exact existing evidence', async () => {
  const { adapter, calls } = harness();
  await adapter.process({ runId: 'chat-run-1', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'chat', sourceExternalId: 'session-1:message-9', sourceVersion: 'message-v1', checkpoint: 'message-9', rawText: 'Please pay the fictional invoice and reply.', existingEvidence: { topicId: 'topic-home', sourceReferenceId: 'session:1', sourcePath: 'message:9', sourceReferenceVersion: 'session-message-revision-9' } }] });
  assert.equal(calls.source.length, 0); assert.equal(calls.chat.length, 3); assert.equal(calls.chat.every(call => call.sourceReferenceId === 'session:1'), true);
});

test('partial failure reports the last acknowledged checkpoint and never publishes a healthy receipt', async () => {
  const { adapter, calls } = harness({ failCapture: true });
  await assert.rejects(() => adapter.process({ runId: 'email-run-failure', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-42', sourceVersion: 'v1', checkpoint: 'message-42', rawText: 'Please pay the fictional invoice and reply.' }] }), error => error.message === 'fictional-capture-failed' && error.checkpoint === 'start' && error.counts.failedCount === 1);
  assert.deepEqual(calls.receipt.map(call => call.status), ['pending', 'failed']);
  assert.equal(calls.receipt.at(-1).checkpoint, 'start');
});

test('a bounded page records and returns an exact resumable continuation', async () => {
  const { adapter, calls } = harness();
  const enumeration = { scope: 'bounded', scannedCount: 1, remainingCount: 4, failedReadCount: 1, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'page-3' };
  const result = await adapter.process({ runId: 'email-run-bounded', nextExpectedAt: '2026-09-22T00:05:00.000Z', enumeration, records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'notice-1', sourceVersion: 'v1', checkpoint: 'page-2:notice-1', rawText: 'no action' }] });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.continuation, { scopeId: 'mailbox-fixture', cursor: 'page-3', remainingCount: 4, failedReadCount: 1, scanCapReached: true });
  assert.deepEqual(calls.receipt.map(item => item.status), ['pending', 'incomplete']);
  assert.deepEqual(calls.receipt.at(-1).continuation, result.continuation);
  assert.deepEqual(calls.plans[0].enumeration, enumeration);
});

test('record-level bounded enumeration becomes the authoritative durable continuation', async () => {
  const { adapter, calls } = harness();
  const enumeration = { scope: 'bounded', scannedCount: 1, remainingCount: 4, failedReadCount: 1, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'page-2' };
  const result = await adapter.process({ runId: 'email-record-bounded', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'notice-bounded', sourceVersion: 'v1', checkpoint: 'page-1', rawText: 'no action', enumeration }] });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.continuation, { scopeId: 'mailbox-fixture', cursor: 'page-2', remainingCount: 4, failedReadCount: 1, scanCapReached: true });
  assert.equal(calls.receipt.at(-1).status, 'incomplete');
  assert.deepEqual(calls.plans[0].enumeration, enumeration);
});

test('multiple record-level enumeration scopes are rejected before a receipt is published', async () => {
  const { adapter, calls } = harness();
  const base = { schemaVersion: 1, sourceKind: 'email', sourceVersion: 'v1', rawText: 'no action', enumeration: { scope: 'bounded', scannedCount: 1, remainingCount: 1, failedReadCount: 0, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'next' } };
  await assert.rejects(() => adapter.process({ runId: 'email-conflicting-enumeration', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ ...base, sourceExternalId: 'one', checkpoint: 'one' }, { ...base, sourceExternalId: 'two', checkpoint: 'two' }] }), error => error.code === 'producer-enumeration-scope-invalid');
  assert.equal(calls.receipt.length, 0);
});

test('retry loads the accepted extraction and resumes only missing outcomes', async () => {
  const acceptedExtraction = { schemaVersion: 1, proposedTopic: 'home', notePath: 'Inbox/invoice.md', knowledgeMarkdown: '# Accepted reference\n', knowledgeOutcomeId: 'accepted-information', obligations: [
    { obligationId: 'accepted-first', title: 'First accepted obligation', provenance: 'explicit' },
    { obligationId: 'accepted-second', title: 'Second accepted obligation', provenance: 'explicit' },
    { obligationId: 'accepted-choice', title: 'Accepted choice', classification: 'decision', provenance: 'inferred' }
  ] };
  const durablePlan = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-retry', sourceVersion: 'email-change-key-11', checkpoint: 'message-retry', observedAt: '2026-09-21T01:00:00.000Z', processorVersion: 'processor-v1', acceptedExtraction, outcomes: [
    { outcomeId: 'accepted-first', kind: 'obligation' }, { outcomeId: 'accepted-second', kind: 'obligation' }, { outcomeId: 'accepted-choice', kind: 'decision' }, { outcomeId: 'accepted-information', kind: 'information' }
  ], enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false } };
  const completed = new Map([['accepted-information', 'quiet'], ['accepted-first', 'applied'], ['accepted-choice', 'clarified']]);
  const captures = []; const outcomes = []; let extracted = 0;
  const adapter = createProducerIntakeAdapter({
    processorVersion: 'processor-v2', now: () => '2026-09-21T02:00:00.000Z',
    loadIntakeSourceAccount: async () => ({ plan: durablePlan, account: { outcomes: durablePlan.outcomes.map(item => ({ ...item, status: completed.get(item.outcomeId) ?? 'missing', ...(item.outcomeId === 'accepted-information' ? { topicId: 'topic-home', sourceReferenceId: 'note:accepted', sourcePath: 'Inbox/invoice.md', sourceReferenceVersion: 'note-revision-4' } : {}) })) } }),
    extract: async () => { extracted += 1; throw new Error('retry must not re-extract an accepted source revision'); },
    resolveTopic: async () => ({ topicId: 'topic-home', noteFolderReferenceId: 'folder-home' }),
    saveSourceNote: async () => { throw new Error('completed quiet evidence must not be saved again'); },
    captureSourceCommitment: async input => { captures.push(input); return { loop: { loopId: `loop:${input.obligationId}` } }; },
    captureChatCommitment: async () => { throw new Error('unexpected Chat capture'); },
    recordIntakeSourcePlan: async () => { throw new Error('accepted plan must not be replaced'); },
    recordIntakeOutcome: async input => { outcomes.push(input); return { outcome: input }; },
    recordIntakeReceipt: async input => ({ receipt: input })
  });
  await adapter.process({ runId: 'retry-run', nextExpectedAt: '2026-09-22T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-retry', sourceVersion: 'email-change-key-11', checkpoint: 'message-retry', rawText: 'Changed extractor input must be ignored.' }] });
  assert.equal(extracted, 0);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].obligationId, 'accepted-second');
  assert.equal(captures[0].sourceVersion, 'email-change-key-11');
  assert.deepEqual(outcomes.map(item => item.outcomeId), ['accepted-second']);
});

test('an explicit no-action source needs no Topic or evidence', async () => {
  const { adapter, calls } = harness();
  const acceptedExtraction = { schemaVersion: 1, proposedTopic: null, notePath: '', knowledgeMarkdown: '', obligations: [], noAction: { outcomeId: 'ignored-email:no-action', summary: 'No durable value or action' } };
  const result = await adapter.process({ runId: 'email-no-topic-no-action', sourceKind: 'email', nextExpectedAt: '2026-09-23T00:00:00.000Z', records: [{ schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'ignored-email', sourceVersion: 'change-key-ignore', checkpoint: 'ignored-email', acceptedExtraction }] });
  assert.equal(result.status, 'healthy-processed'); assert.equal(result.skippedCount, 1); assert.equal(calls.save.length, 0); assert.equal(calls.source.length, 0);
  assert.deepEqual(calls.outcomes.map(item => [item.outcomeId, item.status]), [['ignored-email:no-action', 'no-action']]);
});

test('a pinned retained Note cannot fall through to creating replacement evidence', async () => {
  let saves = 0;
  const adapter = createProducerIntakeAdapter({
    processorVersion: 'fixture-v1', extract: async () => { throw new Error('accepted extraction must be reused'); },
    loadIntakeSourceAccount: async () => null,
    resolveTopic: async () => ({ topicId: 'topic-fixture', noteFolderReferenceId: 'folder-fixture' }),
    saveSourceNote: async () => { saves += 1; throw new Error('replacement Note must not be created'); },
    captureSourceCommitment: async () => { throw new Error('capture must not run'); }, captureChatCommitment: async () => { throw new Error('capture must not run'); },
    recordIntakeSourcePlan: async input => ({ plan: { schemaVersion: 1, ...input }, account: { outcomes: [] } }),
    recordIntakeOutcome: async () => { throw new Error('outcome must not run'); }, recordIntakeReceipt: async input => ({ receipt: input })
  });
  const record = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'message-pinned-note', sourceVersion: 'change-key-1', retainedNoteRevision: `sha256:${'a'.repeat(64)}`, checkpoint: 'message-pinned-note', acceptedExtraction: { schemaVersion: 1, proposedTopic: 'Fictional Home', notePath: 'Inbox/Pinned.md', knowledgeMarkdown: 'Retained at source.', obligations: [{ obligationId: 'fictional-obligation', title: 'Review fictional item', provenance: 'explicit' }] } };
  await assert.rejects(() => adapter.process({ runId: 'pinned-note-run', records: [record], nextExpectedAt: '2026-09-23T01:00:00.000Z' }), error => error.code === 'producer-evidence-unavailable');
  assert.equal(saves, 0);
});
