/**
 * Durable checkpoint adapter for historical backfill. The metadata owner uses
 * a compare-and-swap sequence so two runners cannot both advance one plan.
 */
export function createHistoricalBackfillStore({ metadata } = {}) {
  if (!metadata?.getHistoricalBackfillState || !metadata?.saveHistoricalBackfillState) throw new TypeError('Historical backfill storage requires metadata ownership.');
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

  return Object.freeze({
    loadState: load,
    saveState: save,
    loadWithdrawalState: load,
    saveWithdrawalState: save
  });
}
