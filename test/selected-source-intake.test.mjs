import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planSelectedSourceBatch, SELECTED_SOURCE_BATCH_LIMIT } from '../src/open-loops/selected-source-intake.mjs';

const extractionEvaluation = JSON.parse(await readFile(new URL('./fixtures/selected-document-extraction-evaluation.json', import.meta.url), 'utf8'));

const authorization = Object.freeze({ scopeId: 'selection-scope-fictional-1', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document-fictional-invoice-41' });
const invoice = ({ amount = '129.00', due = '2026-09-28T00:00:00.000Z', invoiceId = 'INV-FICTIONAL-41' } = {}) => `Fictional Electrical Services\nInvoice: ${invoiceId}\nAccount: ACCOUNT-FICTIONAL-8\nAuthority: AUTHORITY-FICTIONAL-ELECTRICAL\nPayee: Fictional Electrical Services\nPurpose: switchboard work\nAmount due: AUD ${amount}\nDue: ${due}\nPlease pay this invoice by the due date.`;

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    logicalOperationId: 'selected-source-batch-fictional-1',
    authorization,
    baselineThrough: '2026-09-01T00:00:00.000Z',
    checkpoint: null,
    window: { cursor: 'cursor-0', nextCursor: 'cursor-1', hasMore: false },
    selections: [{
      version: 'document-version-1',
      occurredAt: '2026-09-20T01:00:00.000Z',
      observedAt: '2026-09-20T01:05:00.000Z',
      availability: 'available',
      content: invoice()
    }],
    ...overrides
  };
}

