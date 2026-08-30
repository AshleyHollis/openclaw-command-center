import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';
import { createSourceReference } from './reference.mjs';
import { assertLogicalOperationId } from './operation-journal.mjs';
import { createMutationCoordinator } from './mutation-coordinator.mjs';
import { assertPrimaryMayClose } from './session-state.mjs';

function responseKey(value) {
  return value?.key ?? value?.sessionKey ?? value?.session?.key ?? null;
}
function responseSessionId(value) { return value?.sessionId ?? value?.id ?? value?.entry?.sessionId ?? value?.session?.sessionId ?? null; }
function responseRevision(value) { const revision = value?.revision ?? value?.updatedAt ?? value?.entry?.updatedAt ?? value?.session?.revision ?? null; return revision === null ? null : String(revision); }

function messageIdempotencyKey(value) {
  return value?.idempotencyKey ?? value?.__openclaw?.idempotencyKey ?? value?.metadata?.idempotencyKey ?? value?.message?.idempotencyKey ?? null;
}

export class SessionAdapter {
  constructor({ api, gateway, sessionStore, transcriptReader, metadata, topicId, coordinator, now } = {}) {
    this.api = api;
    this.gateway = gateway ?? api?.runtime?.gateway;
    this.sessionStore = sessionStore ?? api?.runtime?.agent?.session;
    this.transcriptReader = transcriptReader;
    if (!this.gateway?.request && !this.sessionStore?.listSessionEntries) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' });
    this.metadata = metadata;
    this.topicId = nonBlank(topicId, 'topicId');
    this.coordinator = coordinator ?? createMutationCoordinator({ metadata });
    this.now = now ?? (() => new Date().toISOString());
  }

