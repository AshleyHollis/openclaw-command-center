import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-notification-settings-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try { return await run({ metadata, stateDir }); } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

const operation = '81111111-1111-4111-8111-111111111111';

test('notification settings use durable defaults and revisioned closed updates', async () => {
  await fixture(async ({ metadata, stateDir }) => {
    const first = createNotificationService({ metadata, now: () => Date.parse('2026-08-27T12:00:00.000Z'), timeZone: 'America/New_York' });
    assert.deepEqual(first.getSettings(), {
      settingsId: 'global', dueReminders: true, importantItems: true, criticalRealerts: true,
      quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00', timeZone: 'America/New_York', genericPreview: false,
      revision: 1, updatedAt: '2026-08-27T12:00:00.000Z'
    });
    const changed = first.updateSettings({ schemaVersion: 1, logicalOperationId: operation, expectedRevision: 1, settings: { dueReminders: false, importantItems: false, criticalRealerts: true, quietHoursEnabled: false, quietHoursStart: '21:00', quietHoursEnd: '06:00', timeZone: 'UTC', genericPreview: true } });
    assert.equal(changed.revision, 2);
    assert.deepEqual(first.updateSettings({ schemaVersion: 1, logicalOperationId: operation, expectedRevision: 1, settings: { dueReminders: false, importantItems: false, criticalRealerts: true, quietHoursEnabled: false, quietHoursStart: '21:00', quietHoursEnd: '06:00', timeZone: 'UTC', genericPreview: true } }), changed);
    first.updateSettings({ schemaVersion: 1, logicalOperationId: '86666666-6666-4666-8666-666666666666', expectedRevision: 2, settings: { genericPreview: false } });
    assert.equal(first.updateSettings({ schemaVersion: 1, logicalOperationId: operation, expectedRevision: 1, settings: { dueReminders: false, importantItems: false, criticalRealerts: true, quietHoursEnabled: false, quietHoursStart: '21:00', quietHoursEnd: '06:00', timeZone: 'UTC', genericPreview: true } }).genericPreview, true);
    assert.throws(() => first.updateSettings({ schemaVersion: 1, logicalOperationId: '82222222-2222-4222-8222-222222222222', expectedRevision: 1, settings: {} }), /revision/i);
    assert.throws(() => first.updateSettings({ schemaVersion: 1, logicalOperationId: '83333333-3333-4333-8333-333333333333', expectedRevision: 2, settings: { extra: true } }), /unsupported|extra/i);
    first.close();
    const reopenedMetadata = openCommandCenterMetadataService({ stateDir });
    const reopened = createNotificationService({ metadata: reopenedMetadata, now: () => Date.parse('2026-08-27T12:01:00.000Z') });
    assert.equal(reopened.getSettings().revision, 3);
    assert.equal(reopened.getSettings().genericPreview, false);
    reopened.close();
    reopenedMetadata.close();
  });
});
