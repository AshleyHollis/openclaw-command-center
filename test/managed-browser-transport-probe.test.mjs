import assert from 'node:assert/strict';
import test from 'node:test';

// Run only as a focused worker probe. This makes no Gateway request and does
// not diagnose which internal launchServer/connect operation failed.
test('managed Chromium transport contrast', async t => {
  const transportVariable = 'COMMAND_CENTER_BROWSER_TRANSPORT';
  const originalTransport = process.env[transportVariable];
  let launchManagedBrowser;
  let closeManagedBrowser;
  const outcomes = [];

  try {
    try {
      ({ launchManagedBrowser, closeManagedBrowser } = await import('./support/real-host-runtime.mjs'));
    } catch {
      // A missing dependency is not evidence about either browser transport.
      outcomes.push('default-unavailable', 'direct-unavailable');
    }

    if (launchManagedBrowser && closeManagedBrowser) {
      for (const transport of ['default', 'direct']) {
        if (transport === 'default') delete process.env[transportVariable];
        else process.env[transportVariable] = 'direct';
        let managed;
        let outcome = `${transport}-ready`;
        try {
          managed = await launchManagedBrowser({
            executablePath: '/usr/bin/chromium', headless: true, timeout: 60_000
          });
        } catch {
          outcome = `${transport}-failed`;
        } finally {
          if (managed) {
            try { await closeManagedBrowser(managed); }
            catch { outcome = `${transport}-close-failed`; }
          }
        }
        outcomes.push(outcome);
      }
    }
  } finally {
    if (originalTransport === undefined) delete process.env[transportVariable];
    else process.env[transportVariable] = originalTransport;
  }

  // Assert only closed outcomes after both attempts; no caught exception,
  // browser endpoint, process output or environment value enters TAP.
  for (const [index, transport] of ['default', 'direct'].entries()) {
    await t.test(`${transport} transport: ${outcomes[index]}`, () => {
      assert.equal(outcomes[index], `${transport}-ready`);
    });
  }
});
