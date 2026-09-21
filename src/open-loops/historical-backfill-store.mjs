import { createHash } from 'node:crypto';

/**
 * Durable checkpoint adapter for historical backfill. The metadata owner uses
 * a compare-and-swap sequence so two runners cannot both advance one plan.
 */
export function createHistoricalBackfillStore({ metadata } = {}) {
  if (!metadata?.getHistoricalBackfillState || !metadata?.saveHistoricalBackfillState || !metadata?.recordOperation) throw new TypeError('Historical backfill storage requires metadata ownership.');
  const sequences = new Map();

  const load = async ({ stateKey }) => {
    const saved = metadata.getHistoricalBackfillState(stateKey);
    sequences.set(stateKey, saved?.sequence ?? 0);
    return saved?.state ?? null;
  };

  const save = async ({ stateKey, state }) => {
    if (!sequences.has(stateKey)) throw Object.assign(new Error('backfill-state-not-loaded'), { code: 'backfill-state-not-loaded' });
    const saved = metadata.saveHistoricalBackfillState({
      stateKey,
      expectedSequence: sequences.get(stateKey),
      state,
      updatedAt: state.updatedAt
    });
    sequences.set(stateKey, saved.sequence);
  };

  const recordReceipt = async (receipt, { assertCurrent = () => {} } = {}) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.backfillId !== 'string' || typeof receipt.mode !== 'string' || typeof receipt.status !== 'string' || !Number.isFinite(Date.parse(receipt.observedAt))) throw new TypeError('Historical backfill receipt is invalid.');
    const identity = { owner: 'historical-backfill.receipt.v1', backfillId: receipt.backfillId, mode: receipt.mode };
    const identityText = JSON.stringify(identity);
    const intentDigest = `sha256:${createHash('sha256').update(identityText).digest('hex')}`;
    const logicalOperationId = `historical-backfill-receipt:${createHash('sha256').update(identityText).digest('hex')}`;
    assertCurrent();
    metadata.recordOperation({
      logicalOperationId, transportRequestId: logicalOperationId, intentDigest, operationKind: 'historical-backfill.receipt.v1',
      state: receipt.status === 'failed' ? 'not-applied' : 'applied', resultStatus: receipt.status,
      resultIdentity: JSON.stringify(receipt), observedRevision: `${receipt.status}:${receipt.counts?.read ?? receipt.counts?.withdrawn ?? 0}`,
      createdAt: metadata.getOperation?.(logicalOperationId)?.createdAt ?? receipt.observedAt, updatedAt: receipt.observedAt
    });
  };

  return Object.freeze({
    loadState: load,
    saveState: save,
    loadWithdrawalState: load,
    saveWithdrawalState: save,
    recordReceipt
  });
}
