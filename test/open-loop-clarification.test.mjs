import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';
import { clarificationInterpretationOperationId } from '../src/open-loops/clarification-context.mjs';
import { isCanonicalUuid } from '../src/sources/operation-journal.mjs';
import { projectQuietAttention } from '../src/open-loops/quiet-attention.mjs';

const now = '2026-09-24T03:00:00.000Z';

test('one saved clarification has one public-route-compatible interpretation identity', () => {
  const first = clarificationInterpretationOperationId('fictional-clarification-one');
  assert.ok(isCanonicalUuid(first));
  assert.equal(first, clarificationInterpretationOperationId('fictional-clarification-one'));
  assert.notEqual(first, clarificationInterpretationOperationId('fictional-clarification-two'));
  assert.throws(() => clarificationInterpretationOperationId(''), { code: 'invalid-request' });
});

test('inactive agent-tool registration delegates interpretation to the active owner', () => {
  const key = Symbol.for('openclaw.command-center.active-topic-maintenance-owners.v1');
  const previous = globalThis[key];
  const inactive = createMetadataService({});
  const input = { clarificationObservationId: 'fictional-saved-clarification', outcome: 'clear', paymentState: 'paid' };
  const expected = { schemaVersion: 1, disposition: 'applied' };
  try {
    globalThis[key] = { interpretClarification: received => {
      assert.deepEqual(received, input);
      return expected;
    } };
    assert.equal(inactive.openLoopsInterpretClarification(input, { authenticatedRequesterId: 'owner-fixture' }), expected);
    delete globalThis[key];
    assert.throws(() => inactive.openLoopsInterpretClarification(input, { authenticatedRequesterId: 'owner-fixture' }), { code: 'capability-unavailable' });
  } finally {
    if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
  }
});

const message = (id, invoiceId) => ({
  schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: id, version: 'v1' },
  occurredAt: now, observedAt: now, historicalBaseline: false, disposition: 'confirmed-obligation',
  requestKind: 'payment', explicitRequest: true, summary: `Pay fictional invoice ${invoiceId}`,
  payee: 'Example Supplier', purpose: 'Fictional invoice', amount: 12300, currency: 'AUD',
  dueAt: '2026-10-01T00:00:00.000Z', invoiceId, authorityId: 'FICTIONAL-SUPPLIER',
  accountId: 'FICTIONAL-ACCOUNT', attachmentIds: [], evidenceSelectors: ['subject']
});

