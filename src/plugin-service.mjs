import { createHash } from 'node:crypto';
import { openCommandCenterMetadataService } from './metadata/service.mjs';
import { createLegacyDiscordMigrationService } from './migration/service.mjs';
import { createPreservedHistoryReader } from './migration/preserved-history-read.mjs';
import { createAuthoritativeSourceService } from './sources/service.mjs';
import { createTopicService } from './topics/service.mjs';
import { SourceServiceError } from './sources/errors.mjs';
import { FIRST_LIVE_FEATURES } from './release-scope.mjs';

function unavailable(feature) {
  const reason = FIRST_LIVE_FEATURES[feature] === false
    ? 'is deferred from the first live release'
    : 'is not available in this service activation';
  throw new SourceServiceError('capability-unavailable', `Command Center ${feature} ${reason}.`);
}

export function runtimeHostIdentity(stateDir) {
  const value = String(stateDir ?? '').trim();
  if (!value) throw new TypeError('Runtime host identity requires a resolved state directory.');
  return `command-center-runtime:${createHash('sha256').update(value).digest('hex')}`;
}

export function runNoteMaintenance() { return unavailable('noteMaintenance'); }

// History remains a retained read path. Its host SDK is needed only when that
// path is requested, not to activate Topics or to launch a background index.
async function readVisibleTranscript(input) {
  const { readVisibleSessionTranscriptMessageEntries } = await import('openclaw/plugin-sdk/session-transcript-runtime');
  return readVisibleSessionTranscriptMessageEntries(input);
}

export function createMetadataService(api) {
  let metadataService;
  let sourceService;
  let topicService;
  let stopPromise;
  let recoveryOnly = false;
  const refuseRecovery = () => { throw new SourceServiceError('recovery-only', 'Command Center is recovery-only; authoritative data and mutations remain unavailable.'); };
  const requireOperational = () => { if (recoveryOnly) refuseRecovery(); };
  const refuseDeferred = feature => { requireOperational(); return unavailable(feature); };
  return {
    id: 'command-center-metadata',
    async start() {
      stopPromise = undefined;
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const gatewayAvailable = typeof api.runtime?.gateway?.request === 'function';
      const sessionCatalogAvailable = typeof api.runtime?.agent?.session?.listSessionEntries === 'function';
      const configured = api.pluginConfig?.sourceCapabilities ?? {};
      const capabilities = {
        notes: FIRST_LIVE_FEATURES.noteRead && configured.notes !== false,
        sessions: FIRST_LIVE_FEATURES.conversations && (gatewayAvailable || sessionCatalogAvailable) && configured.sessions !== false,
        // Lightweight operation receipts remain core metadata. This does not
        // instantiate the rich Activity/Dashboard presentation or event owners.
        activity: configured.activity !== false,
        scheduler: false, search: false, analysis: false, attention: false
      };
      metadataService = openCommandCenterMetadataService({ stateDir, capabilities });
      recoveryOnly = metadataService.getOperatingStatus().mode === 'recovery-only';
      if (recoveryOnly) {
        // Refused metadata must never be opened independently by a consumer.
        const closedPresentation = reads => new Proxy(Object.freeze(reads), {
          get(target, property) { return Object.hasOwn(target, property) ? target[property] : property === 'then' ? undefined : refuseRecovery; }
        });
        const destination = () => ({ activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] });
        sourceService = closedPresentation({
          status() {
            const status = metadataService.getOperatingStatus();
            return { schemaVersion: 1, mode: 'recovery-only', metadataSchemaVersion: status.schemaVersion, diagnostics: status.diagnostics ?? [], unavailableCapabilities: status.unavailableCapabilities ?? [] };
          },
          close() {}
        });
        topicService = closedPresentation({ listDestination: destination, listDestinationVerified: destination });
        return sourceService.status();
      }
      const migrationService = createLegacyDiscordMigrationService({ metadata: metadataService, api, gateway: api.runtime?.gateway, config: api.pluginConfig?.legacyDiscordMigration, logger: api.logger });
      const activatedMetadata = metadataService;
      const historySource = structuredClone(api.pluginConfig?.preservedHistorySource);
      const nativeHistorySource = structuredClone(api.pluginConfig?.nativeHistorySource);
      let historyReaderPromise;
      const historyReader = async () => {
        const assertActive = () => {
          requireOperational();
          if (stopPromise || metadataService !== activatedMetadata) throw new SourceServiceError('capability-unavailable', 'This history reader activation has ended.');
        };
        assertActive();
        if (!historySource && !nativeHistorySource) throw new SourceServiceError('capability-unavailable', 'The preserved history source is not configured.');
        historyReaderPromise ??= Promise.all([import('openclaw/plugin-sdk/session-store-runtime'), import('openclaw/plugin-sdk/session-transcript-runtime')])
          .then(([sessionStore, transcripts]) => { assertActive(); return createPreservedHistoryReader({ metadata: activatedMetadata, sourceOptions: historySource, nativeSourceOptions: nativeHistorySource, sessionStore, transcripts, config: api.config }); })
          .catch(error => { historyReaderPromise = undefined; throw error; });
        const reader = await historyReaderPromise;
        assertActive();
        return reader;
      };
      sourceService = createAuthoritativeSourceService({ metadata: metadataService, api, capabilities, migration: migrationService, transcriptReader: readVisibleTranscript, historyReader, noteRecoveryEffects: false });
      topicService = createTopicService({ metadata: metadataService, api, noteVaultRoot: api.pluginConfig?.topics?.noteRoot });
      // Existing-data bootstrap and its durable recovery remain required. No
      // optional Settings, Cron, notification or disposable index is touched.
      return migrationService.start();
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = Promise.resolve().then(() => {
        sourceService?.close?.();
        metadataService?.close();
        metadataService = undefined;
        sourceService = undefined;
        topicService = undefined;
      });
      return stopPromise;
    },
    get sourceService() { return sourceService; },
    get topicService() { return topicService; },
    get attentionService() { return undefined; },
    get maintenanceService() { return undefined; },
    get searchService() { return undefined; },
    get searchRebuildService() { return undefined; },
    get dashboardService() { return undefined; },
    get notificationService() { return undefined; },
    get topicAnalysisRunner() { return undefined; },
    get topicAnalysisSchedule() { return undefined; },
    get topicReview() { return undefined; },
    topicAnalysisRead() { return refuseDeferred('analysis'); },
    topicAnalysisRun() { return refuseDeferred('analysis'); },
    topicAnalysisScheduleUpdate() { return refuseDeferred('analysis'); },
    topicReviewGet() { return refuseDeferred('analysis'); },
    topicReviewDecide() { return refuseDeferred('analysis'); },
    topicReviewSnooze() { return refuseDeferred('analysis'); },
    topicReviewCheckpoint() { return refuseDeferred('analysis'); },
    topicReviewApply() { return refuseDeferred('analysis'); },
    async dashboardGet() { return refuseDeferred('dashboard'); },
    dashboardUpdateSettings() { return refuseDeferred('dashboard'); },
    notificationReconcile() { return refuseDeferred('notifications'); },
    notificationCaptureBinding() { return refuseDeferred('notifications'); },
    topicContextRetrieve() { return refuseDeferred('search'); },
    async searchRebuild() { return refuseDeferred('search'); },
    async searchPrepareRebuild() { return refuseDeferred('search'); }
  };
}
