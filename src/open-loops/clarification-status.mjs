export function clarificationInterpretationStatus(metadata, loop) {
  const id = loop?.attention?.pendingClarificationId;
  if (!id) return null;
  const accepted = metadata?.getClarificationProposal?.(id);
  return accepted?.proposal?.outcome === 'ambiguous' ? 'review-required'
    : accepted?.proposal?.outcome === 'clear' ? 'proposal-saved' : 'pending';
}
