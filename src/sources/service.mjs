import { createActivityService } from '../activity/service.mjs';
import { createAnalysisAdapter } from './analysis.mjs';
import { createAttentionAdapter } from './attention.mjs';
import { capabilityDiagnostics, normalizeSourceCapabilities, requireCapability } from './capabilities.mjs';
import { sourceError, assertNoUnexpectedKeys } from './errors.mjs';
import { createMutationCoordinator } from './mutation-coordinator.mjs';
import { createNoteAdapter } from './notes.mjs';
import { createReminderAdapter } from './reminders.mjs';
import { createSearchAdapter } from './search.mjs';
import { createSessionAdapter } from './sessions.mjs';
import { createSchedulerAdapter } from './scheduler.mjs';

function adapterInput(input = {}) {
  const { topicId: _topicId, ...rest } = input;
  return rest;
}

export class AuthoritativeSourceService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw sourceError('recovery-only', 'Authoritative-source metadata is unavailable.');
    this.api = options.api;
    this.gateway = options.gateway ?? options.api?.runtime?.gateway;
    this.capabilities = normalizeSourceCapabilities(options.capabilities ?? {});
    this.searchProvider = options.searchProvider;
    this.analysisProvider = options.analysisProvider;
    this.migration = options.migration;
    this.attentionService = options.attentionService ?? null;
    this.defaults = options;
    this.coordinator = options.coordinator ?? createMutationCoordinator({ metadata: this.metadata });
    this.topicServices = new Map();
    this.activity = options.activity ?? createActivityService({ metadata: this.metadata });
  }

  status() {
    const metadataStatus = this.metadata.getOperatingStatus?.() ?? { mode: 'recovery-only', schemaVersion: null, diagnostics: [] };
    const sourceDiagnostics = capabilityDiagnostics(this.capabilities);
    const unavailableCapabilities = [...new Set([...(metadataStatus.unavailableCapabilities ?? []), ...sourceDiagnostics.map((item) => item.capability)])];
    return Object.freeze({ schemaVersion: 1, mode: metadataStatus.mode === 'recovery-only' ? 'recovery-only' : unavailableCapabilities.length > 0 ? 'degraded' : metadataStatus.mode, metadataSchemaVersion: metadataStatus.schemaVersion, diagnostics: [...(metadataStatus.diagnostics ?? []), ...sourceDiagnostics], unavailableCapabilities });
  }

  forTopic(topicId, extra = {}) {
    const id = String(topicId ?? '').trim();
    if (!id) throw sourceError('invalid-request', 'topicId must be a non-blank string.');
    if (!this.topicServices.has(id) || Object.keys(extra).length > 0) {
      const options = { ...this.defaults, ...extra, metadata: this.metadata, api: this.api, gateway: this.gateway, topicId: id, coordinator: this.coordinator };
      const notes = this.capabilities.notes?.available === false ? null : createNoteAdapter(options);
      const sessions = this.capabilities.sessions?.available === false || !this.gateway?.request ? null : createSessionAdapter(options);
      const scheduler = this.capabilities.scheduler?.available === false || !this.gateway?.request ? null : createSchedulerAdapter(options);
      const search = this.capabilities.search?.available === false || !this.searchProvider ? null : createSearchAdapter({ provider: this.searchProvider });
      const service = Object.freeze({
        notes,
        sessions,
        scheduler,
        reminders: scheduler ? createReminderAdapter({ ...options, metadata: this.metadata, api: this.api, gateway: this.gateway, topicId: id, coordinator: this.coordinator }) : null,
        search,
        activity: this.activity,
        analysis: this.capabilities.analysis?.available === false || !this.analysisProvider ? null : createAnalysisAdapter({ provider: this.analysisProvider, topicId: id }),
        attention: this.capabilities.attention?.available === false ? null : createAttentionAdapter({
          ...options,
          act: this.attentionService?.act?.bind(this.attentionService),
          ingest: this.attentionService?.ingest?.bind(this.attentionService),
          list: this.attentionService?.list?.bind(this.attentionService),
          get: (input) => this.attentionService?.get?.(input?.episodeId),
          listActions: async (episodeId) => this.attentionService?.get?.(episodeId)?.episode?.actions?.map((action) => action.actionId) ?? []
        })
      });
      if (Object.keys(extra).length === 0) this.topicServices.set(id, service);
      return service;
    }
    return this.topicServices.get(id);
  }

  requireTopicService(input) {
    const topicId = String(input?.topicId ?? '').trim();
    if (!topicId) throw sourceError('invalid-request', 'topicId must be a non-blank string.');
    if (typeof this.metadata.getTopic !== 'function') throw sourceError('recovery-only', 'Topic ownership metadata is unavailable.');
    const topic = this.metadata.getTopic(topicId);
    if (!topic) throw sourceError('source-recovery', 'The requested Topic does not exist.');
    if (topic.lifecycle !== 'active') throw sourceError('source-recovery', 'The requested Topic is still provisioning and is not available for normal use.');
    this.assertTopicReadiness(topic);
    return this.forTopic(topicId);
  }

  assertTopicReadiness(topic) {
    if (topic?.lifecycle !== 'active') throw sourceError('source-recovery', 'The requested Topic is still provisioning and is not available for normal use.');
    if (!this.migration) return;
    if (this.metadata.getMigrationCompletion?.()) return;
    const durableRow = (this.metadata.listMigrationChannels?.() ?? []).find((channel) => channel.topicId === topic.topicId);
    const durableOwner = Boolean(durableRow);
    let configured = false;
    try { configured = this.migration.normalizedConfig?.()?.channels?.some((channel) => channel.topicId === topic.topicId) === true; }
    catch {
      if (durableOwner) throw sourceError('source-recovery', 'The migration configuration requires review before Topic use.');
      return;
    }
    if (!configured && !durableOwner) return;
    const references = this.metadata.listSourceReferences?.(topic.topicId) ?? [];
    const folders = references.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    const sessions = references.filter((reference) => reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session');
    const primary = sessions.filter((reference) => {
      const state = this.metadata.getSessionState?.(reference.referenceId);
      return state?.status === 'open' && state.isPrimary === true && typeof state.sessionId === 'string' && state.sessionId.trim() !== '';
    });
    if (durableRow?.phase === 'complete') {
      if (durableRow.failureCode) throw sourceError('source-recovery', 'The completed migration binding requires integrity review before Topic use.');
      const importedFolder = references.find((reference) => reference.referenceId === durableRow.noteFolderReferenceId && reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
      const importedSession = references.find((reference) => reference.referenceId === durableRow.sessionReferenceId && reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session');
      const importedState = importedSession ? this.metadata.getSessionState?.(importedSession.referenceId) : null;
      if (!importedFolder || !importedSession || importedState?.sessionId !== durableRow.sessionId || importedState.status !== 'open' || importedState.isPrimary !== true) throw sourceError('source-recovery', 'The verified migration bindings are unavailable or rebound.');
      return;
    }
    if (folders.length !== 1 || sessions.length !== 1 || primary.length !== 1) throw sourceError('source-recovery', 'The Topic authoritative bindings are incomplete or ambiguous.');
    if (configured && durableRow?.phase !== 'complete') throw sourceError('source-recovery', 'The migrated Topic has not completed destination verification.');
  }

  async notesBrowse(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'notes'); return service.notes.browse(adapterInput(input)); }
  async notesRead(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'notes'); return service.notes.read(adapterInput(input)); }
  async guardedNoteMutation(input, operationKind, method) {
    const service = this.requireTopicService(input);
    requireCapability(this.capabilities, 'notes');
    const execute = () => service.notes[method](adapterInput(input));
    if (!this.coordinator) return execute();
    const logicalOperationId = input.logicalOperationId;
    const { requestId: _requestId, schemaVersion: _schemaVersion, ...intentInput } = input;
    return this.coordinator.mutate({
      operationKind,
      requestId: input.requestId ?? logicalOperationId,
      logicalOperationId,
      intent: intentInput,
      execute,
      reconcile: async ({ applied = false, resultIdentity = null, observedRevision = null } = {}) => {
        const targetPath = input.destinationPath ?? input.newPath ?? input.path ?? input.notePath;
        if (!targetPath) return { matched: false };
        const relocation = method === 'rename' || method === 'move';
        const readIfPresent = async (path) => {
          try { return await service.notes.read({ path }); }
          catch (error) {
            if (error?.code === 'not-found' || error?.code === 'ENOENT') return null;
            throw error;
          }
        };
        try {
          if (relocation) {
            const sourcePath = input.path ?? input.sourcePath ?? input.notePath;
            if (!sourcePath) return { outcome: 'conflict' };
            const source = await readIfPresent(sourcePath);
            const destination = await readIfPresent(targetPath);
            if (source) return { outcome: destination ? 'conflict' : source.revision === input.expectedRevision ? 'not-applied' : 'conflict' };
            if (!destination || destination.revision !== input.expectedRevision) return { outcome: 'conflict' };
            const destinationIdentity = destination.sourceReference?.externalSourceId ?? destination.sourceReference?.referenceId ?? null;
            if (!applied || !resultIdentity) return { outcome: 'unknown' };
            if (destinationIdentity !== resultIdentity || (observedRevision && destination.revision !== observedRevision)) return { outcome: 'conflict' };
            return { outcome: 'applied', value: { schemaVersion: 1, status: 'reconciled', note: destination, logicalOperationId } };
          }
          const current = await service.notes.read({ path: targetPath });
          const desiredText = input.text ?? input.content;
          const matches = desiredText !== undefined ? current.text === desiredText : current.revision === input.expectedRevision;
          return matches
            ? { matched: true, value: { schemaVersion: 1, status: 'reconciled', note: current, logicalOperationId } }
            : { matched: false };
        } catch { return { matched: false }; }
      }
    });
  }
  async notesCreate(input = {}) { return this.guardedNoteMutation(input, 'notes.create', 'create'); }
  async notesEdit(input = {}) { return this.guardedNoteMutation(input, 'notes.edit', 'edit'); }
  async notesRename(input = {}) { return this.guardedNoteMutation(input, 'notes.rename', 'rename'); }
  async notesMove(input = {}) { return this.guardedNoteMutation(input, 'notes.move', 'move'); }
  async sessionsHistory(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'sessions'); if (!service.sessions) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' }); return service.sessions.history(adapterInput(input)); }
  async sessionsNavigate(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'sessions'); if (!service.sessions) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' }); return service.sessions.navigate(adapterInput(input)); }
  async sessionsCreate(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'sessions'); if (!service.sessions) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' }); return service.sessions.create(adapterInput(input)); }
  async sessionsSend(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'sessions'); if (!service.sessions) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' }); return service.sessions.send(adapterInput(input)); }
  async sessionsClose(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'sessions'); if (!service.sessions) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' }); return service.sessions.close(adapterInput(input)); }
  async sessionsReopen(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'sessions'); if (!service.sessions) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' }); return service.sessions.reopen(adapterInput(input)); }
  async migrationStatus() { return this.migration ? this.migration.status() : { schemaVersion: 1, enabled: false, phase: 'disabled', complete: true, actions: [], channels: [], failures: [] }; }
  async migrationReview() { return this.migration ? this.migration.review() : this.migrationStatus(); }
  async migrationResume(input = {}) {
    if (!this.migration) throw sourceError('source-recovery', 'Legacy Discord migration is not configured.');
    return this.migration.resume(input);
  }
  async ingestReminderRows(topicId, rows) {
    if (!this.attentionService?.ingest) return rows;
    const configuredNow = typeof this.defaults.now === 'function' ? this.defaults.now() : this.defaults.now;
    const configuredNowMs = typeof configuredNow === 'number' ? configuredNow : Date.parse(configuredNow);
    const observedNowMs = Number.isFinite(configuredNowMs) ? configuredNowMs : Date.now();
    const observedAt = new Date(observedNowMs).toISOString();
    const returnedIds = new Set();
    for (const row of rows) {
      const externalId = row.sourceReference.externalSourceId;
      returnedIds.add(externalId);
      const schedule = row?.job?.schedule;
      const dueAt = schedule?.kind === 'at' ? Date.parse(schedule.at) : Number(row?.job?.state?.nextRunAtMs);
      const due = row?.job?.enabled !== false && Number.isFinite(dueAt) && dueAt <= observedNowMs;
      const occurrenceVersion = row.job.configRevision ?? row.sourceReference.observedRevision;
      const context = this.attentionService.sourceOccurrenceContext?.({ sourceCapabilityId: 'reminders', stableSubjectId: externalId, attentionReason: 'reminder-due' });
      if (due) {
        const generation = context && ['Resolved', 'Withdrawn'].includes(context.state) ? context.generation + 1 : context?.generation ?? 1;
        await this.attentionService.ingest({
          schemaVersion: 1,
          sourceCapabilityId: 'reminders',
          stableSubjectId: externalId,
          attentionReason: 'reminder-due',
          occurrenceId: `reminder:${externalId}:generation:${generation}:revision:${occurrenceVersion ?? 'unversioned'}`,
          ...(occurrenceVersion ? { occurrenceVersion: String(occurrenceVersion) } : {}),
          occurredAt: observedAt,
          topicId,
          sourceReferenceId: row.sourceReference.referenceId,
          evidenceFacts: { reminderDue: true, dueAt: Number.isFinite(dueAt) ? new Date(dueAt).toISOString() : observedAt },
          ...(occurrenceVersion ? { transitionEvidence: { verifiedSource: 'scheduler-readback', version: String(occurrenceVersion), state: 'active' } } : {})
        });
      } else if (context && context.state !== 'Snoozed' && !['Resolved', 'Withdrawn'].includes(context.state)) {
        await this.attentionService.ingest({
          schemaVersion: 1,
          sourceCapabilityId: 'reminders',
          stableSubjectId: externalId,
          attentionReason: 'reminder-due',
          occurrenceId: `reminder:${externalId}:terminal:${occurrenceVersion ?? 'unversioned'}`,
          ...(occurrenceVersion ? { occurrenceVersion: String(occurrenceVersion) } : {}),
          occurredAt: observedAt,
          topicId,
          sourceReferenceId: row.sourceReference.referenceId,
          evidenceFacts: { reminderDue: false },
          transitionEvidence: { verifiedSource: 'scheduler-readback', ...(occurrenceVersion ? { version: String(occurrenceVersion) } : {}), state: row?.job?.enabled === false ? 'resolved' : 'withdrawn' }
        });
      }
    }
    for (const episode of this.attentionService.allEpisodes?.() ?? []) {
      if (episode.topicId !== topicId || episode.sourceCapabilityId !== 'reminders' || ['Resolved', 'Withdrawn'].includes(episode.state) || returnedIds.has(episode.stableSubjectId)) continue;
      await this.attentionService.ingest({ schemaVersion: 1, sourceCapabilityId: 'reminders', stableSubjectId: episode.stableSubjectId, attentionReason: episode.attentionReason, occurrenceId: `reminder:${episode.stableSubjectId}:missing:${observedAt}`, occurredAt: observedAt, topicId, sourceReferenceId: episode.sourceReferenceId, evidenceFacts: { reminderDue: false }, transitionEvidence: { verifiedSource: 'scheduler-readback', state: 'withdrawn' } });
    }
    return rows;
  }
  async remindersList(input = {}) {
    const service = this.requireTopicService(input);
    requireCapability(this.capabilities, 'scheduler');
    if (!service.reminders) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' });
    return this.ingestReminderRows(input.topicId, await service.reminders.list(adapterInput(input)));
  }
  async refreshReminderAttention() {
    for (const topic of this.metadata.listUsableTopics?.() ?? []) await this.remindersList({ schemaVersion: 1, topicId: topic.topicId });
  }
  async remindersSnooze(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.reminders) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.reminders.snooze(adapterInput(input)); }
  async remindersComplete(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.reminders) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.reminders.complete(adapterInput(input)); }
  async schedulesGet(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.scheduler) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.scheduler.read(adapterInput(input)); }
  async schedulesList(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.scheduler) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.scheduler.list(adapterInput(input)); }
  async schedulesCreate(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.scheduler) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.scheduler.create(adapterInput(input)); }
  async schedulesUpdate(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.scheduler) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.scheduler.updateSchedule(adapterInput(input)); }
  async schedulesSetEnabled(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.scheduler) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.scheduler.setEnabled(adapterInput(input)); }
  async schedulesRun(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.scheduler) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.scheduler.run(adapterInput(input)); }
  metadataRead(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'requestId', 'topicId', 'referenceId'], 'metadata read request');
    if (input.referenceId) {
      const topicId = String(input.topicId ?? '').trim();
      const topic = topicId ? this.metadata.getTopic?.(topicId) : null;
      if (!topic) throw sourceError('source-recovery', 'The requested Topic does not exist.');
      this.assertTopicReadiness(topic);
      const reference = this.metadata.getSourceReference(input.referenceId);
      if (!reference || reference.topicId !== topicId) throw sourceError('source-recovery', 'The exact Topic-owned Source Reference was not found.');
      return reference;
    }
    if (input.topicId) {
      const topic = this.metadata.getTopic(input.topicId);
      if (topic) this.assertTopicReadiness(topic);
      return { topic, sourceReferences: this.metadata.listSourceReferences(input.topicId), preferences: this.metadata.getPresentationPreferences(input.topicId), activity: this.metadata.listActivity(input.topicId) };
    }
    const activeTopics = this.metadata.listUsableTopics?.() ?? this.metadata.listTopics().filter((topic) => topic.lifecycle === 'active');
    const topics = activeTopics.filter((topic) => {
      try { this.assertTopicReadiness(topic); return true; }
      catch (error) { if (error?.code === 'source-recovery') return false; throw error; }
    });
    const usableTopicIds = new Set(topics.map((topic) => topic.topicId));
    return { topics, sourceReferences: this.metadata.listSourceReferences().filter((reference) => usableTopicIds.has(reference.topicId)), activity: this.metadata.listActivity().filter((activity) => activity.topicId === null || usableTopicIds.has(activity.topicId)) };
  }
  async metadataWrite(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'requestId', 'logicalOperationId', 'topicId', 'operation', 'value'], 'metadata write request');
    const operations = { topic: 'createTopic', preferences: 'setPresentationPreferences', convention: 'setSourceConventionState', policy: 'setPolicyVersion', proposal: 'setProposalState' };
    const method = operations[input.operation];
    if (!method || typeof this.metadata[method] !== 'function') throw sourceError('invalid-request', 'Unsupported metadata operation.');
    const value = input.value ?? {};
    const envelopeTopicId = String(input.topicId ?? '').trim();
    const valueTopicId = String(value.topicId ?? '').trim();
    if (envelopeTopicId && valueTopicId && envelopeTopicId !== valueTopicId) throw sourceError('invalid-request', 'Metadata request Topic identity does not match its value.');
    let topicId = envelopeTopicId || valueTopicId;
    if (!topicId && value.referenceId) topicId = this.metadata.getSourceReference?.(value.referenceId)?.topicId ?? '';
    if (topicId) {
      const topic = this.metadata.getTopic?.(topicId);
      if (topic) this.assertTopicReadiness(topic);
    }
    if (!input.logicalOperationId) return this.metadata[method](input.value);
    return this.coordinator.mutate({
      operationKind: `metadata.${input.operation}`,
      requestId: input.requestId ?? input.logicalOperationId,
      logicalOperationId: input.logicalOperationId,
      intent: { operation: input.operation, value: input.value },
      execute: () => this.metadata[method](input.value),
      reconcile: async () => {
        let current = null;
        if (input.operation === 'topic') current = this.metadata.getTopic?.(value.topicId);
        if (input.operation === 'preferences') current = this.metadata.getPresentationPreferences?.(value.topicId);
        if (input.operation === 'convention') current = this.metadata.getSourceConventionState?.(value.referenceId)?.find((entry) => entry.aspect === value.aspect);
        if (input.operation === 'policy') current = this.metadata.getPolicyVersion?.(value.policyId);
        if (input.operation === 'proposal') current = this.metadata.getProposalState?.(value.proposalId);
        if (!current) return { matched: false };
        const comparable = Object.fromEntries(Object.keys(value).filter((key) => key !== 'createdAt' && key !== 'updatedAt').map((key) => [key, value[key]]));
        const matches = Object.entries(comparable).every(([key, expected]) => current[key] === expected);
        return matches ? { matched: true, value: current } : { matched: false };
      }
    });
  }
  async searchQuery(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'search'); if (!service.search) throw sourceError('capability-unavailable', 'Derived search capability is unavailable.', { capability: 'search' }); return service.search.query(input); }
  analysisRead(input) { requireCapability(this.capabilities, 'analysis'); const analysis = this.requireTopicService(input).analysis; if (!analysis) throw sourceError('capability-unavailable', 'Topic Analysis capability is unavailable.', { capability: 'analysis' }); return analysis.status(adapterInput(input)); }
  assertMutationAllowed() {
    if (this.metadata.getOperatingStatus?.().mode === 'recovery-only') throw sourceError('recovery-only', 'Authoritative-source mutations are blocked in Recovery-only mode.');
  }
  analysisRun(input) {
    requireCapability(this.capabilities, 'analysis');
    this.assertMutationAllowed();
    const analysis = this.requireTopicService(input).analysis;
    if (!analysis) throw sourceError('capability-unavailable', 'Topic Analysis capability is unavailable.', { capability: 'analysis' });
    return this.coordinator.mutate({ operationKind: 'analysis.run', requestId: input.requestId ?? input.logicalOperationId, logicalOperationId: input.logicalOperationId, topicId: input.topicId, intent: { input: input.input }, execute: () => analysis.run(input) });
  }
  attentionAct(input) {
    requireCapability(this.capabilities, 'attention');
    this.assertMutationAllowed();
    this.requireTopicService(input);
    if (!this.attentionService) throw sourceError('capability-unavailable', 'Attention capability is unavailable.', { capability: 'attention' });
    return this.attentionService.act(input);
  }
  async attentionList(input = {}) { requireCapability(this.capabilities, 'attention'); await this.attentionService?.refreshApprovals({ topicId: input.topicId, authenticatedOperatorId: input.authenticatedOperatorId }); const request = { ...input }; delete request.authenticatedOperatorId; delete request.requestId; return this.attentionService?.list(request) ?? { schemaVersion: 1, revision: 0, buckets: [[], [], [], []], episodes: [], inProgress: [] }; }
  async attentionGet(input = {}) { requireCapability(this.capabilities, 'attention'); await this.attentionService?.refreshApprovals({ episodeId: input.episodeId, authenticatedOperatorId: input.authenticatedOperatorId }); return this.attentionService?.get(input.episodeId) ?? { schemaVersion: 1, revision: 0, episode: null }; }
  activityList(input = {}) { requireCapability(this.capabilities, 'activity'); const request = { ...input }; delete request.requestId; return this.attentionService?.listActivity(request) ?? { schemaVersion: 1, records: [], nextOffset: null, hasMore: false }; }
  activityGet(input = {}) { requireCapability(this.capabilities, 'activity'); return { schemaVersion: 1, record: this.attentionService?.getActivity(input.activityId) ?? null }; }
  close() {
    for (const service of this.topicServices.values()) service.notes?.close?.();
    this.topicServices.clear();
  }
}

export function createAuthoritativeSourceService(options) {
  return new AuthoritativeSourceService(options);
}

export const createSourceService = createAuthoritativeSourceService;
