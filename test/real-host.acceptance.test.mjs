import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
import { importedProvenance } from '../src/migration/transcript.mjs';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isControlUiBootstrapUrl } from '../src/acceptance-readiness.mjs';

function routeGrant(config) {
  const values = config?.[runtimeCapability.bootstrap.grantsField] || [];
  return Array.isArray(values) && values.some((value) => value?.pluginId === 'command-center' && value?.path === '/plugins/command-center' && value?.match === 'exact');
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

async function waitForMigrationCompletion(databasePath, { attempts = 100, delayMs = 100 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const completion = database.prepare('SELECT * FROM migration_completion WHERE completion_id = ?').get('legacy-discord-v1');
      const binding = completion ? database.prepare(`SELECT reference.external_source_id AS sessionKey, state.session_id AS sessionId
        FROM source_references AS reference JOIN session_state AS state ON state.reference_id = reference.reference_id
        WHERE reference.topic_id = ? AND reference.source_system = 'openclaw' AND reference.source_kind = 'session' AND state.is_primary = 1 AND state.status = 'open'`).get('fictional-topic-alpha') : null;
      if (completion && binding) return { completion, binding };
    } finally { database.close(); }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new HarnessFailure('migration-incomplete', 'Pinned-host startup did not durably complete the configured legacy migration');
}

async function readAuthenticatedHistory({ gatewayUrl, credential, sessionKey }) {
  const socket = new WebSocket(gatewayUrl.replace(/^http/u, 'ws'));
  const frames = [];
  const waitForFrame = (predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const inspect = (frame) => { if (predicate(frame)) { cleanup(); resolve(frame); return true; } return false; };
    const onMessage = (event) => { let frame; try { frame = JSON.parse(String(event.data)); } catch { return; } frames.push(frame); inspect(frame); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Authenticated Gateway response timed out.')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener('message', onMessage); };
    for (const frame of frames) if (inspect(frame)) return;
    socket.addEventListener('message', onMessage);
  });
  try {
    const challengePromise = waitForFrame((frame) => frame?.type === 'event' && frame.event === 'connect.challenge');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Authenticated Gateway connection timed out.')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Authenticated Gateway connection failed.')); }, { once: true });
    });
    const challenge = await challengePromise;
    assert.equal(typeof challenge.payload?.nonce, 'string');
    const connectId = 'command-center-acceptance-connect';
    socket.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: { id: 'cli', version: '1', platform: 'test', mode: 'cli' }, caps: [], commands: [], role: 'operator', scopes: ['operator.read'], auth: { ['to' + 'ken']: credential } } }));
    const connected = await waitForFrame((frame) => frame?.type === 'res' && frame.id === connectId);
    if (!connected.ok) throw new Error(`Authenticated Gateway connect failed: ${connected.error?.code ?? 'unknown'}`);
    const historyId = 'command-center-acceptance-history';
    socket.send(JSON.stringify({ type: 'req', id: historyId, method: 'chat.history', params: { sessionKey } }));
    const response = await waitForFrame((frame) => frame?.type === 'res' && frame.id === historyId);
    if (!response.ok) throw new Error(`Authenticated chat.history failed: ${response.error?.code ?? 'unknown'}`);
    return response.payload;
  } finally { socket.close(); }
}

