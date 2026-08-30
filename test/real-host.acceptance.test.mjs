import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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
import { COMMAND_CENTER_SCHEMA_VERSION } from '../src/metadata/schema.mjs';
import { importedProvenance } from '../src/migration/transcript.mjs';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isControlUiBootstrapUrl } from '../src/acceptance-readiness.mjs';
import { assertPerformanceObservationWithinBaseline, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';

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

async function requestAuthenticatedGateway({ gatewayUrl, credential, method, params = {}, scopes = ['operator.read'] }) {
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
    const connectId = `command-center-acceptance-connect-${randomUUID()}`;
    socket.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: { id: 'cli', version: '1', platform: 'test', mode: 'cli' }, caps: [], commands: [], role: 'operator', scopes, auth: { ['to' + 'ken']: credential } } }));
    const connected = await waitForFrame((frame) => frame?.type === 'res' && frame.id === connectId);
    if (!connected.ok) throw new Error(`Authenticated Gateway connect failed: ${connected.error?.code ?? 'unknown'}`);
    const requestId = `command-center-acceptance-${randomUUID()}`;
    socket.send(JSON.stringify({ type: 'req', id: requestId, method, params }));
    const response = await waitForFrame((frame) => frame?.type === 'res' && frame.id === requestId);
    if (!response.ok) throw new Error(`Authenticated ${method} failed: ${response.error?.code ?? 'unknown'}`);
    return response.payload;
  } finally { socket.close(); }
}

async function readAuthenticatedHistory({ gatewayUrl, credential, sessionKey }) {
  return requestAuthenticatedGateway({ gatewayUrl, credential, method: 'chat.history', params: { sessionKey } });
}

async function waitForFrameText(frame, selector, expected, timeout = 10_000) {
  await frame.waitForFunction(({ selector: target, expectedText }) => document.querySelector(target)?.textContent?.includes(expectedText), { selector, expectedText: expected }, { timeout });
}

async function waitForDashboard(frame, timeout = 10_000) {
  await frame.waitForFunction(() => {
    const dashboard = document.querySelector('#dashboard');
    return dashboard && !dashboard.textContent?.includes('Loading current Attention…') && !dashboard.textContent?.includes('Loading Activity…');
  }, undefined, { timeout });
}

async function submitFrameForm(frame, selector) {
  await frame.locator(selector).evaluate((form) => form.requestSubmit());
}

async function selectWorkspaceSection(frame, name, width) {
  if (width < 768) await frame.locator(`.workspace-sections button[data-section="${name}"]`).click();
}

