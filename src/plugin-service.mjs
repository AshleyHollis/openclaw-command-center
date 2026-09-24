import { createHash } from 'node:crypto';
import { extractSelectedDocumentText } from './open-loops/selected-document-text.mjs';
import { createAttentionService } from './attention/service.mjs';
import { createDashboardService } from './dashboard/service.mjs';
import { openCommandCenterMetadataService } from './metadata/service.mjs';
import { createLegacyDiscordMigrationService } from './migration/service.mjs';
import { createPreservedHistoryReader } from './migration/preserved-history-read.mjs';
import { createAuthoritativeSourceService } from './sources/service.mjs';
import { createTopicService } from './topics/service.mjs';
import { inspectTopicDiscoverability } from './topics/discoverability.mjs';
import { SourceServiceError } from './sources/errors.mjs';
import { withNoteFilesystemOwner } from './sources/note-filesystem-owner.mjs';
import { prepareSupportingNoteAnnotation } from './open-loops/supporting-note-annotation.mjs';
import { FIRST_LIVE_FEATURES } from './release-scope.mjs';
import { createOpenLoopReminderCoordinator, openLoopReminderOperationId } from './open-loops/reminder-coordinator.mjs';
import { planOrganizationChange } from './open-loops/capacity-workspace.mjs';
import { createCommitmentCaptureService } from './open-loops/commitment-capture.mjs';
import { loadIntakeSourceAccount } from './open-loops/intake-accounting.mjs';
import { clarificationInterpretationOperationId, loadPendingClarificationContext } from './open-loops/clarification-context.mjs';
import { createCapacityReviewService } from './open-loops/capacity-review.mjs';
import { createDailyWorkspaceService } from './daily-workspace/service.mjs';

const activeTopicMaintenanceOwners = Symbol.for('openclaw.command-center.active-topic-maintenance-owners.v1');

function publishTopicMaintenanceOwners(owners) {
  globalThis[activeTopicMaintenanceOwners] = owners;
  return () => { if (globalThis[activeTopicMaintenanceOwners] === owners) delete globalThis[activeTopicMaintenanceOwners]; };
}

function readTopicMaintenanceOwners() {
  return globalThis[activeTopicMaintenanceOwners];
}

function unavailable(feature) {
  const reason = FIRST_LIVE_FEATURES[feature] === false
    ? 'is deferred from the first live release'
    : 'is not available in this service activation';
  throw new SourceServiceError('capability-unavailable', `Command Center ${feature} ${reason}.`);
}

