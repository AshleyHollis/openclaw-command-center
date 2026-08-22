import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import path from 'node:path';
import { chromium } from 'playwright';
import 'playwright-core';
import { finalizeAcceptanceJourney } from '../src/acceptance-finalization.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, observedBrowserResponseStatus, recordBounded } from '../src/browser-evidence.mjs';
import { build, assertBuiltDigest } from '../src/build.mjs';
import { withIsolatedWorld } from '../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, HarnessFailure, launchPinnedHost, parseHostDescriptor, redact, stopPinnedHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';
import { assertWebSocketDestination, boundedTrafficEvidence, TrafficGuard } from '../src/isolation.mjs';
import { runtimeCapability } from '../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';

function routeGrant(config) {
  const values = config?.[runtimeCapability.bootstrap.grantsField] || [];
  return Array.isArray(values) && values.some((value) => value?.pluginId === 'command-center' && value?.path === '/plugins/command-center');
}

function redactBrowserEvidence(value) {
  return redact(String(value).replace(/([?#&](?:token|password|secret|key)=)[^&#\s]+/gi, '$1[redacted]'), 300);
}

function boundedHostEvidence(diagnostics) {
  return {
    stdout: diagnostics.stdout,
    stderr: diagnostics.stderr,
    category: diagnostics.category,
    traffic: boundedTrafficEvidence(diagnostics.guard.attempts)
  };
}

async function mountedPluginFrame(page) {
  const iframe = page.locator('iframe.plugin-tab-embed__frame');
  await iframe.waitFor({ state: 'attached', timeout: 10_000 });
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame || new URL(frame.url()).pathname !== '/plugins/command-center') {
    throw new HarnessFailure('sandbox-mismatch', 'Command Center external tab did not create its mounted frame');
  }
  return { iframe, frame };
}

test('mounts the built plugin through the isolated authenticated external tab', { timeout: 110_000 }, async () => {
  const descriptor = parseHostDescriptor(); // Mandatory: never skip absent controller input.
  const buildReceipt = await build();
  await assertBuiltDigest(buildReceipt);
  await withIsolatedWorld(async (world) => {
    const host = await launchPinnedHost({ descriptor, world, buildReceipt });
    const gatewayUrl = world.gateway.url;
    assert.deepEqual(host.endpoint, world.gateway);
    assert.notEqual(world.gateway.port, 18789);
    assert.ok(host.child.pid, 'spawned host must own the isolated endpoint before probing it');
    const browserGuard = new TrafficGuard();
    const evidence = { console: [], errors: [], requests: [], responses: [], dom: '', bootstrapStatus: undefined, parentBootstrapBodyKeys: [], routeGrant: false, parentBootstrap: false, cookieProbe: false, cookieProbeStatus: undefined, frame: false, readinessAttempts: [] };
    let browser;
    let failure;
    try {
      try {
        await waitForConsecutiveReadiness(async () => {
          const observation = { attempt: evidence.readinessAttempts.length + 1, url: `${gatewayUrl}${runtimeCapability.bootstrap.path}`, status: undefined, error: undefined, bodyKeys: [] };
          try {
            host.diagnostics.guard.assert('127.0.0.1', 'harness bootstrap');
            const response = await fetch(observation.url, { headers: { authorization: `Bearer ${world.gatewayCredential}` } });
            observation.status = response.status;
            const body = await response.json().catch(() => undefined);
            observation.bodyKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : [];
            evidence.readinessAttempts.push(observation);
            return response.ok;
          } catch (error) { observation.error = String(error).slice(0, 300); evidence.readinessAttempts.push(observation); return false; }
        }, host.earlyExit, { attempts: 60, delayMs: 500 });
      } catch (error) {
        throw new HarnessFailure(error.category || 'readiness-flapping', `${error.message}; host stdout: ${host.diagnostics.stdout}; host stderr: ${host.diagnostics.stderr}`);
      }
      // The service receives the pinned host's resolved stateDir. Verify the
      // startup-created store is beneath this disposable fixture and that no
      // sibling Command Center storage was created.
      const resolvedStateDir = path.join(world.root, '.openclaw');
      const databasePath = resolveCommandCenterDatabasePath(resolvedStateDir);
      await access(databasePath);
      assert.deepEqual(await readdir(path.dirname(databasePath)), ['metadata.sqlite']);
      const startupDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(startupDatabase.prepare('PRAGMA user_version').get().user_version, 1);
        const sourceReferenceTopic = startupDatabase.prepare('PRAGMA foreign_key_list(source_references)').all()
          .find((foreignKey) => foreignKey.from === 'topic_id');
        assert.equal(sourceReferenceTopic?.on_delete, 'RESTRICT');
      } finally {
        startupDatabase.close();
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.route('**/*', async (route) => {
        const request = route.request();
        const hostName = new URL(request.url()).hostname;
        try { browserGuard.assert(hostName, 'browser'); recordBounded(evidence.requests, redactBrowserEvidence(request.url())); await route.continue(); }
        catch (error) {
          recordBounded(evidence.errors, redactBrowserEvidence(error.message));
          await route.abort();
        }
      });
      await page.routeWebSocket('**/*', (socket) => {
        try {
          assertWebSocketDestination(browserGuard, socket.url());
          socket.connectToServer();
        } catch (error) {
          // Omitting connectToServer rejects the socket before any remote I/O.
          recordBounded(evidence.errors, redactBrowserEvidence(error.message));
        }
      });
      page.on('console', (message) => recordBounded(evidence.console, redactBrowserEvidence(message.text())));
      page.on('pageerror', (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      page.on('response', (response) => recordBounded(evidence.responses, redactBrowserEvidence(`${response.status()} ${response.url()}`)));
      const parentBootstrap = observeBrowserResponse(
        page.waitForResponse((response) => new URL(response.url()).pathname === runtimeCapability.bootstrap.path, { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      const cookieProbe = observeBrowserResponse(
        page.waitForResponse((response) => new URL(response.url()).searchParams.has('__openclaw_plugin_frame_auth_probe'), { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      await page.goto(`${gatewayUrl}/__openclaw__/plugin?plugin=command-center&id=command-center#${runtimeCapability.authentication.urlFragmentParameter}=${encodeURIComponent(world.gatewayCredential)}`, { waitUntil: 'domcontentloaded' });
      const observedBootstrap = await parentBootstrap;
      evidence.parentBootstrap = observedBootstrap.observed;
      if (!evidence.parentBootstrap) throw new HarnessFailure('bootstrap-authentication-failure', 'Parent token-fragment authentication did not fetch the Control UI bootstrap response');
      evidence.bootstrapStatus = observedBootstrap.value.status();
      if (!observedBootstrap.value.ok()) throw new HarnessFailure('bootstrap-authentication-failure', 'Parent token-fragment authentication could not read the Control UI bootstrap response');
      const parentConfig = await observedBootstrap.value.json();
      evidence.parentBootstrapBodyKeys = parentConfig && typeof parentConfig === 'object' ? Object.keys(parentConfig).slice(0, 30) : [];
      evidence.routeGrant = routeGrant(parentConfig);
      if (!evidence.routeGrant) throw new HarnessFailure('missing-route-grant', 'The command-center route was not granted to the authenticated parent');
      const observedCookieProbe = await cookieProbe;
      evidence.cookieProbeStatus = observedBrowserResponseStatus(observedCookieProbe);
      evidence.cookieProbe = hasSuccessfulBrowserResponse(observedCookieProbe);
      if (!evidence.cookieProbe) throw new HarnessFailure('failed-cookie-probe', 'Sandbox cookie probe was not observed');
      const { iframe, frame } = await mountedPluginFrame(page);
      evidence.frame = true;
      const sandbox = await iframe.getAttribute('sandbox');
      if (sandbox !== 'allow-scripts') throw new HarnessFailure('sandbox-mismatch', 'External tab iframe is not scripts-only');
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const title = frame.getByRole('heading', { name: 'Command Center' });
        await assert.doesNotReject(title.waitFor());
        const box = await title.boundingBox();
        assert.ok(box && box.width <= width, `mounted shell overflows ${width}px`);
      }
      evidence.dom = redactBrowserEvidence((await frame.locator('body').innerText()).slice(0, 1000));
    } catch (error) {
      failure = error;
    }
    const finalizationErrors = await finalizeAcceptanceJourney({
      closeBrowser: async () => await browser?.close(),
      stopHost: async () => {
        await stopPinnedHost(host.child);
        await host.outputDrained;
      },
      // All traffic producers have stopped above. The final checks therefore
      // cover background work and fatal output completed during shutdown.
      assertBrowserTraffic: () => browserGuard.assertClean(),
      assertHostTraffic: () => {
        assertNoFatalHostOutput(host.diagnostics);
        host.diagnostics.guard.assertClean();
      },
      assertChildTraffic: async () => await assertRecordedChildTraffic(world),
      // Bind the digest to the completed desktop and narrow-viewport journey.
      assertBuildDigest: async () => await assertBuiltDigest(buildReceipt)
    });
    if (!failure && finalizationErrors.length > 0) {
      failure = finalizationErrors[0].error;
    }
    if (failure) {
      failure.diagnostics = {
        ...(failure.diagnostics || {}),
        ...evidence,
        host: boundedHostEvidence(host.diagnostics),
        finalizationErrors: finalizationErrors.map(({ phase, error }) => ({
          phase,
          error: redactBrowserEvidence(error?.message || error)
        }))
      };
      throw failure;
    }
  }, { candidateRoot: process.cwd() });
});
