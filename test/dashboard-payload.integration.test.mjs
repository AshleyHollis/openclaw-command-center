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
