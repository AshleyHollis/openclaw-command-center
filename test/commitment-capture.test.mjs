import test from 'node:test';
import assert from 'node:assert/strict';
import { planCommitmentCapture, createCommitmentCaptureService } from '../src/open-loops/commitment-capture.mjs';
import { commitmentCaptureToolFactory } from '../src/open-loops/commitment-tool.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = overrides => ({ schemaVersion: 1, logicalOperationId: '10000000-0000-4000-8000-000000000001', sourceKind: 'chat', sourceExternalId: 'agent:main:fictional', sourceVersion: 'session-1', topicId: 'topic-home', title: 'Research laundry storage', obligationId: 'laundry-storage-research', provenance: 'explicit', occurredAt: '2026-09-20T01:00:00Z', observedAt: '2026-09-20T01:00:01Z', historicalBaseline: false, ...overrides });

test('explicit capture becomes one quiet confirmed commitment and an idea stays suggested', () => {
  const explicit = planCommitmentCapture(base({ importance: 'normal', importanceOrigin: 'processing', effortMinutes: 30, contexts: ['home'] }));
  assert.equal(explicit.loop.state, 'confirmed');
  assert.equal(explicit.loop.attention.activated, false);
  assert.equal(explicit.loop.attention.importance, 'normal');
  const idea = planCommitmentCapture(base({ provenance: 'idea' }));
  assert.equal(idea.loop.state, 'suggested');
  assert.equal(idea.loop.attention.provenance, 'idea');
});

test('an explicitly typed bill is a payment loop that can record a paid assertion', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-bill-capture-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId: 'topic-home', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' });
    const capture = createCommitmentCaptureService({ metadata });
    const input = base({ sourceKind: 'email', sourceExternalId: 'email:fictional-bill', title: 'Pay fictional bill', obligationId: 'bill-1', obligationKind: 'payment' });
    const first = await capture.capture(input);
    assert.equal(first.loop.kind, 'payment');
    assert.equal(first.loop.paymentState, 'unpaid');
    assert.equal((await capture.capture(input)).loop.loopId, first.loop.loopId);
    const paid = metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: '20000000-0000-4000-8000-000000000002', loopId: first.loop.loopId, expectedRevision: first.loop.revision, paymentState: 'paid', actorId: 'fictional-operator', rationale: 'Fictional assertion only.', updatedAt: '2026-09-20T02:00:00Z' });
    assert.equal(paid.loop.paymentState, 'paid');
    assert.equal(paid.loop.state, 'resolved');
    const replay = await capture.capture({ ...input, logicalOperationId: '30000000-0000-4000-8000-000000000003', sourceVersion: 'session-2' });
    assert.equal(replay.loop.loopId, first.loop.loopId);
    assert.equal(replay.loop.paymentState, 'paid');
    await assert.rejects(() => capture.capture({ ...input, logicalOperationId: '40000000-0000-4000-8000-000000000004', sourceVersion: 'session-3', obligationKind: undefined }), /explicit duplicate review/u);
    assert.equal(metadata.listOpenLoops().length, 1);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('manual quick capture shares the commitment identity and keeps ideas in review', () => {
  const task = planCommitmentCapture(base({ sourceKind: 'manual', sourceExternalId: 'operator:fictional', sourceVersion: 'quick-capture:task-1', obligationId: 'task-1' }));
  const idea = planCommitmentCapture(base({ sourceKind: 'manual', sourceExternalId: 'operator:fictional', sourceVersion: 'quick-capture:idea-1', obligationId: 'idea-1', provenance: 'idea' }));
  assert.equal(task.loop.state, 'confirmed');
  assert.equal(idea.loop.state, 'suggested');
  assert.notEqual(task.loop.loopId, idea.loop.loopId);
});

