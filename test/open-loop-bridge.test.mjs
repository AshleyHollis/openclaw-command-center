import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BRIDGE_CONTRACTS, validateBridgeRequest } from '../src/bridge/contracts.mjs';
import { invokeBridgeMethod, registerBridgeMethods } from '../src/bridge/register.mjs';

const loop = {
  schemaVersion: 1,
  loopId: 'loop-fictional',
  kind: 'payment',
  stableSubjectId: 'invoice:fictional-1',
  title: 'Fictional invoice',
  state: 'confirmed',
  paymentState: 'unpaid',
  amount: 12300,
  currency: 'AUD',
  attention: { actions: ['Open bill'], activated: false, currentEvidence: true },
  evidenceObservationIds: ['observation-fictional'],
  revision: 1
};

test('open-loop bridge contracts use read and native-Reminder admin scopes with closed lifecycle inputs', () => {
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.list'].scope, 'operator.read');
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.payment-status'].scope, 'operator.admin');
  const decisionId = randomUUID();
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: decisionId, loopId: loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-09-30T00:00:00.000Z', rationale: 'Wait for the fictional corrected invoice.' }));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: decisionId, loopId: loop.loopId, expectedRevision: 1, decision: 'defer', rationale: 'Missing review time.' }), /reviewAt/);
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: decisionId, loopId: loop.loopId, expectedRevision: 1, decision: 'resolve', reviewAt: '2026-09-30T00:00:00.000Z', rationale: 'Unexpected review time.' }), /reviewAt/);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, decision: 'correct-date', dueAt: '2026-10-04T13:59:59.000Z', rationale: 'The fictional original shows this corrected date.' }));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, decision: 'correct-date', rationale: 'Missing corrected date.' }), /dueAt/);
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.payment-status', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, paymentState: 'paid', paidAmount: 12300, rationale: 'Missing currency.' }), /currency/);
});

test('selected-source intake bridge accepts only the bounded raw-source envelope and returns a closed summary', async () => {
  const logicalOperationId = randomUUID();
  const params = {
    schemaVersion: 1,
    logicalOperationId,
    authorization: { scopeId: 'fictional-operator', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'fictional-source-reference' },
    baselineThrough: '2026-09-01T00:00:00.000Z',
    window: { cursor: 'cursor-0', nextCursor: 'cursor-1', hasMore: false },
    selections: [{ version: 'v1', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', availability: 'available', content: 'Invoice: INV-FICTIONAL\nAmount due: AUD 48.00' }]
  };
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.intake-selected'].scope, 'operator.admin');
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.intake-selected', params));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.intake-selected', { ...params, interpretation: { type: 'bill' } }), /Unsupported bridge request field/);
  const result = await invokeBridgeMethod({
    openLoopsIngestSelected(input) {
      assert.equal(input.authenticatedOperatorId, 'fictional-operator');
      return { schemaVersion: 1, disposition: 'applied', checkpoint: { schemaVersion: 1, laneId: 'lane', scopeId: 'fictional-operator', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'fictional-source-reference', cursor: 'cursor-1', processedCount: 1, lastObservedAt: '2026-09-20T00:01:00.000Z', lastAvailableAt: '2026-09-20T00:01:00.000Z', freshness: 'available', digest: `sha256:${'a'.repeat(64)}` }, freshness: { status: 'available', lastObservedAt: '2026-09-20T00:01:00.000Z', lastAvailableAt: '2026-09-20T00:01:00.000Z' }, hasMore: false, results: [{ disposition: 'created', observationId: 'fictional-observation', sourceVersion: 'v1', historicalBaseline: false, loop }] };
    }
  }, 'command-center.v1.open-loops.intake-selected', params, null, 'fictional-operator');
  assert.equal(result.results[0].loop.loopId, loop.loopId);
  assert.equal(result.checkpoint.scopeId, 'fictional-operator');
});

test('open-loop detail sanitization withholds raw source fields and attachment identifiers', async () => {
  const result = await invokeBridgeMethod({
    openLoopsGet: () => ({ schemaVersion: 1, loop: { ...loop, secretLocator: 'private-source' }, evidence: [{ observationId: 'observation-fictional', type: 'bill', sourceSystem: 'fictional-mail', sourceKind: 'email', sourceVersion: 'v1', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T01:00:00.000Z', historicalBaseline: false, summary: 'Fictional bill', invoiceId: 'INVOICE-FICTIONAL', attachmentIds: ['private-attachment'], rawBody: 'private-body' }] })
  }, 'command-center.v1.open-loops.get', { schemaVersion: 1, loopId: loop.loopId });
  assert.equal(result.loop.secretLocator, undefined);
  assert.equal(result.evidence[0].attachmentIds, undefined);
  assert.equal(result.evidence[0].rawBody, undefined);
  assert.equal(result.evidence[0].sourceVersion, 'v1');
  assert.equal(result.evidence[0].invoiceId, 'INVOICE-FICTIONAL');
});

test('registered open-loop mutations require an authenticated operator and reach the qualified service', async () => {
  const methods = new Map();
  let received;
  registerBridgeMethods({ registerGatewayMethod: (name, handler) => methods.set(name, handler) }, {
    openLoopsPaymentStatus(input) { received = input; return { schemaVersion: 1, disposition: 'applied', loop: { ...loop, state: 'monitoring', paymentState: 'payment-pending', revision: 2 } }; }
  });
  const params = { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, paymentState: 'payment-pending', rationale: 'The fictional transfer is awaiting settlement.' };
  let unauthenticated;
  await methods.get('command-center.v1.open-loops.payment-status')({ req: { id: 'request-unauthenticated' }, params, context: { authenticated: true }, respond: (ok, result, error) => { unauthenticated = { ok, result, error }; } });
  assert.equal(unauthenticated.ok, false);
  assert.equal(unauthenticated.error.code, 'unauthenticated');
  let authenticated;
  await methods.get('command-center.v1.open-loops.payment-status')({ req: { id: 'request-authenticated' }, params, client: { authenticatedUserProfile: { profileId: 'fictional-operator' } }, context: { authenticated: true }, respond: (ok, result, error) => { authenticated = { ok, result, error }; } });
  assert.equal(authenticated.ok, true);
  assert.equal(authenticated.result.result.loop.paymentState, 'payment-pending');
  assert.equal(received.authenticatedOperatorId, 'fictional-operator');
});
