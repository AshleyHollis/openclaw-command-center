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
      result = await execute(id, async (signal) => {
        try { return await run(signal); }
        catch (error) { observedError = error; throw error; }
      });
    } catch (error) {
      observedError ??= error;
      if (error?.fatalAcceptanceCleanup === true) throw error;
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

export async function runSequentialAcceptanceBatch(items, { run, identify = (_item, index) => index, signal } = {}) {
  if (!Array.isArray(items) || typeof run !== 'function') throw new TypeError('Sequential acceptance batch requires items and a run function.');
  const results = [];
  for (const [index, item] of items.entries()) {
    try {
      signal?.throwIfAborted();
      results.push(await run(item, index, signal));
    }
    catch (error) {
      const failure = { id: String(identify(item, index)).slice(0, 120), error: String(error?.message ?? error).slice(0, 300) };
      const batchError = new Error(`Acceptance sequential mutation failed: ${JSON.stringify(failure)}`);
      batchError.failures = [failure];
      throw batchError;
    }
  }
  return results;
}

export async function requireBoundedMutationResponse(response, label, signal) {
  signal?.throwIfAborted();
  let body;
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) throw new Error(`${label} response exceeded 65536 bytes`);
        chunks.push(value);
      }
      const encoded = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.byteLength; }
      try { body = JSON.parse(new TextDecoder().decode(encoded)); } catch { body = undefined; }
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  } else body = await response.json().catch(() => undefined);
  const bodyKeys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).slice(0, 30) : [];
  const code = typeof body?.code === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(body.code) ? body.code : 'unavailable';
  if (!response.ok) throw new Error(`${label} failed with status ${response.status}; code=${code}; bodyKeys=${JSON.stringify(bodyKeys)}`);
  return { status: response.status, code, bodyKeys };
}

export async function runAbortableAcceptanceBoundary(run, { signal, onAbort = () => {} } = {}) {
  if (typeof run !== 'function' || typeof onAbort !== 'function') throw new TypeError('Abortable acceptance boundary requires run and onAbort functions.');
  signal?.throwIfAborted();
  const aborted = () => { onAbort(signal.reason); };
  signal?.addEventListener('abort', aborted, { once: true });
  try { return await run(signal); }
  finally { signal?.removeEventListener('abort', aborted); }
}

export async function runBoundedAcceptanceSlice(id, run, { timeoutMs = 240_000, cleanupTimeoutMs = 15_000 } = {}) {
  if (typeof id !== 'string' || !id || typeof run !== 'function') throw new TypeError('Bounded acceptance slice requires an id and run function.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 300_000) throw new TypeError('Acceptance slice timeout must remain below the controller inactivity timeout.');
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || timeoutMs + cleanupTimeoutMs >= 300_000) throw new TypeError('Acceptance slice execution plus cleanup must remain below the controller inactivity timeout.');
  const controller = new AbortController();
  const task = Promise.resolve().then(() => run(controller.signal));
  const deadline = Symbol('acceptance-slice-deadline');
  let timer;
  let outcome;
  try { outcome = await Promise.race([task, new Promise((resolve) => { timer = setTimeout(() => resolve(deadline), timeoutMs); })]); }
  finally { clearTimeout(timer); }
  if (outcome !== deadline) return outcome;
  controller.abort(new Error(`Acceptance slice ${id} exceeded its ${timeoutMs} ms deadline`));
  const cleanupDeadline = Symbol('acceptance-slice-cleanup-deadline');
  let cleanupTimer;
  const cleanup = await Promise.race([task.then(() => true, () => true), new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(cleanupDeadline), cleanupTimeoutMs); })]);
  clearTimeout(cleanupTimer);
  if (cleanup === cleanupDeadline) {
    const error = new Error(`Acceptance slice ${id} did not settle within ${cleanupTimeoutMs} ms after cancellation`);
    error.fatalAcceptanceCleanup = true;
    throw error;
  }
  throw controller.signal.reason;
}

export async function runIsolatedAcceptanceSlices(slices, { maxConcurrency = 2, timeoutMs = 240_000, cleanupTimeoutMs = 15_000, onProgress = () => {} } = {}) {
  if (!Array.isArray(slices) || slices.some((slice) => typeof slice?.id !== 'string' || typeof slice?.run !== 'function')) throw new TypeError('Isolated acceptance slices require closed id/run entries.');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 2) throw new TypeError('Isolated acceptance slices support at most two lanes.');
  const results = new Map();
  const failures = [];
  let next = 0;
  let fatalCleanup = false;
  const worker = async (lane) => {
    while (!fatalCleanup && next < slices.length) {
      const slice = slices[next++];
      onProgress({ id: slice.id, lane, status: 'started' });
      try {
        const evidence = await runBoundedAcceptanceSlice(slice.id, slice.run, { timeoutMs, cleanupTimeoutMs });
        results.set(slice.id, evidence);
        onProgress({ id: slice.id, lane, status: 'passed' });
      } catch (error) {
        failures.push({ id: slice.id, error });
        onProgress({ id: slice.id, lane, status: 'failed' });
        if (error?.fatalAcceptanceCleanup === true) fatalCleanup = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, slices.length) }, (_, lane) => worker(lane)));
  return Object.freeze({ results, failures: Object.freeze(failures) });
}
