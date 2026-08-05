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
  assertBuildDigest
}) {
  const phases = [
    ['browser-close', closeBrowser],
    ['host-stop', stopHost],
    ['browser-traffic', assertBrowserTraffic],
    ['host-traffic', assertHostTraffic],
    ['child-traffic', assertChildTraffic],
    ['build-digest', assertBuildDigest]
  ];
  const errors = [];
  for (const [phase, run] of phases) {
    try {
      await run();
    } catch (error) {
      errors.push(Object.freeze({ phase, error }));
    }
  }
  return Object.freeze(errors);
}
