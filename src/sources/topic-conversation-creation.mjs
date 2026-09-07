import { assertNoUnexpectedKeys, nonBlank, sourceError } from './errors.mjs';
import { assertLogicalOperationId } from './operation-journal.mjs';

// A lost response is deliberately not executable recovery. The existing native
// idempotency cache is process-local; the durable local dispatch claim is not.
export async function createTopicConversation(adapter, input, runtime, { existingOnly = false } = {}) {
  assertNoUnexpectedKeys(input, ['schemaVersion', 'logicalOperationId', 'requestId', 'label', 'isPrimary', 'expectedTopicRevision'], 'Conversation creation');
  const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
  if (!Number.isInteger(input.expectedTopicRevision) || input.expectedTopicRevision < 0 || input.isPrimary !== undefined && input.isPrimary !== false) throw sourceError('invalid-request', 'Conversation creation requires the original Topic revision and cannot replace its Primary.');
  if (runtime.authoritativeSession !== undefined || typeof runtime.gatewayRequest !== 'function') throw sourceError('capability-unavailable', 'Conversation creation requires authenticated native dispatch.');
  const { principalId, assertCurrent } = conversationAuthority(runtime);
  const gatewayRequest = runtime.gatewayRequest;
  const label = input.label === undefined ? `Topic Conversation ${logicalOperationId}` : nonBlank(input.label, 'label').trim();
  if (label.length > 300) throw sourceError('invalid-request', 'Conversation label must be at most 300 characters.');
  const request = Object.freeze({ topicId: adapter.topicId, expectedTopicRevision: input.expectedTopicRevision, principalId, label });
  const metadata = adapter.metadata;
  if (typeof metadata?.claimTopicConversationCreation !== 'function' || typeof adapter.sessionStore?.getSessionEntry !== 'function') throw sourceError('capability-unavailable', 'Durable Conversation ownership and exact native readback are required.');
  const unknown = () => ({ schemaVersion: 1, status: 'unknown', logicalOperationId });
  const readExact = async (key, sessionId) => {
    const entry = await adapter.sessionStore.getSessionEntry({ agentId: 'main', sessionKey: key, readConsistency: 'latest' });
    assertCurrent();
    if (!entry || entry.sessionId !== sessionId) throw sourceError('source-recovery', 'The exact Conversation generation is unavailable; no replacement was attached.');
    return entry;
  };
  assertCurrent();
  const claim = existingOnly
    ? { dispatch: false, operation: metadata.readTopicConversationCreation({ logicalOperationId, topicId: adapter.topicId, principalId }, assertCurrent) }
    : metadata.claimTopicConversationCreation({ logicalOperationId, request }, assertCurrent);
  let operation = claim.operation;
  if (claim.dispatch) {
    const primary = operation.intent.primary;
    await readExact(primary.locator?.locator ?? primary.reference.externalSourceId, primary.state.sessionId);
    // Recheck the original local snapshot after native Primary verification.
    metadata.assertTopicConversationCreation({ logicalOperationId, request }, assertCurrent);
    let response;
    try {
      response = await gatewayRequest('sessions.create', { agentId: 'main', label, idempotencyKey: logicalOperationId }, { requestId: input.requestId ?? logicalOperationId });
    } catch (error) {
      return unknown();
    }
    const key = response?.key;
    const sessionId = response?.sessionId;
    const revision = response?.entry?.updatedAt ?? response?.revision;
    if (typeof key !== 'string' || !key.trim() || typeof sessionId !== 'string' || !sessionId.trim() || !['number', 'string'].includes(typeof revision) || String(revision).trim() === '') {
      return unknown();
    }
    // Recording the already dispatched result preserves causal evidence even
    // when its request retired. This does not attach or authorize another effect.
    operation = metadata.observeTopicConversationCreation({ logicalOperationId, request, result: { key, sessionId, creationRevision: String(revision) } });
  }
  if (!operation.result?.nativeResult) return unknown();
  const nativeResult = operation.result.nativeResult;
  await readExact(nativeResult.key, nativeResult.sessionId);
  const assertPublication = () => {
    assertCurrent();
    // The public native getSessionEntry contract is synchronous. Read again
    // inside local completion, with no awaited callback holding a stale row.
    // This does not claim a transaction spanning native and plugin stores.
    const exact = adapter.sessionStore.getSessionEntry({ agentId: 'main', sessionKey: nativeResult.key, readConsistency: 'latest' });
    const primary = operation.intent.primary;
    const currentPrimary = operation.state === 'applied' ? null : adapter.sessionStore.getSessionEntry({ agentId: 'main', sessionKey: primary.locator?.locator ?? primary.reference.externalSourceId, readConsistency: 'latest' });
    if (!exact || exact.sessionId !== nativeResult.sessionId || operation.state !== 'applied' && currentPrimary?.sessionId !== primary.state.sessionId) throw sourceError('source-recovery', 'The exact Conversation or Primary generation changed before publication.');
    assertCurrent();
  };
  const result = metadata.completeTopicConversationCreation({ logicalOperationId, request }, assertPublication);
  return { schemaVersion: 1, status: 'applied', logicalOperationId, value: result };
}

