import { createHash } from 'node:crypto';
import { loadIntakeSourceAccount, projectIntakeAccounts } from './intake-accounting.mjs';
import { sourceError } from '../sources/errors.mjs';

const captureKinds = new Set(['email', 'chat', 'note']);

export function clarificationInterpretationOperationId(clarificationObservationId) {
  if (typeof clarificationObservationId !== 'string' || !clarificationObservationId.trim())
    throw sourceError('invalid-request', 'A saved clarification identity is required.');
  const digest = createHash('sha256').update('command-center-targeted-interpretation:v1\0').update(clarificationObservationId).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

// A pending clarification is the durable queue marker. Resolve its source from
// the capture evidence instead of trusting a caller-supplied source identity.
export function loadPendingClarificationContext(metadata, { loopId, expectedRevision }) {
  if (typeof loopId !== 'string' || !loopId.trim() || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw sourceError('invalid-request', 'An exact loop and revision are required.');
  }
  const loop = metadata.getOpenLoop(loopId);
  if (!loop) return Object.freeze({ status: 'not-found' });
  if (loop.revision !== expectedRevision) return Object.freeze({ status: 'superseded', loopRevision: loop.revision });
  const clarificationId = loop.attention?.pendingClarificationId;
  if (!clarificationId || !loop.evidenceObservationIds.includes(clarificationId)) return Object.freeze({ status: 'not-pending' });
  const clarification = metadata.getOpenLoopObservation(clarificationId);
  if (clarification?.source?.system !== 'command-center' || clarification.source.kind !== 'user-clarification'
    || clarification.facts?.eventKind !== 'clarification-submitted' || typeof clarification.facts.rationale !== 'string') {
    return Object.freeze({ status: 'evidence-unavailable' });
  }
  const candidates = loop.evidenceObservationIds.map(id => metadata.getOpenLoopObservation(id)).filter(observation =>
    observation?.source?.system === 'command-center-capture' && captureKinds.has(observation.source.kind)
    && typeof observation.facts?.sourceVersion === 'string' && typeof observation.facts?.obligationId === 'string');
  if (candidates.length !== 1) return Object.freeze({ status: 'review-required', reason: 'source-identity-ambiguous' });
  const capture = candidates[0];
  const source = { sourceKind: capture.source.kind, sourceExternalId: capture.source.externalId, sourceVersion: capture.facts.sourceVersion };
  const accepted = loadIntakeSourceAccount(metadata, source);
  const outcomeId = capture.facts.obligationId;
  const outcome = accepted?.account?.outcomes?.find(item => item.outcomeId === outcomeId);
  const obligation = accepted?.plan?.acceptedExtraction?.obligations?.find(item => item.obligationId === outcomeId);
  if (!accepted || !outcome || outcome.loopId !== loopId || !obligation ||
    !accepted.plan.outcomes.some(item => item.outcomeId === outcomeId && ['obligation', 'decision'].includes(item.kind))) {
    return Object.freeze({ status: 'review-required', reason: 'accepted-outcome-unavailable' });
  }
  const later = projectIntakeAccounts(metadata, source.sourceKind).some(item =>
    item.sourceExternalId === source.sourceExternalId && item.sourceVersion !== source.sourceVersion
    && Date.parse(item.observedAt) >= Date.parse(accepted.plan.observedAt));
  if (later) return Object.freeze({ status: 'review-required', reason: 'source-revision-changed' });
  const acceptedObligation = Object.freeze(Object.fromEntries([
    'obligationId', 'title', 'classification', 'obligationKind', 'provenance',
    'dueAt', 'reviewAt', 'plannedAt'
  ].filter(key => obligation[key] !== undefined).map(key => [key, obligation[key]])));
  return Object.freeze({
    status: 'pending', loopId, expectedRevision, clarificationObservationId: clarificationId,
    userWords: clarification.facts.rationale, source, outcomeId,
    processorVersion: accepted.plan.processorVersion,
    ...(accepted.plan.retainedNoteRevision ? { retainedNoteRevision: accepted.plan.retainedNoteRevision } : {}),
    acceptedObligation
  });
}