test('item-specific clarification saves exact words, fences old follow-up, and leaves a sibling unchanged across restart', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-item-clarification-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir });
    const first = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-first-intake', message: message('fictional-one', 'A-1') });
    const second = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-second-intake', message: message('fictional-two', 'B-2') });
    const input = { schemaVersion: 1, logicalOperationId: 'fictional-clarification-1', loopId: first.loop.loopId,
      expectedRevision: first.loop.revision, actorId: 'fictional-operator',
      rationale: 'The date in this invoice may be wrong; please check the attachment before scheduling.', updatedAt: now };
    const saved = metadata.recordOpenLoopClarification(input);
    assert.equal(saved.disposition, 'applied');
    assert.equal(saved.loop.loopId, first.loop.loopId);
    assert.equal(saved.loop.revision, first.loop.revision + 1);
    assert.equal(saved.loop.state, 'decision-needed');
    assert.equal(saved.loop.paymentState, 'unpaid');
    assert.equal(projectQuietAttention(saved.loop, { now }).group, 'attention');
    assert.equal(metadata.getOpenLoop(second.loop.loopId).revision, second.loop.revision);
    assert.equal(metadata.listOpenLoops().length, 2);
    assert.equal(metadata.recordOpenLoopClarification(input).disposition, 'duplicate');
    assert.throws(() => metadata.recordOpenLoopClarification({ ...input, rationale: 'Changed words.' }),
      error => error.code === 'open-loop-intent-mismatch');
    assert.throws(() => metadata.recordOpenLoopClarification({ ...input, logicalOperationId: 'fictional-stale-clarification' }),
      error => error.code === 'open-loop-stale-revision');
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir });
    const retained = metadata.getOpenLoopObservation(saved.loop.evidenceObservationIds.find(id => id.startsWith('user-clarification:')));
    assert.equal(retained.facts.rationale, input.rationale);
    assert.equal(retained.facts.status, 'submitted');
    assert.equal(metadata.recordOpenLoopClarification(input).disposition, 'duplicate');
    assert.equal(metadata.getOpenLoop(second.loop.loopId).revision, second.loop.revision);
    const corrected = metadata.recordOpenLoopDecision({ schemaVersion: 1,
      logicalOperationId: 'fictional-clarification-resolution', loopId: first.loop.loopId,
      expectedRevision: saved.loop.revision, decision: 'correct-date', dueAt: '2026-10-04T00:00:00.000Z',
      actorId: 'fictional-operator', rationale: 'Verified the fictional attachment date for this item.', updatedAt: '2026-09-24T04:00:00.000Z' });
    assert.equal(corrected.loop.loopId, first.loop.loopId);
    assert.equal(corrected.loop.dueAt, '2026-10-04T00:00:00.000Z');
    assert.equal(corrected.loop.attention.pendingClarificationId, undefined);
    assert.equal(projectQuietAttention(corrected.loop, { now }).group, 'coming-up');
    assert.ok(corrected.loop.evidenceObservationIds.some(id =>
      metadata.getOpenLoopObservation(id)?.facts?.resolvesClarificationId === retained.observationId));
    assert.equal(metadata.listOpenLoops().length, 2);
    assert.equal(metadata.getOpenLoop(second.loop.loopId).revision, second.loop.revision);
    assert.equal(metadata.recordOpenLoopDecision({ schemaVersion: 1,
      logicalOperationId: 'fictional-clarification-resolution', loopId: first.loop.loopId,
      expectedRevision: saved.loop.revision, decision: 'correct-date', dueAt: '2026-10-04T00:00:00.000Z',
      actorId: 'fictional-operator', rationale: 'Verified the fictional attachment date for this item.', updatedAt: '2026-09-24T04:01:00.000Z' }).disposition, 'duplicate');
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('clarifying a paid assertion preserves that assertion while superseding its old follow-up', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-paid-clarification-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    const created = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-paid-intake',
      message: message('fictional-paid-source', 'PAID-1') });
    const paid = metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1,
      logicalOperationId: 'fictional-paid-assertion', loopId: created.loop.loopId,
      expectedRevision: created.loop.revision, paymentState: 'paid', actorId: 'fictional-operator',
      rationale: 'Fictional operator assertion only.', updatedAt: now });
    assert.equal(metadata.getOpenLoopUserActionReceipt('fictional-paid-assertion').current, true);
    const clarified = metadata.recordOpenLoopClarification({ schemaVersion: 1,
      logicalOperationId: 'fictional-paid-clarification', loopId: created.loop.loopId,
      expectedRevision: paid.loop.revision, actorId: 'fictional-operator',
      rationale: 'I may have marked the wrong fictional invoice paid.', updatedAt: '2026-09-24T04:00:00.000Z' });
    assert.equal(clarified.loop.loopId, created.loop.loopId);
    assert.equal(clarified.loop.state, 'uncertain');
    assert.equal(clarified.loop.paymentState, 'paid', 'uninterpreted words do not reverse the user assertion');
    assert.equal(metadata.getOpenLoopUserActionReceipt('fictional-paid-assertion').current, false);
    assert.equal(metadata.getCurrentOpenLoopUserActionReceipt(created.loop.loopId), null);
    assert.equal(projectQuietAttention(clarified.loop, { now }).group, 'attention');
    const settled = metadata.recordOpenLoopPaymentStatus({ schemaVersion: 1,
      logicalOperationId: 'fictional-corrected-payment-status', loopId: created.loop.loopId,
      expectedRevision: clarified.loop.revision, paymentState: 'payment-pending', actorId: 'fictional-operator',
      rationale: 'The fictional payment is pending, not settled.', updatedAt: '2026-09-24T05:00:00.000Z' });
    assert.equal(settled.loop.paymentState, 'payment-pending');
    assert.equal(settled.loop.attention.pendingClarificationId, undefined);
    assert.equal(projectQuietAttention(settled.loop, { now }).group, 'coming-up');
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
