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
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.capture'].scope, 'operator.write');
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.payment-status'].scope, 'operator.admin');
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.clarify'].scope, 'operator.admin');
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.clarify', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, rationale: 'Please check this one fictional invoice.' }));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.clarify', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, rationale: 'Please check this one fictional invoice.', globalPreference: true }), /Unsupported bridge request field/);
  const decisionId = randomUUID();
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: decisionId, loopId: loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-09-30T00:00:00.000Z', rationale: 'Wait for the fictional corrected invoice.' }));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: decisionId, loopId: loop.loopId, expectedRevision: 1, decision: 'defer', rationale: 'Missing review time.' }), /reviewAt/);
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: decisionId, loopId: loop.loopId, expectedRevision: 1, decision: 'resolve', reviewAt: '2026-09-30T00:00:00.000Z', rationale: 'Unexpected review time.' }), /reviewAt/);
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, decision: 'correct-date', dueAt: '2026-10-04T13:59:59.000Z', rationale: 'The fictional original shows this corrected date.' }));
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, decision: 'correct-date', dueDate: '2026-10-04', dueTimeZone: 'Australia/Brisbane', rationale: 'The fictional original gives a date without a time.' }));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, decision: 'correct-date', rationale: 'Missing corrected date.' }), /corrected timing/);
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, decision: 'correct-date', dueDate: '2026-10-04', rationale: 'Missing timezone.' }), /calendar date with timezone/);
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.payment-status', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: loop.loopId, expectedRevision: 1, paymentState: 'paid', paidAmount: 12300, rationale: 'Missing currency.' }), /currency/);
});

test('quick capture accepts only one explicit task or idea for one exact Topic', async () => {
  const params = { schemaVersion: 1, logicalOperationId: randomUUID(), captureId: randomUUID(), capturedAt: '2026-09-20T01:00:00.000Z', topicId: 'fictional-topic', captureKind: 'task', title: 'Call the fictional cabinet maker' };
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.capture', params));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.capture', { ...params, captureKind: 'note' }), /task, idea/);
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.capture', { ...params, dueAt: '2026-09-30T00:00:00Z' }), /Unsupported bridge request field/);
  const result = await invokeBridgeMethod({
    openLoopsCapture(input) {
      assert.equal(input.authenticatedOperatorId, 'fictional-operator');
      return { schemaVersion: 1, disposition: 'applied', loop: { ...loop, loopId: 'manual-fictional', topicId: input.topicId, kind: 'general', state: 'confirmed', title: input.title } };
    }
  }, 'command-center.v1.open-loops.capture', params, null, 'fictional-operator');
  assert.equal(result.loop.loopId, 'manual-fictional');
});

