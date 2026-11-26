import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentIdentity } from '../src/open-loops/payment-identity.mjs';
import { normalizeAcceptedExtraction } from '../src/open-loops/intake-accounting.mjs';
import { planCommitmentCapture } from '../src/open-loops/commitment-capture.mjs';

const identity = { schemaVersion: 1, amountMinorUnits: 12500, currency: 'AUD', invoiceId: 'BILL-101' };
const obligation = { obligationId: 'BILL-101', title: 'Fictional accepted invoice', classification: 'obligation', obligationKind: 'payment', provenance: 'explicit', paymentIdentity: identity };
test('payment identity is closed, exact and never coerces amounts or infers currency scale', () => {
  assert.deepEqual(normalizePaymentIdentity(identity), identity);
  for (const patch of [{ amountMinorUnits: '12500' }, { amountMinorUnits: -1 }, { amountMinorUnits: 1.5 }, { amountMinorUnits: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'aud' }, { currency: undefined }, { invented: true }, { invoiceId: ' BILL-101' }, { predecessor: { loopId: 'loop', observationId: 'observation', explanation: 'new request', title: 'guessed' } }]) assert.throws(() => normalizePaymentIdentity({ ...identity, ...patch }), error => error.code === 'invalid-request');
});
test('accepted extraction preserves exact payment facts only on explicit payment obligations', () => {
  const extraction = { schemaVersion: 1, notePath: 'Bills/101.md', knowledgeMarkdown: '', obligations: [obligation] };
  assert.deepEqual(normalizeAcceptedExtraction(extraction).obligations[0].paymentIdentity, identity);
  for (const patch of [{ provenance: 'inferred' }, { classification: 'decision' }, { obligationKind: undefined }]) assert.throws(() => normalizeAcceptedExtraction({ ...extraction, obligations: [{ ...obligation, ...patch }] }));
});
test('capture retains namespaced facts without adding generic reconciliation or legacy payment assertions', () => {
  const { classification, ...accepted } = obligation;
  const input = { schemaVersion: 1, ...accepted, logicalOperationId: '00000000-0000-4000-8000-000000000001', sourceKind: 'email', sourceExternalId: 'fictional:message-101', sourceVersion: 'v1', topicId: 'fictional-home', occurredAt: '2026-10-05T22:00:00Z', observedAt: '2026-10-05T22:00:00Z' };
  const planned = planCommitmentCapture(input);
  assert.deepEqual(planned.observation.facts.paymentIdentity, identity);
  assert.equal(planned.observation.facts.invoiceId, undefined);
  assert.equal(planned.loop.amount, undefined); assert.equal(planned.loop.paymentState, 'unpaid');
  for (const patch of [{ sourceKind: 'note' }, { historicalBaseline: true }, { provenance: 'quoted' }]) assert.throws(() => planCommitmentCapture({ ...input, ...patch }));
});