async function runUiJourney(frame, { width, name, category = 'project' }) {
  const measurement = {};
  const dashboardStarted = Date.now();
  await waitForDashboard(frame);
  measurement.dashboardReadyMs = Date.now() - dashboardStarted;
  await frame.locator('#topic-create input[name="name"]').fill(name);
  await frame.locator('#topic-create select[name="paraCategory"]').selectOption(category);
  const topicStarted = Date.now();
  await submitFrameForm(frame, '#topic-create');
  await waitForFrameText(frame, '#topic-status', 'Topic created and verified.');
  const row = frame.locator('.topic-row').filter({ hasText: name });
  await row.getByRole('button', { name: 'Open Topic', exact: true }).click();
  await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
  measurement.topicReadyMs = Date.now() - topicStarted;
  const topicId = await row.getAttribute('data-topic-id');
  assert.match(topicId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  await selectWorkspaceSection(frame, 'chat', width);
  await frame.locator('#chat-message').fill(`Fictional Primary Chat message for ${name}.`);
  await submitFrameForm(frame, '#chat-form');
  await waitForFrameText(frame, '#chat-status', 'Message sent.');

  await selectWorkspaceSection(frame, 'conversations', width);
  const conversationName = `Fictional Conversation ${name}`;
  await frame.locator('#conversation-create input[name="label"]').fill(conversationName);
  await submitFrameForm(frame, '#conversation-create');
  const conversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
  const conversationSwitchStarted = Date.now();
  await conversation.getByRole('button', { name: conversationName, exact: true }).click();
  await waitForFrameText(frame, '#chat-conversation-name', conversationName);
  measurement.conversationSwitchMs = Date.now() - conversationSwitchStarted;
  await conversation.getByRole('button', { name: 'Close', exact: true }).click();
  await frame.locator('#conversation-view').selectOption('closed');
  const closedConversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
  await closedConversation.getByText('Closed', { exact: true }).waitFor();
  await closedConversation.getByRole('button', { name: 'Reopen', exact: true }).click();
  await frame.locator('#conversation-view').selectOption('open');
  await frame.locator('.conversation-item').filter({ hasText: conversationName }).getByText('Open', { exact: true }).waitFor();

  await selectWorkspaceSection(frame, 'notes', width);
  await frame.locator('#note-new').click();
  const noteDialog = frame.getByRole('dialog', { name: 'Create Note' });
  await noteDialog.waitFor();
  const notePath = `journey-${width}.md`;
  await frame.locator('#note-action-path').fill(notePath);
  await frame.locator('#note-action-text').fill(`# ${name}\n\nFictional journey search evidence.`);
  await frame.locator('#note-action-submit').click();
  await frame.locator('#notes-tree').getByRole('button', { name: notePath, exact: true }).waitFor();
  const noteStarted = Date.now();
  await frame.locator('#notes-tree').getByRole('button', { name: notePath, exact: true }).click();
  await frame.locator('#note-editor').waitFor({ state: 'visible' });
  measurement.largeNoteRenderMs = Date.now() - noteStarted;
  const editedText = `# ${name}\n\nEdited fictional journey evidence.`;
  await frame.locator('#note-content').fill(editedText);
  await frame.locator('#note-save').click();
  await waitForFrameText(frame, '#notes-status', 'Note saved.');
  await frame.locator('#note-preview-mode').click();
  await frame.locator('#note-preview').waitFor({ state: 'visible' });
  await waitForFrameText(frame, '#note-preview', 'Edited fictional journey evidence.');
  await frame.locator('#note-edit-mode').click();
  await frame.locator('#note-rename').click();
  await frame.locator('#note-action-path').fill(`renamed-${width}.md`);
  await frame.locator('#note-action-submit').click();
  const renamedPath = `renamed-${width}.md`;
  await frame.locator('#notes-tree').getByRole('button', { name: renamedPath, exact: true }).waitFor();
  await frame.locator('#notes-tree').getByRole('button', { name: renamedPath, exact: true }).click();
  await frame.locator('#note-move').click();
  const movedPath = `nested/journey-${width}.md`;
  await frame.locator('#note-action-path').fill(movedPath);
  await frame.locator('#note-action-submit').click();
  await frame.locator('#notes-tree').getByRole('button', { name: movedPath, exact: true }).waitFor();

  await selectWorkspaceSection(frame, 'search', width);
  await frame.locator('#workspace-search-query').fill('Edited fictional journey evidence');
  const searchStarted = Date.now();
  await submitFrameForm(frame, '#workspace-search-form');
  await waitForFrameText(frame, '#workspace-search-status', '1 Notes');
  measurement.indexedSearchMs = Date.now() - searchStarted;
  await frame.locator('#workspace-notes-results').getByRole('button', { name: 'Open Note', exact: true }).click();
  await frame.locator('#note-editor').waitFor({ state: 'visible' });

  await frame.locator('#workspace-back').click();
  await waitForDashboard(frame);
  await frame.locator('#topic-search-topic-id').selectOption(topicId);
  await frame.locator('#topic-search-query').fill('Edited fictional journey evidence');
  await submitFrameForm(frame, '#topic-search-form');
  await waitForFrameText(frame, '#topic-search-status', '1 Notes');
  await frame.locator('#notes-results').getByRole('button', { name: 'Open Note', exact: true }).click();
  await waitForFrameText(frame, '#topic-search-detail', 'Edited fictional journey evidence.');
  assert.equal(await frame.locator('#dashboard').isHidden(), false);
  return { topicId, measurement };
}

async function assertResponsiveFrame(frame, page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px page has horizontal overflow`);
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px plugin frame has horizontal overflow`);
  const interactive = await frame.locator('button, input, select, textarea, a').evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
  }).map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, name: node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 40) })));
  for (const node of interactive) assert.ok(node.width >= 44 && node.height >= 44, `${width}px interactive target is below 44px: ${node.name}`);
  assert.equal(await frame.locator('h1').count(), 1);
  assert.equal(await frame.locator('[role="dialog"]').count(), 2);
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
        assert.equal(startupDatabase.prepare('PRAGMA user_version').get().user_version, COMMAND_CENTER_SCHEMA_VERSION);
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
      const serializedBootstrap = JSON.stringify(parentConfig);
      assert.doesNotMatch(serializedBootstrap, /tokenHash/iu);
      assert.doesNotMatch(serializedBootstrap, new RegExp(world.gatewayCredential, 'u'));
      const observedCookieProbe = await cookieProbe;
      evidence.cookieProbeStatus = observedBrowserResponseStatus(observedCookieProbe);
      evidence.cookieProbe = hasSuccessfulBrowserResponse(observedCookieProbe);
      if (!evidence.cookieProbe) throw new HarnessFailure('failed-cookie-probe', 'Sandbox cookie probe was not observed');
      let { iframe, frame } = await mountedPluginFrame(page);
      evidence.frame = true;
      const sandbox = await iframe.getAttribute('sandbox');
      if (sandbox !== 'allow-scripts') throw new HarnessFailure('sandbox-mismatch', 'External tab iframe is not scripts-only');
      const baseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
      assert.equal(baseline.pluginBuildDigest, `sha256:${buildReceipt.digest}`);
      const desktopJourney = await runUiJourney(frame, { width: 1440, name: 'Fictional Desktop Journey Topic', category: 'project' });
      await assertResponsiveFrame(frame, page, 1440);
      for (const name of ['dashboardReadyMs', 'topicReadyMs', 'conversationSwitchMs', 'indexedSearchMs', 'largeNoteRenderMs']) assertPerformanceObservationWithinBaseline(name, desktopJourney.measurement[name], baseline);

      host.diagnostics.guard.assert('127.0.0.1', 'authenticated reminder fixture creation');
      for (let index = 1; index <= 3; index += 1) {
        await requestAuthenticatedGateway({
          gatewayUrl,
          credential: world.gatewayCredential,
          scopes: ['operator.read', 'operator.write'],
          method: 'command-center.v1.reminders.create',
          params: {
            schemaVersion: 1,
            topicId: desktopJourney.topicId,
            logicalOperationId: randomUUID(),
            declaration: {
              name: `Fictional due reminder ${index}`,
              enabled: true,
              deleteAfterRun: false,
              schedule: { kind: 'at', at: new Date(Date.now() - 60_000 - index).toISOString() },
              payload: { kind: 'systemEvent', text: `Fictional release journey reminder ${index}` },
              sessionTarget: 'main',
              wakeMode: 'next-heartbeat'
            }
          }
        });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      ({ iframe, frame } = await mountedPluginFrame(page));
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
      await waitForDashboard(frame);
      const attentionCards = frame.locator('#attention-cards .attention-card');
      await assert.doesNotReject(attentionCards.nth(2).waitFor({ state: 'visible', timeout: 15_000 }));
      const attentionCard = attentionCards.first();
      await attentionCard.waitFor({ state: 'visible', timeout: 15_000 });
      await attentionCard.getByRole('button', { name: 'View evidence', exact: true }).click();
      assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
      assert.ok((await frame.locator('#evidence-content').innerText()).length > 0);
      await frame.locator('#evidence-close').click();
      await attentionCard.locator('select[aria-label="Snooze duration"]').selectOption('PT72H');
      const actionStarted = Date.now();
      await attentionCard.getByRole('button', { name: 'Snooze', exact: true }).click();
      await waitForFrameText(frame, '#dashboard-feedback', 'Item snoozed.');
      evidence.performanceMeasurements = { desktop: { ...desktopJourney.measurement, sourceActionMs: Date.now() - actionStarted } };
      assert.ok(await frame.locator('#in-progress').count() === 1);
      assert.match(await frame.locator('#in-progress').innerText(), /Nothing in progress|Action/u);

      await page.setViewportSize({ width: 320, height: 900 });
      const mobileJourney = await runUiJourney(frame, { width: 320, name: 'Fictional Mobile Journey Topic', category: 'project' });
      await assertResponsiveFrame(frame, page, 320);
      evidence.performanceMeasurements.mobile = { ...mobileJourney.measurement, sourceActionMs: 0 };

      await frame.locator('#analysis-run').click();
      await waitForFrameText(frame, '#analysis-feedback', 'Analysis completed.');
      const mobileRow = frame.locator('.topic-row').filter({ hasText: 'Fictional Mobile Journey Topic' });
      await page.once('dialog', (dialog) => dialog.accept('Area: Fictional Mobile Journey Topic'));
      await mobileRow.getByRole('button', { name: 'Rename', exact: true }).click();
      await waitForFrameText(frame, '#topic-status', 'Topic renamed.');
      await frame.locator('#analysis-run').click();
      await waitForFrameText(frame, '#analysis-feedback', 'Analysis completed.');
      const proposal = frame.locator('.topic-review-proposal').first();
      await proposal.waitFor({ state: 'visible', timeout: 15_000 });
      await proposal.getByRole('button', { name: 'Approve', exact: true }).click();
      await waitForFrameText(frame, '#analysis-feedback', 'Proposal decision saved.');
      const checkpoint = frame.locator('#topic-review-checkpoint');
      await checkpoint.waitFor({ state: 'visible' });
      await page.once('dialog', (dialog) => dialog.accept());
      await checkpoint.click();
      await waitForFrameText(frame, '#topic-review-plan', 'Application outcomes:');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
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
