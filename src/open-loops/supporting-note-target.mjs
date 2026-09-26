const nonBlank = value => typeof value === 'string' && value.trim() !== '';
const captureKinds = new Set(['email', 'chat', 'note']);
const result = (status, extra = {}) => Object.freeze({ schemaVersion: 1, status, ...extra });

// Select from the loop's immutable capture evidence, never from a title, a
// nearby Topic Note, or a mutable email reader location. The Note owner still
// verifies the exact reference, path and revision before any filesystem write.
export function selectSupportingNoteTarget({ loop, observations, getSourceReference } = {}) {
  if (!loop || !Array.isArray(loop.evidenceObservationIds) || !Array.isArray(observations) || typeof getSourceReference !== 'function') {
    throw new TypeError('Supporting Note selection requires one loop, its evidence and a Source Reference reader.');
  }
  const evidenceIds = new Set(loop.evidenceObservationIds);
  const captures = observations.filter(item => evidenceIds.has(item?.observationId)
    && item?.source?.system === 'command-center-capture' && captureKinds.has(item.source.kind));
  if (!captures.length) return result('none');
  if (captures.some(item => !nonBlank(item.topicId) || item.topicId !== loop.topicId
    || !nonBlank(item.facts?.sourceReferenceId) || !nonBlank(item.facts?.sourcePath)
    || !nonBlank(item.facts?.sourceReferenceVersion) || !nonBlank(item.facts?.sourceVersion))) {
    return result('conflict', { reason: 'capture-note-identity-unavailable' });
  }
  const targetIds = new Set(captures.map(item => `${item.facts.sourceReferenceId}\u0000${item.facts.sourcePath}`));
  if (targetIds.size !== 1) return result('conflict', { reason: 'multiple-supporting-notes' });
  const latest = [...captures].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.observationId.localeCompare(right.observationId)).at(-1);
  const reference = getSourceReference(latest.facts.sourceReferenceId);
  if (!reference || reference.referenceId !== latest.facts.sourceReferenceId || reference.topicId !== loop.topicId
    || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note' || !nonBlank(reference.observedRevision)) {
    return result('conflict', { reason: 'supporting-note-reference-unavailable' });
  }
  return result('ready', { target: Object.freeze({ topicId: loop.topicId, referenceId: reference.referenceId,
    path: latest.facts.sourcePath, expectedRevision: reference.observedRevision,
    captureObservationId: latest.observationId, upstreamSourceVersion: latest.facts.sourceVersion,
    retainedNoteRevision: latest.facts.sourceReferenceVersion }) });
}
