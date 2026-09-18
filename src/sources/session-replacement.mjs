// A missing binding alone is never permission to omit authoritative content.
// Only an applied, exact replacement can leave a presentation-only former row.
export function explicitSessionReplacements(metadata, topicId) {
  const replacements = new Set();
  const recovery = new Map((metadata?.listSourceRecovery?.(topicId) ?? []).map((row) => [row.referenceId, row]));
  for (const operation of metadata?.listTopicOperations?.(topicId) ?? []) {
    const { intent, result } = operation;
    if (operation.state !== 'applied' || operation.operationKind !== 'topics.recovery.replace' || intent?.topicId !== topicId || result?.status !== 'replaced') continue;
    const reference = metadata.getSourceReference(intent.referenceId);
    const replacement = metadata.getSourceReference(result.replacementReferenceId);
    const state = metadata.getSessionState(intent.referenceId);
    if (reference?.topicId !== topicId || reference.sourceKind !== 'session' || reference.sourceSystem !== 'openclaw' || !state || state.isPrimary !== false) continue;
    if (replacement?.topicId !== topicId || replacement.sourceKind !== 'session' || replacement.sourceSystem !== 'openclaw' || replacement.referenceId === reference.referenceId) continue;
    if (recovery.get(reference.referenceId)?.state !== 'replaced') continue;
    replacements.add(reference.referenceId);
  }
  return replacements;
}

export function unavailableReplacedSession(metadata, reference, catalogRows, replacements) {
  if (!replacements.has(reference.referenceId)) return false;
  const state = metadata.getSessionState(reference.referenceId);
  const key = metadata.getSourceLocator?.(reference.referenceId)?.locator ?? reference.externalSourceId;
  return !catalogRows.some((row) => (row.key ?? row.sessionKey ?? row.session?.key) === key && (row.sessionId ?? row.id ?? row.entry?.sessionId ?? row.session?.sessionId) === state.sessionId);
}
