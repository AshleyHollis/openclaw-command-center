/**
 * Finish an acceptance journey in a fixed order. Transport guards are only
 * authoritative after their producers have stopped, so all shutdown work
 * precedes every final traffic and build assertion. Continue after failures to
 * retain complete diagnostics for the test receipt.
 */
export async function finalizeAcceptanceJourney({
  closeBrowser,
  stopHost,
  assertBrowserTraffic,
  assertHostTraffic,
  assertChildTraffic,
  assertBuildDigest,
  timeoutMs = 60_000,
  onProgress
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Acceptance finalization timeout must be between 1 and 300000 ms.');
  const phases = [
    ['browser-close', closeBrowser],
    ['host-stop', stopHost],
    ['browser-traffic', assertBrowserTraffic],
    ['host-traffic', assertHostTraffic],
    ['child-traffic', assertChildTraffic],
    ['build-digest', assertBuildDigest]
  ];
  const errors = [];
  let shutdownFailed = false;
  for (const [phase, run] of phases) {
    onProgress?.(Object.freeze({ phase, status: 'started' }));
    if (shutdownFailed && ['browser-traffic', 'host-traffic', 'child-traffic'].includes(phase)) {
      errors.push(Object.freeze({ phase, error: new Error(`Acceptance finalization ${phase} is not authoritative because shutdown did not complete.`) }));
      onProgress?.(Object.freeze({ phase, status: 'failed' }));
      continue;
    }
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => run(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Acceptance finalization ${phase} exceeded its ${timeoutMs} ms deadline`)); }, timeoutMs); })
      ]);
      onProgress?.(Object.freeze({ phase, status: 'passed' }));
    } catch (error) {
      errors.push(Object.freeze({ phase, error }));
      if (phase === 'browser-close' || phase === 'host-stop') shutdownFailed = true;
      onProgress?.(Object.freeze({ phase, status: 'failed' }));
    } finally { clearTimeout(timer); }
  }
  return Object.freeze(errors);
}
