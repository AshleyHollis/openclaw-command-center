import { sourceError } from '../sources/errors.mjs';

const fail = message => { throw sourceError('invalid-request', message); };
const text = (value, field, maximum = 300) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum) fail(`${field} must be an exact nonblank string.`);
  return value;
};
export function normalizePaymentIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'amountMinorUnits', 'currency', 'invoiceId', 'accountId', 'payeeId', 'purpose', 'predecessor'].includes(key))) fail('paymentIdentity is invalid.');
  const result = { schemaVersion: 1 };
  if ((value.amountMinorUnits === undefined) !== (value.currency === undefined)) fail('Payment amount and currency must be provided together.');
  if (value.amountMinorUnits !== undefined) {
    if (!Number.isSafeInteger(value.amountMinorUnits) || value.amountMinorUnits < 0 || typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) fail('Payment minor units or uppercase three-letter currency identifier are invalid.');
    result.amountMinorUnits = value.amountMinorUnits; result.currency = value.currency;
  }
  for (const key of ['invoiceId', 'accountId', 'payeeId', 'purpose']) if (value[key] !== undefined) result[key] = text(value[key], key);
  if (value.predecessor !== undefined) {
    const relation = value.predecessor;
    if (!relation || typeof relation !== 'object' || Array.isArray(relation) || Object.keys(relation).some(key => !['loopId', 'observationId', 'explanation'].includes(key))) fail('Payment predecessor is invalid.');
    result.predecessor = Object.freeze({ loopId: text(relation.loopId, 'predecessor.loopId'), observationId: text(relation.observationId, 'predecessor.observationId'), explanation: text(relation.explanation, 'predecessor.explanation', 1000) });
  }
  return Object.freeze(result);
}

// Resolve literal accepted identities only. Reading their evidence remains the caller's authority boundary.
export function resolvePaymentPredecessor({ metadata, loadAccount, relation, actionLoopId, semanticKey }) {
  const loop = metadata.getOpenLoop(relation.loopId), observation = metadata.getOpenLoopObservation(relation.observationId);
  const unavailable = () => { throw sourceError('unavailable', 'The exact accepted payment predecessor is unavailable.'); };
  if (!loop || loop.loopId === actionLoopId || loop.kind !== 'payment' || loop.state !== 'confirmed' || !loop.evidenceObservationIds.includes(relation.observationId) || !observation || observation.source.system !== 'command-center-capture' || observation.source.kind !== 'email' || observation.historicalBaseline || observation.facts.provenance !== 'explicit' || observation.facts.obligationKind !== 'payment') unavailable();
  const account = loadAccount(metadata, { sourceKind: 'email', sourceExternalId: observation.source.externalId, sourceVersion: observation.facts.sourceVersion });
  const obligation = account?.plan.acceptedExtraction.obligations.find(item => item.obligationId === observation.facts.obligationId);
  const outcome = account?.account.outcomes.find(item => item.outcomeId === observation.facts.obligationId);
  if (obligation?.classification !== 'obligation' || obligation.obligationKind !== 'payment' || obligation.provenance !== 'explicit' || outcome?.status !== 'applied' || outcome.loopId !== loop.loopId) unavailable();
  const facts = observation.facts;
  const predecessorKey = facts.correlationId ? JSON.stringify([facts.correlationNamespace, facts.correlationId]) : JSON.stringify([observation.source.externalId, facts.obligationId]);
  if (predecessorKey === semanticKey) throw sourceError('conflict', 'A new requested action must have a distinct accepted correlation.');
  const reference = metadata.getSourceReference(facts.sourceReferenceId ?? '');
  if (!facts.sourceReferenceId || !facts.sourcePath || !facts.sourceReferenceVersion || reference?.topicId !== loop.topicId || reference.sourceKind !== 'note' || reference.observedRevision !== facts.sourceReferenceVersion) unavailable();
  return { loop, observation, obligation, semanticKey: predecessorKey };
}