test('selected-source intake bridge accepts one persisted document selection without caller-supplied content or versions', async () => {
  const logicalOperationId = randomUUID();
  const params = {
    schemaVersion: 1,
    logicalOperationId,
    authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'fictional-source-reference' },
    baselineThrough: '2026-09-01T00:00:00.000Z',
    selections: [{ topicId: 'fictional-topic', path: 'selected-invoice.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }]
  };
  assert.equal(BRIDGE_CONTRACTS['command-center.v1.open-loops.intake-selected'].scope, 'operator.admin');
  assert.doesNotThrow(() => validateBridgeRequest('command-center.v1.open-loops.intake-selected', params));
  assert.throws(() => validateBridgeRequest('command-center.v1.open-loops.intake-selected', { ...params, interpretation: { type: 'bill' } }), /Unsupported bridge request field/);
  const result = await invokeBridgeMethod({
    openLoopsIngestSelected(input) {
      assert.equal(input.authenticatedOperatorId, 'fictional-operator');
      assert.equal(input.selections[0].content, undefined);
      assert.equal(input.selections[0].version, undefined);
      return { schemaVersion: 1, disposition: 'applied', checkpoint: { schemaVersion: 1, laneId: 'lane', scopeId: 'fictional-operator', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'fictional-source-reference', cursor: 'cursor-1', processedCount: 1, lastObservedAt: '2026-09-20T00:01:00.000Z', lastAvailableAt: '2026-09-20T00:01:00.000Z', freshness: 'available', digest: `sha256:${'a'.repeat(64)}` }, freshness: { status: 'available', lastObservedAt: '2026-09-20T00:01:00.000Z', lastAvailableAt: '2026-09-20T00:01:00.000Z' }, hasMore: false, results: [{ disposition: 'created', observationId: 'fictional-observation', sourceVersion: 'v1', historicalBaseline: false, loop }] };
    }
  }, 'command-center.v1.open-loops.intake-selected', params, null, 'fictional-operator');
  assert.equal(result.results[0].loop.loopId, loop.loopId);
  assert.equal(result.checkpoint.scopeId, 'fictional-operator');
});

test('open-loop detail sanitization withholds raw source fields and attachment identifiers', async () => {
  const result = await invokeBridgeMethod({
    openLoopsGet: () => ({ schemaVersion: 1, loop: { ...loop, secretLocator: 'private-source' }, evidence: [{ observationId: 'observation-fictional', type: 'bill', sourceSystem: 'fictional-mail', sourceKind: 'email', sourceVersion: 'v1', sourceReferenceVersion: 'retained-note-v9', originalEmailStatus: 'available', originalEmailUrl: 'https://outlook.office.com/mail/id/fictional', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T01:00:00.000Z', historicalBaseline: false, summary: 'Fictional bill', invoiceId: 'INVOICE-FICTIONAL', attachmentIds: ['private-attachment'], rawBody: 'private-body' }] })
  }, 'command-center.v1.open-loops.get', { schemaVersion: 1, loopId: loop.loopId });
  assert.equal(result.loop.secretLocator, undefined);
  assert.equal(result.evidence[0].attachmentIds, undefined);
  assert.equal(result.evidence[0].rawBody, undefined);
  assert.equal(result.evidence[0].sourceVersion, 'v1');
  assert.equal(result.evidence[0].sourceReferenceVersion, 'retained-note-v9');
  assert.equal(result.evidence[0].originalEmailUrl, 'https://outlook.office.com/mail/id/fictional');
  assert.equal(result.evidence[0].originalEmailStatus, 'available');
  assert.equal(result.evidence[0].invoiceId, 'INVOICE-FICTIONAL');
});

test('open-loop detail retains public interpretation evidence without its internal fence', async () => {
  const interpretationOf = 'fictional-user-clarification';
  const result = await invokeBridgeMethod({
    openLoopsGet: () => ({ schemaVersion: 1, loop, evidence: [{ observationId: 'fictional-interpretation',
      type: 'payment-evidence', sourceSystem: 'command-center', sourceKind: 'processor-interpretation', sourceVersion: 'v1',
      occurredAt: '2026-09-24T00:00:00.000Z', observedAt: '2026-09-24T00:00:00.000Z', historicalBaseline: false,
      paymentState: 'paid', provenance: 'interpreted-user-assertion', interpretationOf, processorVersion: 'fictional-v1',
      interpretationFence: { secret: 'internal-source-identity' } }] })
  }, 'command-center.v1.open-loops.get', { schemaVersion: 1, loopId: loop.loopId });
  assert.deepEqual({ paymentState: result.evidence[0].paymentState, provenance: result.evidence[0].provenance,
    interpretationOf: result.evidence[0].interpretationOf, processorVersion: result.evidence[0].processorVersion },
  { paymentState: 'paid', provenance: 'interpreted-user-assertion', interpretationOf, processorVersion: 'fictional-v1' });
  assert.equal(result.evidence[0].interpretationFence, undefined);
});

test('admitted open-loop mutations require an authenticated operator before acquiring service authority', async () => {
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
  assert.equal(received, undefined);
  let authenticated;
  await methods.get('command-center.v1.open-loops.payment-status')({ req: { id: 'request-authenticated' }, params, client: { authenticatedUserProfile: { profileId: 'fictional-operator' } }, context: { authenticated: true }, respond: (ok, result, error) => { authenticated = { ok, result, error }; } });
  assert.equal(authenticated.ok, true);
  assert.equal(authenticated.result.result.loop.paymentState, 'payment-pending');
  assert.equal(received.authenticatedOperatorId, 'fictional-operator');
});

test('open-loop bridge handler forwards its authenticated Scheduler runtime', async () => {
  const dispatched = [];
  const logicalOperationId = randomUUID();
  const service = {
    async openLoopsDecide(input, runtime) {
      const job = await runtime.gateway.request('cron.add', {
        name: 'Fictional bill review',
        schedule: { kind: 'at', at: input.reviewAt },
        payload: { kind: 'systemEvent', text: 'Review fictional bill' }
      }, { requestId: input.logicalOperationId });
      return { schemaVersion: 1, disposition: 'updated', loop: { ...loop, state: 'waiting', reviewAt: input.reviewAt, revision: 2 }, reminder: { status: 'applied', action: 'create', referenceId: job.id } };
    }
  };
  const client = { authenticatedUserProfile: { profileId: 'fictional-operator' } };
  const gateway = {
    request: async (method, params, options) => {
      dispatched.push({ method, params, options, client });
      return { id: 'fictional-native-reminder' };
    }
  };
  const result = await invokeBridgeMethod(service, 'command-center.v1.open-loops.decide',
    { schemaVersion: 1, logicalOperationId, loopId: loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-09-30T00:00:00.000Z', rationale: 'Review the fictional bill later.' },
    'request-open-loop-defer', 'fictional-operator', { gateway });
  assert.equal(dispatched[0].method, 'cron.add');
  assert.equal(dispatched[0].client, client);
  assert.equal(dispatched[0].options.requestId, logicalOperationId);
  assert.equal(result.reminder.status, 'applied');
});

test('open-loop Reminder routes use the authenticated 9.5 Gateway facade without legacy dispatch options', () => {
  const registrations = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {});
  for (const method of [
    'command-center.v1.open-loops.decide',
    'command-center.v1.open-loops.payment-status',
    'command-center.v1.open-loops.renovation-requirement',
    'command-center.v1.open-loops.renovation-purchase',
    'command-center.v1.open-loops.renovation-purchase-correction',
    'command-center.v1.open-loops.renovation-replacement',
    'command-center.v1.open-loops.renovation-fulfilment'
  ]) assert.equal(registrations.find(([name]) => name === method)[2].gatewayMethodDispatchMethods, undefined);
  assert.equal(registrations.find(([name]) => name === 'command-center.v1.open-loops.intake-selected')[2].gatewayMethodDispatchMethods, undefined);
});
