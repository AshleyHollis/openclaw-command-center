import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardService } from '../src/dashboard/service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planMessageIntake } from '../src/open-loops/message-intake.mjs';
import { projectQuietInbox } from '../src/open-loops/quiet-attention.mjs';

const now = '2026-09-20T01:00:00.000Z';
function bill(overrides = {}) {
  return {
    schemaVersion: 1,
    channel: 'email',
    source: { system: 'fictional-mail', externalId: 'restart-bill', version: 'v1' },
    occurredAt: '2026-09-20T00:55:00.000Z',
    observedAt: now,
    historicalBaseline: false,
    disposition: 'confirmed-obligation',
    requestKind: 'payment',
    explicitRequest: true,
    summary: 'A fictional renovation invoice is ready.',
    payee: 'Example Renovations',
    purpose: 'fictional renovation progress invoice',
    amount: 245000,
    currency: 'AUD',
    dueAt: '2026-09-28T13:59:59.000Z',
    invoiceId: 'INVOICE-FICTIONAL-RESTART',
    authorityId: 'EXAMPLE-RENOVATIONS-AUTHORITY',
    evidenceSelectors: ['subject', 'attachment:invoice-number'],
    ...overrides
  };
}

test('restart preserves one bill, payment provenance and duplicate-free source replay', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-open-loop-restart-'));
  let first;
  try {
    first = openCommandCenterMetadataService({ stateDir });
    const created = first.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'restart-intake', message: bill() });
    first.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'restart-payment-pending', loopId: created.loop.loopId, expectedRevision: 1, paymentState: 'payment-pending', actorId: 'operator-fictional', rationale: 'The fictional transfer was initiated but settlement is not verified.', updatedAt: '2026-09-20T02:00:00.000Z' });
    first.close(); first = undefined;

    const reopened = openCommandCenterMetadataService({ stateDir });
    try {
      const loops = reopened.listOpenLoops();
      assert.equal(loops.length, 1);
      assert.equal(loops[0].paymentState, 'payment-pending');
      assert.equal(loops[0].evidenceObservationIds.length, 2);
      const replay = reopened.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'restart-intake', message: bill() });
      assert.equal(replay.disposition, 'duplicate');
      assert.equal(replay.loop.revision, 1, 'the intake receipt remains the immutable revision produced by that operation');
      assert.equal(reopened.listOpenLoopObservations().length, 2);
      assert.deepEqual(reopened.listOpenLoopsPage({ offset: 0, limit: 1 }), { schemaVersion: 1, loops, total: 1, offset: 0, nextOffset: null, nextCursor: null, hasMore: false });
    } finally { reopened.close(); }
  } finally { first?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('a large historical baseline stays quiet while current requests retain honest capped counts', async () => {
  const historical = Array.from({ length: 500 }, (_, index) => planMessageIntake(bill({
    source: { system: 'fictional-archive', externalId: `historical-bill-${index}`, version: 'v1' },
    historicalBaseline: true,
    occurredAt: '2024-01-01T00:00:00.000Z',
    observedAt: '2026-09-20T00:00:00.000Z',
    dueAt: '2024-01-31T00:00:00.000Z',
    invoiceId: `HISTORICAL-INVOICE-${index}`
  })).loop);
  const current = Array.from({ length: 5 }, (_, index) => planMessageIntake(bill({
    channel: 'sms',
    source: { system: 'fictional-sms', externalId: `current-reply-${index}`, version: 'v1' },
    disposition: 'explicit-request',
    requestKind: 'reply',
    amount: undefined,
    currency: undefined,
    dueAt: undefined,
    invoiceId: undefined,
    conversationId: `fictional-conversation-${index}`,
    summary: `Confirm fictional renovation access window ${index}.`
  })).loop);
  const inbox = projectQuietInbox([...historical, ...current], { now });
  assert.equal(inbox.attention.length, 5);
  assert.equal(inbox.waiting.length, 500);
  assert.equal(inbox.comingUp.length, 0);
  const metadata = {
    listUsableTopics: () => [],
    getQuietAttentionInbox: () => inbox,
    listOpenLoops: () => [...historical, ...current],
    listActivity: () => []
  };
  const dashboard = await createDashboardService({ metadata, now: () => now }).get({ schemaVersion: 1 });
  assert.equal(dashboard.openLoops.attentionTotal, 5);
  assert.equal(dashboard.openLoops.highlighted.length, 3);
  assert.equal(dashboard.openLoops.waitingTotal, 500);
  assert.equal(dashboard.openLoops.waiting.length, 20);
  assert.equal(dashboard.openLoops.waiting[0].state, 'confirmed');
  assert.equal(dashboard.attentionBadgeCount, 5);
});

test('informational history remains source evidence without producing loops', () => {
  const plans = Array.from({ length: 1000 }, (_, index) => planMessageIntake(bill({
    source: { system: 'fictional-archive', externalId: `informational-${index}`, version: 'v1' },
    disposition: 'informational',
    requestKind: 'none',
    explicitRequest: false,
    amount: undefined,
    currency: undefined,
    dueAt: undefined,
    invoiceId: undefined,
    summary: `Fictional informational message ${index}.`
  })));
  assert.equal(plans.filter(plan => plan.loop !== null).length, 0);
  assert.equal(plans.every(plan => plan.observation.type === 'general'), true);
});

test('cursor inventory does not skip or duplicate loops when an earlier row is updated', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-open-loop-cursor-'));
  const service = openCommandCenterMetadataService({ stateDir });
  try {
    for (let index = 0; index < 5; index += 1) service.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: `cursor-bill-${index}`, message: bill({ source: { system: 'fictional-mail', externalId: `cursor-source-${index}`, version: 'v1' }, invoiceId: `CURSOR-INVOICE-${index}` }) });
    const first = service.listOpenLoopsPage({ offset: 0, limit: 2 });
    service.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: 'cursor-update-first', loopId: first.loops[0].loopId, expectedRevision: 1, paymentState: 'payment-pending', actorId: 'operator-fictional', rationale: 'Update while the bounded inventory is being reviewed.', updatedAt: '2026-09-20T02:00:00.000Z' });
    const seen = [...first.loops.map(loop => loop.loopId)];
    let cursor = first.nextCursor; let offset = first.nextOffset;
    while (cursor) {
      const page = service.listOpenLoopsPage({ offset, limit: 2, cursor });
      seen.push(...page.loops.map(loop => loop.loopId));
      cursor = page.nextCursor; offset = page.nextOffset;
    }
    assert.equal(new Set(seen).size, 5);
    assert.deepEqual(seen.slice().sort(), service.listOpenLoops().map(loop => loop.loopId).sort());
  } finally { service.close(); await rm(stateDir, { recursive: true, force: true }); }
});