const publicEvidenceFields = Object.freeze(['summary', 'payee', 'purpose', 'amount', 'currency', 'dueAt', 'dueDate', 'dueTimeZone', 'authorityId', 'invoiceId', 'accountId', 'eventKind', 'subjectKind', 'subjectNamespace', 'subjectId', 'requirementKind', 'requirementNamespace', 'requirementId', 'purchaseNamespace', 'purchaseId', 'stageNamespace', 'stageId', 'installationRequired', 'fulfilmentKind', 'fulfilledItemIds', 'outstandingItemIds', 'expectedAt', 'note', 'replacementPurchaseId', 'replacedItemId', 'dispositionKind', 'obligationId', 'chosenOption', 'recordedChoice', 'observedChoice', 'conflictKind', 'rationale', 'assumption', 'assessment', 'material', 'decisionId', 'status', 'paymentState', 'resolvesClarificationId', 'interpretationOf', 'provenance', 'processorVersion', 'supersedesDecisionId', 'supersededByDecisionId', 'sourceReferenceId', 'sourcePath', 'sourceReferenceVersion', 'extractionStatus', 'pageCount', 'pageEvidence']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  : value;
const operationDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
function publicOpenLoopEvidence(observation, metadata) {
  const emailReader = observation.source.kind === 'email' && observation.source.system === 'command-center-capture'
    ? metadata.getEmailReaderLocator?.(observation.source.externalId, observation.facts.sourceVersion)
    : null;
  return Object.freeze({
    observationId: observation.observationId,
    type: observation.type,
    sourceSystem: observation.source.system,
    sourceKind: observation.source.kind,
    sourceVersion: observation.facts.sourceVersion ?? observation.source.version,
    occurredAt: observation.occurredAt,
    observedAt: observation.observedAt,
    historicalBaseline: observation.historicalBaseline,
    ...(observation.topicId ? { topicId: observation.topicId } : {}),
    ...Object.fromEntries(publicEvidenceFields.filter(key => observation.facts[key] !== undefined).map(key => [key, observation.facts[key]])),
    ...(emailReader ? { originalEmailStatus: emailReader.status, ...(emailReader.webLink ? { originalEmailUrl: emailReader.webLink } : {}) } : {}),
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
  let capacityReview;
  let dailyWorkspace;
  let topicService;
  let stopPromise;
  let releaseDurableFolderStager;
  let releaseFilesystemIdentityReader;
  let releaseNoteFilesystemCoordinator;
  let releaseTopicMaintenanceOwners;
  let recoveryOnly = false;
  const closeActivation = () => {
    releaseDurableFolderStager?.();
    releaseDurableFolderStager = undefined;
    releaseFilesystemIdentityReader?.();
    releaseFilesystemIdentityReader = undefined;
    releaseNoteFilesystemCoordinator?.();
    releaseNoteFilesystemCoordinator = undefined;
    releaseTopicMaintenanceOwners?.();
    releaseTopicMaintenanceOwners = undefined;
    sourceService?.close?.();
    attentionService?.close?.();
    metadataService?.close();
    metadataService = undefined;
    sourceService = undefined;
    attentionService = undefined;
    dashboardService = undefined;
    openLoopReminders = undefined;
    capacityReview = undefined;
    dailyWorkspace = undefined;
    topicService = undefined;
  };
  const refuseRecovery = () => { throw new SourceServiceError('recovery-only', 'Command Center is recovery-only; authoritative data and mutations remain unavailable.'); };
  const requireOperational = () => { if (recoveryOnly) refuseRecovery(); };
  const refuseDeferred = feature => { requireOperational(); return unavailable(feature); };
  const requireOperator = (input, action) => {
    const operatorId = typeof input?.authenticatedOperatorId === 'string' ? input.authenticatedOperatorId.trim() : '';
    if (!operatorId) throw new SourceServiceError('unauthenticated', `Authenticated operator identity is required for ${action}.`);
    return operatorId;
  };
  const reminderSummary = (status, plan) => Object.freeze({ status, action: plan.action, referenceId: plan.referenceId, ...(plan.reason ? { reason: plan.reason } : {}) });
  function commitDecisionWithNoteFence(input, commit) {
    const loop = metadataService.getOpenLoop(input.loopId);
    // The owner checks expectedRevision again at the actual SQLite commit.
    // A Note-backed decision also shares the Note owner's cross-process lock
    // so an older Note effect cannot publish across a newer user decision.
    const note = loop?.revision === input.expectedRevision
      ? metadataService.previewOpenLoopSupportingNoteTarget(loop.loopId) : null;
    return note && note.status !== 'none' ? withNoteFilesystemOwner(metadataService, commit) : commit();
  }
  function afterDecisionCommit(committed, logicalOperationId, runtime) {
    if (runtime?.deferFollowUp === true) {
      const pending = result => {
        const { followUpIntent, supportingNoteTarget, ...publicResult } = result;
        return Object.freeze({ ...publicResult,
          ...(followUpIntent ? { reminder: reminderSummary('pending', followUpIntent) } : {}),
          ...(supportingNoteTarget && supportingNoteTarget.status !== 'none'
            ? { supportingNote: Object.freeze({ status: supportingNoteTarget.status === 'ready' ? 'pending' : supportingNoteTarget.status }) } : {}) });
      };
      return committed && typeof committed.then === 'function' ? committed.then(pending) : pending(committed);
    }
    const withReminder = committed && typeof committed.then === 'function'
      ? committed.then(result => reconcileOpenLoopReminder(result, logicalOperationId, runtime))
      : reconcileOpenLoopReminder(committed, logicalOperationId, runtime);
    const withNote = result => {
      const saved = metadataService.getOpenLoopSupportingNoteIntent(logicalOperationId);
      if (!saved || saved.target.status === 'none') return result;
      return reconcileOpenLoopSupportingNote(logicalOperationId).then(supportingNote => Object.freeze({ ...result, supportingNote }));
    };
    return withReminder && typeof withReminder.then === 'function' ? withReminder.then(withNote) : withNote(withReminder);
  }
  async function reconcileOpenLoopSupportingNote(decisionOperationId) {
    const initial = metadataService.getOpenLoopSupportingNoteIntent(decisionOperationId);
    if (!initial?.current) return Object.freeze({ status: 'superseded' });
    if (initial.target.status !== 'ready') return Object.freeze({ status: initial.target.status, ...(initial.target.reason ? { reason: initial.target.reason } : {}) });
    return withNoteFilesystemOwner(metadataService, async () => {
      const saved = metadataService.getOpenLoopSupportingNoteIntent(decisionOperationId);
      if (!saved?.current) return Object.freeze({ status: 'superseded' });
      if (saved.outcome?.status === 'completed') {
        if (saved.intent && metadataService.getOperation(saved.intent.logicalOperationId)?.state === 'applied') {
          return Object.freeze({ status: 'completed', logicalOperationId: saved.intent.logicalOperationId });
        }
        return Object.freeze({ status: 'unknown', reason: 'missing-effect-receipt' });
      }
      const target = saved.target.target;
      let prepared = saved.intent;
      try {
        // A retained producer Note is also the exact evidence for sibling
        // outcomes in the accepted source plan. Keep its admitted revision
        // stable until those effects finish; otherwise a crash retry cannot
        // verify the original evidence without silently adopting new bytes.
        const capture = metadataService.getOpenLoopObservation(target.captureObservationId);
        if (capture?.source?.system === 'command-center-capture' && capture.source.kind === 'email') {
          if (capture.facts?.sourceVersion !== target.upstreamSourceVersion
            || capture.facts?.sourceReferenceId !== target.referenceId
            || capture.facts?.sourcePath !== target.path
            || capture.facts?.sourceReferenceVersion !== target.retainedNoteRevision) {
            throw new SourceServiceError('conflict', 'The supporting Note no longer matches its accepted source evidence.');
          }
          const admitted = loadIntakeSourceAccount(metadataService, { sourceKind: 'email',
            sourceExternalId: capture.source.externalId, sourceVersion: capture.facts.sourceVersion });
          if (admitted?.plan.retainedNoteRevision !== undefined
            && admitted.plan.retainedNoteRevision !== target.retainedNoteRevision) {
            throw new SourceServiceError('conflict', 'The retained source Note revision differs from the accepted plan.');
          }
          if (admitted && !admitted.account?.accounted) {
            return Object.freeze({ status: 'pending', reason: 'source-outcomes-pending' });
          }
        }
        if (!prepared) {
          const current = await sourceService.notesRead({ schemaVersion: 1, topicId: target.topicId,
            referenceId: target.referenceId, path: target.path, sourceKind: 'note' });
          if (current.revision !== target.expectedRevision) throw new SourceServiceError('conflict', 'The supporting Note changed before the decision could be recorded there.');
          let annotation;
          try { annotation = prepareSupportingNoteAnnotation({ text: current.text,
            loopId: saved.loopId, observation: saved.observation }); }
          catch { throw new SourceServiceError('conflict', 'The managed supporting Note block needs review before it can be updated.'); }
          prepared = metadataService.prepareOpenLoopSupportingNoteIntent({ schemaVersion: 1,
            decisionOperationId, expectedLoopRevision: saved.loopRevision,
            target, text: annotation.text });
        }
        if (!metadataService.getOpenLoopSupportingNoteIntent(decisionOperationId)?.current) return Object.freeze({ status: 'superseded' });
        const noteEffect = { schemaVersion: 1, logicalOperationId: prepared.logicalOperationId,
          topicId: target.topicId, referenceId: target.referenceId, path: target.path,
          expectedRevision: target.expectedRevision, text: prepared.text };
        if (saved.intent) {
          const verified = await sourceService.notesEditReconcile(noteEffect);
          if (verified.status === 'not-applied') await sourceService.notesEdit(noteEffect);
          else if (verified.status !== 'applied') throw new SourceServiceError('unknown', 'The supporting Note effect is not yet verified.');
        } else await sourceService.notesEdit(noteEffect);
        const sourceOperation = metadataService.getOperation(prepared.logicalOperationId);
        if (sourceOperation?.state !== 'applied' || !sourceOperation.observedRevision) throw new SourceServiceError('unknown', 'The supporting Note effect lacks an applied operation receipt.');
        const outcome = metadataService.recordOpenLoopSupportingNoteOutcome({ schemaVersion: 1,
          decisionOperationId, expectedLoopRevision: saved.loopRevision,
          status: 'completed', observedRevision: sourceOperation.observedRevision });
        return Object.freeze({ status: outcome.status, logicalOperationId: prepared.logicalOperationId });
      } catch (error) {
        const status = error?.code === 'conflict' || error?.code === 'open-loop-note-intent-mismatch' ? 'conflict'
          : error?.code === 'unknown' ? 'unknown' : 'unavailable';
        const reason = typeof error?.code === 'string' && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : 'supporting-note-effect-failed';
        if (saved.outcome?.status === 'completed') return Object.freeze({ status, reason });
        try { metadataService.recordOpenLoopSupportingNoteOutcome({ schemaVersion: 1,
          decisionOperationId, expectedLoopRevision: saved.loopRevision,
          status, reason }); }
        catch { return Object.freeze({ status: 'superseded' }); }
        return Object.freeze({ status, reason });
      }
    });
  }
  function reconcileOpenLoopReminder(result, parentOperationId, runtime = {}) {
    const reminderCoordinator = runtime?.gateway?.request
      ? createOpenLoopReminderCoordinator({ api, gateway: runtime.gateway, metadata: metadataService })
      : openLoopReminders;
    const { followUpIntent, supportingNoteTarget: _supportingNoteTarget, ...publicResult } = result;
    if (!reminderCoordinator) return Object.freeze(publicResult);
    if (result.followUpIntent) {
      return reminderCoordinator.reconcileAccepted({ loop: result.loop, followUpIntent })
        .then(receipt => Object.freeze({ ...publicResult, reminder: reminderSummary(receipt.status, receipt.plan) }));
    }
    const plan = reminderCoordinator.plan({ loop: result.loop });
    if (['none', 'blocked'].includes(plan.action)) return Object.freeze({ ...publicResult, reminder: reminderSummary(plan.action, plan) });
    const logicalOperationId = openLoopReminderOperationId(parentOperationId);
    const prior = metadataService.getOperation(logicalOperationId);
    if (prior) {
      if (prior.state === 'unknown') throw new SourceServiceError('unknown', 'The native Reminder outcome is unknown. Retry the unchanged open-loop action to reconcile it.');
      if (prior.state !== 'applied') throw new SourceServiceError('conflict', 'The native Reminder was not changed. Refresh the open loop and retry with a new action.');
      return Object.freeze({ ...publicResult, reminder: reminderSummary(prior.state, plan) });
    }
    return reminderCoordinator.reconcile({
      loop: result.loop,
      logicalOperationId
    }).then(receipt => Object.freeze({ ...publicResult, reminder: reminderSummary(receipt.status, receipt.plan) }));
  }
  const service = {
    id: 'command-center-metadata',
    async start(context = {}) {
      stopPromise = undefined;
      try {
      const [{ setHostDurableFolderStager, setHostFilesystemIdentityReader }, { setHostNoteFilesystemCoordinator }, fileAccess, sqlite] = await Promise.all([
        import('./sources/note-folder-identity.mjs'), import('./sources/note-filesystem-owner.mjs'),
        import('openclaw/plugin-sdk/file-access-runtime'), import('openclaw/plugin-sdk/sqlite-runtime')
      ]);
      const fixtureFileAccess = api.runtime?.fileAccess ?? {};
      releaseDurableFolderStager = setHostDurableFolderStager(fixtureFileAccess.stageDurableFileInDirectory ?? fileAccess.stageDurableFileInDirectory);
      releaseFilesystemIdentityReader = setHostFilesystemIdentityReader(fixtureFileAccess.readDurableFilesystemIdentity ?? fileAccess.readDurableFilesystemIdentity);
      releaseNoteFilesystemCoordinator = setHostNoteFilesystemCoordinator(fixtureFileAccess.tryAcquireExclusiveSqliteCoordinator ?? sqlite.tryAcquireExclusiveSqliteCoordinator);
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const gatewayAvailable = typeof api.runtime?.gateway?.request === 'function';
      const serviceCronAvailable = typeof context.getCron === 'function';
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
      dailyWorkspace = createDailyWorkspaceService({ metadata: metadataService, routines: api.pluginConfig?.routines ?? [] });
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
      if ((serviceCronAvailable || gatewayAvailable) && api.pluginConfig?.capacityReview) {
        const serviceCron = context.getCron?.();
        capacityReview = createCapacityReviewService({ metadata: metadataService, sourceService, scheduler: serviceCron, gateway: serviceCron ? undefined : api.runtime.gateway, config: api.pluginConfig.capacityReview });
        await capacityReview.reconcileSchedule();
      }
      topicService = createTopicService({ metadata: metadataService, api, noteVaultRoot: api.pluginConfig?.topics?.noteRoot });
      const migrationResult = await migrationService.start();
      // A running Gateway is insufficient evidence that existing Topics and
      // their Primary Conversations survived startup. Report the bounded audit
      // without making an unavailable Note source hide healthy Conversations.
      try {
        const discoverability = await inspectTopicDiscoverability({ metadata: metadataService, topics: topicService, sources: sourceService });
        api.logger?.info?.(`Command Center discoverability ${JSON.stringify(discoverability)}`);
      } catch (error) {
        api.logger?.error?.(`Command Center discoverability ${JSON.stringify({ code: error?.code ?? 'topic-discoverability-check-failed', ...(error?.summary ? { summary: error.summary } : {}) })}`);
      }
      releaseTopicMaintenanceOwners = publishTopicMaintenanceOwners(Object.freeze({ sourceService, metadata: metadataService, capacityReview, dailyWorkspace,
        interpretClarification: (input, runtime) => service.openLoopsInterpretClarification(input, runtime) }));
      if (FIRST_LIVE_FEATURES.dashboard) {
        try { await sourceService.refreshReminderAttention(); }
        catch { api.logger?.warn?.('Command Center could not refresh Reminder attention during startup.'); }
        dashboardService = createDashboardService({
          sourceService,
          attentionService,
          metadata: metadataService,
          dailyWorkspace,
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
      } catch (error) {
        closeActivation();
        throw error;
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = Promise.resolve().then(() => {
        // Do not retain an old host activation's capability across a restart.
        // The release closure cannot clear a capability installed by its successor.
        closeActivation();
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
      return sourceService && metadataService ? { sourceService, metadata: metadataService } : readTopicMaintenanceOwners() ?? {};
    },
    get capacityReview() { return capacityReview ?? readTopicMaintenanceOwners()?.capacityReview; },
    get dailyWorkspace() { return dailyWorkspace ?? readTopicMaintenanceOwners()?.dailyWorkspace; },
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
    briefingSetRead(input = {}) { requireOperational(); return dailyWorkspace.setBriefingRead(input); },
    routineDecide(input = {}) { requireOperational(); return dailyWorkspace.decideRoutine(input); },
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
      const priorUserActionOperationId = loop.attention?.pendingClarificationId && loop.attention?.priorUserActionOperationId;
      const prior = priorUserActionOperationId ? metadataService.getOpenLoopUserActionReceipt(priorUserActionOperationId) : null;
      const accepted = metadataService.getCurrentOpenLoopUserActionReceipt(loop.loopId)
        ?? (prior?.loop.loopId === loop.loopId ? prior : null);
      const priorDecision = Boolean(accepted && accepted.current === false);
      let followUp;
      let supportingNote;
      if (accepted) {
        let plan;
        let planningConflict = false;
        try { plan = accepted.followUpIntent ?? openLoopReminders?.plan({ loop: accepted.loop }); }
        catch { planningConflict = true; }
        const operation = metadataService.getOperation(openLoopReminderOperationId(accepted.logicalOperationId));
        const status = operation?.state === 'applied' ? 'completed' : !openLoopReminders ? 'unavailable'
          : planningConflict || plan?.action === 'conflict' ? 'conflict' : !plan ? 'unavailable'
          : operation?.state === 'unknown' ? 'unknown' : operation ? 'conflict'
            : plan.action === 'none' ? 'completed' : plan.action === 'blocked' ? 'blocked' : 'pending';
        followUp = Object.freeze({ status, logicalOperationId: accepted.logicalOperationId,
          ...(priorDecision ? { priorDecision: true } : {}),
          ...(plan ? { action: plan.action, ...(plan.reason ? { reason: plan.reason } : {}) } : {}) });
        const note = metadataService.getOpenLoopSupportingNoteIntent(accepted.logicalOperationId);
        if (note && note.target.status !== 'none') {
          const operation = note?.intent && metadataService.getOperation(note.intent.logicalOperationId);
          const noteStatus = note.target.status === 'conflict' ? 'conflict'
            : note.outcome?.status === 'completed' && operation?.state !== 'applied' ? 'unknown'
              : note.outcome?.status ?? (operation?.state === 'unknown' ? 'unknown'
                : operation?.state === 'conflict' ? 'conflict' : 'pending');
          supportingNote = Object.freeze({ status: noteStatus,
            ...(priorDecision ? { priorDecision: true } : {}),
            ...(note.outcome?.reason ? { reason: note.outcome.reason } : {}),
            ...(note.intent ? { logicalOperationId: note.intent.logicalOperationId } : {}) });
        }
      }
      return Object.freeze({ schemaVersion: 1, loop, evidence: Object.freeze(loop.evidenceObservationIds.map(id => publicOpenLoopEvidence(metadataService.getOpenLoopObservation(id), metadataService))), ...(followUp ? { followUp } : {}), ...(supportingNote ? { supportingNote } : {}) });
    },
    async openLoopsCapture(input = {}) {
      requireOperational();
      const operatorId = requireOperator(input, 'quick capture');
      const topic = metadataService.getTopic(input.topicId);
      if (!topic || topic.lifecycle !== 'active') throw new SourceServiceError('not-found', 'Quick capture requires one exact active Topic.');
      const now = input.capturedAt;
      const capture = createCommitmentCaptureService({ metadata: metadataService, sourceService });
      let result;
      try {
        result = await capture.capture({
          schemaVersion: 1,
          logicalOperationId: input.logicalOperationId,
          sourceKind: 'manual',
          sourceExternalId: `operator:${operatorId}`,
          sourceVersion: `quick-capture:${input.captureId}`,
          topicId: input.topicId,
          title: input.title,
          obligationId: input.captureId,
          provenance: input.captureKind === 'idea' ? 'idea' : 'explicit',
          occurredAt: now,
          observedAt: now,
          historicalBaseline: false
        });
      } catch (error) {
        if (error instanceof SourceServiceError) throw error;
        throw new SourceServiceError('invalid-request', error?.message ?? 'Quick capture is invalid.');
      }
      return Object.freeze({ schemaVersion: 1, disposition: result.disposition === 'duplicate' ? 'duplicate' : 'applied', loop: result.loop });
    },
    async openLoopsIngestSelected(input = {}) {
      requireOperational();
      const operatorId = typeof input.authenticatedOperatorId === 'string' ? input.authenticatedOperatorId.trim() : '';
      if (!operatorId) throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for selected-source intake.');
      if (!input.authorization || typeof input.authorization !== 'object' || Array.isArray(input.authorization) || Object.keys(input.authorization).some(key => !['sourceSystem', 'sourceKind', 'resourceId'].includes(key))) throw new SourceServiceError('invalid-request', 'Selected-source authorization must identify one exact persisted source reference.');
      const authorization = { ...input.authorization, scopeId: operatorId };
      if (authorization.sourceKind !== 'document') throw new SourceServiceError('invalid-request', 'The bounded intake pilot accepts one existing document source reference.');
      if (!Array.isArray(input.selections) || input.selections.length !== 1) throw new SourceServiceError('invalid-request', 'The bounded intake pilot accepts exactly one selected document.');
      const selection = input.selections[0];
      if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['topicId', 'path', 'occurredAt', 'observedAt'].includes(key))) throw new SourceServiceError('invalid-request', 'The selected document must identify its exact Topic, path, and selection times.');
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
      let pending = prior;
      const recovery = pending ? JSON.parse(pending.resultIdentity) : null;
      let prepared = recovery?.status === 'prepared' ? recovery.prepared : null;
      if (prepared) {
        const publicResult = publicize(metadataService.applyPreparedSelectedSourceBatch(prepared));
        metadataService.recordOperation({ ...pending, state: 'applied', resultStatus: publicResult.disposition, resultIdentity: JSON.stringify(publicResult), updatedAt: selection.observedAt });
        return schedule(publicResult);
      }
      const reference = metadataService.getSourceReference(authorization.resourceId);
      if (!reference || reference.sourceSystem !== authorization.sourceSystem || reference.sourceKind !== authorization.sourceKind) throw new SourceServiceError('source-recovery', 'The selected document is not an exact persisted source reference.');
      if (selection.topicId !== reference.topicId) throw new SourceServiceError('invalid-request', 'The selected document Topic does not match its persisted Source Reference.');
      pending ??= metadataService.recordOperation({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest, operationKind, state: 'pending', resultStatus: 'pending', resultIdentity: JSON.stringify({ schemaVersion: 1, status: 'source-read-pending' }), observedRevision: reference.observedRevision ?? 'unknown', createdAt: selection.observedAt, updatedAt: selection.observedAt });
      if (!prepared) {
        const expectedSourceRevision = pending.observedRevision === 'unknown' ? undefined : pending.observedRevision;
        let note; let readFailure;
        try { note = await sourceService.notesRead({ schemaVersion: 1, topicId: reference.topicId, referenceId: reference.referenceId, path: selection.path, ...(expectedSourceRevision === undefined ? {} : { observedRevision: expectedSourceRevision }), sourceKind: 'document', returnBytes: true }); }
        catch (error) { readFailure = error; }
        const extraction = !readFailure && Buffer.isBuffer(note?.bytes) ? await extractSelectedDocumentText({ bytes: note.bytes, path: selection.path }) : null;
        if (!readFailure && (!extraction || typeof note.revision !== 'string' || note.revision.trim() === '')) throw new SourceServiceError('source-recovery', 'The selected document did not return authoritative bytes and version evidence.');
        const unavailableReason = readFailure?.code === 'not-found' ? 'not-found' : readFailure?.code === 'unauthenticated' || readFailure?.code === 'forbidden' ? 'permission-revoked' : readFailure?.code === 'conflict' || readFailure?.code === 'source-recovery' ? 'version-replaced' : 'temporarily-unavailable';
        prepared = metadataService.prepareSelectedSourceBatch({
          schemaVersion: 1,
          logicalOperationId: input.logicalOperationId,
          authorization,
          baselineThrough: input.baselineThrough,
          window: { cursor: `selected:${input.logicalOperationId}`, nextCursor: `complete:${input.logicalOperationId}`, hasMore: false },
          selections: [readFailure
            ? { version: `unavailable:${expectedSourceRevision ?? 'unknown'}:${unavailableReason}`, occurredAt: selection.occurredAt, observedAt: selection.observedAt, availability: 'unavailable', unavailableReason, sourcePath: selection.path, ...(selection.topicId ? { topicId: selection.topicId } : {}) }
            : { version: note.revision, occurredAt: selection.occurredAt, observedAt: selection.observedAt, availability: 'available', content: extraction.content, sourcePath: selection.path, extractionStatus: extraction.extractionStatus, reviewRequired: extraction.reviewRequired, ...(extraction.pageCount === undefined ? {} : { pageCount: extraction.pageCount }), pageEvidence: extraction.pageEvidence, ...(selection.topicId ? { topicId: selection.topicId } : {}) }]
        });
        pending = metadataService.recordOperation({ ...pending, resultIdentity: JSON.stringify({ schemaVersion: 1, status: 'prepared', prepared }), updatedAt: selection.observedAt });
      }
      const publicResult = publicize(metadataService.applyPreparedSelectedSourceBatch(prepared));
      metadataService.recordOperation({ ...pending, state: 'applied', resultStatus: publicResult.disposition, resultIdentity: JSON.stringify(publicResult), updatedAt: selection.observedAt });
      return schedule(publicResult);
    },
    openLoopsDecide(input = {}, runtime = {}) {
      requireOperational();
      if (typeof input.authenticatedOperatorId !== 'string' || input.authenticatedOperatorId.trim() === '') throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for open-loop decisions.');
      const committed = commitDecisionWithNoteFence(input, () => metadataService.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision, decision: input.decision, ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }), ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }), ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate, dueTimeZone: input.dueTimeZone }), ...(input.amount === undefined ? {} : { amount: input.amount, currency: input.currency }), actorId: input.authenticatedOperatorId, rationale: input.rationale, updatedAt: new Date().toISOString() }));
      return afterDecisionCommit(committed, input.logicalOperationId, runtime);
    },
    openLoopsClarify(input = {}) {
      requireOperational();
      const actorId = requireOperator(input, 'item-specific clarification');
      return commitDecisionWithNoteFence(input, () => metadataService.recordOpenLoopClarification({
        schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId,
        expectedRevision: input.expectedRevision, actorId, rationale: input.rationale,
        updatedAt: new Date().toISOString()
      }));
    },
    openLoopsInterpretClarification(input = {}, runtime = {}) {
      requireOperational();
      if (!metadataService) {
        const active = readTopicMaintenanceOwners()?.interpretClarification;
        if (typeof active !== 'function') throw new SourceServiceError('capability-unavailable', 'Active clarification owner is unavailable.');
        return active(input, runtime);
      }
      if (typeof input.clarificationObservationId !== 'string' || !input.clarificationObservationId.trim())
        throw new SourceServiceError('invalid-request', 'An exact saved clarification is required.');
      const logicalOperationId = clarificationInterpretationOperationId(input.clarificationObservationId);
      const prior = metadataService.getOpenLoopUserActionReceipt(logicalOperationId);
      if (prior && input.outcome !== 'clear') throw new SourceServiceError('conflict', 'The clarification already has a clear interpretation.');
      const context = prior ? null : loadPendingClarificationContext(metadataService, { loopId: input.loopId, expectedRevision: input.expectedRevision });
      if (context && context.status !== 'pending') return Object.freeze({ schemaVersion: 1, ...context });
      if (context && (input.clarificationObservationId !== context.clarificationObservationId || input.processorVersion !== context.processorVersion))
        throw new SourceServiceError('conflict', 'The targeted clarification identity changed.');
      if (!prior && input.outcome === 'ambiguous') return Object.freeze({ schemaVersion: 1, status: 'review-required', reason: 'clarification-ambiguous', loopId: context.loopId });
      const decision = ['confirm', 'defer', 'dismiss', 'resolve', 'correct-date'].includes(input.decision);
      const payment = ['partially-paid', 'payment-pending', 'paid', 'disputed', 'cancelled', 'uncertain'].includes(input.paymentState);
      if (input.outcome !== 'clear' || decision === payment)
        throw new SourceServiceError('invalid-request', 'A clear interpretation requires one supported decision or payment status.');
      const priorEvidence = prior?.loop.evidenceObservationIds.map(id => metadataService.getOpenLoopObservation(id))
        .find(item => item?.source?.kind === 'processor-interpretation' && item.source.externalId === logicalOperationId);
      if (prior && (!priorEvidence || priorEvidence.facts.interpretationOf !== input.clarificationObservationId
        || priorEvidence.facts.processorVersion !== input.processorVersion || !priorEvidence.facts.interpretationFence))
        throw new SourceServiceError('conflict', 'The saved interpretation identity differs.');
      const clarification = prior ? null : metadataService.getOpenLoopObservation(context.clarificationObservationId);
      const interpretationFence = priorEvidence?.facts.interpretationFence ?? { clarificationObservationId: context.clarificationObservationId,
        ...context.source, outcomeId: context.outcomeId, processorVersion: context.processorVersion };
      const common = { schemaVersion: 1, logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision,
        actorId: priorEvidence?.facts.actorId ?? clarification.facts.actorId,
        rationale: priorEvidence?.facts.rationale ?? context.userWords, updatedAt: new Date().toISOString(), interpretationFence };
      const committed = commitDecisionWithNoteFence(input, () => payment
        ? metadataService.recordOpenLoopPaymentStatus({ ...common, paymentState: input.paymentState,
          ...(input.paidAmount === undefined ? {} : { paidAmount: input.paidAmount, currency: input.currency }) })
        : metadataService.recordOpenLoopDecision({ ...common, decision: input.decision,
          ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }),
          ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
          ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate, dueTimeZone: input.dueTimeZone }) }));
      return afterDecisionCommit(committed, logicalOperationId, runtime);
    },
    openLoopsResumeFollowUp(input = {}, runtime = {}) {
      requireOperational();
      const actorId = requireOperator(input, 'open-loop follow-up recovery');
      if (typeof runtime?.gateway?.request !== 'function') throw new SourceServiceError('capability-unavailable', 'An authenticated Scheduler request is required to resume follow-up.');
      const accepted = metadataService.getOpenLoopUserActionReceipt(input.logicalOperationId);
      if (!accepted) throw new SourceServiceError('not-found', 'The exact saved user decision is unavailable.');
      if (accepted.actorId !== actorId) throw new SourceServiceError('unauthorized', 'The saved decision belongs to another operator.');
      if (!accepted.current || metadataService.getOpenLoop(accepted.loop.loopId)?.revision !== accepted.loop.revision) {
        return Object.freeze({ schemaVersion: 1, disposition: 'superseded', loop: metadataService.getOpenLoop(accepted.loop.loopId) });
      }
      const reminder = reconcileOpenLoopReminder({ schemaVersion: 1, disposition: 'duplicate', loop: accepted.loop,
        ...(accepted.followUpIntent ? { followUpIntent: accepted.followUpIntent } : {}) }, accepted.logicalOperationId, runtime);
      return Promise.resolve(reminder).then(async result => {
        const saved = metadataService.getOpenLoopSupportingNoteIntent(accepted.logicalOperationId);
        if (!saved || saved.target.status === 'none') return result;
        return Object.freeze({ ...result, supportingNote: await reconcileOpenLoopSupportingNote(accepted.logicalOperationId) });
      });
    },
    openLoopsPaymentStatus(input = {}, runtime = {}) {
      requireOperational();
      if (typeof input.authenticatedOperatorId !== 'string' || input.authenticatedOperatorId.trim() === '') throw new SourceServiceError('unauthenticated', 'Authenticated operator identity is required for payment status records.');
      const committed = commitDecisionWithNoteFence(input, () => metadataService.recordOpenLoopPaymentStatus({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, loopId: input.loopId, expectedRevision: input.expectedRevision, paymentState: input.paymentState, ...(input.paidAmount === undefined ? {} : { paidAmount: input.paidAmount, currency: input.currency }), actorId: input.authenticatedOperatorId, rationale: input.rationale, updatedAt: new Date().toISOString() }));
      return afterDecisionCommit(committed, input.logicalOperationId, runtime);
    },
    openLoopsOrganize(input = {}, runtime = {}) {
      requireOperational();
      requireOperator(input, 'open-loop organization');
      const loop = metadataService.getOpenLoop(input.loopId);
      if (!loop) throw new SourceServiceError('not-found', 'The exact open loop is unavailable.');
      if (loop.revision !== input.expectedRevision) throw new SourceServiceError('conflict', 'The open loop changed. Refresh before organizing it.');
      const updatedAt = new Date().toISOString();
      let next;
      try { next = planOrganizationChange(loop, { schemaVersion: 1, action: input.action, ...(input.importance === undefined ? {} : { importance: input.importance }), ...(input.plannedAt === undefined ? {} : { plannedAt: input.plannedAt }), ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }), ...(input.effortMinutes === undefined ? {} : { effortMinutes: input.effortMinutes }), ...(input.contexts === undefined ? {} : { contexts: input.contexts }), ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }), updatedAt }); }
      catch (error) { throw new SourceServiceError('invalid-request', error.message); }
      const result = metadataService.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: loop.revision, loop: next, evidenceRoles: {}, updatedAt });
      return reconcileOpenLoopReminder(result, input.logicalOperationId, runtime);
    },
    openLoopsRenovationRequirement(input = {}, runtime = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation requirement records');
      const result = metadataService.recordRenovationRequirement({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, requirement: input.requirement });
      return reconcileOpenLoopReminder(result, input.logicalOperationId, runtime);
    },
    openLoopsRenovationPurchase(input = {}, runtime = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation purchase reconciliation');
      const result = metadataService.reconcileRenovationPurchase({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, reconciliation: input.reconciliation });
      return reconcileOpenLoopReminder(result, input.logicalOperationId, runtime);
    },
    openLoopsRenovationPurchaseCorrection(input = {}, runtime = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation purchase relationship corrections');
      const result = metadataService.correctRenovationPurchase({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, correction: input.correction });
      return reconcileOpenLoopReminder(result, input.logicalOperationId, runtime);
    },
    openLoopsRenovationReplacement(input = {}, runtime = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation replacement records');
      const result = metadataService.recordRenovationReplacement({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, replacement: input.replacement });
      return reconcileOpenLoopReminder(result, input.logicalOperationId, runtime);
    },
    openLoopsRenovationFulfilment(input = {}, runtime = {}) {
      requireOperational(); const actorId = requireOperator(input, 'renovation fulfilment records');
      const result = metadataService.recordRenovationFulfilment({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, expectedRevision: input.expectedRevision, actorId, fulfilment: input.fulfilment });
      return reconcileOpenLoopReminder(result, input.logicalOperationId, runtime);
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
  return service;
}
