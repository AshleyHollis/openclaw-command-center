import { createHash } from 'node:crypto';
import { createAttentionService } from './attention/service.mjs';
import { createNoteMaintenanceService } from './maintenance/notes.mjs';
import { openCommandCenterMetadataService } from './metadata/service.mjs';
import { createLegacyDiscordMigrationService } from './migration/service.mjs';
import { createAuthoritativeSourceService } from './sources/service.mjs';
import { reminderActionApplied } from './sources/reminder-lifecycle.mjs';
import { createSearchRebuildService, reconcileTopicSearchBookkeeping } from './search/rebuild.mjs';
import { createTopicSearchService } from './search/service.mjs';
import { createTopicContextPolicy } from './search/context.mjs';
import { createTopicService } from './topics/service.mjs';
import { createDashboardService } from './dashboard/service.mjs';
import { createNotificationService } from './notifications/service.mjs';
import { createTopicAnalysisRunner } from './topics/analysis-runner.mjs';
import { createTopicAnalysisProvider } from './topics/analysis-provider.mjs';
import { createProductionTopicAnalyzer } from './topics/production-analyzer.mjs';
import { createTopicAnalysisScheduleService } from './topics/analysis-schedule.mjs';
import { createTopicReviewService } from './topics/review.mjs';
import { SourceServiceError } from './sources/errors.mjs';

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