test('reprocessing appends evidence while user planning and importance win', () => {
  const first = planCommitmentCapture(base({ importance: 'low', importanceOrigin: 'processing' })).loop;
  const existing = { ...first, revision: 2, attention: { ...first.attention, importance: 'high', importanceOrigin: 'user', plannedAt: '2026-09-21T03:00:00Z', lastConsideredAt: '2026-09-20T02:00:00Z' } };
  const next = planCommitmentCapture(base({ sourceVersion: 'session-2', importance: 'normal', importanceOrigin: 'processing' }), existing).loop;
  assert.equal(next.attention.importance, 'high');
  assert.equal(next.attention.importanceOrigin, 'user');
  assert.equal(next.attention.plannedAt, '2026-09-21T03:00:00Z');
  assert.equal(next.evidenceObservationIds.length, 2);
});

test('the same Topic obligation reconciles evidence from email, Chat and Note into one item', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-cross-source-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId: 'topic-home', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' });
    const service = createCommitmentCaptureService({ metadata });
    const correlation = { correlationNamespace: 'fictional-project-obligation', correlationId: 'laundry-storage-research' };
    const email = await service.capture(base({ ...correlation, sourceKind: 'email', sourceExternalId: 'email:fictional', sourceVersion: '1' }));
    const chat = await service.capture(base({ ...correlation, logicalOperationId: '20000000-0000-4000-8000-000000000002', sourceKind: 'chat', sourceExternalId: 'chat:fictional', sourceVersion: '2' }));
    const note = await service.capture(base({ ...correlation, logicalOperationId: '30000000-0000-4000-8000-000000000003', sourceKind: 'note', sourceExternalId: 'note:fictional', sourceVersion: '3' }));
    assert.equal(chat.loop.loopId, email.loop.loopId);
    assert.equal(note.loop.loopId, email.loop.loopId);
    assert.equal(metadata.listOpenLoops().length, 1);
    assert.equal(note.loop.evidenceObservationIds.length, 3);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a new source adopts one pre-upgrade source-scoped commitment by Topic and obligation', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-legacy-source-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId: 'topic-home', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' });
    const legacy = planCommitmentCapture(base({ sourceKind: 'email', sourceExternalId: 'email:legacy', sourceVersion: '1' }));
    const legacyLoop = legacy.loop;
    metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: '40000000-0000-4000-8000-000000000004', operationKind: 'commitment.capture.v1', intent: legacy.value,
      expectedRevision: 0, observation: legacy.observation, loop: legacyLoop, evidenceRoles: { [legacy.observation.observationId]: 'origin' }, updatedAt: legacy.value.observedAt });
    const service = createCommitmentCaptureService({ metadata });
    const result = await service.capture(base({ logicalOperationId: '50000000-0000-4000-8000-000000000005', sourceKind: 'email', sourceExternalId: 'email:legacy', sourceVersion: '2', correlationNamespace: 'fictional-project-obligation', correlationId: 'laundry-storage-research' }));
    assert.equal(result.loop.loopId, legacyLoop.loopId);
    assert.equal(result.loop.evidenceObservationIds.length, 2);
    assert.equal(metadata.listOpenLoops().length, 1);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('matching generic obligation labels do not merge without exact shared correlation', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-no-guessed-correlation-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId: 'topic-home', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' });
    const service = createCommitmentCaptureService({ metadata });
    await service.capture(base({ sourceKind: 'email', sourceExternalId: 'email:one', sourceVersion: '1', obligationId: 'reply' }));
    await service.capture(base({ logicalOperationId: '60000000-0000-4000-8000-000000000006', sourceKind: 'chat', sourceExternalId: 'chat:two', sourceVersion: '1', obligationId: 'reply' }));
    assert.equal(metadata.listOpenLoops().length, 2);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a cross-source correlation does not silently adopt unnamespaced legacy evidence', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-legacy-ambiguity-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId: 'topic-home', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' });
    const legacy = planCommitmentCapture(base({ sourceKind: 'email', sourceExternalId: 'email:legacy-ambiguous', sourceVersion: '1' }));
    metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: '70000000-0000-4000-8000-000000000007', operationKind: 'commitment.capture.v1', intent: legacy.value,
      expectedRevision: 0, observation: legacy.observation, loop: { ...legacy.loop, loopId: 'open-loop:legacy-ambiguous', stableSubjectId: 'commitment:legacy-ambiguous' },
      evidenceRoles: { [legacy.observation.observationId]: 'origin' }, updatedAt: legacy.value.observedAt });
    const service = createCommitmentCaptureService({ metadata });
    await assert.rejects(() => service.capture(base({ logicalOperationId: '80000000-0000-4000-8000-000000000008', sourceKind: 'chat', sourceExternalId: 'chat:new', sourceVersion: '2', correlationNamespace: 'fictional-project-obligation', correlationId: 'laundry-storage-research' })), /explicit duplicate review/u);
    assert.equal(metadata.listOpenLoops().length, 1);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('capture owner atomically replays and verifies exact Note references', async () => {
  const loops = new Map(); const receipts = new Map();
  const metadata = {
    getSourceReference: id => id === 'ref-note' ? { referenceId: id, topicId: 'topic-home', sourceKind: 'note' } : null,
    findOpenLoopBySubject: (kind, subject) => [...loops.values()].find(loop => loop.kind === kind && loop.stableSubjectId === subject) ?? null,
    applyOpenLoopChange: input => { const prior = receipts.get(input.logicalOperationId); if (prior) return prior; loops.set(input.loop.loopId, input.loop); const result = { schemaVersion: 1, disposition: 'created', observation: input.observation, loop: input.loop }; receipts.set(input.logicalOperationId, result); return result; }
  };
  const sourceService = { notesRead: async input => ({ referenceId: input.referenceId }) };
  const service = createCommitmentCaptureService({ metadata, sourceService });
  const input = base({ sourceKind: 'note', sourceReferenceId: 'ref-note', sourcePath: 'Inbox/Fictional note.md', sourceExternalId: 'ref-note' });
  const first = await service.capture(input); const replay = await service.capture(input);
  assert.equal(first.loop.loopId, replay.loop.loopId);
  assert.equal(loops.size, 1);
  await assert.rejects(() => service.capture({ ...input, logicalOperationId: '20000000-0000-4000-8000-000000000002', sourceReferenceId: 'missing' }), /not exactly owned/);
});