function conversationAuthority(runtime) {
  const authority = runtime.creationAuthority;
  if (!authority || typeof authority.assertCurrent !== 'function') throw sourceError('capability-unavailable', 'Conversation creation requires current operator authority.');
  const principalId = nonBlank(authority.principalId, 'principalId');
  const checkAuthority = authority.assertCurrent;
  const assertCurrent = () => {
    if (authority.principalId !== principalId || runtime.creationAuthority !== authority || authority.assertCurrent !== checkAuthority) throw sourceError('conflict', 'Conversation creation operator changed.');
    checkAuthority.call(authority);
  };
  assertCurrent();
  return { principalId, assertCurrent };
}

export function inspectTopicConversation(adapter, input, runtime) {
  assertNoUnexpectedKeys(input, ['schemaVersion'], 'Conversation recovery inspection');
  const { principalId, assertCurrent } = conversationAuthority(runtime);
  return adapter.metadata.inspectTopicConversationCreation({ topicId: adapter.topicId, principalId }, assertCurrent);
}

export function reconcileTopicConversation(adapter, input, runtime) {
  assertNoUnexpectedKeys(input, ['schemaVersion', 'logicalOperationId'], 'Conversation reconciliation');
  const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
  const { principalId, assertCurrent } = conversationAuthority(runtime);
  const operation = adapter.metadata.readTopicConversationCreation({ topicId: adapter.topicId, principalId, logicalOperationId }, assertCurrent);
  return createTopicConversation(adapter, { logicalOperationId, expectedTopicRevision: operation.intent.request.expectedTopicRevision, label: operation.intent.request.label, isPrimary: false }, runtime, { existingOnly: true });
}

export function acknowledgeTopicConversation(adapter, input, runtime) {
  assertNoUnexpectedKeys(input, ['schemaVersion', 'logicalOperationId', 'referenceId'], 'Conversation acknowledgement');
  const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
  const referenceId = nonBlank(input.referenceId, 'referenceId');
  const { principalId, assertCurrent } = conversationAuthority(runtime);
  const access = { topicId: adapter.topicId, principalId, logicalOperationId };
  const operation = adapter.metadata.readTopicConversationCreation(access, assertCurrent);
  if (operation.state !== 'applied' || !operation.result?.nativeResult) throw sourceError('unknown', 'The Conversation outcome has not been proven applied.');
  const native = operation.result.nativeResult;
  const assertReceipt = () => {
    assertCurrent();
    const exact = adapter.sessionStore?.getSessionEntry?.({ agentId: 'main', sessionKey: native.key, readConsistency: 'latest' });
    if (!exact || exact.sessionId !== native.sessionId) throw sourceError('source-recovery', 'The exact created Conversation generation is unavailable.');
    assertCurrent();
  };
  return adapter.metadata.acknowledgeTopicConversationCreation({ ...access, referenceId }, assertReceipt);
}