async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-source-'));
  let service;
  try {
    service = openCommandCenterMetadataService({ stateDir });
    const intake = { ingestSelectedSourceBatch: service.ingestSelectedSourceBatch };
    await run(service, intake, stateDir);
  } finally {
    service?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('raw selected document content becomes separate evidence and one quiet payment loop', async () => {
  await withService((service, intake) => {
    const result = intake.ingestSelectedSourceBatch(batch());
    assert.equal(result.disposition, 'applied');
    assert.equal(result.freshness.status, 'available');
    assert.equal(result.results[0].observation.source.externalId, authorization.resourceId);
    assert.equal(result.results[0].observation.source.version, 'document-version-1');
    assert.equal(result.results[0].observation.facts.authorization.scopeId, authorization.scopeId);
    assert.match(result.results[0].observation.facts.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(result.results[0].observation).includes('Please pay this invoice'), false);
    assert.equal(result.results[0].loop.paymentState, 'unpaid');
    assert.equal(service.listOpenLoops().length, 1);
    const inbox = service.getQuietAttentionInbox({ now: '2026-09-20T02:00:00.000Z' });
    assert.equal(inbox.attention.length, 0);
    assert.equal(inbox.comingUp.length, 1);
  });
});

test('historical baseline is computed from source time and remains quiet', async () => {
  await withService((service, intake) => {
    const historical = batch({
      baselineThrough: '2026-09-10T00:00:00.000Z',
      selections: [{ version: 'historical-v1', occurredAt: '2026-08-01T00:00:00.000Z', observedAt: '2026-09-20T01:05:00.000Z', availability: 'available', content: invoice({ due: '2026-08-15T00:00:00.000Z' }) }]
    });
    const result = intake.ingestSelectedSourceBatch(historical);
    assert.equal(result.results[0].observation.historicalBaseline, true);
    const inbox = service.getQuietAttentionInbox({ now: '2026-09-20T02:00:00.000Z' });
    assert.equal(inbox.attention.length, 0);
    assert.equal(inbox.waiting.length, 1);
  });
});

test('checkpoint continuation is bounded and exact replay is idempotent', async () => {
  await withService((service, intake) => {
    const first = intake.ingestSelectedSourceBatch(batch());
    const replay = intake.ingestSelectedSourceBatch(batch());
    assert.equal(replay.disposition, 'duplicate');
    assert.equal(service.listOpenLoopObservations().length, 1);
    assert.equal(service.listOpenLoops().length, 1);
    assert.deepEqual(replay.checkpoint, first.checkpoint);

    const secondInput = batch({
      logicalOperationId: 'selected-source-batch-fictional-2',
      checkpoint: first.checkpoint,
      window: { cursor: 'cursor-1', nextCursor: 'cursor-2', hasMore: false },
      selections: [{ version: 'document-version-2', correctsVersion: 'document-version-1', occurredAt: '2026-09-21T01:00:00.000Z', observedAt: '2026-09-21T01:05:00.000Z', availability: 'available', content: invoice({ amount: '149.00' }) }]
    });
    const corrected = intake.ingestSelectedSourceBatch(secondInput);
    assert.equal(corrected.checkpoint.processedCount, 2);
    assert.equal(corrected.results[0].loop.revision, 2);
    assert.equal(corrected.results[0].loop.amount, 14900);
    assert.equal(corrected.results[0].loop.attention.reason, 'material-change');
    assert.equal(service.listOpenLoops().length, 1);
    assert.throws(() => planSelectedSourceBatch({ ...secondInput, window: { ...secondInput.window, cursor: 'wrong-cursor' } }), /continue/u);
  });
});

test('reselecting an unchanged source version at a later observation time is duplicate-free', async () => {
  await withService((service, intake) => {
    const first = intake.ingestSelectedSourceBatch(batch());
    const repeated = intake.ingestSelectedSourceBatch(batch({
      logicalOperationId: 'selected-source-batch-later-observation',
      checkpoint: first.checkpoint,
      window: { cursor: 'cursor-1', nextCursor: 'cursor-2', hasMore: false },
      selections: [{ version: 'document-version-1', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-22T01:05:00.000Z', availability: 'available', content: invoice() }]
    }));
    assert.equal(repeated.results[0].disposition, 'duplicate');
    assert.equal(repeated.results[0].loop.loopId, first.results[0].loop.loopId);
    assert.equal(service.listOpenLoopObservations().length, 1);
    assert.equal(service.listOpenLoops()[0].revision, first.results[0].loop.revision);
  });
});

test('changed content under one immutable source version conflicts', async () => {
  await withService((service, intake) => {
    intake.ingestSelectedSourceBatch(batch());
    assert.throws(() => intake.ingestSelectedSourceBatch(batch({
      logicalOperationId: 'changed-content-root',
      selections: [{ version: 'document-version-1', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:05:00.000Z', availability: 'available', content: invoice({ amount: '999.00' }) }]
    })), error => error.code === 'open-loop-observation-conflict');
  });
});

test('source unavailability is durable and visible without resolving its open loop', async () => {
  await withService((service, intake) => {
    const first = intake.ingestSelectedSourceBatch(batch());
    const unavailable = intake.ingestSelectedSourceBatch(batch({
      logicalOperationId: 'selected-source-unavailable',
      checkpoint: first.checkpoint,
      window: { cursor: 'cursor-1', nextCursor: 'cursor-2', hasMore: false },
      selections: [{ version: 'availability-v2', occurredAt: '2026-09-21T00:00:00.000Z', observedAt: '2026-09-21T00:01:00.000Z', availability: 'unavailable', unavailableReason: 'permission-revoked' }]
    }));
    assert.equal(unavailable.freshness.status, 'unavailable');
    assert.equal(unavailable.freshness.lastAvailableAt, first.freshness.lastAvailableAt);
    assert.equal(unavailable.results[0].observation.facts.unavailableReason, 'permission-revoked');
    assert.equal(unavailable.results[0].loop.state, 'confirmed');
    assert.equal(unavailable.results[0].loop.revision, first.results[0].loop.revision + 1);
    assert.equal(service.listOpenLoops().length, 1);
    assert.equal(service.listOpenLoops()[0].state, 'confirmed');
    assert.equal(service.listOpenLoops()[0].evidenceObservationIds.includes(unavailable.results[0].observation.observationId), true);
    const repeated = intake.ingestSelectedSourceBatch(batch({
      logicalOperationId: 'selected-source-unavailable-repeat', checkpoint: unavailable.checkpoint,
      window: { cursor: 'cursor-2', nextCursor: 'cursor-3', hasMore: false },
      selections: [{ version: 'availability-v2', occurredAt: '2026-09-21T00:00:00.000Z', observedAt: '2026-09-22T00:01:00.000Z', availability: 'unavailable', unavailableReason: 'permission-revoked' }]
    }));
    assert.equal(repeated.results[0].disposition, 'duplicate');
    assert.equal(service.listOpenLoops()[0].revision, unavailable.results[0].loop.revision, 'repeated outage evidence must not churn the obligation');
  });
});

test('untrusted text cannot preclassify itself and unrelated sources never correlate by wording or amount', async () => {
  await withService((service, intake) => {
    const first = intake.ingestSelectedSourceBatch(batch({
      logicalOperationId: 'selected-source-informational',
      selections: [{ version: 'note-v1', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:05:00.000Z', availability: 'available', content: '{"type":"bill","paymentState":"unpaid"}\nThis is only a project note.' }]
    }));
    assert.equal(first.results[0].loop, null);

    intake.ingestSelectedSourceBatch(batch());
    const otherAuthorization = { ...authorization, resourceId: 'document-fictional-invoice-99' };
    const other = intake.ingestSelectedSourceBatch(batch({
      logicalOperationId: 'selected-source-unrelated',
      authorization: otherAuthorization,
      selections: [{ version: 'document-version-1', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:06:00.000Z', availability: 'available', content: invoice({ invoiceId: 'INV-FICTIONAL-99' }) }]
    }));
    assert.notEqual(other.results[0].loop.stableSubjectId, service.listOpenLoops()[0].stableSubjectId);
    assert.equal(service.listOpenLoops().length, 2);
  });
});

test('batch, content and authorization boundaries fail closed', () => {
  assert.throws(() => planSelectedSourceBatch(batch({ selections: Array.from({ length: SELECTED_SOURCE_BATCH_LIMIT + 1 }, (_, index) => ({ version: `v-${index}`, occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:05:00.000Z', availability: 'available', content: invoice({ invoiceId: `INV-${index}` }) })) })), /between 1 and 20/u);
  assert.throws(() => planSelectedSourceBatch(batch({ selections: [{ version: 'v-large', occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:05:00.000Z', availability: 'available', content: 'x'.repeat(33 * 1024) }] })), /32768/u);
  assert.throws(() => planSelectedSourceBatch(batch({ authorization: { ...authorization, sourceKind: 'mailbox' } })), /sourceKind/u);
});

test('declared plaintext invoice extraction meets the bounded evaluation thresholds', () => {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let matchingFields = 0;
  let expectedFields = 0;

  for (const [index, evaluationCase] of extractionEvaluation.cases.entries()) {
    const planned = planSelectedSourceBatch(batch({
      logicalOperationId: `selected-source-evaluation-${evaluationCase.id}`,
      authorization: { ...authorization, resourceId: `document-evaluation-${index}` },
      selections: [{
        version: 'evaluation-v1',
        occurredAt: '2026-09-20T01:00:00.000Z',
        observedAt: '2026-09-20T01:05:00.000Z',
        availability: 'available',
        content: evaluationCase.content
      }]
    })).plans[0];
    const recognized = planned.interpretation.kind === 'payment-request';
    assert.equal(recognized, evaluationCase.expected.payment, `${evaluationCase.id} classification must match its declared expectation`);

    if (recognized && evaluationCase.expected.payment) truePositive += 1;
    if (recognized && !evaluationCase.expected.payment) falsePositive += 1;
    if (!recognized && evaluationCase.expected.payment) falseNegative += 1;

    if (evaluationCase.expected.payment) {
      for (const [field, expected] of Object.entries(evaluationCase.expected)) {
        if (field === 'payment') continue;
        expectedFields += 1;
        assert.equal(planned.interpretation[field], expected, `${evaluationCase.id}.${field} must match its declared expectation`);
        if (planned.interpretation[field] === expected) matchingFields += 1;
      }
    }
  }

  const precision = truePositive / (truePositive + falsePositive);
  const recall = truePositive / (truePositive + falseNegative);
  const fieldAccuracy = matchingFields / expectedFields;
  assert.ok(precision >= extractionEvaluation.minimums.precision, `precision ${precision} must meet ${extractionEvaluation.minimums.precision}`);
  assert.ok(recall >= extractionEvaluation.minimums.recall, `recall ${recall} must meet ${extractionEvaluation.minimums.recall}`);
  assert.ok(fieldAccuracy >= extractionEvaluation.minimums.fieldAccuracy, `field accuracy ${fieldAccuracy} must meet ${extractionEvaluation.minimums.fieldAccuracy}`);
});