test('native tool resolves Topic from the exact active Session and never accepts caller Topic authority', async () => {
  let captured;
  const metadata = { findOpenLoopBySubject: () => null, applyOpenLoopChange(input) { captured = input; return { disposition: 'created', loop: input.loop }; } };
  const sourceService = { sessionTopicContext: async () => ({ status: 'bound', sessionId: 'session-1', topicId: 'topic-home' }) };
  const tool = commitmentCaptureToolFactory({ getOwners: () => ({ metadata, sourceService }) })({ sessionKey: 'agent:main:fictional', sessionId: 'session-1' });
  const result = await tool.execute('tool-call-1', { title: 'Research laundry storage', obligationId: 'laundry-storage-research', provenance: 'explicit' });
  assert.equal(captured.loop.topicId, 'topic-home');
  assert.match(captured.observation.source.version, /^commitment:[0-9a-f]{32}$/u);
  assert.match(captured.observation.facts.sourceVersion, /^tool:[0-9a-f-]{36}$/u);
  assert.equal(result.details.loop.state, 'confirmed');
});

test('real SQLite owner survives restart and deduplicates an unchanged capture', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-capture-'));
  let metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId: 'topic-home', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' });
    const service = createCommitmentCaptureService({ metadata });
    const first = await service.capture(base({}));
    assert.equal(first.disposition, 'created');
    assert.equal((await service.capture(base({}))).loop.loopId, first.loop.loopId);
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir });
    assert.equal(metadata.listOpenLoops().length, 1);
    assert.equal(metadata.getOpenLoop(first.loop.loopId).evidenceObservationIds.length, 1);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});
