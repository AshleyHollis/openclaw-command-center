export function clarificationInterpretationStatus(metadata, loop) {
  const id = loop?.attention?.pendingClarificationId;
  if (!id) return null;
  const disposition = metadata?.getClarificationWorkerDisposition?.(id);
  if (disposition?.status === 'review-required') return 'review-required';
  if (disposition?.status === 'failed') return 'processing-failed';
  const accepted = metadata?.getClarificationProposal?.(id);
  return accepted?.proposal?.outcome === 'ambiguous' ? 'review-required'
    : accepted?.proposal?.outcome === 'clear' ? 'proposal-saved' : 'pending';
}
