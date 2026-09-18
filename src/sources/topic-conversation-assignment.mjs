import { assertNoUnexpectedKeys, nonBlank, sourceError } from './errors.mjs';
import { assertLogicalOperationId } from './operation-journal.mjs';

/**
 * Attach an already-existing, unassigned native Conversation to one Topic.
 * This deliberately has no native side effect: the durable Topic reference is
 * the ownership boundary; groups, labels, uploads and transcript bytes stay
 * exactly where they are.
 */
export function assignTopicConversation(adapter, input = {}, runtime = {}) {
  assertNoUnexpectedKeys(input, ['schemaVersion', 'requestId', 'logicalOperationId', 'sessionKey', 'expectedSessionId', 'expectedSessionRevision', 'expectedMembership', 'topicId', 'expectedTopicRevision'], 'Conversation assignment');
  const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
  const sessionKey = nonBlank(input.sessionKey, 'sessionKey');
  const expectedSessionId = nonBlank(input.expectedSessionId, 'expectedSessionId');
  const expectedSessionRevision = nonBlank(input.expectedSessionRevision, 'expectedSessionRevision');
  const agent = /^agent:([^:]+):.+$/u.exec(sessionKey);
  if (!agent || input.expectedMembership !== 'unassigned' || !Number.isSafeInteger(input.expectedTopicRevision) || input.expectedTopicRevision < 0) {
    throw sourceError('invalid-request', 'Assignment requires one exact unassigned Conversation and the original Topic revision.');
  }
  const authority = runtime.creationAuthority;
  if (!authority || typeof authority.assertCurrent !== 'function' || typeof adapter.sessionStore?.getSessionEntry !== 'function' || typeof adapter.metadata?.assignTopicConversation !== 'function') {
    throw sourceError('capability-unavailable', 'Durable Conversation assignment and authenticated native readback are required.');
  }
  const principalId = nonBlank(authority.principalId, 'principalId');
  // The configured main key is authoritative host configuration supplied to
  // the plugin at activation. A sidebar must hide General for usability, but
  // the mutation owner must also reject it when called directly. Retain the
  // legacy "main" alias because an unchanged durable row can predate a main
  // key rename.
  const configuredMainKey = typeof adapter.api?.config?.session?.mainKey === 'string' && adapter.api.config.session.mainKey.trim()
    ? adapter.api.config.session.mainKey.trim()
    : 'main';
  const protectedKeys = new Set([
    `agent:${agent?.[1] ?? ''}:${configuredMainKey}`,
    `agent:${agent?.[1] ?? ''}:main`
  ]);
  const assertCurrent = () => {
    if (runtime.creationAuthority !== authority || authority.principalId !== principalId) throw sourceError('unauthenticated', 'The authenticated assignment authority changed.');
    authority.assertCurrent();
    const entry = adapter.sessionStore.getSessionEntry({ agentId: agent[1], sessionKey, readConsistency: 'latest' });
    // Imported History is a durable, read-only Session owner. Its native
    // category is presentation data and must never authorize assignment. A
    // reused key is recovery-only, not a new unassigned Conversation.
    const history = (adapter.metadata.listImportedHistories?.() ?? []).find((row) => row?.target?.agentId === agent[1] && row?.target?.sessionKey === sessionKey);
    if (history && history.target.sessionId !== expectedSessionId) {
      throw sourceError('source-recovery', 'The native Session key belongs to a replaced Imported History destination.');
    }
    if (history && history.target.sessionId === expectedSessionId) {
      throw sourceError('conflict', 'Imported History is read-only and cannot be assigned to a Topic.');
    }
    // The store's lifecycle flags are authoritative. Do not infer safety from
    // a display label, a sidebar group, or a caller supplied classification.
    if (!entry || protectedKeys.has(sessionKey) || entry.sessionId !== expectedSessionId || String(entry.updatedAt ?? entry.revision ?? '') !== expectedSessionRevision || entry.archived === true || entry.closed === true || (typeof entry.status === 'string' && entry.status !== 'open') || entry.category === 'history' || entry.category === 'main' || entry.isMain === true) {
      throw sourceError('conflict', 'The exact unassigned Conversation changed, closed, or was replaced.');
    }
  };
  assertCurrent();
  const result = adapter.metadata.assignTopicConversation({
    logicalOperationId,
    request: { topicId: adapter.topicId, expectedTopicRevision: input.expectedTopicRevision, principalId, sessionKey, expectedSessionId, expectedSessionRevision }
  }, assertCurrent);
  assertCurrent();
  return Object.freeze({ schemaVersion: 1, status: result.replayed ? 'replayed' : 'applied', logicalOperationId,
    topicId: result.topicId, referenceId: result.referenceId, sessionKey, sessionId: expectedSessionId, topicRevision: result.topicRevision });
}
