import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-entity-corrections-'));
  const service = openCommandCenterMetadataService({ stateDir });
  try { await run(service); } finally { service.close(); await rm(stateDir, { recursive: true, force: true }); }
}
function observation(id, entityId, label = 'Alex Example') {
  return {
    schemaVersion: 1,
    observationId: id,
    source: { system: 'fictional-mail', kind: 'message', externalId: id, version: 'v1' },
    type: 'general',
    occurredAt: '2026-09-20T01:00:00.000Z',
    observedAt: '2026-09-20T01:01:00.000Z',
    historicalBaseline: false,
    entityRefs: [{ kind: 'person', id: entityId, label, confidence: 0.6, evidence: ['sender-name'] }],
    facts: { summary: 'A fictional source mentions a same-name person.' }
  };
}
function correction(overrides = {}) {
  return {
    schemaVersion: 1,
    correctionId: 'fictional-person-correction-1',
    targetObservationId: 'same-name-message-1',
    targetEntity: { kind: 'person', id: 'person-fictional-1', label: 'Alex Example' },
    action: 'replace',
    replacementEntity: { kind: 'person', id: 'person-fictional-2', label: 'Alex Example' },
    actorId: 'operator-fictional',
    rationale: 'The exact source context identifies the other fictional Alex.',
    correctedAt: '2026-09-20T02:00:00.000Z',
    ...overrides
  };
}

test('an explicit same-name correction changes only the exact source observation', async () => {
  await withService(service => {
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'source-one', observation: observation('same-name-message-1', 'person-fictional-1') });
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'source-two', observation: observation('same-name-message-2', 'person-fictional-3') });
    const result = service.recordEntityCorrection({ schemaVersion: 1, logicalOperationId: 'replace-same-name-person', correction: correction() });
    assert.equal(result.disposition, 'applied');
    assert.deepEqual(result.resolution.entities.map(item => [item.id, item.status]), [['person-fictional-1', 'rejected'], ['person-fictional-2', 'confirmed']]);
    assert.equal(service.resolveEntityRefs('same-name-message-2').entities[0].status, 'source-claimed');
    assert.equal(service.recordEntityCorrection({ schemaVersion: 1, logicalOperationId: 'replace-same-name-person', correction: correction() }).disposition, 'duplicate');
  });
});

test('a later explicit confirmation reverses a replacement without deleting its provenance', async () => {
  await withService(service => {
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'reversible-source', observation: observation('same-name-message-1', 'person-fictional-1') });
    service.recordEntityCorrection({ schemaVersion: 1, logicalOperationId: 'initial-replacement', correction: correction() });
    const restored = service.recordEntityCorrection({ schemaVersion: 1, logicalOperationId: 'restore-original', correction: correction({ correctionId: 'fictional-person-correction-2', action: 'confirm', replacementEntity: undefined, rationale: 'New exact evidence confirms the original fictional identity.', correctedAt: '2026-09-21T02:00:00.000Z' }) });
    assert.deepEqual(restored.resolution.entities.map(item => [item.id, item.status]), [['person-fictional-1', 'confirmed'], ['person-fictional-2', 'rejected']]);
    assert.equal(restored.resolution.corrections.length, 2);
    assert.equal(service.getOpenLoopObservation('same-name-message-1').entityRefs[0].id, 'person-fictional-1');
  });
});

test('corrections require an exact observed entity and leave no record when validation fails', async () => {
  await withService(service => {
    service.ingestOpenLoopObservation({ schemaVersion: 1, logicalOperationId: 'mismatch-source', observation: observation('same-name-message-1', 'person-fictional-1') });
    const before = service.listOpenLoopObservations().length;
    assert.throws(() => service.recordEntityCorrection({ schemaVersion: 1, logicalOperationId: 'wrong-target', correction: correction({ targetEntity: { kind: 'person', id: 'person-does-not-exist' } }) }), error => error.code === 'entity-correction-target-mismatch');
    assert.equal(service.listOpenLoopObservations().length, before);
    assert.throws(() => service.recordEntityCorrection({ schemaVersion: 1, logicalOperationId: 'bad-replacement', correction: correction({ replacementEntity: { kind: 'person', id: 'person-fictional-1' } }) }), error => error.code === 'entity-correction-invalid');
  });
});
