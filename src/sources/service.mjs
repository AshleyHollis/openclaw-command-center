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
        attention: this.capabilities.attention?.available === false ? null : createAttentionAdapter(options)
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
    if (!this.metadata.getTopic(topicId)) throw sourceError('source-recovery', 'The requested Topic does not exist.');
    return this.forTopic(topicId);
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
  async remindersList(input = {}) { const service = this.requireTopicService(input); requireCapability(this.capabilities, 'scheduler'); if (!service.reminders) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' }); return service.reminders.list(adapterInput(input)); }
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
      if (!topicId || !this.metadata.getTopic?.(topicId)) throw sourceError('source-recovery', 'The requested Topic does not exist.');
      const reference = this.metadata.getSourceReference(input.referenceId);
      if (!reference || reference.topicId !== topicId) throw sourceError('source-recovery', 'The exact Topic-owned Source Reference was not found.');
      return reference;
    }
    return input.topicId ? { topic: this.metadata.getTopic(input.topicId), sourceReferences: this.metadata.listSourceReferences(input.topicId), preferences: this.metadata.getPresentationPreferences(input.topicId), activity: this.metadata.listActivity(input.topicId) } : { topics: this.metadata.listTopics(), sourceReferences: this.metadata.listSourceReferences(), activity: this.metadata.listActivity() };
  }
  async metadataWrite(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'requestId', 'logicalOperationId', 'topicId', 'operation', 'value'], 'metadata write request');
    const operations = { topic: 'createTopic', preferences: 'setPresentationPreferences', convention: 'setSourceConventionState', policy: 'setPolicyVersion', proposal: 'setProposalState' };
    const method = operations[input.operation];
    if (!method || typeof this.metadata[method] !== 'function') throw sourceError('invalid-request', 'Unsupported metadata operation.');
    if (!input.logicalOperationId) return this.metadata[method](input.value);
    return this.coordinator.mutate({
      operationKind: `metadata.${input.operation}`,
      requestId: input.requestId ?? input.logicalOperationId,
      logicalOperationId: input.logicalOperationId,
      intent: { operation: input.operation, value: input.value },
      execute: () => this.metadata[method](input.value),
      reconcile: async () => {
        const value = input.value ?? {};
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
  analysisRead(input) { requireCapability(this.capabilities, 'analysis'); const analysis = this.forTopic(input.topicId).analysis; if (!analysis) throw sourceError('capability-unavailable', 'Topic Analysis capability is unavailable.', { capability: 'analysis' }); return analysis.status(adapterInput(input)); }
  assertMutationAllowed() {
    if (this.metadata.getOperatingStatus?.().mode === 'recovery-only') throw sourceError('recovery-only', 'Authoritative-source mutations are blocked in Recovery-only mode.');
  }
  analysisRun(input) {
    requireCapability(this.capabilities, 'analysis');
    this.assertMutationAllowed();
    const analysis = this.forTopic(input.topicId).analysis;
    if (!analysis) throw sourceError('capability-unavailable', 'Topic Analysis capability is unavailable.', { capability: 'analysis' });
    return this.coordinator.mutate({ operationKind: 'analysis.run', requestId: input.requestId ?? input.logicalOperationId, logicalOperationId: input.logicalOperationId, topicId: input.topicId, intent: { input: input.input }, execute: () => analysis.run(input) });
  }
  attentionAct(input) {
    requireCapability(this.capabilities, 'attention');
    this.assertMutationAllowed();
    const attention = this.forTopic(input.topicId).attention;
    if (!attention) throw sourceError('capability-unavailable', 'Attention capability is unavailable.', { capability: 'attention' });
    return this.coordinator.mutate({ operationKind: 'attention.act', requestId: input.requestId ?? input.logicalOperationId, logicalOperationId: input.logicalOperationId, topicId: input.topicId, intent: { attentionId: input.attentionId, actionId: input.actionId }, execute: () => attention.act(input) });
  }
  close() {
    for (const service of this.topicServices.values()) service.notes?.close?.();
    this.topicServices.clear();
  }
}

export function createAuthoritativeSourceService(options) {
  return new AuthoritativeSourceService(options);
}

export const createSourceService = createAuthoritativeSourceService;
