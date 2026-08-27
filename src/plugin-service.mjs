import { createHash } from 'node:crypto';
import { createAttentionService } from './attention/service.mjs';
import { createNoteMaintenanceService } from './maintenance/notes.mjs';
import { openCommandCenterMetadataService } from './metadata/service.mjs';
import { createLegacyDiscordMigrationService } from './migration/service.mjs';
import { createAuthoritativeSourceService } from './sources/service.mjs';
import { createSearchRebuildService, reconcileTopicSearchBookkeeping } from './search/rebuild.mjs';
import { createTopicSearchService } from './search/service.mjs';
import { createTopicContextPolicy } from './search/context.mjs';
import { createTopicService } from './topics/service.mjs';

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
  let searchService;
  let searchRebuildService;
  let contextPolicy;
  let topicService;
  return {
    id: 'command-center-metadata',
    async start() {
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const gatewayAvailable = typeof api.runtime?.gateway?.request === 'function';
      const capabilities = { notes: true, sessions: gatewayAvailable, scheduler: gatewayAvailable, activity: true, search: true, analysis: false, attention: true };
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
      const searchProvider = {
        query: (input) => searchService.query(input),
        rebuild: (input) => searchService.rebuild(input),
        invalidate: (input) => searchService.invalidate(input)
      };
      sourceService = createAuthoritativeSourceService({ metadata: metadataService, api, capabilities, attentionService, migration: migrationService, searchProvider });
      topicService = createTopicService({ metadata: metadataService, api, noteVaultRoot: api.pluginConfig?.topics?.noteRoot, searchProvider, schedulerFactory: (topicId) => sourceService.forTopic(topicId).scheduler });
      searchRebuildService = createSearchRebuildService({
        stateDir,
        metadata: metadataService,
        api,
        gateway: api.runtime?.gateway,
        noteAdapterFactory: (topicId) => sourceService.forTopic(topicId).notes
      });
      searchService = createTopicSearchService({
        stateDir,
        metadata: metadataService,
        sourceService,
        rebuild: (input) => searchRebuildService.rebuild(input)
      });
      contextPolicy = createTopicContextPolicy({ metadata: metadataService, searchService });
      const migrationResult = await migrationService.start();
      await reconcileTopicSearchBookkeeping({ stateDir, metadata: metadataService });
      try {
        await searchService.invalidate({});
        await searchService.rebuild({});
      }
      catch { api.logger?.warn?.('Command Center Topic Search remains unavailable until its authoritative sources can be rebuilt.'); }
      if (gatewayAvailable) {
        try { await sourceService.refreshReminderAttention(); }
        catch { api.logger?.warn?.('Command Center could not refresh Reminder attention during startup.'); }
      }
      maintenanceService = createNoteMaintenanceService({ sourceService, metadata: metadataService });
      activeMaintenanceService = maintenanceService;
      return migrationResult;
    },
    stop() {
      sourceService?.close?.();
      attentionService?.close?.();
      metadataService?.close();
      metadataService = undefined;
      sourceService = undefined;
      searchService = undefined;
      searchRebuildService = undefined;
      contextPolicy = undefined;
      topicService = undefined;
      attentionService = undefined;
      maintenanceService = undefined;
      activeMaintenanceService = undefined;
    },
    get sourceService() { return sourceService; },
    get attentionService() { return attentionService; },
    get maintenanceService() { return maintenanceService; },
    get searchService() { return searchService; },
    get topicService() { return topicService; },
    topicContextRetrieve(input) {
      if (!contextPolicy) throw new Error('Command Center Topic context is not ready.');
      return contextPolicy.retrieve(input);
    }
  };
}
