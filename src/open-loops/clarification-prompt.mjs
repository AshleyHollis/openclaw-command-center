export function buildTargetedClarificationPrompt({ loopId, expectedRevision, clarificationObservationId }) {
  if (typeof loopId !== 'string' || !loopId.trim() || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || typeof clarificationObservationId !== 'string' || !clarificationObservationId.trim()) {
    throw new TypeError('An exact pending clarification identity is required.');
  }
  return [
    'Process exactly one already saved Command Center item clarification.',
    `Call command_center_get_pending_clarification with loopId ${JSON.stringify(loopId)} and expectedRevision ${expectedRevision}.`,
    `Continue only if status is pending and clarificationObservationId is ${JSON.stringify(clarificationObservationId)}.`,
    'Use only the returned userWords and acceptedObligation. Do not read the mailbox, Note body, other items or sibling outcomes. Do not infer a global preference.',
    'If the words clearly specify one supported decision or payment status, call command_center_interpret_clarification once with the same loopId, expectedRevision, clarificationObservationId and returned processorVersion. Preserve explicit dates and amounts; never invent them.',
    'Treat paid as an assertion from the user’s words, not verified payment evidence. Never send a message or make a payment.',
    'A saved interpretation can leave Reminder and supporting Note effects pending. Report that status exactly; do not claim they completed or retry the source.',
    'If the words are ambiguous, conflicting, hypothetical or insufficient, call command_center_interpret_clarification with outcome ambiguous and leave the item pending for user review.',
    'If the item or source is superseded, stop without retrying against a newer revision. Report only the tool disposition and item identity.'
  ].join('\n');
}
