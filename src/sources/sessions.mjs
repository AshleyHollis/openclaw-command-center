import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';
import { createSourceReference } from './reference.mjs';
import { assertLogicalOperationId } from './operation-journal.mjs';
import { createMutationCoordinator } from './mutation-coordinator.mjs';
import { assertPrimaryMayClose } from './session-state.mjs';

function responseKey(value) {
  return value?.key ?? value?.sessionKey ?? value?.session?.key ?? null;
}

function messageIdempotencyKey(value) {
  return value?.idempotencyKey ?? value?.__openclaw?.idempotencyKey ?? value?.metadata?.idempotencyKey ?? value?.message?.idempotencyKey ?? null;
}

export class SessionAdapter {
  constructor({ api, gateway, metadata, topicId, coordinator, now } = {}) {
    this.gateway = gateway ?? api?.runtime?.gateway;
    if (!this.gateway?.request) throw sourceError('capability-unavailable', 'The Sessions gateway capability is unavailable.', { capability: 'sessions' });
    this.metadata = metadata;
    this.topicId = nonBlank(topicId, 'topicId');
    this.coordinator = coordinator ?? createMutationCoordinator({ metadata });
    this.now = now ?? (() => new Date().toISOString());
  }

  references() {
    return (this.metadata?.listSourceReferences?.(this.topicId) ?? []).filter((reference) => reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session');
  }

  resolveReference(input) {
    const referenceId = typeof input === 'string' ? input : input?.referenceId ?? input?.sessionReferenceId;
    nonBlank(referenceId, 'sessionReferenceId');
    const matches = this.references().filter((reference) => reference.referenceId === referenceId);
    if (matches.length !== 1) throw sourceError('source-recovery', 'The exact linked Session Source Reference was not found in this Topic.');
    return matches[0];
  }

  async request(method, params, options) {
    return this.gateway.request(method, params, options);
  }

  async create(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'logicalOperationId', 'requestId', 'label', 'isPrimary'], 'Session create request');
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const requestedKey = `agent:main:command-center:${logicalOperationId}`;
    const execute = async ({ requestId }) => {
      const params = { agentId: 'main', ...(input.label ? { label: input.label } : {}) };
      params['k' + 'ey'] = requestedKey;
      const result = await this.request('sessions.create', params, { requestId });
      const sessionKey = responseKey(result);
      if (sessionKey !== requestedKey) throw sourceError('unavailable', 'sessions.create returned an unexpected Session key.');
      const reference = await this.persistReference({ ['k' + 'ey']: sessionKey, sessionId: result?.sessionId ?? result?.session?.sessionId ?? null, isPrimary: input.isPrimary ?? false });
      return { ['k' + 'ey']: sessionKey, sessionId: result?.sessionId ?? result?.session?.sessionId ?? null, sourceReference: reference };
    };
    const reconcile = async ({ applied = false } = {}) => {
      const listing = await this.request('sessions.list', {});
      const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
      const matches = rows.filter((row) => responseKey(row) === requestedKey);
      if (matches.length !== 1) return { matched: false };
      const row = matches[0];
      const reference = await this.persistReference({ ['k' + 'ey']: requestedKey, sessionId: row.sessionId ?? row.id ?? null, isPrimary: input.isPrimary ?? false, preserveState: applied });
      return { matched: true, value: { ['k' + 'ey']: requestedKey, sessionId: row.sessionId ?? row.id ?? null, sourceReference: reference } };
    };
    if (this.coordinator) return this.coordinator.mutate({ operationKind: 'sessions.create', requestId: input.requestId ?? logicalOperationId, logicalOperationId, topicId: this.topicId, intent: { requestedKey, label: input.label ?? null, isPrimary: input.isPrimary ?? false }, execute, reconcile });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: await execute({ requestId: input.requestId ?? logicalOperationId }) };
  }

  async persistReference({ ['k' + 'ey']: externalId, sessionId, isPrimary = false, preserveState = false }) {
    let reference = this.references().find((item) => item.externalSourceId === externalId);
    if (!reference) {
      reference = createSourceReference({ referenceId: `session:${this.topicId}:${externalId}`, topicId: this.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: externalId, observedRevision: null });
      this.metadata?.createSourceReference?.(reference);
    }
    const existingState = this.metadata?.getSessionState?.(reference.referenceId);
    if (preserveState && existingState?.sessionId && sessionId && existingState.sessionId !== sessionId) throw sourceError('source-recovery', 'The authoritative Session identity changed during replay.');
    if (this.metadata?.setSessionState && !(preserveState && existingState)) this.metadata.setSessionState({ referenceId: reference.referenceId, sessionId, status: 'open', isPrimary, updatedAt: this.now() });
    return reference;
  }

  async history(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId', 'requestId', 'limit', 'offset', 'messageId'], 'Session history request');
    const reference = this.resolveReference(input);
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
      const state = this.metadata?.getSessionState?.(reference.referenceId);
      if (state?.status === 'closed') throw sourceError('conflict', 'A Closed Conversation is read-only and cannot receive Chat messages.');
      const result = await this.request('chat.send', { sessionKey: reference.externalSourceId, message: input.message, idempotencyKey: logicalOperationId }, { requestId });
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

  async close(input = {}) {
    return this.setClosed(input, 'closed');
  }

  async reopen(input = {}) {
    return this.setClosed(input, 'open');
  }

  async setClosed(input, status) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId', 'requestId', 'logicalOperationId', 'isPrimary'], 'Session metadata request');
    const reference = this.resolveReference(input);
    const current = this.metadata?.getSessionState?.(reference.referenceId);
    if (status === 'closed') assertPrimaryMayClose(current);
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const apply = () => this.metadata?.setSessionState?.({ referenceId: reference.referenceId, sessionId: current?.sessionId ?? reference.observedRevision, status, isPrimary: input.isPrimary ?? current?.isPrimary ?? false, updatedAt: this.now() });
    const execute = () => apply() ?? { referenceId: reference.referenceId, status };
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
      intent: { status, isPrimary: input.isPrimary ?? current?.isPrimary ?? false },
      execute,
      reconcile
    });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: execute() };
  }

  async navigate(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'sessionReferenceId'], 'Session navigation request');
    const reference = this.resolveReference(input);
    return Object.freeze({ schemaVersion: 1, status: 'applied', sessionKey: reference.externalSourceId, sourceReference: reference });
  }
}

export function createSessionAdapter(options) {
  return new SessionAdapter(options);
}
