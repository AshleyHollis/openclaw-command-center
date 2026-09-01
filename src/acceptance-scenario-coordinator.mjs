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
