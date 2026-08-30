export const RECONCILIATION_OUTCOMES = Object.freeze(['applied', 'not-applied', 'partial', 'conflict', 'unknown']);

export class ReconciliationError extends Error {
  constructor(outcome, message = `Action delivery is ${outcome}.`, details = {}) { super(message); this.name = 'ReconciliationError'; this.code = outcome; this.outcome = outcome; Object.assign(this, details); }
}

function outcomeOf(value) {
  const outcome = value?.outcome ?? (value?.matched === true ? 'applied' : value?.matched === false ? 'not-applied' : null);
  return RECONCILIATION_OUTCOMES.includes(outcome) ? outcome : 'unknown';
}

export async function executeWithReconciliation({ attempt, descriptor, dispatch, reconcile, reconcileFirst = false, beforeRetry = null }) {
  if (!attempt || typeof dispatch !== 'function' || typeof reconcile !== 'function') throw new TypeError('attempt, dispatch, and reconcile are required');
  const disclosedRetry = descriptor?.idempotency?.idempotent === true && descriptor?.idempotency?.transientRetryable === true;
  let retryCount = attempt.retryCount ?? 0;
  async function observe(error, result, retry) {
    const observation = await reconcile({ attempt, error: error ?? null, result: result ?? null, retry });
    const outcome = outcomeOf(observation);
    return { ...observation, outcome };
  }
  async function retryAfterNotApplied(cause, observation) {
    if (!disclosedRetry || observation?.transient !== true || retryCount >= 1) throw new ReconciliationError('not-applied', 'The action was proven not applied and no disclosed transient retry is available.', { cause });
    if (beforeRetry) await beforeRetry();
    retryCount += 1;
    let retryResult;
    try {
      retryResult = await dispatch({ attempt: { ...attempt, retryCount }, retry: true });
    } catch (error) {
      const observation = await observe(error, retryResult, true);
      if (observation.outcome === 'applied') return { status: 'applied', result: observation.value ?? retryResult, observation, retryCount };
      throw new ReconciliationError(observation.outcome, 'The disclosed retry remains unresolved.', { cause: error });
    }
    const retryObservation = await observe(null, retryResult, true);
    if (retryObservation.outcome !== 'applied') throw new ReconciliationError(retryObservation.outcome, 'The disclosed retry did not reach a verified applied state.');
    return { status: 'applied', result: retryResult, observation: retryObservation, retryCount };
  }
  if (reconcileFirst) {
    const observation = await observe(null, null, false);
    if (observation.outcome === 'applied') return { status: 'applied', result: observation.value ?? null, observation, retryCount };
    if (observation.outcome !== 'not-applied') throw new ReconciliationError(observation.outcome, 'Persisted action delivery requires operator reconciliation.');
    return retryAfterNotApplied(null, observation);
  }
  let result;
  let dispatchError = null;
  try {
    result = await dispatch({ attempt, retry: false });
  } catch (error) {
    dispatchError = error;
  }
  const observation = await observe(dispatchError, result, false);
  if (observation.outcome === 'applied') return { status: 'applied', result: observation.value ?? result, observation, retryCount };
  if (observation.outcome !== 'not-applied') throw new ReconciliationError(observation.outcome, 'Action delivery requires operator reconciliation.', { cause: dispatchError });
  return retryAfterNotApplied(dispatchError, observation);
}
