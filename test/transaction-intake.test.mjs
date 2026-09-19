import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planTransactionEvent } from '../src/open-loops/transaction-intake.mjs';
import { projectQuietAttention } from '../src/open-loops/quiet-attention.mjs';

const now = '2026-09-20T01:00:00.000Z';
function event(overrides = {}) {
  return {
    schemaVersion: 1,
    source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-1', version: 'v1' },
    eventKind: 'order-placed',
    subject: { kind: 'order', id: 'ORDER-FICTIONAL-1' },
    occurredAt: now,
    observedAt: now,
    historicalBaseline: false,
    summary: 'Fictional kitchen cabinets were ordered.',
    supplier: 'Example Joinery',
    amount: 880000,
    currency: 'AUD',
    amountBasis: 'including-tax',
    expectedAt: '2026-10-20T01:00:00.000Z',
    installationRequired: true,
    lineItemIds: ['cabinet-set-fictional'],
    evidenceSelectors: ['document:order-number'],
    ...overrides
  };
}
async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-transaction-intake-'));
  const service = openCommandCenterMetadataService({ stateDir });
  try { await run(service); } finally { service.close(); await rm(stateDir, { recursive: true, force: true }); }
}
const ingest = (service, logicalOperationId, value) => service.ingestTransactionEvent({ schemaVersion: 1, logicalOperationId, event: value });

test('quote revisions preserve both sources and request comparison without claiming an increase', async () => {
  await withService(service => {
    const first = ingest(service, 'quote-v1', event({ eventKind: 'quote-issued', subject: { kind: 'quote', id: 'QUOTE-FICTIONAL-8' }, source: { system: 'fictional-documents', externalId: 'quote-8', version: 'v1' }, summary: 'Initial fictional benchtop quote.', amount: 910000, amountBasis: 'excluding-tax', expectedAt: undefined, installationRequired: undefined }));
    assert.equal(projectQuietAttention(first.loop, { now }).group, 'suggested');
    const revised = ingest(service, 'quote-v2', event({ eventKind: 'quote-revised', subject: { kind: 'quote', id: 'QUOTE-FICTIONAL-8' }, source: { system: 'fictional-documents', externalId: 'quote-8', version: 'v2' }, summary: 'Revised fictional benchtop quote.', amount: 995000, amountBasis: 'including-tax', expectedAt: undefined, installationRequired: undefined, materialChanges: ['amount-or-basis-changed'] }));
    assert.equal(revised.loop.loopId, first.loop.loopId);
    assert.equal(revised.loop.evidenceObservationIds.length, 2);
    assert.equal(projectQuietAttention(revised.loop, { now }).reason, 'material-change');
    assert.match(revised.loop.attention.whyNow, /review the evidence/i);
    assert.doesNotMatch(revised.loop.attention.whyNow, /increase|more expensive/i);
    assert.deepEqual(service.listOpenLoopObservations().map(item => item.source.version).sort(), ['v1', 'v2']);
  });
});

