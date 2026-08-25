import assert from 'node:assert/strict';
import test from 'node:test';
import { executeWithReconciliation, ReconciliationError } from '../src/attention/execution.mjs';

test('reconciliation allows one identical disclosed retry only after not-applied read-back', async () => {
  let dispatches = 0;
  const result = await executeWithReconciliation({
    attempt: { attemptId: 'attempt-1', retryCount: 0 },
    descriptor: { idempotency: { idempotent: true, transientRetryable: true } },
    dispatch: async ({ retry }) => { dispatches += 1; assert.equal(retry, dispatches === 2); if (dispatches === 1) throw Object.assign(new Error('timeout'), { ambiguous: true }); return { revision: 'revision-2' }; },
    reconcile: async ({ retry }) => retry ? { outcome: 'applied', value: { revision: 'revision-2' } } : { outcome: 'not-applied', transient: true }
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.retryCount, 1);
  assert.equal(dispatches, 2);
});

test('a permanent dispatch failure is not retried even when read-back proves not applied', async () => {
  let dispatches = 0;
  await assert.rejects(() => executeWithReconciliation({
    attempt: { attemptId: 'attempt-permanent', retryCount: 0 },
    descriptor: { idempotency: { idempotent: true, transientRetryable: true } },
    dispatch: async () => { dispatches += 1; throw Object.assign(new Error('validation failed'), { transient: false }); },
    reconcile: async () => ({ outcome: 'not-applied', transient: false })
  }), (error) => error instanceof ReconciliationError && error.outcome === 'not-applied');
  assert.equal(dispatches, 1);
});

test('ambiguous and partial outcomes never receive a blind retry', async () => {
  let dispatches = 0;
  let observations = 0;
  await assert.rejects(() => executeWithReconciliation({
    attempt: { attemptId: 'attempt-2', retryCount: 0 },
    descriptor: { idempotency: { idempotent: true, transientRetryable: true } },
    dispatch: async () => { dispatches += 1; throw new Error('timeout'); },
    reconcile: async () => { observations += 1; return { outcome: observations === 1 ? 'partial' : 'applied' }; }
  }), (error) => error instanceof ReconciliationError && error.outcome === 'partial');
  assert.equal(dispatches, 1);
  assert.equal(observations, 1);
});
