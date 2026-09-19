import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planMessageIntake } from '../src/open-loops/message-intake.mjs';
import { projectQuietAttention } from '../src/open-loops/quiet-attention.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const observedAt = '2026-09-20T01:00:00.000Z';
function message(overrides = {}) {
  return {
    schemaVersion: 1,
    channel: 'email',
    source: { system: 'fictional-mail', externalId: 'message-1', version: 'v1' },
    occurredAt: '2026-09-20T00:55:00.000Z',
    observedAt,
    historicalBaseline: false,
    disposition: 'confirmed-obligation',
    requestKind: 'payment',
    explicitRequest: true,
    summary: 'A fictional electricity bill is ready.',
    payee: 'Example Energy',
    purpose: 'electricity invoice',
    amount: 12900,
    currency: 'AUD',
    dueAt: '2026-09-28T13:59:59.000Z',
    invoiceId: 'INV-FICTIONAL-42',
    accountId: 'ACCOUNT-FICTIONAL-7',
    attachmentIds: ['attachment-fictional-invoice'],
    evidenceSelectors: ['subject', 'attachment:1:invoice-number'],
    ...overrides
  };
}
async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-message-intake-'));
  const service = openCommandCenterMetadataService({ stateDir });
  try { await run(service); } finally { service.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('informational mail remains evidence without creating an open loop', () => {
  const plan = planMessageIntake(message({ disposition: 'informational', requestKind: 'none', explicitRequest: false, amount: undefined, currency: undefined, dueAt: undefined, invoiceId: undefined }));
  assert.equal(plan.observation.type, 'general');
  assert.equal(plan.loop, null);
});

test('an explicit reply request is immediately actionable while drafting remains non-sending', () => {
  const plan = planMessageIntake(message({ disposition: 'explicit-request', requestKind: 'reply', amount: undefined, currency: undefined, dueAt: undefined, invoiceId: undefined, conversationId: 'conversation-fictional-9', deadlineAt: '2026-09-26T00:00:00.000Z', summary: 'Confirm whether the fictional appointment time works.' }));
  const projected = projectQuietAttention(plan.loop, { now: observedAt });
  assert.equal(projected.group, 'attention');
  assert.equal(projected.reason, 'response-requested');
  assert.deepEqual(projected.actions, ['Open original', 'Draft reply', 'Remind me']);
});

test('a future confirmed bill stays Coming up and a missing date remains a visible current request', () => {
  const future = planMessageIntake(message());
  assert.equal(projectQuietAttention(future.loop, { now: observedAt }).group, 'coming-up');
  const noDate = planMessageIntake(message({ dueAt: undefined }));
  assert.equal(projectQuietAttention(noDate.loop, { now: observedAt }).group, 'attention');
  assert.equal(noDate.loop.dueAt, undefined);
});

test('matching invoice evidence across email and SMS creates one obligation with two sources', async () => {
  await withService(service => {
    const first = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-email-1', message: message() });
    const reminder = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-sms-1', message: message({ channel: 'sms', source: { system: 'fictional-sms', externalId: 'sms-77', version: 'v1' }, disposition: 'source-reminder', summary: 'Reminder for the same fictional invoice.', attachmentIds: [], evidenceSelectors: ['body:invoice-number'] }) });
    assert.equal(first.loop.loopId, reminder.loop.loopId);
    assert.equal(service.listOpenLoops().length, 1);
    assert.equal(service.listOpenLoopObservations().length, 2);
    assert.equal(reminder.loop.evidenceObservationIds.length, 2);
    assert.equal(reminder.loop.state, 'confirmed');
    assert.equal(service.getQuietAttentionInbox({ now: observedAt }).comingUp.length, 1);
  });
});

test('exact intake replay is duplicate-free and does not advance the loop revision', async () => {
  await withService(service => {
    const input = { schemaVersion: 1, logicalOperationId: 'intake-replay', message: message() };
    assert.equal(service.ingestIncomingMessage(input).loop.revision, 1);
    const replay = service.ingestIncomingMessage(input);
    assert.equal(replay.disposition, 'duplicate');
    assert.equal(replay.loop.revision, 1);
    assert.equal(service.listOpenLoops().length, 1);
    assert.equal(service.listOpenLoopObservations().length, 1);
  });
});

test('sender, account and amount similarity never merge distinct invoices', async () => {
  await withService(service => {
    service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-invoice-42', message: message() });
    service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-invoice-43', message: message({ source: { system: 'fictional-mail', externalId: 'message-2', version: 'v1' }, invoiceId: 'INV-FICTIONAL-43' }) });
    service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-account-only', message: message({ source: { system: 'fictional-mail', externalId: 'message-3', version: 'v1' }, invoiceId: undefined }) });
    assert.equal(service.listOpenLoops().length, 3);
  });
});

test('a current reminder after recorded payment creates reconciliation instead of silently reopening or clearing', async () => {
  await withService(service => {
    const created = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-before-payment', message: message() });
    service.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: 'record-fictional-payment', expectedRevision: 1, loop: { ...created.loop, state: 'resolved', paymentState: 'paid', attention: { actions: [], activated: false, currentEvidence: true }, revision: 2 }, updatedAt: '2026-09-21T00:00:00.000Z' });
    const reminder = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'intake-after-payment', message: message({ channel: 'sms', source: { system: 'fictional-sms', externalId: 'sms-after-payment', version: 'v1' }, disposition: 'source-reminder', observedAt: '2026-09-22T00:00:00.000Z', summary: 'A later reminder still requests payment.', attachmentIds: [] }) });
    assert.equal(reminder.loop.state, 'uncertain');
    assert.equal(reminder.loop.paymentState, 'uncertain');
    assert.equal(service.getQuietAttentionInbox({ now: '2026-09-22T00:00:00.000Z' }).attention[0].reason, 'evidence-conflict');
  });
});