test('split delivery stays open and delivery completion remains distinct from installation', async () => {
  await withService(service => {
    const placed = ingest(service, 'order-place', event());
    const dispatched = ingest(service, 'order-dispatch', event({ eventKind: 'dispatch', source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-2', version: 'v1' }, amount: undefined, currency: undefined, amountBasis: undefined, summary: 'The fictional cabinet order was dispatched.' }));
    const partial = ingest(service, 'order-partial', event({ eventKind: 'delivery-partial', source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-3', version: 'v1' }, amount: undefined, currency: undefined, amountBasis: undefined, summary: 'Only the fictional cabinet carcasses arrived.', lineItemIds: ['cabinet-carcasses-fictional'] }));
    assert.equal(placed.loop.loopId, dispatched.loop.loopId);
    assert.equal(partial.loop.state, 'monitoring');
    assert.equal(partial.loop.expectedEvent, 'remaining delivery');
    const delivered = ingest(service, 'order-delivered', event({ eventKind: 'delivery-complete', source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-4', version: 'v1' }, amount: undefined, currency: undefined, amountBasis: undefined, summary: 'All fictional cabinet packages arrived.', lineItemIds: ['cabinet-set-fictional'] }));
    assert.equal(delivered.loop.state, 'monitoring');
    assert.equal(delivered.loop.expectedEvent, 'installation');
    const installed = ingest(service, 'order-installed', event({ eventKind: 'installation-complete', source: { system: 'fictional-installer', kind: 'installation-record', externalId: 'installation-1', version: 'v1' }, amount: undefined, currency: undefined, amountBasis: undefined, expectedAt: undefined, summary: 'The fictional cabinets were installed.', lineItemIds: ['cabinet-set-fictional'] }));
    assert.equal(installed.loop.state, 'resolved');
    assert.equal(projectQuietAttention(installed.loop, { now }).group, 'terminal');
  });
});

test('a corrected expected date surfaces once while exact replay remains duplicate-free', async () => {
  await withService(service => {
    ingest(service, 'date-original', event());
    const correctedEvent = event({ source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-date', version: 'v2' }, eventKind: 'dispatch', amount: undefined, currency: undefined, amountBasis: undefined, expectedAt: '2026-11-03T01:00:00.000Z', summary: 'The fictional cabinet delivery date was corrected.', materialChanges: ['expected-date-changed'] });
    const corrected = ingest(service, 'date-correction', correctedEvent);
    assert.equal(projectQuietAttention(corrected.loop, { now }).reason, 'material-change');
    assert.equal(corrected.loop.dueAt, '2026-11-03T01:00:00.000Z');
    const replay = ingest(service, 'date-correction', correctedEvent);
    assert.equal(replay.disposition, 'duplicate');
    assert.equal(replay.loop.revision, 2);
    assert.equal(service.listOpenLoopObservations().length, 2);
  });
});

test('same supplier does not let an unrelated delivery close another exact order', async () => {
  await withService(service => {
    const first = ingest(service, 'first-order', event());
    const other = ingest(service, 'other-delivery', event({ subject: { kind: 'order', id: 'ORDER-FICTIONAL-2' }, source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-other', version: 'v1' }, eventKind: 'delivery-complete', amount: undefined, currency: undefined, amountBasis: undefined, installationRequired: false, summary: 'A different fictional order arrived.' }));
    assert.notEqual(first.loop.loopId, other.loop.loopId);
    assert.equal(other.loop.state, 'resolved');
    assert.equal(service.getOpenLoop(first.loop.loopId).state, 'confirmed');
  });
});

test('an exact cancellation closes only its order and retains cancellation evidence', async () => {
  await withService(service => {
    const placed = ingest(service, 'cancel-order-place', event());
    const cancelled = ingest(service, 'cancel-order', event({ eventKind: 'order-cancelled', source: { system: 'fictional-orders', kind: 'order-event', externalId: 'event-cancel', version: 'v1' }, amount: undefined, currency: undefined, amountBasis: undefined, expectedAt: undefined, summary: 'The fictional cabinet order was cancelled.', materialChanges: ['order-cancelled'] }));
    assert.equal(cancelled.loop.loopId, placed.loop.loopId);
    assert.equal(cancelled.loop.state, 'cancelled');
    assert.equal(cancelled.loop.evidenceObservationIds.length, 2);
    assert.equal(projectQuietAttention(cancelled.loop, { now }).group, 'terminal');
    assert.equal(service.getOpenLoopObservation(cancelled.observation.observationId).facts.eventKind, 'order-cancelled');
  });
});

test('appointment revisions retain history and request a decision for the exact appointment', async () => {
  await withService(service => {
    const confirmed = ingest(service, 'appointment-confirmed', event({ eventKind: 'appointment-confirmed', subject: { kind: 'appointment', id: 'APPOINTMENT-FICTIONAL-1' }, source: { system: 'fictional-calendar-mail', kind: 'appointment', externalId: 'appointment-message', version: 'v1' }, amount: undefined, currency: undefined, amountBasis: undefined, installationRequired: undefined, expectedAt: '2026-10-01T03:00:00.000Z', summary: 'Fictional benchtop measure appointment.' }));
    assert.equal(confirmed.loop.state, 'suggested');
    const revised = ingest(service, 'appointment-revised', event({ eventKind: 'appointment-revised', subject: { kind: 'appointment', id: 'APPOINTMENT-FICTIONAL-1' }, source: { system: 'fictional-calendar-mail', kind: 'appointment', externalId: 'appointment-message', version: 'v2' }, amount: undefined, currency: undefined, amountBasis: undefined, installationRequired: undefined, expectedAt: '2026-10-03T05:00:00.000Z', summary: 'Fictional benchtop measure appointment changed.', materialChanges: ['appointment-time-changed'] }));
    assert.equal(revised.loop.loopId, confirmed.loop.loopId);
    assert.equal(revised.loop.state, 'decision-needed');
    assert.equal(projectQuietAttention(revised.loop, { now }).reason, 'material-change');
    assert.equal(revised.loop.evidenceObservationIds.length, 2);
  });
});

test('historical orders and old expected dates build a quiet baseline', async () => {
  await withService(service => {
    const historical = ingest(service, 'historical-order', event({ historicalBaseline: true, occurredAt: '2024-01-01T00:00:00.000Z', expectedAt: '2024-02-01T00:00:00.000Z' }));
    const projected = projectQuietAttention(historical.loop, { now });
    assert.equal(projected.group, 'waiting');
    assert.equal(service.getQuietAttentionInbox({ now }).attention.length, 0);
  });
});

test('transaction intake rejects ambiguous identity and invalid event families', () => {
  assert.throws(() => planTransactionEvent(event({ subject: { kind: 'order', id: '' } })), /subject.id/);
  assert.throws(() => planTransactionEvent(event({ eventKind: 'quote-issued', subject: { kind: 'order', id: 'ORDER-FICTIONAL-1' } })), /does not match/);
  assert.throws(() => planTransactionEvent(event({ amountBasis: 'probably-taxed' })), /amountBasis/);
});
