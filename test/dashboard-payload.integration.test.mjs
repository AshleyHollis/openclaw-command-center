import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAttentionService } from '../src/attention/service.mjs';
import { createDashboardService } from '../src/dashboard/service.mjs';
import { createDashboardReadHttpHandler } from '../src/dashboard/http-route.mjs';

test('a full Activity page remains readable alongside multiple due Reminders', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-dashboard-payload-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { attention: true, activity: true, scheduler: true } });
  const now = '2026-09-05T10:00:00.000Z';
  const attention = createAttentionService({ metadata, now: () => now });
  try {
    const topicId = randomUUID();
    metadata.createTopic({ topicId, name: 'Fictional Dashboard Topic', paraCategory: 'project', lifecycle: 'active' });
    for (let index = 0; index < 51; index += 1) metadata.recordActivity({
      activityId: `activity:${randomUUID()}`, topicId, logicalOperationId: randomUUID(), transportRequestId: randomUUID(),
      operationKind: 'fixture.scale', outcome: 'applied', observedRevision: `sha256:${String(index).padStart(64, '0')}`,
      createdAt: now, updatedAt: now
    });
    attention.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', monitoring: true, actions: [], deriveEvidence: (value) => value.evidenceFacts, verifyTransition: () => true });
    for (let index = 0; index < 5; index += 1) {
      const referenceId = randomUUID();
      const jobId = randomUUID();
      metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: jobId, observedRevision: `sha256:${'a'.repeat(64)}` });
      await attention.ingest({ schemaVersion: 1, sourceCapabilityId: 'reminders', stableSubjectId: jobId, attentionReason: 'reminder-due', occurrenceId: randomUUID(), occurrenceVersion: `sha256:${'a'.repeat(64)}`, occurredAt: now, topicId, sourceReferenceId: referenceId, evidenceFacts: { reminderDue: true, explicitTimed: true, dueAt: now } });
    }
    const dashboard = createDashboardService({ metadata, attentionService: attention, now: () => now });
    const expected = await dashboard.get({ schemaVersion: 1, activityOffset: 0, activityLimit: 50 });
    assert.equal(expected.activity.records.length, 50);
    assert.equal(expected.attention.length, 5);
    const bytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, status: 'applied', result: expected }));
    assert.ok(bytes > 32_768, `the legal mixed Dashboard must reproduce the old response overflow; observed ${bytes} bytes`);
    const response = { statusCode: 0, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await createDashboardReadHttpHandler({ dashboard })({ method: 'GET', url: '/plugins/command-center/api/dashboard?activityLimit=50', headers: { origin: 'null' } }, response);
    assert.equal(response.statusCode, 200, JSON.stringify({ bytes, body: response.body }));
    assert.deepEqual(response.body.result, JSON.parse(JSON.stringify(expected)));
    assert.equal(response.body.result.activity.nextOffset, 50);
    assert.equal(response.body.result.activity.hasMore, true);
  } finally { attention.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('Dashboard keeps future bills quiet and highlights current reply requests with bounded evidence', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-dashboard-open-loops-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  const now = '2026-09-20T01:00:00.000Z';
  try {
    metadata.ingestIncomingMessage({
      schemaVersion: 1,
      logicalOperationId: 'dashboard-fictional-bill',
      message: {
        schemaVersion: 1,
        channel: 'email',
        source: { system: 'fictional-mail', externalId: 'bill-message', version: 'v1' },
        occurredAt: now,
        observedAt: now,
        historicalBaseline: false,
        disposition: 'confirmed-obligation',
        requestKind: 'payment',
        explicitRequest: true,
        summary: 'A fictional renovation progress invoice is ready.',
        payee: 'Example Renovations',
        purpose: 'kitchen progress invoice',
        amount: 245000,
        currency: 'AUD',
        dueAt: '2026-10-04T13:59:59.000Z',
        invoiceId: 'RENOVATION-FICTIONAL-3',
        attachmentIds: ['fictional-invoice-pdf'],
        evidenceSelectors: ['subject', 'attachment:1:invoice-number']
      }
    });
    metadata.ingestIncomingMessage({
      schemaVersion: 1,
      logicalOperationId: 'dashboard-fictional-reply',
      message: {
        schemaVersion: 1,
        channel: 'sms',
        source: { system: 'fictional-sms', externalId: 'reply-message', version: 'v1' },
        occurredAt: now,
        observedAt: now,
        historicalBaseline: false,
        disposition: 'explicit-request',
        requestKind: 'reply',
        explicitRequest: true,
        summary: 'Confirm the fictional cabinet delivery access window.',
        conversationId: 'fictional-renovation-conversation',
        evidenceSelectors: ['body:request']
      }
    });
    const result = await createDashboardService({ metadata, now: () => now }).get({ schemaVersion: 1 });
    assert.equal(result.openLoops.total, 2);
    assert.equal(result.openLoops.attentionTotal, 1);
    assert.equal(result.openLoops.comingUpTotal, 1);
    assert.equal(result.attentionBadgeCount, 1);
    assert.deepEqual(result.openLoops.highlighted.map(item => item.title), ['Confirm the fictional cabinet delivery access window.']);
    assert.deepEqual(result.openLoops.highlighted[0].actions, ['Open original', 'Draft reply', 'Remind me']);
    assert.equal(result.openLoops.comingUp[0].paymentState, 'unpaid');
    assert.equal(result.openLoops.comingUp[0].amount, 245000);
    assert.equal(result.openLoops.comingUp[0].evidenceCount, 1);
    assert.equal(JSON.stringify(result.openLoops).includes('fictional-invoice-pdf'), false);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
