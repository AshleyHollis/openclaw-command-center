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

test('reprocessing appends evidence while user planning and importance win', () => {
  const first = planCommitmentCapture(base({ importance: 'low', importanceOrigin: 'processing' })).loop;
  const existing = { ...first, revision: 2, attention: { ...first.attention, importance: 'high', importanceOrigin: 'user', plannedAt: '2026-09-21T03:00:00Z', lastConsideredAt: '2026-09-20T02:00:00Z' } };
  const next = planCommitmentCapture(base({ sourceVersion: 'session-2', importance: 'normal', importanceOrigin: 'processing' }), existing).loop;
  assert.equal(next.attention.importance, 'high');
  assert.equal(next.attention.importanceOrigin, 'user');
  assert.equal(next.attention.plannedAt, '2026-09-21T03:00:00Z');
  assert.equal(next.evidenceObservationIds.length, 2);
});

test('capture owner atomically replays and verifies exact Note references', async () => {
  const loops = new Map(); const receipts = new Map();
  const metadata = {
    getSourceReference: id => id === 'ref-note' ? { referenceId: id, topicId: 'topic-home', sourceKind: 'note' } : null,
    findOpenLoopBySubject: (_kind, subject) => [...loops.values()].find(loop => loop.stableSubjectId === subject) ?? null,
    applyOpenLoopChange: input => { const prior = receipts.get(input.logicalOperationId); if (prior) return prior; loops.set(input.loop.loopId, input.loop); const result = { schemaVersion: 1, disposition: 'created', observation: input.observation, loop: input.loop }; receipts.set(input.logicalOperationId, result); return result; }
  };
  const sourceService = { notesRead: async input => ({ referenceId: input.referenceId }) };
  const service = createCommitmentCaptureService({ metadata, sourceService });
  const input = base({ sourceKind: 'note', sourceReferenceId: 'ref-note', sourceExternalId: 'ref-note' });
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
  assert.match(captured.observation.source.version, /^tool:[0-9a-f-]{36}$/u);
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
