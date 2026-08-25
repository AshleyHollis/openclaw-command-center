import { createHash } from 'node:crypto';
import { createAttentionService } from './attention/service.mjs';
import { createNoteMaintenanceService } from './maintenance/notes.mjs';
import { openCommandCenterMetadataService } from './metadata/service.mjs';
import { createLegacyDiscordMigrationService } from './migration/service.mjs';
import { createAuthoritativeSourceService } from './sources/service.mjs';

let activeMaintenanceService;

export function runtimeHostIdentity(stateDir) {
  const value = String(stateDir ?? '').trim();
  if (!value) throw new TypeError('Runtime host identity requires a resolved state directory.');
  return `command-center-runtime:${createHash('sha256').update(value).digest('hex')}`;
}

export function runNoteMaintenance(input) {
  if (!activeMaintenanceService) throw new Error('Command Center Note maintenance is not ready.');
  return activeMaintenanceService.run(input);
}

export function createMetadataService(api) {
  let metadataService;
  let sourceService;
  let attentionService;
  let maintenanceService;
  return {
    id: 'command-center-metadata',
    async start() {
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const gatewayAvailable = typeof api.runtime?.gateway?.request === 'function';
      const sessionStoreAvailable = typeof api.runtime?.agent?.session?.patchSessionEntry === 'function';
      const capabilities = { notes: true, sessions: sessionStoreAvailable, scheduler: gatewayAvailable, activity: true, search: false, analysis: false, attention: true };
      metadataService = openCommandCenterMetadataService({ stateDir, capabilities });
      const migrationService = createLegacyDiscordMigrationService({ metadata: metadataService, api, gateway: api.runtime?.gateway, config: api.pluginConfig?.legacyDiscordMigration, logger: api.logger });
      attentionService = createAttentionService({
        metadata: metadataService,
        host: runtimeHostIdentity(stateDir),
        timeZone: api.config?.agents?.defaults?.userTimezone ?? 'UTC',
        sourceActions: {
          complete: ({ episode, parameters, logicalOperationId }) => sourceService.forTopic(episode.topicId).reminders.complete({ schemaVersion: 1, referenceId: episode.sourceReferenceId, expectedConfigRevision: parameters.expectedConfigRevision, logicalOperationId }),
          snooze: ({ episode, parameters, logicalOperationId }) => sourceService.forTopic(episode.topicId).reminders.snooze({ schemaVersion: 1, referenceId: episode.sourceReferenceId, expectedConfigRevision: parameters.expectedConfigRevision, logicalOperationId, patch: { schedule: { kind: 'at', at: parameters.until } } }),
          verify: async ({ episode, actionId, parameters }) => {
            const rows = await sourceService.forTopic(episode.topicId).reminders.list({ schemaVersion: 1 });
            const row = rows.find((item) => item.sourceReference?.referenceId === episode.sourceReferenceId);
            if (actionId === 'reminder.complete') return row?.job?.enabled === false;
            return row?.job?.schedule?.kind === 'at' && row.job.schedule.at === parameters.until;
          }
        }
      });
      attentionService.registerSourceCapability({
        sourceCapabilityId: 'reminders',
        sourceKind: 'reminder',
        monitoring: true,
        deriveEvidence: (occurrence) => occurrence.evidenceFacts,
        verifyTransition: (occurrence) => occurrence.transitionEvidence?.verifiedSource === 'scheduler-readback' && occurrence.transitionEvidence?.version === occurrence.occurrenceVersion,
        actions: []
      });
      sourceService = createAuthoritativeSourceService({ metadata: metadataService, api, capabilities, attentionService, migration: migrationService });
      if (gatewayAvailable) {
        try { await sourceService.refreshReminderAttention(); }
        catch { api.logger?.warn?.('Command Center could not refresh Reminder attention during startup.'); }
      }
      maintenanceService = createNoteMaintenanceService({ sourceService, metadata: metadataService });
      activeMaintenanceService = maintenanceService;
      return migrationService.start();
    },
    stop() {
      sourceService?.close?.();
      attentionService?.close?.();
      metadataService?.close();
      metadataService = undefined;
      sourceService = undefined;
      attentionService = undefined;
      maintenanceService = undefined;
      activeMaintenanceService = undefined;
    },
    get sourceService() { return sourceService; },
    get attentionService() { return attentionService; },
    get maintenanceService() { return maintenanceService; }
  };
}
