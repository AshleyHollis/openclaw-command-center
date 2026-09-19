import assert from 'node:assert/strict';
import test from 'node:test';
import { exactCorrelationKeys, normalizeLoop, normalizeObservation } from '../src/open-loops/contracts.mjs';
import { projectQuietAttention, projectQuietInbox } from '../src/open-loops/quiet-attention.mjs';

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'observation-fictional-invoice-1',
    source: { system: 'fictional-mail', kind: 'email', externalId: 'message-fictional-1', version: 'v1' },
    type: 'bill',
    occurredAt: '2026-09-18T02:00:00Z',
    observedAt: '2026-09-18T02:01:00Z',
    historicalBaseline: false,
    facts: { invoiceId: 'INV-FICTIONAL-41', accountId: 'ACCOUNT-FICTIONAL', amount: 45000, currency: 'AUD' },
    ...overrides
  };
}

function loop(overrides = {}) {
  return {
    schemaVersion: 1,
    loopId: 'loop-fictional-invoice-41',
    kind: 'payment',
    stableSubjectId: 'invoice:INV-FICTIONAL-41',
    title: 'Pay fictional electrical invoice',
    state: 'confirmed',
    paymentState: 'unpaid',
    amount: 45000,
    currency: 'aud',
    dueAt: '2026-09-25T00:00:00Z',
    evidenceObservationIds: ['observation-fictional-invoice-1'],
    attention: { actions: ['view-source', 'record-payment', 'remind'], currentEvidence: true },
    revision: 1,
    ...overrides
  };
}

test('observations preserve source identity and exact identifiers without sender-based correlation', () => {
  const normalized = normalizeObservation(observation({ facts: { invoiceId: 'INV-FICTIONAL-41', sender: 'billing@example.invalid', amount: 45000 } }));
  assert.match(normalized.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(exactCorrelationKeys(observation({ facts: { invoiceId: 'INV-FICTIONAL-41', sender: 'billing@example.invalid', amount: 45000 } })), ['invoice:INV-FICTIONAL-41']);
  assert.deepEqual(exactCorrelationKeys(observation({ observationId: 'unrelated', source: { system: 'fictional-mail', kind: 'sms', externalId: 'sms-2', version: 'v1' }, facts: { sender: 'billing@example.invalid', amount: 45000 } })), []);
});

test('observation replay is canonical while changed source versions remain distinct evidence', () => {
  const first = normalizeObservation(observation());
  const replay = normalizeObservation({ ...observation(), facts: { currency: 'AUD', amount: 45000, accountId: 'ACCOUNT-FICTIONAL', invoiceId: 'INV-FICTIONAL-41' } });
  const revision = normalizeObservation(observation({ source: { system: 'fictional-mail', kind: 'email', externalId: 'message-fictional-1', version: 'v2' } }));
  assert.equal(replay.digest, first.digest);
  assert.notEqual(revision.digest, first.digest);
});

test('future bills remain Coming up until their accepted attention window', () => {
  const projected = projectQuietAttention(loop(), { now: '2026-09-19T00:00:00Z', leadTimeMs: 3 * 24 * 60 * 60 * 1000 });
  assert.equal(projected.group, 'coming-up');
  assert.equal(projected.dueAt, '2026-09-25T00:00:00Z');
});

test('current due bills explain why they need attention and expose safe actions', () => {
  const projected = projectQuietAttention(loop(), { now: '2026-09-23T00:00:00Z' });
  assert.deepEqual({ group: projected.group, reason: projected.reason, whyNow: projected.whyNow, actions: projected.actions }, {
    group: 'attention', reason: 'due-window', whyNow: 'Pay fictional electrical invoice is approaching its accepted due date.',
    actions: ['view-source', 'record-payment', 'remind']
  });
});

test('historical imports do not create a fresh overdue backlog', () => {
  const projected = projectQuietAttention(loop({
    dueAt: '2024-01-10T00:00:00Z',
    attention: { actions: ['view-source', 'record-payment'], currentEvidence: false }
  }), { now: '2026-09-19T00:00:00Z' });
  assert.equal(projected.group, 'waiting');
});

test('explicit response requests are actionable only with a useful next action', () => {
  const base = loop({ kind: 'response', paymentState: undefined, amount: undefined, currency: undefined, dueAt: undefined, title: 'Confirm fictional appointment', attention: { reason: 'response-requested', whyNow: 'The fictional contractor asked for access confirmation.', actions: ['open-source', 'draft-reply'], currentEvidence: true } });
  assert.equal(projectQuietAttention(base).group, 'attention');
  assert.equal(projectQuietAttention({ ...base, attention: { ...base.attention, actions: [] } }).group, 'waiting');
});

test('payment lifecycle does not treat pending or partial payment as settlement', () => {
  assert.equal(projectQuietAttention(loop({ paymentState: 'payment-pending' }), { now: '2026-09-23T00:00:00Z' }).group, 'attention');
  assert.equal(projectQuietAttention(loop({ paymentState: 'partially-paid' }), { now: '2026-09-23T00:00:00Z' }).group, 'attention');
  assert.equal(projectQuietAttention(loop({ paymentState: 'paid', state: 'resolved' }), { now: '2026-09-23T00:00:00Z' }).group, 'terminal');
});

test('quiet inbox separates suggestions, waiting work, upcoming dates and active attention', () => {
  const inbox = projectQuietInbox([
    loop({ loopId: 'suggested', state: 'suggested', dueAt: undefined }),
    loop({ loopId: 'waiting', kind: 'order', paymentState: undefined, amount: undefined, currency: undefined, state: 'waiting', dueAt: undefined, attention: undefined }),
    loop({ loopId: 'upcoming', dueAt: '2026-10-20T00:00:00Z' }),
    loop({ loopId: 'actionable', dueAt: '2026-09-20T00:00:00Z' })
  ], { now: '2026-09-19T00:00:00Z' });
  assert.deepEqual({ attention: inbox.attention.length, comingUp: inbox.comingUp.length, waiting: inbox.waiting.length, suggested: inbox.suggested.length }, { attention: 1, comingUp: 1, waiting: 1, suggested: 1 });
});

test('contracts reject invented due dates, unsafe money and unbounded evidence', () => {
  assert.throws(() => normalizeLoop(loop({ dueAt: 'Friday' })), /RFC 3339/u);
  assert.throws(() => normalizeLoop(loop({ amount: 45.2 })), /minor currency units/u);
  assert.throws(() => normalizeObservation(observation({ facts: { body: 'x'.repeat(13 * 1024) } })), /exceeds/u);
});

