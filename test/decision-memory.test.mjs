import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planDecisionRecord } from '../src/open-loops/decision-memory.mjs';
import { projectQuietAttention } from '../src/open-loops/quiet-attention.mjs';

async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-decision-memory-'));
  const service = openCommandCenterMetadataService({ stateDir });
  try { await run(service); } finally { service.close(); await rm(stateDir, { recursive: true, force: true }); }
}
function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'fictional-benchtop-selection',
    status: 'confirmed',
    decidedAt: '2026-09-20T02:00:00.000Z',
    actorId: 'operator-fictional',
    subject: { kind: 'product-choice', id: 'fictional-benchtop', label: 'Fictional kitchen benchtop choice' },
    chosenOption: 'Example Stone A',
    alternatives: ['Example Stone B', 'Example Laminate C'],
    rationale: 'Choose the option that fits the accepted fictional renovation budget.',
    assumptions: ['The installed price remains within AUD 10,000.'],
    sourceObservationIds: [],
    ...overrides
  };
}
function challenge(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'fictional-benchtop-selection',
    source: { system: 'fictional-documents', kind: 'quote', externalId: 'quote-benchtop', version: 'v2' },
    occurredAt: '2026-09-22T01:00:00.000Z',
    observedAt: '2026-09-22T01:05:00.000Z',
    historicalBaseline: false,
    summary: 'A revised fictional quote may exceed the recorded budget assumption.',
    assumption: 'The installed price remains within AUD 10,000.',
    assessment: 'contradicted',
    material: true,
    evidenceSelectors: ['quote:total', 'quote:tax-basis'],
    ...overrides
  };
}

test('tentative preferences remain suggestions and never become confirmed decisions implicitly', async () => {
  await withService(service => {
    const recorded = service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'tentative-choice', expectedRevision: 0, decision: decision({ status: 'tentative', chosenOption: undefined, rationale: 'This was discussed but not chosen.' }) });
    assert.equal(recorded.decision.loop.state, 'suggested');
    assert.equal(projectQuietAttention(recorded.decision.loop).group, 'suggested');
    assert.equal(recorded.observation.facts.status, 'tentative');
    assert.equal(recorded.observation.source.kind, 'explicit-decision');
  });
});

test('explicit revisions preserve the original rationale and require optimistic revision ownership', async () => {
  await withService(service => {
    const first = service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'initial-decision', expectedRevision: 0, decision: decision() });
    assert.equal(first.decision.loop.state, 'resolved');
    const replay = service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'initial-decision', expectedRevision: 0, decision: decision() });
    assert.equal(replay.disposition, 'duplicate');
    const revised = service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'revised-decision', expectedRevision: 1, decision: decision({ decidedAt: '2026-09-25T02:00:00.000Z', chosenOption: 'Example Stone B', rationale: 'An explicit fictional revised choice accepted the new finish.', assumptions: ['The revised finish is available before installation.'] }) });
    assert.equal(revised.decision.loop.revision, 2);
    const choices = revised.decision.evidence.map(item => item.facts.chosenOption).filter(Boolean).sort();
    assert.deepEqual(choices, ['Example Stone A', 'Example Stone B']);
    assert.throws(() => service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'stale-decision', expectedRevision: 1, decision: decision({ decidedAt: '2026-09-26T02:00:00.000Z', chosenOption: 'Example Laminate C' }) }), error => error.code === 'open-loop-stale-revision');
  });
});

test('material contradictory evidence asks for reconsideration without changing the chosen option', async () => {
  await withService(service => {
    service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'decision-before-challenge', expectedRevision: 0, decision: decision() });
    const challenged = service.challengeDecisionMemory({ schemaVersion: 1, logicalOperationId: 'material-challenge', expectedRevision: 1, challenge: challenge() });
    assert.equal(challenged.decision.loop.state, 'decision-needed');
    const projected = projectQuietAttention(challenged.decision.loop, { now: '2026-09-22T02:00:00.000Z' });
    assert.equal(projected.reason, 'material-change');
    assert.match(projected.whyNow, /remains unchanged until explicitly revised/i);
    assert.equal(challenged.decision.evidence.find(item => item.type === 'decision-evidence').facts.chosenOption, 'Example Stone A');
    assert.equal(service.challengeDecisionMemory({ schemaVersion: 1, logicalOperationId: 'material-challenge', expectedRevision: 1, challenge: challenge() }).disposition, 'duplicate');
  });
});

test('ambiguous or historical challenges stay available without becoming active Attention', async () => {
  await withService(service => {
    service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'decision-for-ambiguity', expectedRevision: 0, decision: decision() });
    const ambiguous = service.challengeDecisionMemory({ schemaVersion: 1, logicalOperationId: 'ambiguous-challenge', expectedRevision: 1, challenge: challenge({ assessment: 'ambiguous', material: false }) });
    assert.equal(projectQuietAttention(ambiguous.decision.loop, { now: '2026-09-22T02:00:00.000Z' }).group, 'reconciliation');
    const revised = service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'resolve-ambiguity', expectedRevision: 2, decision: decision({ decidedAt: '2026-09-23T02:00:00.000Z', rationale: 'The user explicitly kept the original fictional choice.' }) });
    const historical = service.challengeDecisionMemory({ schemaVersion: 1, logicalOperationId: 'historical-challenge', expectedRevision: 3, challenge: challenge({ source: { system: 'fictional-documents', kind: 'quote', externalId: 'old-quote', version: 'v1' }, occurredAt: '2024-01-01T00:00:00.000Z', observedAt: '2026-09-23T03:00:00.000Z', historicalBaseline: true }) });
    assert.equal(revised.decision.loop.state, 'resolved');
    assert.equal(projectQuietAttention(historical.decision.loop, { now: '2026-09-23T04:00:00.000Z' }).group, 'terminal');
  });
});

test('decision records can cite existing evidence but reject invented observation references', async () => {
  await withService(service => {
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'supporting-quote-observation', observation: {
      schemaVersion: 1,
      observationId: 'fictional-supporting-quote',
      source: { system: 'fictional-documents', kind: 'quote', externalId: 'quote-source', version: 'v1' },
      type: 'quote',
      occurredAt: '2026-09-19T00:00:00.000Z',
      observedAt: '2026-09-19T01:00:00.000Z',
      historicalBaseline: false,
      entityRefs: [{ kind: 'quote', id: 'QUOTE-FICTIONAL-1', evidence: ['quote-number'] }],
      facts: { amount: 990000, currency: 'AUD' }
    } });
    const linked = service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'linked-decision', expectedRevision: 0, decision: decision({ sourceObservationIds: ['fictional-supporting-quote'] }) });
    assert.equal(linked.decision.evidence.length, 2);
    const before = service.listOpenLoopObservations().length;
    assert.throws(() => service.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'missing-source-decision', expectedRevision: 0, decision: decision({ decisionId: 'missing-source', sourceObservationIds: ['does-not-exist'] }) }), error => error.code === 'decision-memory-source-missing');
    assert.equal(service.listOpenLoopObservations().length, before);
  });
});

test('decision contract requires explicit choice for confirmation and bounds assumptions', () => {
  assert.throws(() => planDecisionRecord(decision({ chosenOption: undefined })), /chosenOption/);
  assert.throws(() => planDecisionRecord(decision({ assumptions: Array.from({ length: 25 }, (_, index) => `Assumption ${index}`) })), /assumptions/);
});
