import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createTopicAnalysisScheduleService } from '../src/topics/analysis-schedule.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';
import { durableFictionalCron } from './fixtures/analysis-settings-process-death.mjs';
import { conditionalOwnerContract } from './fixtures/conditional-owner-contract.mjs';

for (const kind of ['analysis-settings', 'notification-settings']) conditionalOwnerContract(test, kind, async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-owner-contract-'));
  const clients = new Set();
  const field = kind === 'analysis-settings' ? 'localTime' : 'quietHoursEnd';
  const connect = () => {
    const metadata = openCommandCenterMetadataService({ stateDir });
    const service = kind === 'analysis-settings'
      ? createTopicAnalysisScheduleService({ metadata, getCron: () => durableFictionalCron(stateDir), now: () => Date.parse('2026-08-23T06:59:00Z') })
      : createNotificationService({ metadata, now: () => Date.parse('2026-08-23T06:59:00Z') });
    const client = {
      read: async () => { const current = service.getSettings(); return { revision: current.revision, value: current[field] }; },
      write: async (command) => kind === 'analysis-settings' ? (await service.update(command)).settings : service.updateSettings(command),
      close() { service.close?.(); metadata.close(); clients.delete(client); }
    };
    clients.add(client); return client;
  };
  let current = connect();
  t.after(async () => { for (const client of clients) client.close(); await rm(stateDir, { recursive: true, force: true }); });
  return {
    read: () => current.read(), write: (command) => current.write(command),
    command: (expectedRevision, value, logicalOperationId) => ({ schemaVersion: 1, expectedRevision, logicalOperationId, settings: { [field]: value } }),
    competitor: async () => connect(),
    reopen: async () => { current.close(); current = connect(); }
  };
});