test('mounts the built plugin through the isolated authenticated external tab', { timeout: 110_000 }, async (testContext) => {
  const descriptor = parseHostDescriptor(); // Mandatory: never skip absent controller input.
  const buildReceipt = await build();
  await assertBuiltDigest(buildReceipt);
  await withIsolatedWorld(async (world) => {
    const migrationExportPath = path.join(world.tempRoot, 'legacy-discord-export.v1.json');
    const migrationFolderPath = path.join(world.paths.vault, 'fictional-alpha');
    await mkdir(migrationFolderPath, { recursive: true });
    const migrationExport = JSON.parse(await readFile(new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
    await writeFile(migrationExportPath, `${JSON.stringify(migrationExport)}\n`);
    const configured = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    configured.plugins.entries[world.manifest.candidate.id].config = {
      legacyDiscordMigration: {
        schemaVersion: 1,
        exportPath: migrationExportPath,
        channels: [{ channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-alpha', paraCategory: 'project', noteFolderPath: migrationFolderPath }]
      }
    };
    await writeFile(world.manifest.configPath, `${JSON.stringify(configured)}\n`);
    const host = await launchPinnedHost({ descriptor, world, buildReceipt });
    const gatewayUrl = world.gateway.url;
    const resolvedStateDir = path.join(world.root, '.openclaw');
    const databasePath = resolveCommandCenterDatabasePath(resolvedStateDir);
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
            return response.ok && isCommandCenterMetadataReady(databasePath);
          } catch (error) { observation.error = String(error).slice(0, 300); evidence.readinessAttempts.push(observation); return false; }
        }, host.earlyExit, { attempts: 60, delayMs: 500 });
      } catch (error) {
        throw new HarnessFailure(error.category || 'readiness-flapping', `${error.message}; host stdout: ${host.diagnostics.stdout}; host stderr: ${host.diagnostics.stderr}`);
      }
      // The service receives the pinned host's resolved stateDir. Verify the
      // startup-created store is beneath this disposable fixture and that no
      // sibling Command Center storage was created.
      await access(databasePath);
      const { completion, binding } = await waitForMigrationCompletion(databasePath);
      assert.equal(completion.verified_channel_count, 1);
      assert.equal(completion.verified_occurrence_count, migrationExport.channels[0].messages.length);
      host.diagnostics.guard.assert('127.0.0.1', 'authenticated chat.history verification');
      const history = await readAuthenticatedHistory({ gatewayUrl, credential: world.gatewayCredential, sessionKey: binding.sessionKey });
      assert.equal(history.sessionId ?? history.session?.sessionId ?? binding.sessionId, binding.sessionId);
      const imported = (history.messages ?? []).filter((message) => message?.__openclaw?.legacyDiscordV1?.immutable === true);
      assert.equal(imported.length, migrationExport.channels[0].messages.length);
      for (const [index, occurrence] of migrationExport.channels[0].messages.entries()) {
        assert.equal(imported[index].text, occurrence.text);
        assert.deepEqual(imported[index].__openclaw.legacyDiscordV1, importedProvenance(migrationExport.channels[0].channelId, occurrence));
      }
      assert.deepEqual(await readdir(path.dirname(databasePath)), ['metadata.sqlite']);
      const startupDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(startupDatabase.prepare('PRAGMA user_version').get().user_version, 5);
        for (const table of ['operation_journal', 'session_state', 'activity_records']) {
          assert.equal(startupDatabase.prepare("SELECT strict FROM pragma_table_list WHERE name = ?").get(table)?.strict, 1);
        }
        const sourceReferenceTopic = startupDatabase.prepare('PRAGMA foreign_key_list(source_references)').all()
          .find((foreignKey) => foreignKey.from === 'topic_id');
        assert.equal(sourceReferenceTopic?.on_delete, 'RESTRICT');
      } finally {
        startupDatabase.close();
      }
      host.diagnostics.guard.assert('127.0.0.1', 'bounded attention action route verification');
      const actionResponse = await fetch(`${gatewayUrl}/plugins/command-center/api/attention/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1 })
      });
      assert.equal(actionResponse.status, 400);
      assert.deepEqual(await actionResponse.json(), { schemaVersion: 1, status: 'unavailable' });
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
        page.waitForResponse((response) => isControlUiBootstrapUrl(response.url(), {
          gatewayUrl,
          bootstrapPath: runtimeCapability.bootstrap.path
        }), { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      const cookieProbe = observeBrowserResponse(
        page.waitForResponse((response) => new URL(response.url()).searchParams.has('__openclaw_plugin_frame_auth_probe'), { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      await page.goto(controlUiPluginUrl({
        gatewayUrl,
        pluginId: 'command-center',
        routeId: 'command-center',
        fragmentParameter: runtimeCapability.authentication.urlFragmentParameter,
        credential: world.gatewayCredential
      }), { waitUntil: 'domcontentloaded' });
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
  testContext.diagnostic(`acceptance-result=${JSON.stringify({
    schemaVersion: 1,
    outcome: 'passed',
    command: [
      'node',
      '--test',
      '--test-isolation=none',
      '--test-reporter=/opt/openclaw-control/src/ticket-test-reporter.js',
      'test/real-host.acceptance.test.mjs'
    ],
    expectedTest: 'mounts the built plugin through the isolated authenticated external tab',
    buildDigest: buildReceipt.digest
  })}`);
});