test('historical bill intake builds a quiet baseline even when its old due date has passed', async () => {
  await withService(service => {
    service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'historical-intake', message: message({ historicalBaseline: true, occurredAt: '2024-01-01T00:00:00.000Z', dueAt: '2024-01-10T00:00:00.000Z' }) });
    const inbox = service.getQuietAttentionInbox({ now: observedAt });
    assert.equal(inbox.attention.length, 0);
    assert.equal(inbox.waiting.length, 1);
  });
});

test('intake rejects invented dates, unbounded evidence and inconsistent payment classification', () => {
  assert.throws(() => planMessageIntake(message({ dueAt: 'soon' })), /dueAt/);
  assert.throws(() => planMessageIntake(message({ evidenceSelectors: Array.from({ length: 25 }, (_, index) => `field-${index}`) })), /evidenceSelectors/);
  assert.throws(() => planMessageIntake(message({ disposition: 'informational' })), /informational/);
});

test('confirmation, deferral and dismissal are revisioned decisions with durable provenance', async () => {
  await withService(service => {
    const suggested = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'potential-bill', message: message({ disposition: 'potential-obligation', dueAt: undefined, summary: 'This may be a fictional payment obligation.' }) });
    assert.equal(suggested.loop.state, 'suggested');
    const confirmed = service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'confirm-potential-bill', loopId: suggested.loop.loopId, expectedRevision: 1, decision: 'confirm', actorId: 'operator-fictional', rationale: 'The invoice identity matches the accepted work.', updatedAt: '2026-09-20T02:00:00.000Z' });
    assert.equal(confirmed.loop.state, 'confirmed');
    assert.equal(confirmed.loop.paymentState, 'unpaid');
    assert.equal(confirmed.loop.evidenceObservationIds.length, 2);
    assert.equal(service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'confirm-potential-bill', loopId: suggested.loop.loopId, expectedRevision: 1, decision: 'confirm', actorId: 'operator-fictional', rationale: 'The invoice identity matches the accepted work.', updatedAt: '2026-09-20T02:00:00.000Z' }).disposition, 'duplicate');

    const reply = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'reply-to-defer', message: message({ source: { system: 'fictional-mail', externalId: 'reply-message', version: 'v1' }, disposition: 'explicit-request', requestKind: 'reply', amount: undefined, currency: undefined, dueAt: undefined, invoiceId: undefined, conversationId: 'conversation-to-defer', summary: 'Confirm the fictional access details.' }) });
    const deferred = service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'defer-reply', loopId: reply.loop.loopId, expectedRevision: 1, decision: 'defer', reviewAt: '2026-09-25T00:00:00.000Z', actorId: 'operator-fictional', rationale: 'Review after the contractor sends the access plan.', updatedAt: '2026-09-20T02:10:00.000Z' });
    assert.equal(projectQuietAttention(deferred.loop, { now: '2026-09-21T00:00:00.000Z' }).group, 'deferred');

    const dismissible = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'dismissible-bill', message: message({ source: { system: 'fictional-mail', externalId: 'dismissible', version: 'v1' }, invoiceId: 'INV-DISMISSIBLE', disposition: 'potential-obligation' }) });
    const dismissed = service.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'dismiss-bill', loopId: dismissible.loop.loopId, expectedRevision: 1, decision: 'dismiss', actorId: 'operator-fictional', rationale: 'This is not an accepted obligation.', updatedAt: '2026-09-20T02:20:00.000Z' });
    assert.equal(dismissed.loop.state, 'cancelled');
  });
});