export function createMetadataService(api, { notificationEmitter, searchRebuildServiceFactory = createSearchRebuildService, topicAnalyzerFactory = createProductionTopicAnalyzer } = {}) {
  let metadataService;
  let sourceService;
  let attentionService;
  let maintenanceService;
  let searchService;
  let searchRebuildService;
  let contextPolicy;
  let topicService;
  let dashboardService;
  let notificationService;
  let notificationTimer;
  let topicAnalysisRunner;
  let topicAnalysisSchedule;
  let topicReview;
  let startupSearchRebuildTask = Promise.resolve();
  let startupSearchRebuildController;
  let stopPromise;
  let stopping = false;
  let recoveryOnly = false;
  const refuseRecovery = () => { throw new SourceServiceError('recovery-only', 'Command Center is recovery-only; authoritative data and mutations remain unavailable.'); };
  const requireOperational = () => { if (recoveryOnly) refuseRecovery(); };
  return {
    id: 'command-center-metadata',
    async start() {
      stopping = false;
      stopPromise = undefined;
      startupSearchRebuildController = new AbortController();
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const gatewayAvailable = typeof api.runtime?.gateway?.request === 'function';
      // Current hosts expose a lazily loaded request-context probe. Entering
      // that runtime while plugin services are activating creates a loader
      // cycle, so activation must finish before any Gateway runtime call.
      const gatewayDefersUntilBinding = gatewayAvailable && typeof api.runtime.gateway.isAvailable === 'function';
      const gatewayActiveAtStartup = gatewayAvailable && !gatewayDefersUntilBinding;
      const configuredSourceCapabilities = api.pluginConfig?.sourceCapabilities ?? {};
      const topicAnalyzer = topicAnalyzerFactory?.();
      const analysisUsable = typeof topicAnalyzer === 'function' || typeof topicAnalyzer?.analyze === 'function';
      const capabilities = {
        notes: configuredSourceCapabilities.notes !== false,
        sessions: gatewayAvailable && configuredSourceCapabilities.sessions !== false,
        scheduler: gatewayAvailable && configuredSourceCapabilities.scheduler !== false,
        activity: configuredSourceCapabilities.activity !== false,
        search: configuredSourceCapabilities.search !== false,
        analysis: analysisUsable && configuredSourceCapabilities.analysis !== false,
        attention: configuredSourceCapabilities.attention !== false
      };
      metadataService = openCommandCenterMetadataService({ stateDir, capabilities });
      recoveryOnly = metadataService.getOperatingStatus().mode === 'recovery-only';
      if (recoveryOnly) {
        // The metadata owner has refused this database. Do not create consumers that open it independently.
        const closedPresentation = (reads) => new Proxy(Object.freeze(reads), { get(target, property) { return Object.hasOwn(target, property) ? target[property] : property === 'then' ? undefined : refuseRecovery; } });
        const destination = () => ({ activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] });
        sourceService = closedPresentation({
          status() { const status = metadataService.getOperatingStatus(); return { schemaVersion: 1, mode: 'recovery-only', metadataSchemaVersion: status.schemaVersion, diagnostics: status.diagnostics ?? [], unavailableCapabilities: status.unavailableCapabilities ?? [] }; },
          close() {}, settleSearchRefresh() {}
        });
        topicService = closedPresentation({ listDestination: destination, listDestinationVerified: destination });
        dashboardService = Object.freeze({ get(input = {}) {
          const activityOffset = input.activityOffset ?? 0;
          const activityLimit = input.activityLimit ?? 50;
          if (!Number.isSafeInteger(activityOffset) || activityOffset < 0 || !Number.isSafeInteger(activityLimit) || activityLimit < 1 || activityLimit > 50) throw new SourceServiceError('invalid-request', 'Dashboard paging is invalid.');
          return { schemaVersion: 1, serverTime: new Date().toISOString(), attention: [], attentionBadgeCount: 0, inProgress: [], comingUp: [], topics: [], activity: { records: [], nextOffset: null, hasMore: false }, activityOffset, activityLimit };
        } });
        return sourceService.status();
      }
      const migrationService = createLegacyDiscordMigrationService({ metadata: metadataService, api, gateway: api.runtime?.gateway, config: api.pluginConfig?.legacyDiscordMigration, logger: api.logger });
      attentionService = createAttentionService({
        metadata: metadataService,
        host: runtimeHostIdentity(stateDir),
        timeZone: api.config?.agents?.defaults?.userTimezone ?? 'UTC',
        sourceActions: {
          complete: ({ episode, parameters, logicalOperationId }) => sourceService.remindersComplete({ schemaVersion: 1, topicId: episode.topicId, referenceId: episode.sourceReferenceId, expectedConfigRevision: parameters.expectedConfigRevision, logicalOperationId }),
          snooze: ({ episode, parameters, logicalOperationId }) => sourceService.remindersSnooze({ schemaVersion: 1, topicId: episode.topicId, referenceId: episode.sourceReferenceId, expectedConfigRevision: parameters.expectedConfigRevision, logicalOperationId, patch: { schedule: { kind: 'at', at: parameters.until } } }),
          verify: async ({ episode, actionId, parameters }) => {
            const rows = await sourceService.remindersList({ schemaVersion: 1, topicId: episode.topicId });
            const row = rows.find((item) => item.sourceReference?.referenceId === episode.sourceReferenceId);
            return reminderActionApplied(actionId, row?.job, parameters);
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
      attentionService.registerSourceCapability({
        sourceCapabilityId: 'topic-review',
        sourceKind: 'topic-review',
        monitoring: true,
        deriveEvidence: (occurrence) => occurrence.evidenceFacts,
        verifyTransition: () => true,
        actions: []
      });
      const searchProvider = {
        query: (input) => searchService.query(input),
        rebuild: (input) => searchService.rebuild(input),
        invalidate: (input) => searchService.invalidate(input)
      };
      // Keep the published SDK boundary lazy. The built asset can be imported
      // for shell/build inspection without resolving host-only packages; the
      // pinned host still supplies the transcript reader before service start.
      const { readVisibleSessionTranscriptMessageEntries } = await import('openclaw/plugin-sdk/session-transcript-runtime');
      const analysisProvider = analysisUsable ? createTopicAnalysisProvider({ getRunner: () => topicAnalysisRunner, metadata: metadataService, onCompleted: () => topicReview?.refreshAndSync?.() }) : null;
      sourceService = createAuthoritativeSourceService({ metadata: metadataService, api, capabilities, attentionService, migration: migrationService, searchProvider, analysisProvider, transcriptReader: readVisibleSessionTranscriptMessageEntries });
      topicService = createTopicService({ metadata: metadataService, api, noteVaultRoot: api.pluginConfig?.topics?.noteRoot, searchProvider, schedulerFactory: (topicId) => sourceService.forTopic(topicId).scheduler });
      searchRebuildService = searchRebuildServiceFactory({
        stateDir,
        metadata: metadataService,
        api,
        gateway: api.runtime?.gateway,
        noteAdapterFactory: (topicId) => sourceService.forTopic(topicId).notes,
        transcriptReader: readVisibleSessionTranscriptMessageEntries,
        requireAuthorizedPreparation: true
      });
      searchService = createTopicSearchService({
        stateDir,
        metadata: metadataService,
        sourceService,
        rebuild: (input) => searchRebuildService.rebuild(input),
        preparedRebuild: typeof searchRebuildService.prepareAuthorized === 'function' && typeof searchRebuildService.rebuildPrepared === 'function'
          ? async (input) => {
              await searchRebuildService.prepareAuthorized(input);
              return searchRebuildService.rebuildPrepared(input);
            }
          : undefined
      });
      contextPolicy = createTopicContextPolicy({ metadata: metadataService, searchService });
      const migrationResult = await migrationService.start();
      await reconcileTopicSearchBookkeeping({ stateDir, metadata: metadataService });
      if (gatewayActiveAtStartup) {
        try { await sourceService.refreshReminderAttention(); }
        catch { api.logger?.warn?.('Command Center could not refresh Reminder attention during startup.'); }
      }
      dashboardService = createDashboardService({
        sourceService,
        attentionService,
        metadata: metadataService,
        now: () => new Date().toISOString(),
        timeZone: api.config?.agents?.defaults?.userTimezone ?? 'UTC',
        notificationSettings: () => notificationService?.getSettings?.(),
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
          if (reference.sourceKind === 'note' && typeof reference.externalSourceId === 'string' && typeof record.verificationRevision === 'string' && record.verificationRevision === reference.observedRevision) {
            return Object.freeze({ kind: 'note', topicId, referenceId, path: reference.externalSourceId, observedRevision: reference.observedRevision, verified: true });
          }
          return undefined;
        }
      });
      notificationService = createNotificationService({
        metadata: metadataService,
        attentionService,
        sourceService,
        emitter: notificationEmitter,
        timeZone: api.config?.agents?.defaults?.userTimezone ?? 'UTC',
        now: () => Date.now(),
        logger: api.logger
      });
      topicAnalysisRunner = createTopicAnalysisRunner({
        metadata: metadataService,
        topicService,
        analyzer: topicAnalyzer,
        now: () => Date.now()
      });
      topicReview = createTopicReviewService({ metadata: metadataService, topicService, attentionService, logger: api.logger, now: () => Date.now() });
      const runAndRefreshTopicReview = async (input) => {
        const result = await topicAnalysisRunner.run(input);
        topicReview.refresh();
        return result;
      };
      topicAnalysisSchedule = createTopicAnalysisScheduleService({ metadata: metadataService, notificationService, gateway: api.runtime?.gateway, now: () => Date.now(), runAnalysis: runAndRefreshTopicReview });
      topicAnalysisSchedule.getSettings();
      if (gatewayActiveAtStartup) {
        try { await topicAnalysisSchedule.reconcile(); }
        catch { api.logger?.warn?.('Command Center Topic Analysis scheduling remains pending until its exact Cron declaration can be reconciled.'); }
      }
      if (gatewayActiveAtStartup) {
        try { await topicAnalysisSchedule.startupCatchUp(); }
        catch { api.logger?.warn?.('Command Center Topic Analysis catch-up remains pending after a bounded startup attempt.'); }
        try { await notificationService.reconcile(); }
        catch { api.logger?.warn?.('Command Center notification reconciliation remains pending until an authenticated operator binding is available.'); }
      }
      notificationTimer = setInterval(() => {
        Promise.resolve(sourceService?.refreshReminderAttention?.())
          .then(() => notificationService?.reconcile?.())
          .catch(() => notificationService?.reconcile?.())
          .catch(() => {});
      }, 60_000);
      notificationTimer.unref?.();
      maintenanceService = createNoteMaintenanceService({ sourceService, metadata: metadataService });
      activeMaintenanceService = maintenanceService;
      // Search projections are disposable and publish atomically. Schedule
      // their replacement only after every activation-critical await has
      // completed, and retain a prior generation until publication succeeds.
      startupSearchRebuildTask = gatewayAvailable && !gatewayActiveAtStartup
        ? Promise.resolve()
        : new Promise((resolve) => setImmediate(resolve)).then(async () => {
            if (stopping) return;
            await searchService.rebuild({ signal: startupSearchRebuildController.signal });
          }).catch(() => { api.logger?.warn?.('Command Center Topic Search remains unavailable until its authoritative sources can be rebuilt.'); });
      return migrationResult;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      startupSearchRebuildController?.abort(new Error('Command Center is stopping.'));
      if (notificationTimer) clearInterval(notificationTimer);
      notificationTimer = undefined;
      stopPromise = Promise.all([
        Promise.resolve(startupSearchRebuildTask).catch(() => {}),
        Promise.resolve(sourceService?.settleSearchRefresh?.()).catch(() => {})
      ]).then(() => {
        notificationService?.close?.();
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
        dashboardService = undefined;
        notificationService = undefined;
        topicAnalysisRunner = undefined;
        topicAnalysisSchedule = undefined;
        topicReview = undefined;
        maintenanceService = undefined;
        activeMaintenanceService = undefined;
      });
      return stopPromise;
    },
    get sourceService() { return sourceService; },
    get attentionService() { return attentionService; },
    get maintenanceService() { return maintenanceService; },
    get searchService() { return searchService; },
    get searchRebuildService() { return searchRebuildService; },
    get topicService() { return topicService; },
    get dashboardService() { return dashboardService; },
    get notificationService() { return notificationService; },
    get topicAnalysisRunner() { return topicAnalysisRunner; },
    get topicAnalysisSchedule() { return topicAnalysisSchedule; },
    get topicReview() { return topicReview; },
    topicAnalysisRead() {
      if (recoveryOnly) return { schemaVersion: 1, schedule: null, runs: [], review: null };
      return { schemaVersion: 1, schedule: topicAnalysisSchedule?.peekSettings?.() ?? metadataService?.getTopicAnalysisSettings?.() ?? null, runs: metadataService?.listTopicAnalysisRuns?.() ?? [], review: topicReview?.get?.() ?? null };
    },
    topicAnalysisRun(input) {
      requireOperational();
      if (!topicAnalysisRunner) throw new Error('Command Center Topic Analysis is not ready.');
      const trigger = input?.trigger ?? 'manual';
      const execution = ['weekly', 'catch-up'].includes(trigger) && topicAnalysisSchedule
        ? topicAnalysisSchedule.weekly({ ...input, trigger })
        : topicAnalysisRunner.run({ ...input, trigger }).then((result) => { topicReview?.refresh?.(); return result; });
      return Promise.resolve(execution);
    },
    topicAnalysisScheduleUpdate(input) { requireOperational(); if (!topicAnalysisSchedule) throw new Error('Command Center Topic Analysis scheduling is not ready.'); return topicAnalysisSchedule.update(input); },
    topicReviewGet() { return topicReview?.get?.() ?? null; },
    topicReviewDecide(input) { requireOperational(); return topicReview.decide(input); },
    topicReviewSnooze(input) { requireOperational(); return topicReview.snooze(input); },
    topicReviewCheckpoint(input) { requireOperational(); return topicReview.checkpoint(input); },
    topicReviewApply(input) { requireOperational(); return topicReview.apply(input); },
    async dashboardGet(input, runtime = {}) {
      if (!dashboardService) throw new Error('Command Center Dashboard is not ready.');
      const request = { ...input };
      delete request.requestId;
      delete request.authenticatedOperatorId;
      if (recoveryOnly) return dashboardService.get(request);
      return sourceService.withSchedulerGateway(runtime, async () => {
        try { await sourceService?.refreshReminderAttention?.(); } catch { /* the projection omits unavailable scheduler rows */ }
        await notificationService?.reconcile?.();
        return dashboardService.get(request);
      });
    },
    dashboardUpdateSettings(input) {
      requireOperational();
      if (!notificationService) throw new Error('Command Center notification settings are not ready.');
      return notificationService.updateSettings(input);
    },
    notificationReconcile(runtime = {}) {
      if (recoveryOnly) return;
      return sourceService.withSchedulerGateway(runtime, () => Promise.resolve(sourceService?.refreshReminderAttention?.()).catch(() => undefined).then(() => notificationService?.reconcile?.()));
    },
    notificationCaptureBinding() {
      return notificationService?.captureCurrentOperatorBinding?.() ?? false;
    },
    topicContextRetrieve(input) {
      requireOperational();
      if (!contextPolicy) throw new Error('Command Center Topic context is not ready.');
      return contextPolicy.retrieve(input);
    },
    async searchRebuild(input) {
      requireOperational();
      if (!searchService?.rebuildPrepared) throw new Error('Command Center Topic Search rebuild is not ready.');
      return searchService.rebuildPrepared(input);
    },
    async searchPrepareRebuild(input) {
      requireOperational();
      if (!searchRebuildService?.prepareAuthorized) throw new Error('Command Center Topic Search rebuild preparation is not ready.');
      return searchRebuildService.prepareAuthorized(input);
    }
  };
}
