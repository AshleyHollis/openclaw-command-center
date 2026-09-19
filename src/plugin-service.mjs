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
import { createOpenLoopReminderCoordinator } from './open-loops/reminder-coordinator.mjs';

function unavailable(feature) {
  const reason = FIRST_LIVE_FEATURES[feature] === false
    ? 'is deferred from the first live release'
    : 'is not available in this service activation';
  throw new SourceServiceError('capability-unavailable', `Command Center ${feature} ${reason}.`);
}

const publicEvidenceFields = Object.freeze(['summary', 'payee', 'purpose', 'amount', 'currency', 'dueAt', 'dueDate', 'dueTimeZone', 'authorityId', 'invoiceId', 'accountId', 'eventKind', 'subjectKind', 'subjectNamespace', 'subjectId', 'requirementKind', 'requirementNamespace', 'requirementId', 'purchaseNamespace', 'purchaseId', 'stageNamespace', 'stageId', 'installationRequired', 'fulfilmentKind', 'replacementPurchaseId', 'replacedItemId', 'dispositionKind', 'obligationId', 'chosenOption', 'recordedChoice', 'observedChoice', 'conflictKind', 'rationale', 'assumption', 'assessment', 'material', 'decisionId', 'status', 'supersedesDecisionId', 'supersededByDecisionId']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  : value;
const operationDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
function publicOpenLoopEvidence(observation) {
  return Object.freeze({
    observationId: observation.observationId,
    type: observation.type,
    sourceSystem: observation.source.system,
    sourceKind: observation.source.kind,
    sourceVersion: observation.source.version,
    occurredAt: observation.occurredAt,
    observedAt: observation.observedAt,
    historicalBaseline: observation.historicalBaseline,
    ...Object.fromEntries(publicEvidenceFields.filter(key => observation.facts[key] !== undefined).map(key => [key, observation.facts[key]])),
    ...(typeof observation.facts.sourceAvailable === 'boolean'
      ? { sourceAvailable: observation.facts.sourceAvailable }
      : observation.facts.availability === 'available'
        ? { sourceAvailable: true }
        : observation.facts.availability === 'unavailable'
          ? { sourceAvailable: false }
          : {})
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
  let openLoopReminders;
  let topicService;
  let stopPromise;
  let releaseDurableFolderStager;
  let releaseNoteFilesystemCoordinator;
  let recoveryOnly = false;
  const refuseRecovery = () => { throw new SourceServiceError('recovery-only', 'Command Center is recovery-only; authoritative data and mutations remain unavailable.'); };
  const requireOperational = () => { if (recoveryOnly) refuseRecovery(); };
  const refuseDeferred = feature => { requireOperational(); return unavailable(feature); };
  const requireOperator = (input, action) => {
    const operatorId = typeof input?.authenticatedOperatorId === 'string' ? input.authenticatedOperatorId.trim() : '';
    if (!operatorId) throw new SourceServiceError('unauthenticated', `Authenticated operator identity is required for ${action}.`);
    return operatorId;
  };
  const reminderOperationId = parentId => {
    const bytes = createHash('sha256').update(`${parentId}\u0000open-loop-reminder`).digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const reminderSummary = (status, plan) => Object.freeze({ status, action: plan.action, referenceId: plan.referenceId, ...(plan.reason ? { reason: plan.reason } : {}) });
  function reconcileOpenLoopReminder(result, parentOperationId) {
    if (!openLoopReminders) return result;
    const plan = openLoopReminders.plan({ loop: result.loop });
    if (['none', 'blocked'].includes(plan.action)) return Object.freeze({ ...result, reminder: reminderSummary(plan.action, plan) });
    const logicalOperationId = reminderOperationId(parentOperationId);
    const prior = metadataService.getOperation(logicalOperationId);
    if (prior) {
      if (prior.state === 'unknown') throw new SourceServiceError('unknown', 'The native Reminder outcome is unknown. Retry the unchanged open-loop action to reconcile it.');
      if (prior.state !== 'applied') throw new SourceServiceError('conflict', 'The native Reminder was not changed. Refresh the open loop and retry with a new action.');
      return Object.freeze({ ...result, reminder: reminderSummary(prior.state, plan) });
    }
    return openLoopReminders.reconcile({
      loop: result.loop,
      logicalOperationId
    }).then(receipt => Object.freeze({ ...result, reminder: reminderSummary(receipt.status, receipt.plan) }));
  }
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
      if (capabilities.scheduler) openLoopReminders = createOpenLoopReminderCoordinator({ api, gateway: api.runtime.gateway, metadata: metadataService });
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
        openLoopReminders = undefined;
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
    async openLoopsIngestSelected(input = {}) {
      requireOperational();
      const operatorId = typeof input.authenticatedOperatorId === 'string' ? input.authenticatedOperatorId.trim() : '';
      if (!operatorId) throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for selected-source intake.');
      if (!input.authorization || typeof input.authorization !== 'object' || Array.isArray(input.authorization) || Object.keys(input.authorization).some(key => !['sourceSystem', 'sourceKind', 'resourceId'].includes(key))) throw new SourceServiceError('invalid-request', 'Selected-source authorization must identify one exact persisted source reference.');
      const authorization = { ...input.authorization, scopeId: operatorId };
      if (authorization.sourceKind !== 'document') throw new SourceServiceError('invalid-request', 'The bounded intake pilot accepts one existing document source reference.');
      const reference = metadataService.getSourceReference(authorization.resourceId);
      if (!reference || reference.sourceSystem !== authorization.sourceSystem || reference.sourceKind !== authorization.sourceKind) throw new SourceServiceError('source-recovery', 'The selected document is not an exact persisted source reference.');
      if (!Array.isArray(input.selections) || input.selections.length !== 1) throw new SourceServiceError('invalid-request', 'The bounded intake pilot accepts exactly one selected document.');
      const selection = input.selections[0];
      if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['topicId', 'path', 'occurredAt', 'observedAt'].includes(key)) || selection.topicId !== reference.topicId) throw new SourceServiceError('invalid-request', 'The selected document must identify its exact Topic, path, and selection times.');
      const operationKind = 'selected-source-intake-root';
      const rootIntent = { schemaVersion: 1, operatorId, authorization: input.authorization, baselineThrough: input.baselineThrough, selections: input.selections };
      const intentDigest = operationDigest(rootIntent);
      const prior = metadataService.getOperation(input.logicalOperationId);
      if (prior && (prior.operationKind !== operationKind || prior.intentDigest !== intentDigest)) throw new SourceServiceError('conflict', 'The selected-source operation ID was reused with different intent.');
      const schedule = result => {
        const scheduled = result.results.map((item, index) => item.loop && item.historicalBaseline !== true
          ? reconcileOpenLoopReminder({ schemaVersion: 1, disposition: item.disposition, loop: item.loop }, `${input.logicalOperationId}:${index}`)
          : null);
        return scheduled.some(value => value && typeof value.then === 'function')
          ? Promise.all(scheduled.map(value => Promise.resolve(value))).then(() => result)
          : result;
      };
      const publicize = result => Object.freeze({
        schemaVersion: 1,
        disposition: result.disposition,
        checkpoint: result.checkpoint,
        freshness: result.freshness,
        hasMore: result.hasMore,
        results: Object.freeze(result.results.map(item => Object.freeze({
          disposition: item.disposition,
          observationId: item.observation.observationId,
          sourceVersion: item.observation.source.version,
          historicalBaseline: item.observation.historicalBaseline,
          ...(item.loop ? { loop: item.loop } : {})
        })))
      });
      if (prior?.state === 'applied') return schedule(Object.freeze(JSON.parse(prior.resultIdentity)));
      if (prior && prior.state !== 'pending') throw new SourceServiceError('unknown', 'The selected-source operation outcome is unknown. Reconcile it before selecting the source again.');
      let pending = prior ?? metadataService.recordOperation({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest, operationKind, state: 'pending', resultStatus: 'pending', resultIdentity: JSON.stringify({ schemaVersion: 1, status: 'source-read-pending' }), observedRevision: reference.observedRevision ?? 'unknown', createdAt: selection.observedAt, updatedAt: selection.observedAt });
      const recovery = JSON.parse(pending.resultIdentity);
      let prepared = recovery?.status === 'prepared' ? recovery.prepared : null;
      if (!prepared) {
        const expectedSourceRevision = pending.observedRevision === 'unknown' ? undefined : pending.observedRevision;
        let note; let readFailure;
        try { note = await sourceService.notesRead({ schemaVersion: 1, topicId: reference.topicId, referenceId: reference.referenceId, path: selection.path, ...(expectedSourceRevision === undefined ? {} : { observedRevision: expectedSourceRevision }), sourceKind: 'document' }); }
        catch (error) { readFailure = error; }
        const content = Buffer.isBuffer(note?.bytes) ? note.bytes.toString('utf8') : note?.text;
        if (!readFailure && (typeof content !== 'string' || typeof note.revision !== 'string' || note.revision.trim() === '')) throw new SourceServiceError('source-recovery', 'The selected document did not return authoritative text and version evidence.');
        const unavailableReason = readFailure?.code === 'not-found' ? 'not-found' : readFailure?.code === 'unauthenticated' || readFailure?.code === 'forbidden' ? 'permission-revoked' : readFailure?.code === 'conflict' || readFailure?.code === 'source-recovery' ? 'version-replaced' : 'temporarily-unavailable';
        prepared = metadataService.prepareSelectedSourceBatch({
          schemaVersion: 1,
          logicalOperationId: input.logicalOperationId,
          authorization,
          baselineThrough: input.baselineThrough,
          window: { cursor: `selected:${input.logicalOperationId}`, nextCursor: `complete:${input.logicalOperationId}`, hasMore: false },
          selections: [readFailure
            ? { version: `unavailable:${expectedSourceRevision ?? 'unknown'}:${unavailableReason}`, occurredAt: selection.occurredAt, observedAt: selection.observedAt, availability: 'unavailable', unavailableReason, ...(selection.topicId ? { topicId: selection.topicId } : {}) }
            : { version: note.revision, occurredAt: selection.occurredAt, observedAt: selection.observedAt, availability: 'available', content, ...(selection.topicId ? { topicId: selection.topicId } : {}) }]
        });
        pending = metadataService.recordOperation({ ...pending, resultIdentity: JSON.stringify({ schemaVersion: 1, status: 'prepared', prepared }), updatedAt: selection.observedAt });
      }
      const publicResult = publicize(metadataService.applyPreparedSelectedSourceBatch(prepared));
      metadataService.recordOperation({ ...pending, state: 'applied', resultStatus: publicResult.disposition, resultIdentity: JSON.stringify(publicResult), updatedAt: selection.observedAt });
      return schedule(publicResult);
    },
    openLoopsDecide(input = {}) {
      requireOperational();
      if (typeof input.authenticatedOperatorId !== 'string' || input.authenticatedOperatorId.trim() === '') throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for open-loop decisions.');
      const result = metadataService.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision, decision: input.decision, ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }), ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }), ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate, dueTimeZone: input.dueTimeZone }), actorId: input.authenticatedOperatorId, rationale: input.rationale, updatedAt: new Date().toISOString() });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsPaymentStatus(input = {}) {
      requireOperational();
      if (typeof input.authenticatedOperatorId !== 'string' || input.authenticatedOperatorId.trim() === '') throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for payment status records.');
      const result = metadataService.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision, paymentState: input.paymentState, ...(input.paidAmount === undefined ? {} : { paidAmount: input.paidAmount, currency: input.currency }), actorId: input.authenticatedOperatorId, rationale: input.rationale, updatedAt: new Date().toISOString() });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsRenovationRequirement(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation requirement records');
      const result = metadataService.recordRenovationRequirement({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, requirement: input.requirement });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsRenovationPurchase(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation purchase reconciliation');
      const result = metadataService.reconcileRenovationPurchase({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, reconciliation: input.reconciliation });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsRenovationPurchaseCorrection(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation purchase relationship corrections');
      const result = metadataService.correctRenovationPurchase({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, correction: input.correction });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsRenovationReplacement(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation replacement records');
      const result = metadataService.recordRenovationReplacement({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, replacement: input.replacement });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsRenovationFulfilment(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation fulfilment records');
      const result = metadataService.recordRenovationFulfilment({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, fulfilment: input.fulfilment });
      return reconcileOpenLoopReminder(result, input.logicalOperationId);
    },
    openLoopsRenovationStage(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation stage activation');
      const result = metadataService.recordRenovationStageActivation({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, activation: input.activation });
      return Object.freeze({ schemaVersion: 1, disposition: result.disposition, observationId: result.observation.observationId });
    },
    openLoopsRenovationStagePrerequisites(input = {}) {
      requireOperational();
      return metadataService.projectRenovationStagePrerequisites({ stage: input.stage, ...(input.topicId ? { topicId: input.topicId } : {}) });
    },
    openLoopsRenovationDecisionConflict(input = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation decision review');
      const result = metadataService.recordRenovationDecisionConflict({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, conflict: input.conflict });
      return Object.freeze({ schemaVersion: 1, disposition: result.disposition, loop: result.decision.loop });
    },
    openLoopsRenovationDecisionRevise(input = {}) {
      requireOperational();
      const actorId = requireOperator(input, 'renovation decision revision');
      return metadataService.reviseRenovationDecision({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, revision: { loopId: input.loopId, chosenOption: input.chosenOption, rationale: input.rationale, decidedAt: input.decidedAt } });
    },
    dashboardUpdateSettings() { return refuseDeferred('dashboard'); },
    notificationReconcile() { return refuseDeferred('notifications'); },
    notificationCaptureBinding() { return refuseDeferred('notifications'); },
    topicContextRetrieve() { return refuseDeferred('search'); },
    async searchRebuild() { return refuseDeferred('search'); },
    async searchPrepareRebuild() { return refuseDeferred('search'); }
  };
}