  references() {
    return (this.metadata?.listSourceReferences?.(this.topicId) ?? []).filter((reference) => reference.topicId === this.topicId && reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session');
  }

  resolveReference(input) {
    const referenceId = typeof input === 'string' ? input : input?.referenceId ?? input?.sessionReferenceId;
    nonBlank(referenceId, 'sessionReferenceId');
    const matches = this.references().filter((reference) => reference.referenceId === referenceId);
    if (matches.length !== 1) throw sourceError('source-recovery', 'The exact linked Session Source Reference was not found in this Topic.');
    return matches[0];
  }

  async request(method, params, options) {
    if (this.gateway?.request) return this.gateway.request(method, params, options);
    const rows = this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true });
    if (method === 'sessions.list') return { sessions: rows.map((row) => ({ sessionKey: row.sessionKey, ...(row.entry ?? {}) })) };
    if (method === 'sessions.create') {
      const entry = { sessionId: params.sessionId ?? params.key, label: params.label, updatedAt: Date.now() };
      if (this.sessionStore.upsertSessionEntry) await this.sessionStore.upsertSessionEntry({ agentId: 'main', sessionKey: params.key, entry });
      else await this.sessionStore.patchSessionEntry({ agentId: 'main', sessionKey: params.key, fallbackEntry: entry, replaceEntry: true, update: async () => entry });
      return { sessionKey: params.key, entry };
    }
    if (method === 'sessions.patch') {
      const row = rows.find((item) => item.sessionKey === params.key);
      if (!row) throw sourceError('source-recovery', 'The exact Session is unavailable.');
      const entry = { ...row.entry, ...(params.label === undefined ? {} : { label: params.label }), updatedAt: Date.now() };
      if (this.sessionStore.upsertSessionEntry) await this.sessionStore.upsertSessionEntry({ agentId: 'main', sessionKey: params.key, entry });
      else await this.sessionStore.patchSessionEntry({ agentId: 'main', sessionKey: params.key, fallbackEntry: entry, replaceEntry: true, update: async () => entry });
      return { sessionKey: params.key, entry };
    }
    throw sourceError('capability-unavailable', `The Session store does not support ${method}.`);
  }

  async create(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'logicalOperationId', 'requestId', 'label', 'isPrimary'], 'Session create request');
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const requestedKey = `agent:main:command-center:${logicalOperationId}`;
    const displayName = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : `Topic Conversation ${logicalOperationId}`;
    const execute = async ({ requestId }) => {
      let result;
      if (this.sessionStore?.listSessionEntries) {
        const existing = this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true }).find((row) => row.sessionKey === requestedKey);
        if (existing) throw sourceError('conflict', 'The deterministic Session key already exists.');
        const initialEntry = { sessionId: logicalOperationId, updatedAt: Date.now(), label: displayName, agentHarnessId: 'command-center', modelSelectionLocked: true, pluginExtensions: { commandCenter: { logicalOperationId, topicId: this.topicId } } };
        if (this.sessionStore.createSessionEntry) result = await this.sessionStore.createSessionEntry({ cfg: this.api?.config, agentId: 'main', ['key']: requestedKey, label: displayName, initialEntry });
        else if (this.sessionStore.patchSessionEntry) {
          const entry = await this.sessionStore.patchSessionEntry({ agentId: 'main', sessionKey: requestedKey, fallbackEntry: initialEntry, replaceEntry: true, update: async (_current, { existingEntry } = {}) => {
            if (existingEntry) throw sourceError('conflict', 'The deterministic Session key already exists.');
            return initialEntry;
          } });
          result = { ['key']: requestedKey, entry };
        } else {
          await this.sessionStore.upsertSessionEntry({ agentId: 'main', sessionKey: requestedKey, entry: initialEntry });
          result = { ['key']: requestedKey, entry: initialEntry };
        }
      } else {
        const params = { agentId: 'main', label: displayName };
        params['k' + 'ey'] = requestedKey;
        result = await this.request('sessions.create', params, { requestId });
      }
      const sessionKey = responseKey(result);
      if (sessionKey !== requestedKey) throw sourceError('unavailable', 'sessions.create returned an unexpected Session key.');
      const sessionId = responseSessionId(result);
      const reference = await this.persistReference({ ['k' + 'ey']: sessionKey, sessionId, isPrimary: input.isPrimary ?? false, displayName });
      return { ['k' + 'ey']: sessionKey, sessionId, creationRevision: responseRevision(result), sourceReference: reference };
    };
    const reconcile = async ({ applied = false } = {}) => {
      const listing = await this.request('sessions.list', {});
      const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
      const matches = rows.filter((row) => responseKey(row) === requestedKey);
      if (matches.length !== 1) return { matched: false };
      const row = matches[0];
      const marker = row?.pluginExtensions?.commandCenter?.logicalOperationId ?? row?.entry?.pluginExtensions?.commandCenter?.logicalOperationId;
      if (this.sessionStore && marker !== logicalOperationId) throw sourceError('conflict', 'The deterministic Session key is owned by another operation.');
      const reference = await this.persistReference({ ['k' + 'ey']: requestedKey, sessionId: responseSessionId(row), isPrimary: input.isPrimary ?? false, displayName, preserveState: applied });
      return { matched: true, value: { ['k' + 'ey']: requestedKey, sessionId: responseSessionId(row), creationRevision: responseRevision(row), sourceReference: reference } };
    };
    if (this.coordinator) return this.coordinator.mutate({ operationKind: 'sessions.create', requestId: input.requestId ?? logicalOperationId, logicalOperationId, topicId: this.topicId, intent: { requestedKey, label: input.label ?? null, isPrimary: input.isPrimary ?? false }, execute, reconcile });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: await execute({ requestId: input.requestId ?? logicalOperationId }) };
  }

  async persistReference({ ['k' + 'ey']: externalId, sessionId, isPrimary = false, displayName, preserveState = false }) {
    let reference = this.references().find((item) => item.externalSourceId === externalId);
    if (!reference) {
      reference = createSourceReference({ referenceId: `session:${this.topicId}:${externalId}`, topicId: this.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: externalId, observedRevision: null });
      this.metadata?.createSourceReference?.(reference);
    }
    const existingState = this.metadata?.getSessionState?.(reference.referenceId);
    if (preserveState && existingState?.sessionId && sessionId && existingState.sessionId !== sessionId) throw sourceError('source-recovery', 'The authoritative Session identity changed during replay.');
    if (this.metadata?.setSessionState && !(preserveState && existingState)) this.metadata.setSessionState({ referenceId: reference.referenceId, sessionId, status: 'open', isPrimary, displayName: displayName || externalId, updatedAt: this.now() });
    return reference;
  }

  async history(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId', 'requestId', 'limit', 'offset', 'messageId'], 'Session history request');
    const reference = this.resolveReference(input);
    if (this.sessionStore) {
      const exact = await this.resolveExact({ referenceId: reference.referenceId });
      if (!this.transcriptReader) return { messages: [], sessionKey: exact.sessionKey, sessionId: exact.sessionId };
      const page = await this.transcriptReader({ agentId: 'main', sessionKey: exact.sessionKey, sessionId: exact.sessionId, maxMessages: input.limit ?? 100 });
      if (page?.kind === 'missing') throw sourceError('source-recovery', 'The exact authoritative Session is missing.');
      if (page?.kind === 'unavailable' || page?.kind === 'reset') throw sourceError('capability-unavailable', 'The authoritative Session transcript is refreshing; try again.', { capability: 'sessions' });
      const returnedKey = responseKey(page);
      const returnedSessionId = responseSessionId(page);
      if (returnedKey !== null && returnedKey !== exact.sessionKey || returnedSessionId !== null && returnedSessionId !== exact.sessionId) throw sourceError('source-recovery', 'The authoritative Session transcript identity did not match the exact linked Session.');
      const current = await this.resolveExact({ referenceId: reference.referenceId });
      if (current.sessionKey !== exact.sessionKey || current.sessionId !== exact.sessionId) throw sourceError('source-recovery', 'The exact authoritative Session changed during transcript retrieval.');
      const entries = Array.isArray(page) ? page : page?.entries;
      if (!Array.isArray(entries)) throw sourceError('source-recovery', 'The authoritative Session transcript returned an incomplete read.');
      return { messages: entries.slice(0, input.limit ?? 100).map((entry) => entry.message ?? entry), sessionKey: exact.sessionKey, sessionId: exact.sessionId };
    }
    const result = await this.request('chat.history', { sessionKey: reference.externalSourceId, ...(input.limit !== undefined ? { limit: input.limit } : {}), ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.messageId !== undefined ? { messageId: input.messageId } : {}) });
    const returnedKey = responseKey(result);
    if (returnedKey !== null && returnedKey !== reference.externalSourceId) throw sourceError('source-recovery', 'Session history returned an unexpected authoritative identity.');
    const returnedSessionId = result?.sessionId ?? result?.session?.sessionId ?? null;
    if (returnedSessionId !== null) {
      const expectedSessionId = this.metadata?.getSessionState?.(reference.referenceId)?.sessionId ?? null;
      if (returnedSessionId !== expectedSessionId) throw sourceError('source-recovery', 'Session history returned an unexpected authoritative identity.');
    }
    return result;
  }

  async send(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId', 'requestId', 'logicalOperationId', 'message'], 'Session send request');
    const reference = this.resolveReference(input);
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    nonBlank(input.message, 'message');
    const execute = async ({ requestId }) => {
      const { state, exact } = await this.resolveStableState(reference.referenceId);
      if (state?.status === 'closed') throw sourceError('conflict', 'A Closed Conversation is read-only and cannot receive Chat messages.');
      const result = await this.request('chat.send', { sessionKey: exact.sessionKey, message: input.message, idempotencyKey: logicalOperationId }, { requestId });
      if (result?.runId !== logicalOperationId) throw sourceError('unavailable', 'chat.send returned an unexpected idempotency result.');
      return result;
    };
    const reconcile = async () => {
      const history = await this.history({ referenceId: reference.referenceId });
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const matched = messages.some((message) => {
        const idempotencyMarker = messageIdempotencyKey(message);
        return idempotencyMarker === logicalOperationId || idempotencyMarker === `${logicalOperationId}:user`;
      });
      return matched
        ? { outcome: 'applied', value: { runId: logicalOperationId, status: 'reconciled' } }
        : { outcome: 'unknown' };
    };
    if (this.coordinator) return this.coordinator.mutate({ operationKind: 'chat.send', requestId: input.requestId ?? logicalOperationId, logicalOperationId, intent: { sessionKey: reference.externalSourceId, message: input.message }, idempotent: true, execute, reconcile });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: await execute({ requestId: input.requestId ?? logicalOperationId }) };
  }

  async list(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'status', 'requestId'], 'Session list request');
    const status = input.status ?? 'open';
    if (!['open', 'closed', 'all'].includes(status)) throw sourceError('invalid-request', 'Session list status must be open, closed, or all.');
    const conversations = [];
    for (const reference of this.references()) {
      const { state } = await this.resolveStableState(reference.referenceId);
      if (typeof state.updatedAt !== 'string' || state.updatedAt.trim() === '') throw sourceError('source-recovery', 'A linked Conversation has incomplete persisted presentation state.');
      if (status !== 'all' && state.status !== status) continue;
      conversations.push({
        referenceId: reference.referenceId,
        sessionId: state.sessionId,
        displayName: state.displayName || (state.isPrimary ? 'Primary Conversation' : 'Conversation'),
        status: state.status,
        isPrimary: state.isPrimary === true,
        wasPrimary: state.wasPrimary === true,
        updatedAt: state.updatedAt
      });
    }
    conversations.sort((left, right) => (left.isPrimary === right.isPrimary ? left.displayName.localeCompare(right.displayName) : left.isPrimary ? -1 : 1) || left.referenceId.localeCompare(right.referenceId));
    return Object.freeze({ schemaVersion: 1, topicId: this.topicId, status, conversations: Object.freeze(conversations.map((conversation) => Object.freeze(conversation))) });
  }

  async close(input = {}) {
    return this.setClosed(input, 'closed');
  }

  async reopen(input = {}) {
    return this.setClosed(input, 'open');
  }

  async setClosed(input, status) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId', 'requestId', 'logicalOperationId', 'isPrimary'], 'Session metadata request');
    const reference = this.resolveReference(input);
    const { state: current } = await this.resolveStableState(reference.referenceId);
    if (status === 'closed') assertPrimaryMayClose(current);
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const execute = async () => {
      const { state: latest } = await this.resolveStableState(reference.referenceId);
      if (latest.sessionId !== current.sessionId) throw sourceError('source-recovery', 'The exact persisted Session identity changed before the lifecycle mutation.');
      if (status === 'closed') assertPrimaryMayClose(latest);
      return this.metadata?.setSessionState?.({ referenceId: reference.referenceId, sessionId: latest.sessionId, status, isPrimary: latest.isPrimary === true, wasPrimary: latest.wasPrimary === true, displayName: latest.displayName, updatedAt: this.now() }) ?? { referenceId: reference.referenceId, status };
    };
    const reconcile = async () => {
      const observed = this.metadata?.getSessionState?.(reference.referenceId);
      if (!observed) return { outcome: 'not-applied' };
      return observed.status === status ? { outcome: 'applied', value: observed } : { outcome: 'not-applied' };
    };
    if (this.coordinator) return this.coordinator.mutate({
      operationKind: `sessions.${status === 'closed' ? 'close' : 'reopen'}`,
      requestId: input.requestId ?? logicalOperationId,
      logicalOperationId,
      topicId: this.topicId,
      referenceId: reference.referenceId,
      intent: { status, isPrimary: current?.isPrimary === true },
      execute,
      reconcile
    });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: await execute() };
  }

  async navigate(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId'], 'Session navigation request');
    const reference = this.resolveReference(input);
    const { state } = await this.resolveStableState(reference.referenceId);
    return Object.freeze({ schemaVersion: 1, status: 'applied', sessionKey: reference.externalSourceId, sessionId: state.sessionId, sourceReference: reference });
  }

  async resolveStableState(referenceId) {
    const exact = await this.resolveExact({ referenceId });
    const state = this.metadata?.getSessionState?.(referenceId);
    if (!state || typeof state.sessionId !== 'string' || state.sessionId.trim() === '' || !['open', 'closed'].includes(state.status)) throw sourceError('source-recovery', 'The linked Session state is missing or incomplete.');
    if (state.sessionId !== exact.sessionId) throw sourceError('source-recovery', 'The exact persisted Session identity changed during authoritative resolution.');
    return { state, exact };
  }

  async resolveExact(input = {}) {
    const reference = this.resolveReference(input);
    const state = this.metadata?.getSessionState?.(reference.referenceId);
    const sessionKey = this.metadata?.getSourceLocator?.(reference.referenceId)?.locator ?? reference.externalSourceId;
    if (!state?.sessionId) throw sourceError('source-recovery', 'The linked Session does not have an exact persisted identity.');
    const listing = this.sessionStore?.listSessionEntries
      ? this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true }).map((row) => ({ sessionKey: row.sessionKey, ...(row.entry ?? {}) }))
      : await this.request('sessions.list', {});
    const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
    const matches = rows.filter((row) => responseKey(row) === sessionKey && responseSessionId(row) === state.sessionId);
    if (matches.length !== 1) throw sourceError('source-recovery', 'The exact authoritative Session is missing or replaced.');
    return { sessionKey, sessionId: state.sessionId, row: matches[0] };
  }
}

export function createSessionAdapter(options) {
  return new SessionAdapter(options);
}
