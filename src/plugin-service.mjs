import { createHash } from 'node:crypto';
import { createAttentionService } from './attention/service.mjs';
import { createDashboardService } from './dashboard/service.mjs';
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

const publicEvidenceFields = Object.freeze(['summary', 'payee', 'purpose', 'amount', 'currency', 'dueAt', 'authorityId', 'invoiceId', 'accountId', 'eventKind', 'subjectKind', 'subjectNamespace', 'subjectId', 'chosenOption', 'rationale', 'assumption', 'assessment', 'material', 'decisionId', 'status', 'supersedesDecisionId', 'supersededByDecisionId']);
function publicOpenLoopEvidence(observation) {
  return Object.freeze({
    observationId: observation.observationId,
    type: observation.type,
    sourceSystem: observation.source.system,
    sourceKind: observation.source.kind,
    occurredAt: observation.occurredAt,
    observedAt: observation.observedAt,
    historicalBaseline: observation.historicalBaseline,
    ...Object.fromEntries(publicEvidenceFields.filter(key => observation.facts[key] !== undefined).map(key => [key, observation.facts[key]]))
  });
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
  let attentionService;
  let dashboardService;
  let topicService;
  let stopPromise;
  let releaseDurableFolderStager;
  let releaseNoteFilesystemCoordinator;
  let recoveryOnly = false;
  const refuseRecovery = () => { throw new SourceServiceError('recovery-only', 'Command Center is recovery-only; authoritative data and mutations remain unavailable.'); };
  const requireOperational = () => { if (recoveryOnly) refuseRecovery(); };
  const refuseDeferred = feature => { requireOperational(); return unavailable(feature); };
  return {
    id: 'command-center-metadata',
    async start() {
      stopPromise = undefined;
      const { setHostDurableFolderStager } = await import('./sources/note-folder-identity.mjs');
      const { setHostNoteFilesystemCoordinator } = await import('./sources/note-filesystem-owner.mjs');
      releaseDurableFolderStager = setHostDurableFolderStager(api.runtime?.fileAccess?.stageDurableFileInDirectory);
      releaseNoteFilesystemCoordinator = setHostNoteFilesystemCoordinator(api.runtime?.fileAccess?.tryAcquireExclusiveSqliteCoordinator);
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
        scheduler: FIRST_LIVE_FEATURES.scheduler && gatewayAvailable && configured.scheduler !== false,
        search: false, analysis: false, attention: FIRST_LIVE_FEATURES.dashboard
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
      if (FIRST_LIVE_FEATURES.dashboard) {
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
          sourceCapabilityId: 'reminders', sourceKind: 'reminder', monitoring: true,
          deriveEvidence: (occurrence) => occurrence.evidenceFacts,
          verifyTransition: (occurrence) => occurrence.transitionEvidence?.verifiedSource === 'scheduler-readback' && occurrence.transitionEvidence?.version === occurrence.occurrenceVersion,
          actions: []
        });
      }
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
      sourceService = createAuthoritativeSourceService({ metadata: metadataService, api, capabilities, attentionService, migration: migrationService, transcriptReader: readVisibleTranscript, historyReader, noteRecoveryEffects: false });
      topicService = createTopicService({ metadata: metadataService, api, noteVaultRoot: api.pluginConfig?.topics?.noteRoot });
      const migrationResult = await migrationService.start();
      if (FIRST_LIVE_FEATURES.dashboard) {
        try { await sourceService.refreshReminderAttention(); }
        catch { api.logger?.warn?.('Command Center could not refresh Reminder attention during startup.'); }
        dashboardService = createDashboardService({
          sourceService,
          attentionService,
          metadata: metadataService,
          now: () => new Date().toISOString(),
          timeZone: api.config?.agents?.defaults?.userTimezone ?? 'UTC',
          navigationResolver: async (record) => {
            const referenceId = record?.sourceReferenceId;
            const topicId = record?.topicId;
            if (typeof referenceId !== 'string' || typeof topicId !== 'string') return undefined;
            const reference = metadataService.getSourceReference?.(referenceId);
            if (!reference || reference.topicId !== topicId) return undefined;
            if (reference.sourceKind === 'session') {
              try {
                const navigation = await sourceService.sessionsNavigate({ schemaVersion: 1, topicId, referenceId });
                if (navigation?.sessionKey && navigation?.sessionId) return Object.freeze({ kind: 'session', topicId, referenceId, sessionKey: navigation.sessionKey, sessionId: navigation.sessionId, verified: true });
              } catch { return undefined; }
            }
            return Object.freeze({ kind: 'source', topicId, referenceId, sourceKind: reference.sourceKind, verified: true });
          }
        });
      }
      // Existing-data bootstrap and its durable recovery remain required.
      // Native Cron is acquired only by an authenticated Reminder/Schedule
      // request; startup itself touches no job or optional background owner.
      return migrationResult;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = Promise.resolve().then(() => {
        // Do not retain an old host activation's capability across a restart.
        // The release closure cannot clear a capability installed by its successor.
        releaseDurableFolderStager?.();
        releaseDurableFolderStager = undefined;
        releaseNoteFilesystemCoordinator?.();
        releaseNoteFilesystemCoordinator = undefined;
        sourceService?.close?.();
        attentionService?.close?.();
        metadataService?.close();
        metadataService = undefined;
        sourceService = undefined;
        attentionService = undefined;
        dashboardService = undefined;
        topicService = undefined;
      });
      return stopPromise;
    },
    get sourceService() { return sourceService; },
    get topicService() { return topicService; },
    // The working-Note tool is part of this activation, not a consumer of an
    // arbitrary Source-service projection. Keep its two durable owners paired
    // at the owning activation boundary so a host tool invocation cannot
    // depend on a secondary public-property lookup.
    getTopicMaintenanceOwners() {
      return { sourceService, metadata: metadataService };
    },
    get attentionService() { return attentionService; },
    get maintenanceService() { return undefined; },
    get searchService() { return undefined; },
    get searchRebuildService() { return undefined; },
    get dashboardService() { return dashboardService; },
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
    async dashboardGet(input = {}) {
      requireOperational();
      if (!dashboardService) return unavailable('dashboard');
      try { await sourceService?.refreshReminderAttention?.(); } catch { /* unavailable scheduler rows are omitted */ }
      const request = { ...input };
      delete request.requestId;
      return dashboardService.get(request);
    },
    openLoopsList(input = {}) {
      requireOperational();
      const offset = Number.isInteger(input.offset) ? input.offset : 0;
      const limit = Number.isInteger(input.limit) ? input.limit : 50;
      return metadataService.listOpenLoopsPage({ offset, limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
    },
    openLoopsGet(input = {}) {
      requireOperational();
      const loop = metadataService.getOpenLoop(input.loopId);
      if (!loop) throw new SourceServiceError('not-found', 'The exact open loop is unavailable.');
      return Object.freeze({ schemaVersion: 1, loop, evidence: Object.freeze(loop.evidenceObservationIds.map(id => publicOpenLoopEvidence(metadataService.getOpenLoopObservation(id)))) });
    },
    openLoopsDecide(input = {}) {
      requireOperational();
      if (typeof input.authenticatedOperatorId !== 'string' || input.authenticatedOperatorId.trim() === '') throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for open-loop decisions.');
      return metadataService.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision, decision: input.decision, ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }), actorId: input.authenticatedOperatorId, rationale: input.rationale, updatedAt: new Date().toISOString() });
    },
    openLoopsPaymentStatus(input = {}) {
      requireOperational();
      if (typeof input.authenticatedOperatorId !== 'string' || input.authenticatedOperatorId.trim() === '') throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for payment status records.');
      return metadataService.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision, paymentState: input.paymentState, ...(input.paidAmount === undefined ? {} : { paidAmount: input.paidAmount, currency: input.currency }), actorId: input.authenticatedOperatorId, rationale: input.rationale, updatedAt: new Date().toISOString() });
    },
    dashboardUpdateSettings() { return refuseDeferred('dashboard'); },
    notificationReconcile() { return refuseDeferred('notifications'); },
    notificationCaptureBinding() { return refuseDeferred('notifications'); },
    topicContextRetrieve() { return refuseDeferred('search'); },
    async searchRebuild() { return refuseDeferred('search'); },
    async searchPrepareRebuild() { return refuseDeferred('search'); }
  };
}