test('partial and pending payment assertions remain open while paid resolves with explicit provenance', async () => {
  await withService(service => {
    const created = service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'payment-lifecycle-bill', message: message({ dueAt: '2026-09-22T00:00:00.000Z' }) });
    const partial = service.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'partial-payment', loopId: created.loop.loopId, expectedRevision: 1, paymentState: 'partially-paid', paidAmount: 2900, currency: 'AUD', actorId: 'operator-fictional', rationale: 'A fictional deposit was recorded.', updatedAt: '2026-09-20T03:00:00.000Z' });
    assert.equal(partial.loop.state, 'confirmed');
    assert.equal(partial.loop.paymentState, 'partially-paid');
    assert.equal(projectQuietAttention(partial.loop, { now: '2026-09-21T00:00:00.000Z' }).group, 'attention');
    const pending = service.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'pending-payment', loopId: created.loop.loopId, expectedRevision: 2, paymentState: 'payment-pending', actorId: 'operator-fictional', rationale: 'The fictional transfer was initiated but has no settlement evidence.', updatedAt: '2026-09-20T03:10:00.000Z' });
    assert.equal(pending.loop.state, 'monitoring');
    const paid = service.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'paid-payment', loopId: created.loop.loopId, expectedRevision: 3, paymentState: 'paid', paidAmount: 12900, currency: 'AUD', actorId: 'operator-fictional', rationale: 'I verified the fictional payment record.', updatedAt: '2026-09-20T03:20:00.000Z' });
    assert.equal(paid.loop.state, 'resolved');
    assert.equal(paid.loop.paymentState, 'paid');
    assert.equal(projectQuietAttention(paid.loop, { now: '2026-09-21T00:00:00.000Z' }).group, 'terminal');
    assert.equal(service.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'paid-payment', loopId: created.loop.loopId, expectedRevision: 3, paymentState: 'paid', paidAmount: 12900, currency: 'AUD', actorId: 'operator-fictional', rationale: 'I verified the fictional payment record.', updatedAt: '2026-09-20T03:20:00.000Z' }).disposition, 'duplicate');
    const observationCount = service.listOpenLoopObservations().length;
    assert.throws(() => service.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'invalid-partial', loopId: created.loop.loopId, expectedRevision: 4, paymentState: 'partially-paid', paidAmount: 12900, currency: 'AUD', actorId: 'operator-fictional', rationale: 'Invalid full amount as partial.', updatedAt: '2026-09-20T03:30:00.000Z' }), error => error.code === 'open-loop-partial-payment-invalid');
    assert.equal(service.listOpenLoopObservations().length, observationCount);
  });
});
