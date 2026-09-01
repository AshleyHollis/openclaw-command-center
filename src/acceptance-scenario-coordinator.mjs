export function createAcceptanceScenarioCoordinator({
  execute = async (_id, run) => run(),
  onProgress = () => {},
  normalizeFailure = (_id, error) => error
} = {}) {
  const evidence = new Map();
  const failures = [];

  const collect = async (id, run) => {
    let observedError;
    let result;
    onProgress({ id, status: 'started' });
    try {
      result = await execute(id, async () => {
        try { return await run(); }
        catch (error) { observedError = error; throw error; }
      });
    } catch (error) {
      observedError ??= error;
    }
    if (observedError === undefined && result !== undefined) evidence.set(id, result);
    const passed = observedError === undefined && evidence.has(id);
    onProgress({ id, status: passed ? 'passed' : 'failed' });
    if (!passed) {
      const error = observedError ?? new Error(`Scenario ${id} produced no completion evidence`);
      failures.push({ id, error: normalizeFailure(id, error) });
    }
    return passed;
  };

  const result = (id) => {
    if (!evidence.has(id)) throw new Error(`Scenario produced no completion evidence for ${id}`);
    return evidence.get(id);
  };

  return { collect, evidence, failures, result };
}

export async function runSettledAcceptanceBatch(items, { run, identify = (_item, index) => index } = {}) {
  if (!Array.isArray(items) || typeof run !== 'function') throw new TypeError('Acceptance batch requires items and a run function.');
  const outcomes = await Promise.all(items.map(async (item, index) => {
    try {
      return { ok: true, value: await run(item, index) };
    } catch (error) {
      return {
        ok: false,
        failure: {
          id: String(identify(item, index)).slice(0, 120),
          error: String(error?.message ?? error).slice(0, 300)
        }
      };
    }
  }));
  const failures = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.failure);
  if (failures.length > 0) {
    const error = new Error(`Acceptance mutation batch failed: ${JSON.stringify(failures)}`);
    error.failures = failures;
    throw error;
  }
  return outcomes.map((outcome) => outcome.value);
}
