import { assertNoUnexpectedKeys, nonBlank, sourceError } from './errors.mjs';
import { assertLogicalOperationId } from './operation-journal.mjs';
import { effectiveSourceLocator } from './reference.mjs';

/** Explicit presentation setup; neither category names nor membership confer Topic ownership. */
export async function previewTopicSessionGroup(adapter) {
  const topic = adapter.metadata.getTopic(adapter.topicId);
  if (!topic || topic.lifecycle !== 'active' || topic.paraCategory === 'archive') throw sourceError('read-only', 'Only active Topics can be organized.');
  const members = [];
  for (const reference of adapter.references()) {
    const { state, exact } = await adapter.resolveStableState(reference.referenceId);
    if (state.status !== 'open') continue;
    const row = exact.row;
    members.push({ referenceId: reference.referenceId, sessionId: exact.sessionId,
      lifecycleRevision: row.lifecycleRevision ?? null, grouped: row.category != null,
      label: state.displayName, eligible: row.category == null && typeof row.lifecycleRevision === 'string' });
  }
  if (adapter.metadata.getTopic(adapter.topicId)?.revision !== topic.revision) throw sourceError('conflict', 'The Topic changed during group preparation.');
  return { schemaVersion: 1, topicId: topic.topicId, name: topic.name, revision: topic.revision, members };
}

export async function groupTopicSession(adapter, input, runtime) {
  assertNoUnexpectedKeys(input, ['schemaVersion', 'requestId', 'logicalOperationId', 'referenceId', 'expectedSessionId', 'expectedLifecycleRevision', 'expectedTopicRevision', 'name'], 'Topic Session group command');
  const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
  const authority = runtime.creationAuthority;
  if (!authority || typeof authority.assertCurrent !== 'function' || !adapter.sessionStore?.patchSessionEntry) throw sourceError('capability-unavailable', 'Authenticated conditional Session grouping is unavailable.');
  const principalId = nonBlank(authority.principalId, 'principalId');
  const expectedSessionId = nonBlank(input.expectedSessionId, 'expectedSessionId');
  const expectedLifecycleRevision = nonBlank(input.expectedLifecycleRevision, 'expectedLifecycleRevision');
  const name = nonBlank(input.name, 'name');
  if (!Number.isSafeInteger(input.expectedTopicRevision) || input.expectedTopicRevision < 0) throw sourceError('invalid-request', 'The original Topic revision is required.');
  const reference = adapter.resolveReference(input);
  const sessionKey = effectiveSourceLocator(adapter.metadata, reference);
  const agent = /^agent:([^:]+):.+$/u.exec(sessionKey);
  if (!agent) throw sourceError('source-recovery', 'The exact native Session locator is unavailable.');
  const assertAuthority = () => {
    if (runtime.creationAuthority !== authority || authority.principalId !== principalId) throw sourceError('unauthenticated', 'The original grouping authority changed.');
    authority.assertCurrent();
  };
  const assertCurrent = () => {
    assertAuthority();
    const topic = adapter.metadata.getTopic(adapter.topicId);
    const currentReference = adapter.resolveReference(input);
    const state = adapter.metadata.getSessionState(reference.referenceId);
    if (adapter.metadata.listSourceRecovery(adapter.topicId).some(item => item.sourceKind === 'session' && item.state === 'required')) throw sourceError('source-recovery', 'Resolve Session recovery before organizing Conversations.');
    if (topic?.revision !== input.expectedTopicRevision || topic.name !== name || topic.lifecycle !== 'active' || topic.paraCategory === 'archive' || state?.sessionId !== expectedSessionId || state.status !== 'open' || effectiveSourceLocator(adapter.metadata, currentReference) !== sessionKey) throw sourceError('conflict', 'The original Topic or Conversation binding changed.');
  };
  assertCurrent();
  const value = { id: reference.referenceId, referenceId: reference.referenceId, topicId: adapter.topicId, sessionId: expectedSessionId, name };
  // The journal proves a witnessed operation, not today's category. An interrupted
  // native write has no causal receipt; stop as unknown rather than reclaim a group.
  const receipt = await adapter.coordinator.mutate({ operationKind: 'sessions.group', requestId: input.requestId ?? logicalOperationId,
    logicalOperationId, topicId: adapter.topicId, referenceId: reference.referenceId,
    intent: { principalId, sessionKey, expectedSessionId, expectedLifecycleRevision, expectedCategory: null, expectedTopicRevision: input.expectedTopicRevision, name },
    execute: async () => {
      assertCurrent();
      const result = await adapter.sessionStore.patchSessionEntry({ agentId: agent[1], sessionKey, preserveActivity: true,
        assertCommitAllowed: assertCurrent,
        update(entry) {
          assertCurrent();
          if (entry.sessionId !== expectedSessionId || entry.lifecycleRevision !== expectedLifecycleRevision || entry.category != null) throw sourceError('conflict', 'The native Conversation changed or was already grouped.');
          return { category: name };
        } });
      if (result?.sessionId !== expectedSessionId || result.lifecycleRevision !== expectedLifecycleRevision || result.category !== name) throw sourceError('delivery-unknown', 'Native grouping returned no exact receipt. Inspect the native group before proceeding.');
      return value;
    },
    reconcile: ({ applied, resultIdentity }) => applied && resultIdentity === reference.referenceId ? { matched: true, value } : { outcome: 'unknown' }
  });
  // Persist the witnessed effect even if access retired while its reply was
  // pending. Publication (including receipt replay) still needs current access.
  assertAuthority();
  return receipt;
}
