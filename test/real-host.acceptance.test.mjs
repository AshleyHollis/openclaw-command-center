import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { chromium } from 'playwright';
import 'playwright-core';
import { finalizeAcceptanceJourney } from '../src/acceptance-finalization.mjs';
import { assertAcceptanceReportPassed, createAcceptanceReport, RELEASE_ROW_IDS, runAcceptanceRows } from '../src/acceptance-report.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, observedBrowserResponseStatus, recordBounded } from '../src/browser-evidence.mjs';
import { build, assertBuiltDigest } from '../src/build.mjs';
import { withIsolatedWorld } from '../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, HarnessFailure, launchPinnedHost, parseHostDescriptor, redact, stopPinnedHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';
import { assertWebSocketDestination, boundedTrafficEvidence, TrafficGuard } from '../src/isolation.mjs';
import { runtimeCapability } from '../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../src/metadata/path.mjs';
import { COMMAND_CENTER_SCHEMA_VERSION, metadataSchemaV1Sql } from '../src/metadata/schema.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { expectedRollbackRelease } from '../src/metadata/recovery.mjs';
import { importedProvenance } from '../src/migration/transcript.mjs';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isControlUiBootstrapUrl } from '../src/acceptance-readiness.mjs';
import { assertPerformanceObservationWithinBaseline, RELEASE_FIXTURE_COUNTS, RELEASE_MEASUREMENTS, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';
import { scanPublicEvidence, scanRepositorySafety } from '../src/safety.mjs';
import { compatibilityTuple, validateCompatibility } from '../src/compatibility.mjs';

const COMMITTED_SEARCH_PROJECTION_FILES = Object.freeze([
  'topic-search-conversations.commit.json',
  'topic-search-conversations.json',
  'topic-search-conversations.sqlite',
  'topic-search-notes.commit.json',
  'topic-search-notes.json',
  'topic-search-notes.sqlite'
]);

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

async function configureEvidencePage(page, browserGuard, evidence) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const hostName = new URL(request.url()).hostname;
    try { browserGuard.assert(hostName, 'browser'); recordBounded(evidence.requests, redactBrowserEvidence(request.url())); await route.continue(); }
    catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); await route.abort(); }
  });
  await page.routeWebSocket('**/*', (socket) => {
    try { assertWebSocketDestination(browserGuard, socket.url()); socket.connectToServer(); }
    catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); }
  });
  page.on('console', (message) => recordBounded(evidence.console, redactBrowserEvidence(message.text())));
  page.on('pageerror', (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
  page.on('response', (response) => recordBounded(evidence.responses, redactBrowserEvidence(`${response.status()} ${response.url()}`)));
}

async function waitForNotificationEmission(databasePath, { attempts = 100, status = 'sent', excludeEmissionId } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const emission = database.prepare('SELECT emission_id, status FROM notification_emissions WHERE status = ? AND (? IS NULL OR emission_id <> ?) ORDER BY updated_at_ms DESC LIMIT 1').get(status, excludeEmissionId ?? null, excludeEmissionId ?? null);
      if (emission) return emission;
    } finally { database.close(); }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new HarnessFailure('notification-reconciliation-timeout', `Closed-tab notification emission did not reach durable ${status} state`);
}

async function mountedPluginFrame(page, pluginDocument) {
  const iframe = page.locator('iframe.plugin-tab-embed__frame');
  try {
    await iframe.waitFor({ state: 'attached', timeout: 10_000 });
  } catch {
    throw new HarnessFailure('missing-plugin-frame', 'Command Center external tab did not attach its iframe');
  }
  if (await iframe.getAttribute('sandbox') !== 'allow-scripts' || await iframe.getAttribute('title') !== 'Command Center') {
    throw new HarnessFailure('sandbox-mismatch', 'Command Center external tab iframe provenance did not match its scripts-only descriptor');
  }
  if (!pluginDocument?.observed || !pluginDocument.value.ok() || new URL(pluginDocument.value.url()).pathname !== '/plugins/command-center') {
    throw new HarnessFailure('plugin-document-mismatch', 'Command Center plugin document did not return a successful exact-route response');
  }
  const body = await pluginDocument.value.body();
  if (body.byteLength === 0 || body.byteLength > 2_000_000) throw new HarnessFailure('plugin-document-mismatch', 'Command Center plugin document response was empty or unbounded');
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new HarnessFailure('missing-plugin-frame', 'Command Center external tab iframe had no attached document');
  if (frame.url() !== 'about:srcdoc') throw new HarnessFailure('plugin-frame-url-mismatch', 'Command Center capability frame was not mounted through the pinned host srcdoc boundary');
  await frame.waitForFunction(() => Boolean(window.CommandCenterTopics && window.CommandCenterSearch), undefined, { timeout: 10_000 });
  const provenance = await frame.evaluate(async () => {
    await Promise.all([window.CommandCenterTopics.ready, window.CommandCenterSearch.ready]);
    return {
      baseURI: document.baseURI,
      title: document.title,
      heading: document.querySelector('h1')?.textContent,
      shell: typeof window.CommandCenterTopics.loadTopics === 'function' && typeof window.CommandCenterSearch.search === 'function',
      bridgeReady: !document.querySelector('#topic-status')?.textContent?.includes('Loading')
    };
  });
  if (new URL(provenance.baseURI).pathname !== '/plugins/command-center' || provenance.title !== 'Command Center' || provenance.heading !== 'Dashboard' || !provenance.shell || !provenance.bridgeReady) {
    throw new HarnessFailure('plugin-document-mismatch', 'Command Center srcdoc did not retain the exact route base, shell markers, and ready capability bridge');
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

async function waitForCommittedSearchProjections(projectionRoot, { attempts = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (JSON.stringify((await readdir(projectionRoot)).sort()) === JSON.stringify(COMMITTED_SEARCH_PROJECTION_FILES)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new HarnessFailure('search-rebuild-timeout', 'Search rebuild did not publish the exact committed projection set');
}

async function seedReleaseNoteCorpus(folder) {
  const exactNote = (bytes, title) => {
    const prefix = `# ${title}\n\n`;
    return `${prefix}${'x'.repeat(bytes - Buffer.byteLength(prefix))}`;
  };
  const entries = [
    ['chunk-boundary.md', exactNote(RELEASE_FIXTURE_COUNTS.chunkBoundaryNoteBytes, 'Fictional chunk boundary')],
    ['large-note.md', exactNote(RELEASE_FIXTURE_COUNTS.largeNoteBytes, 'Fictional large note')]
  ];
  for (let index = entries.length; index < RELEASE_FIXTURE_COUNTS.indexedNotes; index += 1) entries.push([`indexed-${String(index).padStart(4, '0')}.md`, `# Fictional indexed Note ${index}\n\nFictional scale search phrase ${index}.`]);
  for (let offset = 0; offset < entries.length; offset += 100) {
    await Promise.all(entries.slice(offset, offset + 100).map(([name, content]) => writeFile(path.join(folder, name), content)));
  }
  const realized = await readdir(folder);
  assert.equal(realized.filter((name) => name.endsWith('.md')).length, RELEASE_FIXTURE_COUNTS.indexedNotes);
  assert.equal(Buffer.byteLength(await readFile(path.join(folder, 'chunk-boundary.md'))), RELEASE_FIXTURE_COUNTS.chunkBoundaryNoteBytes);
  assert.equal(Buffer.byteLength(await readFile(path.join(folder, 'large-note.md'))), RELEASE_FIXTURE_COUNTS.largeNoteBytes);
  return Object.freeze({ indexedNotes: realized.filter((name) => name.endsWith('.md')).length, chunkBoundaryNoteBytes: RELEASE_FIXTURE_COUNTS.chunkBoundaryNoteBytes, largeNoteBytes: RELEASE_FIXTURE_COUNTS.largeNoteBytes });
}

async function exerciseRestorationMatrix(stateDir) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  const migrationHooks = Symbol.for('openclaw.command-center.test.migration-hooks');
  const seedV1 = async (targetState, topicId) => {
    const targetDatabase = resolveCommandCenterDatabasePath(targetState);
    await mkdir(path.dirname(targetDatabase), { recursive: true });
    const seed = new DatabaseSync(targetDatabase);
    try {
      seed.exec(metadataSchemaV1Sql);
      seed.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(topicId, 'area', 'active', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    } finally { seed.close(); }
    return targetDatabase;
  };
  await seedV1(stateDir, 'fictional-restored-topic');
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const interrupted = openCommandCenterMetadataService({
    stateDir,
    [migrationHooks]: { beforeCommit() { throw new Error('fictional before-commit interruption'); } }
  });
  assert.equal(interrupted.getOperatingStatus().mode, 'recovery-only');
  interrupted.close();
  const afterCommitState = `${stateDir}-after-commit`;
  await seedV1(afterCommitState, 'fictional-after-commit-topic');
  const committedInterruption = openCommandCenterMetadataService({
    stateDir: afterCommitState,
    [migrationHooks]: { afterDatabaseCommit() { throw new Error('fictional post-commit interruption'); } }
  });
  committedInterruption.close();
  const reconciled = openCommandCenterMetadataService({ stateDir: afterCommitState });
  assert.equal(reconciled.getOperatingStatus().mode, 'ready');
  reconciled.close();
  const migrated = openCommandCenterMetadataService({ stateDir });
  assert.equal(migrated.getOperatingStatus().mode, 'ready');
  migrated.close();
  const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
  const manifest = JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8'));
  const currentDatabase = `${databasePath}.current`;
  await copyFile(databasePath, currentDatabase);
  await copyFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'), databasePath);
  const restored = openCommandCenterMetadataService({ stateDir });
  try {
    assert.equal(restored.getOperatingStatus().mode, 'recovery-only');
    assert.throws(() => restored.createTopic({ topicId: 'blocked-before-validation', paraCategory: 'project', lifecycle: 'active' }), (error) => error.code === 'recovery-only');
    const priorRelease = expectedRollbackRelease(stateDir);
    assert.throws(() => restored.verifyRollbackSnapshot({ snapshotId: manifest.snapshotId, priorRelease: { ...priorRelease, host: { ...priorRelease.host, commit: 'fictional-incompatible-commit' } } }), /rollback-/u);
    const verification = restored.verifyRollbackSnapshot({ snapshotId: manifest.snapshotId, priorRelease });
    assert.equal(verification.snapshotId, manifest.snapshotId);
  } finally { restored.close(); }
  await copyFile(currentDatabase, databasePath);
  const validatedCurrent = openCommandCenterMetadataService({ stateDir });
  try {
    validatedCurrent.createTopic({ topicId: 'validated-post-restore-topic', paraCategory: 'project', lifecycle: 'active' });
    assert.equal(validatedCurrent.getTopic('validated-post-restore-topic').topicId, 'validated-post-restore-topic');
  } finally {
    validatedCurrent.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  return Object.freeze({ snapshotId: manifest.snapshotId, writesBlocked: true, exactIdentityValidated: true, postValidationMutation: true });
}

async function exerciseOperatingModeMatrix(root) {
  const compatibilityRows = [
    { id: 'exact', tuple: compatibilityTuple, writable: true },
    { id: 'host', tuple: { ...compatibilityTuple, host: { ...compatibilityTuple.host, commit: 'fictional-incompatible-host' } }, writable: false },
    { id: 'package-build', tuple: { ...compatibilityTuple, package: { ...compatibilityTuple.package, build: 'fictional-incompatible-build' } }, writable: false },
    { id: 'plugin-api', tuple: { ...compatibilityTuple, pluginApi: { ...compatibilityTuple.pluginApi, range: '=fictional-incompatible-api' } }, writable: false },
    { id: 'bridge-protocol', tuple: { ...compatibilityTuple, capabilityBridgeProtocol: { min: 2, max: 2 } }, writable: false }
  ];
  for (const row of compatibilityRows) assert.equal(validateCompatibility(row.tuple).ok, row.writable, `compatibility row ${row.id} must ${row.writable ? 'accept' : 'fail closed'}`);
  const readyState = path.join(root, 'ready');
  const ready = openCommandCenterMetadataService({ stateDir: readyState });
  ready.createTopic({ topicId: 'fictional-mode-topic', paraCategory: 'project', lifecycle: 'active' });
  assert.equal(ready.getOperatingStatus().mode, 'ready');
  ready.close();
  const degradedSource = openCommandCenterMetadataService({ stateDir: readyState, capabilities: { notes: { available: false } } });
  assert.equal(degradedSource.getOperatingStatus().mode, 'degraded');
  assert.equal(degradedSource.getTopic('fictional-mode-topic').topicId, 'fictional-mode-topic');
  assert.throws(() => degradedSource.createSourceReference({ version: 1, referenceId: 'fictional-note-reference', topicId: 'fictional-mode-topic', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: 'fictional.md' }), (error) => error.code === 'capability-unavailable');
  degradedSource.close();
  const degradedBridge = openCommandCenterMetadataService({ stateDir: readyState, capabilities: { sessions: { available: false } } });
  assert.equal(degradedBridge.getOperatingStatus().mode, 'degraded');
  assert.equal(degradedBridge.getTopic('fictional-mode-topic').topicId, 'fictional-mode-topic');
  assert.throws(() => degradedBridge.createSourceReference({ version: 1, referenceId: 'fictional-session-reference', topicId: 'fictional-mode-topic', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional' }), (error) => error.code === 'capability-unavailable');
  degradedBridge.close();
  const recoveryState = path.join(root, 'future-schema');
  const recoveryDatabase = resolveCommandCenterDatabasePath(recoveryState);
  await mkdir(path.dirname(recoveryDatabase), { recursive: true });
  const future = new DatabaseSync(recoveryDatabase);
  try { future.exec('CREATE TABLE fictional_future_marker (id TEXT) STRICT; PRAGMA user_version = 99;'); } finally { future.close(); }
  const recovery = openCommandCenterMetadataService({ stateDir: recoveryState });
  try {
    assert.equal(recovery.getOperatingStatus().mode, 'recovery-only');
    assert.throws(() => recovery.createTopic({ topicId: 'valid-shaped-forged-topic', paraCategory: 'area', lifecycle: 'active' }), (error) => error.code === 'recovery-only');
  } finally { recovery.close(); }
  return Object.freeze({ ready: true, degradedSource: true, degradedBridge: true, recoveryOnly: true, validMutationsRejected: true, compatibilityRows: compatibilityRows.map(({ id, writable }) => ({ id, writable })), bindingStates: [{ current: true, writable: true }, { current: false, writable: false }] });
}

async function exerciseSecureHostVariant({ descriptor, buildReceipt }) {
  return withIsolatedWorld(async (secureWorld) => {
    const config = JSON.parse(await readFile(secureWorld.manifest.configPath, 'utf8'));
    config.gateway.tls = { enabled: true, autoGenerate: true };
    await writeFile(secureWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
    const secureHost = await launchPinnedHost({ descriptor, world: secureWorld, buildReceipt });
    const numericSecureUrl = new URL(secureWorld.gateway.url.replace(/^http:/u, 'https:'));
    const fictionalTailnetHost = 'command-center.fictional.ts.net';
    const secureUrl = `https://${fictionalTailnetHost}:${numericSecureUrl.port}`;
    const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${fictionalTailnetHost} 127.0.0.1,EXCLUDE localhost`] });
    const secureBrowserGuard = new TrafficGuard();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 900 } });
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        const hostname = new URL(route.request().url()).hostname;
        if (hostname !== fictionalTailnetHost) { await route.abort(); throw new HarnessFailure('secure-origin-escape', 'Secure-origin fixture attempted an unexpected hostname.'); }
        secureBrowserGuard.assert('127.0.0.1', `browser-host-map:${fictionalTailnetHost}`);
        await route.continue();
      });
      await waitForConsecutiveReadiness(async () => {
        try {
          const response = await context.request.get(`${secureUrl}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${secureWorld.gatewayCredential}` } });
          return response.ok();
        } catch { return false; }
      }, secureHost.earlyExit, { attempts: 60, delayMs: 250 });
      const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.goto(controlUiPluginUrl({ gatewayUrl: secureUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: secureWorld.gatewayCredential }), { waitUntil: 'domcontentloaded' });
      await mountedPluginFrame(page, await pluginDocument);
      assert.equal(new URL(page.url()).hostname, fictionalTailnetHost);
      assert.equal(new URL(page.url()).protocol, 'https:');
      return Object.freeze({ secureOrigin: new URL(page.url()).origin, actualTlsLoad: true, fictionalTailnetHost, loopbackResolution: '127.0.0.1' });
    } finally {
      await browser.close();
      secureBrowserGuard.assertClean();
      await stopPinnedHost(secureHost.child);
      await secureHost.outputDrained;
      assertNoFatalHostOutput(secureHost.diagnostics);
      await assertRecordedChildTraffic(secureWorld);
    }
  }, { candidateRoot: process.cwd() });
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

function reminderActionRequest(episode) {
  return {
    schemaVersion: 1,
    logicalOperationId: randomUUID(),
    sourceCapabilityId: episode.sourceCapabilityId,
    stableSubjectId: episode.stableSubjectId,
    episodeId: episode.episodeId,
    expectedEpisodeRevision: episode.revision,
    expectedSourceRevision: episode.sourceRevision,
    topicId: episode.topicId,
    sourceReferenceId: episode.sourceReferenceId,
    actionId: 'reminder.complete',
    input: { expectedConfigRevision: episode.sourceRevision }
  };
}

async function readDashboard(gatewayUrl, { activityOffset = 0, activityLimit = 50 } = {}) {
  const response = await fetch(`${gatewayUrl}/plugins/command-center/api/dashboard?activityOffset=${activityOffset}&activityLimit=${activityLimit}`, { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

async function completeReminder(gatewayUrl, episode) {
  const response = await fetch(`${gatewayUrl}/plugins/command-center/api/attention/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reminderActionRequest(episode))
  });
  assert.equal(response.status, 200);
  return response.json();
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

async function assertNoFrameOverflow(frame, label) {
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${label} has page-level horizontal overflow`);
}

async function activate(locator, keyboard = false, key = 'Enter') {
  if (keyboard) {
    await locator.scrollIntoViewIfNeeded();
    await locator.press(key);
  }
  else await locator.click();
}

async function enterText(locator, value, keyboard = false) {
  if (!keyboard) return locator.fill(value);
  await locator.press('ControlOrMeta+A');
  await locator.pressSequentially(value);
}

async function chooseOption(locator, value, keyboard = false) {
  if (!keyboard) return locator.selectOption(value);
  const index = await locator.locator('option').evaluateAll((options, target) => options.findIndex((option) => option.value === target), value);
  assert.ok(index >= 0, `Missing keyboard-select option ${value}`);
  await locator.press('Home');
  for (let position = 0; position < index; position += 1) await locator.press('ArrowDown');
  await locator.press('Enter');
  assert.equal(await locator.inputValue(), value);
}

async function submitFrameForm(frame, selector, keyboard = false) {
  if (keyboard) await activate(frame.locator(`${selector} button[type="submit"]`), true);
  else await frame.locator(selector).evaluate((form) => form.requestSubmit());
}

async function selectWorkspaceSection(frame, name, width, keyboard = false) {
  if (width < 768) await activate(frame.locator(`.workspace-sections button[data-section="${name}"]`), keyboard);
}

async function runUiJourney(frame, { width, name, category = 'project', keyboard = false, projectionRoot } = {}) {
  const measurement = {};
  const actionDurations = [];
  const timed = async (run) => { const started = Date.now(); await run(); actionDurations.push(Math.max(1, Date.now() - started)); };
  const dashboardStarted = Date.now();
  await waitForDashboard(frame);
  measurement.dashboardRefreshMs = Math.max(1, Date.now() - dashboardStarted);
  await enterText(frame.locator('#topic-create input[name="name"]'), name, keyboard);
  await chooseOption(frame.locator('#topic-create select[name="paraCategory"]'), category, keyboard);
  const topicStarted = Date.now();
  await submitFrameForm(frame, '#topic-create', keyboard);
  await waitForFrameText(frame, '#topic-status', 'Topic created and verified.');
  await assertNoFrameOverflow(frame, `${width}px Topic creation`);
  const row = frame.locator('.topic-row').filter({ hasText: name });
  await activate(row.getByRole('button', { name: 'Open Topic', exact: true }), keyboard);
  await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
  actionDurations.push(Math.max(1, Date.now() - topicStarted));
  const topicId = await row.getAttribute('data-topic-id');
  assert.match(topicId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  await selectWorkspaceSection(frame, 'chat', width, keyboard);
  const primaryMessage = `Fictional Primary Chat message for ${name}.`;
  await enterText(frame.locator('#chat-message'), primaryMessage, keyboard);
  await timed(() => submitFrameForm(frame, '#chat-form', keyboard));
  await waitForFrameText(frame, '#chat-status', 'Message sent.');
  await assertNoFrameOverflow(frame, `${width}px Primary Chat`);

  await selectWorkspaceSection(frame, 'conversations', width, keyboard);
  const conversationName = `Fictional Conversation ${name}`;
  await enterText(frame.locator('#conversation-create input[name="label"]'), conversationName, keyboard);
  await timed(() => submitFrameForm(frame, '#conversation-create', keyboard));
  const conversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
  const conversationSwitchStarted = Date.now();
  await activate(conversation.getByRole('button', { name: conversationName, exact: true }), keyboard);
  await waitForFrameText(frame, '#chat-conversation-name', conversationName);
  actionDurations.push(Math.max(1, Date.now() - conversationSwitchStarted));
  await timed(() => activate(conversation.getByRole('button', { name: 'Close', exact: true }), keyboard));
  await chooseOption(frame.locator('#conversation-view'), 'closed', keyboard);
  const closedConversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
  await closedConversation.getByText('Closed', { exact: true }).waitFor();
  await selectWorkspaceSection(frame, 'search', width, keyboard);
  await enterText(frame.locator('#workspace-search-query'), conversationName, keyboard);
  await submitFrameForm(frame, '#workspace-search-form', keyboard);
  await waitForFrameText(frame, '#workspace-search-status', '1 Conversations');
  const closedSearchResult = frame.locator('#workspace-conversations-results').filter({ hasText: conversationName });
  await closedSearchResult.getByText('Closed', { exact: true }).waitFor();
  await activate(closedSearchResult.getByRole('button', { name: 'Open Conversation', exact: true }), keyboard);
  await waitForFrameText(frame, '#chat-conversation-name', conversationName);
  assert.equal(await frame.locator('#chat-message').isDisabled(), true, 'indexed closed Conversation must remain read-only before reopen');
  await selectWorkspaceSection(frame, 'conversations', width, keyboard);
  await chooseOption(frame.locator('#conversation-view'), 'closed', keyboard);
  await timed(() => activate(closedConversation.getByRole('button', { name: 'Reopen', exact: true }), keyboard));
  await chooseOption(frame.locator('#conversation-view'), 'open', keyboard);
  await frame.locator('.conversation-item').filter({ hasText: conversationName }).getByText('Open', { exact: true }).waitFor();
  await assertNoFrameOverflow(frame, `${width}px Conversation lifecycle`);

  await selectWorkspaceSection(frame, 'notes', width, keyboard);
  await activate(frame.locator('#note-new'), keyboard);
  const noteDialog = frame.getByRole('dialog', { name: 'Create Note' });
  await noteDialog.waitFor();
  const notePath = `journey-${width}.md`;
  await enterText(frame.locator('#note-action-path'), notePath, keyboard);
  await enterText(frame.locator('#note-action-text'), `# ${name}\n\nFictional journey search evidence.`, keyboard);
  await timed(() => activate(frame.locator('#note-action-submit'), keyboard));
  await frame.locator('#notes-tree').getByRole('button', { name: notePath, exact: true }).waitFor();
  const noteStarted = Date.now();
  await activate(frame.locator('#notes-tree').getByRole('button', { name: notePath, exact: true }), keyboard);
  await frame.locator('#note-editor').waitFor({ state: 'visible' });
  actionDurations.push(Math.max(1, Date.now() - noteStarted));
  const editedText = `# ${name}\n\nEdited fictional journey evidence.`;
  await enterText(frame.locator('#note-content'), editedText, keyboard);
  await timed(() => activate(frame.locator('#note-save'), keyboard));
  await waitForFrameText(frame, '#notes-status', 'Note saved.');
  await activate(frame.locator('#note-preview-mode'), keyboard, 'Space');
  await frame.locator('#note-preview').waitFor({ state: 'visible' });
  await waitForFrameText(frame, '#note-preview', 'Edited fictional journey evidence.');
  await activate(frame.locator('#note-edit-mode'), keyboard, 'Space');
  await activate(frame.locator('#note-rename'), keyboard);
  await enterText(frame.locator('#note-action-path'), `renamed-${width}.md`, keyboard);
  await timed(() => activate(frame.locator('#note-action-submit'), keyboard));
  const renamedPath = `renamed-${width}.md`;
  await frame.locator('#notes-tree').getByRole('button', { name: renamedPath, exact: true }).waitFor();
  await activate(frame.locator('#notes-tree').getByRole('button', { name: renamedPath, exact: true }), keyboard);
  await activate(frame.locator('#note-move'), keyboard);
  const movedPath = `nested/journey-${width}.md`;
  await enterText(frame.locator('#note-action-path'), movedPath, keyboard);
  await timed(() => activate(frame.locator('#note-action-submit'), keyboard));
  await frame.locator('#notes-tree').getByRole('button', { name: movedPath, exact: true }).waitFor();
  await assertNoFrameOverflow(frame, `${width}px Note lifecycle`);

  await selectWorkspaceSection(frame, 'search', width, keyboard);
  await enterText(frame.locator('#workspace-search-query'), 'Edited fictional journey evidence', keyboard);
  const rebuildStarted = Date.now();
  await activate(frame.locator('#workspace-search-rebuild'), keyboard);
  await waitForFrameText(frame, '#workspace-search-status', 'rebuilt from authoritative sources');
  if (projectionRoot) {
    await waitForCommittedSearchProjections(projectionRoot);
    measurement.searchRebuildMs = Math.max(1, Date.now() - rebuildStarted);
    actionDurations.push(measurement.searchRebuildMs);
  }
  const searchStarted = Date.now();
  await submitFrameForm(frame, '#workspace-search-form', keyboard);
  await waitForFrameText(frame, '#workspace-search-status', '1 Notes');
  measurement.searchQueryMs = Math.max(1, Date.now() - searchStarted);
  actionDurations.push(measurement.searchQueryMs);
  await activate(frame.locator('#workspace-notes-results').getByRole('button', { name: 'Open Note', exact: true }), keyboard);
  await frame.locator('#note-editor').waitFor({ state: 'visible' });

  await timed(() => activate(frame.locator('#workspace-back'), keyboard));
  await waitForDashboard(frame);
  await chooseOption(frame.locator('#topic-search-topic-id'), topicId, keyboard);
  await enterText(frame.locator('#topic-search-query'), 'Edited fictional journey evidence', keyboard);
  await timed(() => submitFrameForm(frame, '#topic-search-form', keyboard));
  await waitForFrameText(frame, '#topic-search-status', '1 Notes');
  await activate(frame.locator('#notes-results').getByRole('button', { name: 'Open Note', exact: true }), keyboard);
  await waitForFrameText(frame, '#topic-search-detail', 'Edited fictional journey evidence.');
  await assertNoFrameOverflow(frame, `${width}px Topic Search`);
  assert.equal(await frame.locator('#dashboard').isHidden(), false);
  measurement.maximumInteractionHeartbeatMs = Math.max(...actionDurations);
  return { topicId, conversationName, movedPath, primaryMessage, measurement };
}

async function exerciseLargeNoteFixture(frame) {
  const importedTopic = frame.locator('.topic-row').filter({ hasText: 'Fictional Alpha' });
  await importedTopic.getByRole('button', { name: 'Open Topic', exact: true }).click();
  await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
  await selectWorkspaceSection(frame, 'notes', 1440);
  const measurements = {};
  for (const [pathName, edit] of [['chunk-boundary.md', false], ['large-note.md', true]]) {
    const started = Date.now();
    await frame.locator('#notes-tree').getByRole('button', { name: pathName, exact: true }).click();
    await frame.locator('#note-editor').waitFor({ state: 'visible' });
    const bytes = await frame.locator('#note-content').inputValue().then((value) => Buffer.byteLength(value));
    assert.equal(bytes, RELEASE_FIXTURE_COUNTS.largeNoteBytes);
    measurements[`${pathName}OpenMs`] = Math.max(1, Date.now() - started);
    if (edit) {
      await frame.locator('#note-content').press('End');
      await frame.locator('#note-content').pressSequentially('\nFictional measured edit.');
      await frame.locator('#note-save').click();
      await waitForFrameText(frame, '#notes-status', 'Note saved.');
    }
    const previewStarted = Date.now();
    await frame.locator('#note-preview-mode').press('Space');
    await frame.locator('#note-preview').waitFor({ state: 'visible' });
    measurements[`${pathName}PreviewMs`] = Math.max(1, Date.now() - previewStarted);
    await frame.locator('#note-edit-mode').press('Space');
    await assertNoFrameOverflow(frame, `large Note ${pathName}`);
  }
  await frame.locator('#workspace-back').click();
  await waitForDashboard(frame);
  return Object.freeze(measurements);
}

async function assertResponsiveFrame(frame, page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px page has horizontal overflow`);
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px plugin frame has horizontal overflow`);
  const interactive = await frame.locator('button, input, select, textarea, a').evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
  }).map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, name: node.getAttribute('aria-label') || node.labels?.[0]?.textContent?.trim() || node.textContent?.trim().slice(0, 80) || node.getAttribute('title') })));
  for (const node of interactive) {
    assert.ok(node.name, `${width}px interactive target has no observable name`);
    assert.ok(node.width >= 44 && node.height >= 44, `${width}px interactive target is below 44px: ${node.name}`);
  }
  assert.equal(await frame.locator('h1').count(), 1);
  assert.equal(await frame.locator('[role="dialog"]').count(), 2);
}

async function assertKeyboardAccessibility(frame, page) {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  assert.equal(await frame.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(forced-colors: active)').matches), true);
  const traversed = [];
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press('Tab');
    const focused = await frame.evaluate(() => {
      const node = document.activeElement;
      if (!(node instanceof HTMLElement) || node === document.body) return null;
      const style = getComputedStyle(node);
      const name = node.getAttribute('aria-label') || node.labels?.[0]?.textContent?.trim() || node.textContent?.trim().slice(0, 80) || node.getAttribute('title');
      return { name, outline: style.outlineStyle, hidden: Boolean(node.closest('[hidden], [inert]')) };
    });
    if (!focused) continue;
    assert.ok(focused.name, 'Tab traversal reached an unnamed control');
    assert.equal(focused.hidden, false, 'Tab traversal entered hidden or inert content');
    assert.notEqual(focused.outline, 'none', `Keyboard focus is not visible for ${focused.name}`);
    traversed.push(focused.name);
    if (focused.name === 'View evidence') {
      await page.keyboard.press('Enter');
      assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
      assert.equal(await frame.getByRole('dialog', { name: /evidence/iu }).getAttribute('aria-modal'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await frame.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()) === 'View evidence'), true, 'Escape must restore Evidence focus');
      break;
    }
  }
  assert.ok(traversed.includes('View evidence'), 'Tab traversal must reach the Evidence action');
  await page.keyboard.press('Shift+Tab');
  assert.notEqual(await frame.evaluate(() => document.activeElement), null);
  await page.setViewportSize({ width: 1280, height: 900 });
  await frame.evaluate(() => { document.documentElement.style.zoom = '4'; });
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '400% reflow at a 320px-equivalent layout has page-level overflow');
  await assertResponsiveFrame(frame, page, 1280);
  await frame.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
}

test('mounts the built plugin through the isolated authenticated external tab', { timeout: 118_000 }, async (testContext) => {
  const descriptor = parseHostDescriptor(); // Mandatory: never skip absent controller input.
  const buildReceipt = await build();
  await assertBuiltDigest(buildReceipt);
  await withIsolatedWorld(async (world) => {
    const migrationExportPath = path.join(world.tempRoot, 'legacy-discord-export.v1.json');
    const migrationFolderPath = path.join(world.paths.vault, 'fictional-alpha');
    const scaleMigrationFolderPath = path.join(world.paths.vault, 'fictional-scale');
    await Promise.all([mkdir(migrationFolderPath, { recursive: true }), mkdir(scaleMigrationFolderPath, { recursive: true })]);
    const migrationExport = JSON.parse(await readFile(new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
    migrationExport.channels.push({
      channelId: 'fictional-channel-scale',
      displayName: 'Fictional Scale Corpus',
      messages: Array.from({ length: RELEASE_FIXTURE_COUNTS.indexedConversations }, (_, index) => ({
        messageId: `fictional-scale-message-${String(index).padStart(4, '0')}`,
        displayOrder: index,
        author: { id: 'fictional-user-scale', displayName: 'Fictional Scale User' },
        timestamp: new Date(Date.UTC(2026, 7, 21) + index).toISOString(),
        text: `Fictional indexed conversation phrase ${index}.`,
        edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: []
      }))
    });
    const realizedScaleSeed = await seedReleaseNoteCorpus(migrationFolderPath);
    await writeFile(migrationExportPath, `${JSON.stringify(migrationExport)}\n`);
    const configured = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    configured.plugins.entries[world.manifest.candidate.id].config = {
      legacyDiscordMigration: {
        schemaVersion: 1,
        exportPath: migrationExportPath,
        channels: [
          { channelId: 'fictional-channel-alpha', topicId: 'fictional-topic-alpha', paraCategory: 'project', noteFolderPath: migrationFolderPath },
          { channelId: 'fictional-channel-scale', topicId: 'fictional-topic-scale', paraCategory: 'resource', noteFolderPath: scaleMigrationFolderPath }
        ]
      }
    };
    await writeFile(world.manifest.configPath, `${JSON.stringify(configured)}\n`);
    const resolvedStateDir = path.join(world.root, '.openclaw');
    const activityFixture = openCommandCenterMetadataService({ stateDir: resolvedStateDir });
    try {
      activityFixture.createTopic({ topicId: 'fictional-scale-activity-topic', paraCategory: 'resource', lifecycle: 'active' });
      for (let index = 0; index < RELEASE_FIXTURE_COUNTS.activityRecords; index += 1) {
        const createdAt = new Date(Date.UTC(2026, 7, 29, 12, 0, 0) + index).toISOString();
        activityFixture.recordActivity({
          activityId: `fictional-scale-activity-${index}`,
          topicId: 'fictional-scale-activity-topic',
          logicalOperationId: randomUUID(),
          transportRequestId: randomUUID(),
          operationKind: 'fixture.scale',
          outcome: 'applied',
          observedRevision: `sha256:${String(index).padStart(64, '0')}`,
          createdAt,
          updatedAt: createdAt
        });
      }
      assert.equal(activityFixture.listActivity('fictional-scale-activity-topic').length, RELEASE_FIXTURE_COUNTS.activityRecords);
    } finally { activityFixture.close(); }
    const host = await launchPinnedHost({ descriptor, world, buildReceipt });
    const gatewayUrl = world.gateway.url;
    const databasePath = resolveCommandCenterDatabasePath(resolvedStateDir);
    assert.deepEqual(host.endpoint, world.gateway);
    assert.notEqual(world.gateway.port, 18789);
    assert.ok(host.child.pid, 'spawned host must own the isolated endpoint before probing it');
    const browserGuard = new TrafficGuard();
    const evidence = { console: [], errors: [], requests: [], responses: [], bootstrapStatus: undefined, parentBootstrapBodyKeys: [], routeGrant: false, parentBootstrap: false, cookieProbe: false, cookieProbeStatus: undefined, frame: false, readinessAttempts: [] };
    const releaseState = { startup: false, desktop: undefined, mobile: undefined, restored: false, forgedMutationRejected: false, projectionRoot: undefined, baseline: undefined, activityPaged: false, reviewApplied: false, realizedScaleSeed };
    let browser, page, iframe, frame, baseline, desktopJourney, mobileJourney, pluginDocument;
    let failure;
    const scenarioFailures = [];
    const scenarioEvidence = new Map();
    const collectScenario = async (id, run) => {
      let observedError;
      const passed = await testContext.test(`release scenario: ${id}`, async () => {
        try { scenarioEvidence.set(id, await run()); }
        catch (error) { observedError = error; throw error; }
      });
      if (!passed) {
        const bounded = redactBrowserEvidence(observedError?.message || `Scenario ${id} failed without unbounded diagnostics`);
        scenarioFailures.push({ id, error: new HarnessFailure('release-row-failed', bounded) });
      }
    };
    const requireScenario = (...ids) => {
      for (const id of ids) {
        const failed = scenarioFailures.find((entry) => entry.id === id);
        if (failed) throw failed.error;
        if (!scenarioEvidence.has(id)) throw new Error(`Release scenario did not execute: ${id}`);
      }
      return Object.fromEntries(ids.map((id) => [id, scenarioEvidence.get(id) ?? null]));
    };
    await collectScenario('pinned-host-startup', async () => {
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
      assert.equal(completion.verified_channel_count, migrationExport.channels.length);
      assert.equal(completion.verified_occurrence_count, migrationExport.channels.reduce((count, channel) => count + channel.messages.length, 0));
      host.diagnostics.guard.assert('127.0.0.1', 'authenticated chat.history verification');
      const history = await readAuthenticatedHistory({ gatewayUrl, credential: world.gatewayCredential, sessionKey: binding.sessionKey });
      assert.equal(history.sessionId ?? history.session?.sessionId ?? binding.sessionId, binding.sessionId);
      const imported = (history.messages ?? []).filter((message) => message?.__openclaw?.legacyDiscordV1?.immutable === true);
      assert.equal(imported.length, migrationExport.channels[0].messages.length);
      for (const [index, occurrence] of migrationExport.channels[0].messages.entries()) {
        assert.equal(imported[index].text, occurrence.text);
        assert.deepEqual(imported[index].__openclaw.legacyDiscordV1, importedProvenance(migrationExport.channels[0].channelId, occurrence));
      }
      // Complete the frozen conversation fixture through the public Session
      // contract before any browser mutation begins. The migrated primary
      // Session is the first of the exact 51 Topic Conversations.
      for (let offset = 1; offset < RELEASE_FIXTURE_COUNTS.conversations; offset += 10) {
        await Promise.all(Array.from({ length: Math.min(10, RELEASE_FIXTURE_COUNTS.conversations - offset) }, (_, batchIndex) => {
          const index = offset + batchIndex;
          return requestAuthenticatedGateway({
            gatewayUrl,
            credential: world.gatewayCredential,
            scopes: ['operator.read', 'operator.write'],
            method: 'command-center.v1.sessions.create',
            params: { schemaVersion: 1, topicId: 'fictional-topic-scale', label: `Fictional scale Conversation ${index}`, isPrimary: false, logicalOperationId: randomUUID() }
          });
        }));
      }
      const seededSessions = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: 'fictional-topic-scale' } });
      releaseState.realizedConversationCount = ((seededSessions?.result ?? seededSessions)?.conversations ?? seededSessions?.conversations ?? []).length;
      assert.equal(releaseState.realizedConversationCount, RELEASE_FIXTURE_COUNTS.conversations);
      await requestAuthenticatedGateway({
        gatewayUrl,
        credential: world.gatewayCredential,
        scopes: ['operator.read', 'operator.write'],
        method: 'command-center.v1.analysis.run',
        params: { schemaVersion: 1, topicId: 'fictional-topic-alpha', input: {}, logicalOperationId: randomUUID() }
      });
      const pluginStateRoot = path.dirname(databasePath);
      assert.deepEqual((await readdir(pluginStateRoot)).sort(), ['metadata.sqlite', 'projections']);
      const projectionRoot = path.join(pluginStateRoot, 'projections');
      assert.deepEqual(await readdir(projectionRoot), ['.topic-search.invalidated.json']);
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
      host.diagnostics.guard.assert('127.0.0.1', 'pre-journey scale projection verification');
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: 'fictional-topic-alpha', query: 'Fictional', limit: 50 } });
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: 'fictional-topic-scale', query: 'Fictional indexed conversation phrase', limit: 50 } });
      await waitForCommittedSearchProjections(projectionRoot);
      const notesProjection = new DatabaseSync(path.join(projectionRoot, 'topic-search-notes.sqlite'), { readOnly: true });
      const conversationProjection = new DatabaseSync(path.join(projectionRoot, 'topic-search-conversations.sqlite'), { readOnly: true });
      try {
        assert.equal(notesProjection.prepare('SELECT count(*) AS count FROM note_documents WHERE topic_id = ?').get('fictional-topic-alpha').count, RELEASE_FIXTURE_COUNTS.indexedNotes);
        assert.equal(conversationProjection.prepare('SELECT count(*) AS count FROM conversation_documents WHERE topic_id = ?').get('fictional-topic-scale').count, RELEASE_FIXTURE_COUNTS.indexedConversations);
        releaseState.realizedSearchCounts = { notes: RELEASE_FIXTURE_COUNTS.indexedNotes, conversationMessages: RELEASE_FIXTURE_COUNTS.indexedConversations };
      } finally { notesProjection.close(); conversationProjection.close(); }
      // Force the measured journey to prove missing-index rebuild rather than
      // reusing the fixture-verification publication.
      await Promise.all(COMMITTED_SEARCH_PROJECTION_FILES.map((name) => unlink(path.join(projectionRoot, name))));
      host.diagnostics.guard.assert('127.0.0.1', 'bounded attention action route verification');
      const actionResponse = await fetch(`${gatewayUrl}/plugins/command-center/api/attention/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1 })
      });
      assert.equal(actionResponse.status, 400);
      assert.deepEqual(await actionResponse.json(), { schemaVersion: 1, status: 'unavailable' });
      releaseState.forgedMutationRejected = true;
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
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
      pluginDocument = observeBrowserResponse(
        page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      const startupInteractiveStartedAt = Date.now();
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
      assert.equal(serializedBootstrap.includes(world.gatewayCredential), false, 'Bootstrap must not return the fixture credential');
      const securePluginUrl = new URL(controlUiPluginUrl({ gatewayUrl: gatewayUrl.replace(/^http:/u, 'https:'), pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }));
      assert.equal(securePluginUrl.protocol, 'https:');
      assert.equal(securePluginUrl.pathname, '/plugin');
      assert.equal(securePluginUrl.searchParams.get('plugin'), 'command-center');
      assert.equal(securePluginUrl.searchParams.get('id'), 'command-center');
      assert.equal(new URLSearchParams(securePluginUrl.hash.slice(1)).get(runtimeCapability.authentication.urlFragmentParameter) === world.gatewayCredential, true, 'Parent URL must retain the fixture credential only in its fragment');
      const observedCookieProbe = await cookieProbe;
      evidence.cookieProbeStatus = observedBrowserResponseStatus(observedCookieProbe);
      evidence.cookieProbe = hasSuccessfulBrowserResponse(observedCookieProbe);
      if (!evidence.cookieProbe) throw new HarnessFailure('failed-cookie-probe', 'Sandbox cookie probe was not observed');
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument));
      evidence.frame = true;
      const sandbox = await iframe.getAttribute('sandbox');
      if (sandbox !== 'allow-scripts') throw new HarnessFailure('sandbox-mismatch', 'External tab iframe is not scripts-only');
      baseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
      releaseState.startup = true;
      releaseState.startupInteractiveMs = Math.max(1, Date.now() - startupInteractiveStartedAt);
      releaseState.projectionRoot = projectionRoot;
      releaseState.baseline = baseline;
      assert.equal(baseline.pluginBuildDigest, `sha256:${buildReceipt.digest}`);
      return { schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, frame: evidence.frame, routeGrant: evidence.routeGrant };
    });
    await collectScenario('desktop-primary-journey', async () => {
      requireScenario('pinned-host-startup');
      desktopJourney = await runUiJourney(frame, { width: 1440, name: 'Fictional Desktop Journey Topic', category: 'project', projectionRoot: releaseState.projectionRoot });
      desktopJourney.measurement.startupInteractiveMs = releaseState.startupInteractiveMs;
      releaseState.desktop = desktopJourney;
      const desktopSessions = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: desktopJourney.topicId } });
      const primarySession = (desktopSessions?.result ?? desktopSessions)?.conversations?.find((session) => session.isPrimary === true) ?? (desktopSessions?.conversations ?? []).find((session) => session.isPrimary === true);
      assert.ok(primarySession?.sessionId && primarySession?.referenceId);
      const primaryNavigation = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId: desktopJourney.topicId, referenceId: primarySession.referenceId } });
      const primaryTarget = primaryNavigation?.result ?? primaryNavigation;
      assert.ok(primaryTarget?.sessionKey);
      const primaryHistory = await readAuthenticatedHistory({ gatewayUrl, credential: world.gatewayCredential, sessionKey: primaryTarget.sessionKey });
      assert.equal((primaryHistory.messages ?? []).some((message) => message.text === desktopJourney.primaryMessage || message.content === desktopJourney.primaryMessage), true);
      releaseState.primarySession = { ...primarySession, sessionKey: primaryTarget.sessionKey };
      const ordinarySession = ((desktopSessions?.result ?? desktopSessions)?.conversations ?? desktopSessions?.conversations ?? []).find((session) => session.displayName === desktopJourney.conversationName);
      assert.ok(ordinarySession?.referenceId && ordinarySession?.sessionId);
      const desktopNotes = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.notes.browse', params: { schemaVersion: 1, topicId: desktopJourney.topicId } });
      const movedNote = ((desktopNotes?.result ?? desktopNotes)?.notes ?? desktopNotes?.notes ?? []).find((note) => note.path === desktopJourney.movedPath);
      assert.ok(movedNote?.sourceReference?.referenceId && movedNote?.revision);
      releaseState.durableWorkspace = {
        conversation: { referenceId: ordinarySession.referenceId, sessionId: ordinarySession.sessionId },
        note: { referenceId: movedNote.sourceReference.referenceId, revision: movedNote.revision, path: movedNote.path }
      };
      assert.deepEqual((await readdir(releaseState.projectionRoot)).sort(), COMMITTED_SEARCH_PROJECTION_FILES);
      await assertResponsiveFrame(frame, page, 1440);
      return { topicId: desktopJourney.topicId, primarySessionId: releaseState.primarySession.sessionId };
    });
    await collectScenario('scale-performance', async () => {
      requireScenario('pinned-host-startup', 'desktop-primary-journey');
      const realizedConversationCount = releaseState.realizedConversationCount;
      assert.equal(realizedConversationCount, RELEASE_FIXTURE_COUNTS.conversations);
      releaseState.largeNoteMeasurements = await exerciseLargeNoteFixture(frame);
      desktopJourney.measurement.largeNoteOpenMs = Math.max(...Object.entries(releaseState.largeNoteMeasurements).filter(([name]) => name.endsWith('OpenMs')).map(([, value]) => value));
      desktopJourney.measurement.largeNotePreviewMs = Math.max(...Object.entries(releaseState.largeNoteMeasurements).filter(([name]) => name.endsWith('PreviewMs')).map(([, value]) => value));
      host.diagnostics.guard.assert('127.0.0.1', 'authenticated reminder fixture creation');
      for (let index = 1; index <= 1; index += 1) {
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
      const seededDashboard = await readDashboard(gatewayUrl);
      const seededReminders = seededDashboard.attention.filter((episode) => episode.sourceCapabilityId === 'reminders' && episode.actions.some((action) => action.actionId === 'reminder.complete'));
      const seededTopicReviews = seededDashboard.attention.filter((episode) => episode.sourceCapabilityId === 'topic-review');
      assert.equal(seededReminders.length, 1);
      assert.equal(seededTopicReviews.length, 1);
      const fixtureActivity = new DatabaseSync(databasePath, { readOnly: true });
      let realizedActivityRecords;
      try { realizedActivityRecords = fixtureActivity.prepare("SELECT count(*) AS count FROM activity_records WHERE operation_kind = 'fixture.scale'").get().count; }
      finally { fixtureActivity.close(); }
      assert.equal(realizedActivityRecords, RELEASE_FIXTURE_COUNTS.activityRecords);
      await page.close();
      evidence.globalTabClosed = true;
      const closedTabEmission = await waitForNotificationEmission(databasePath, { status: 'sent' });
      evidence.closedTabNotificationStatus = closedTabEmission.status;
      const closedDashboard = await readDashboard(gatewayUrl);
      const closedEpisode = closedDashboard.attention.find((episode) => episode.sourceCapabilityId === 'reminders' && episode.actions.some((action) => action.actionId === 'reminder.complete'));
      assert.ok(closedEpisode?.episodeId && closedEpisode?.sourceReferenceId);
      await completeReminder(gatewayUrl, closedEpisode);
      const clearedEmission = await waitForNotificationEmission(databasePath, { status: 'cleared' });
      evidence.closedTabNotificationCleared = true;
      await requestAuthenticatedGateway({
        gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.reminders.create',
        params: { schemaVersion: 1, topicId: desktopJourney.topicId, logicalOperationId: randomUUID(), declaration: { name: 'Fictional replacement due reminder', enabled: true, deleteAfterRun: false, schedule: { kind: 'at', at: new Date(Date.now() - 120_000).toISOString() }, payload: { kind: 'systemEvent', text: 'Fictional replacement release reminder' }, sessionTarget: 'main', wakeMode: 'next-heartbeat' } }
      });
      const revokedContext = await browser.newContext({ viewport: { width: 320, height: 900 } });
      try {
        const revokedPage = await revokedContext.newPage();
        await revokedPage.goto(`${gatewayUrl}/plugin?plugin=command-center&id=command-center`, { waitUntil: 'domcontentloaded' });
        const revokedBootstrap = await revokedContext.request.get(`${gatewayUrl}${runtimeCapability.bootstrap.path}`);
        assert.equal(revokedBootstrap.ok(), false);
        assert.equal(await revokedPage.locator('iframe.plugin-tab-embed__frame').count(), 0);
        const forgedEpisode = closedDashboard.attention.find((episode) => episode.episodeId !== closedEpisode.episodeId && episode.sourceCapabilityId === 'reminders');
        const forged = await revokedContext.request.post(`${gatewayUrl}/plugins/command-center/api/attention/actions`, { data: {
          schemaVersion: 1, logicalOperationId: randomUUID(), sourceCapabilityId: forgedEpisode.sourceCapabilityId, stableSubjectId: forgedEpisode.stableSubjectId,
          episodeId: forgedEpisode.episodeId, expectedEpisodeRevision: Math.max(0, forgedEpisode.revision - 1), expectedSourceRevision: forgedEpisode.sourceRevision,
          topicId: forgedEpisode.topicId, sourceReferenceId: forgedEpisode.sourceReferenceId, actionId: 'reminder.complete', input: { expectedConfigRevision: forgedEpisode.sourceRevision }
        } });
        assert.equal(forged.status(), 400);
        evidence.revokedMutationRejected = true;
      } finally { await revokedContext.close(); }
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
      const reopenedBootstrap = observeBrowserResponse(
        page.waitForResponse((response) => isControlUiBootstrapUrl(response.url(), { gatewayUrl, bootstrapPath: runtimeCapability.bootstrap.path }), { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      pluginDocument = observeBrowserResponse(
        page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }),
        (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message))
      );
      await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded' });
      const reopenedConfigResponse = await reopenedBootstrap;
      assert.equal(hasSuccessfulBrowserResponse(reopenedConfigResponse), true);
      const reopenedConfig = await reopenedConfigResponse.value.json();
      assert.equal(routeGrant(reopenedConfig), true);
      assert.equal(evidence.revokedMutationRejected, true);
      assert.doesNotMatch(JSON.stringify(reopenedConfig), /tokenHash/iu);
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument));
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
      await waitForDashboard(frame);
      const restoredTopic = frame.locator('.topic-row').filter({ hasText: 'Fictional Desktop Journey Topic' });
      await restoredTopic.getByRole('button', { name: 'Open Topic', exact: true }).click();
      await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
      await selectWorkspaceSection(frame, 'conversations', 1440);
      await frame.locator('.conversation-item').filter({ hasText: desktopJourney.conversationName }).getByText('Open', { exact: true }).waitFor();
      const reopenedSessions = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: desktopJourney.topicId } });
      const reopenedPrimary = (reopenedSessions?.result ?? reopenedSessions)?.conversations?.find((session) => session.isPrimary === true) ?? (reopenedSessions?.conversations ?? []).find((session) => session.isPrimary === true);
      const reopenedNavigation = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId: desktopJourney.topicId, referenceId: reopenedPrimary.referenceId } });
      const reopenedTarget = reopenedNavigation?.result ?? reopenedNavigation;
      assert.deepEqual({ referenceId: reopenedPrimary?.referenceId, sessionId: reopenedPrimary?.sessionId, sessionKey: reopenedTarget?.sessionKey }, { referenceId: releaseState.primarySession.referenceId, sessionId: releaseState.primarySession.sessionId, sessionKey: releaseState.primarySession.sessionKey });
      const reopenedOrdinary = ((reopenedSessions?.result ?? reopenedSessions)?.conversations ?? reopenedSessions?.conversations ?? []).find((session) => session.displayName === desktopJourney.conversationName);
      assert.deepEqual({ referenceId: reopenedOrdinary?.referenceId, sessionId: reopenedOrdinary?.sessionId }, releaseState.durableWorkspace.conversation);
      await selectWorkspaceSection(frame, 'notes', 1440);
      await frame.locator('#notes-tree').getByRole('button', { name: desktopJourney.movedPath, exact: true }).waitFor();
      const reopenedNotes = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.notes.browse', params: { schemaVersion: 1, topicId: desktopJourney.topicId } });
      const reopenedNote = ((reopenedNotes?.result ?? reopenedNotes)?.notes ?? reopenedNotes?.notes ?? []).find((note) => note.path === desktopJourney.movedPath);
      assert.deepEqual({ referenceId: reopenedNote?.sourceReference?.referenceId, revision: reopenedNote?.revision, path: reopenedNote?.path }, releaseState.durableWorkspace.note);
      await selectWorkspaceSection(frame, 'search', 1440);
      await frame.locator('#workspace-search-query').fill('Edited fictional journey evidence');
      await frame.locator('#workspace-search-form').evaluate((form) => form.requestSubmit());
      await waitForFrameText(frame, '#workspace-search-status', '1 Notes');
      await waitForCommittedSearchProjections(releaseState.projectionRoot);
      await frame.locator('#workspace-back').click();
      await waitForDashboard(frame);
      releaseState.restored = true;
      const attentionCards = frame.locator('#attention-cards .attention-card');
      await assert.doesNotReject(attentionCards.nth(1).waitFor({ state: 'visible', timeout: 15_000 }));
      const attentionCard = attentionCards.first();
      const sourceActionCard = attentionCards.nth(1);
      const sourceAction = sourceActionCard.getByRole('button', { name: 'Complete Reminder', exact: true });
      const sourceActionStarted = activate(sourceAction, true);
      await frame.waitForFunction(() => !document.querySelector('#in-progress')?.textContent?.includes('Nothing in progress'), undefined, { timeout: 10_000 });
      await sourceActionStarted;
      await waitForFrameText(frame, '#dashboard-feedback', 'Complete Reminder accepted.');
      const sourceActivity = await frame.evaluate(async () => {
        const response = await fetch('/plugins/command-center/api/dashboard?activityOffset=0&activityLimit=50', { credentials: 'omit', headers: { accept: 'application/json' } });
        return (await response.json()).result;
      });
      const completedActivity = sourceActivity.activity.records.find((record) => /reminder.*complete|complete.*reminder/iu.test(record.operationKind ?? '') && record.outcome === 'applied');
      assert.ok(completedActivity?.activityId && completedActivity?.logicalOperationId);
      releaseState.sourceActionActivity = completedActivity;
      assert.notEqual(clearedEmission.emission_id, undefined);
      await attentionCard.waitFor({ state: 'visible', timeout: 15_000 });
      await activate(attentionCard.getByRole('button', { name: 'View evidence', exact: true }), true);
      assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
      assert.ok((await frame.locator('#evidence-content').innerText()).length > 0);
      await activate(frame.locator('#evidence-close'), true, 'Escape');
      await chooseOption(attentionCard.locator('select[aria-label="Snooze duration"]'), 'PT72H', true);
      const actionStarted = Date.now();
      await activate(attentionCard.getByRole('button', { name: 'Snooze', exact: true }), true);
      await waitForFrameText(frame, '#dashboard-feedback', 'Item snoozed.');
      evidence.performanceMeasurements = { desktop: { ...desktopJourney.measurement, sourceActionMs: Date.now() - actionStarted } };
      assert.ok(await frame.locator('#in-progress').count() === 1);
      const activityStarted = Date.now();
      const loadMoreActivity = frame.locator('#activity-load-more');
      await loadMoreActivity.waitFor({ state: 'visible' });
      const firstActivityPage = await readDashboard(gatewayUrl, { activityOffset: 0, activityLimit: 50 });
      const firstActivityIds = firstActivityPage.activity.records.map((record) => record.activityId);
      await activate(loadMoreActivity, true);
      await frame.waitForFunction(() => document.querySelectorAll('#activity .activity-row').length >= 51, undefined, { timeout: 10_000 });
      const secondActivityPage = await readDashboard(gatewayUrl, { activityOffset: 50, activityLimit: 50 });
      const secondActivityIds = secondActivityPage.activity.records.map((record) => record.activityId);
      assert.equal(new Set([...firstActivityIds, ...secondActivityIds]).size, firstActivityIds.length + secondActivityIds.length, 'Activity pagination must not duplicate identities');
      const renderedActivityIds = await frame.locator('#activity .activity-row').evaluateAll((rows) => rows.map((row) => row.dataset.activityId).filter(Boolean));
      assert.deepEqual(renderedActivityIds.slice(0, firstActivityIds.length), firstActivityIds, 'Activity page append must not replace or reorder page one');
      desktopJourney.measurement.activityPageAppendMs = Math.max(1, Date.now() - activityStarted);
      releaseState.activityPaged = true;
      for (const name of RELEASE_MEASUREMENTS) assertPerformanceObservationWithinBaseline(name, desktopJourney.measurement[name], baseline);
      return { restored: true, sentEmissionId: closedTabEmission.emission_id, clearedEmissionId: clearedEmission.emission_id, activityId: completedActivity.activityId, realizedFixtureCounts: { ...releaseState.realizedScaleSeed, conversations: realizedConversationCount, activityRecords: realizedActivityRecords, actionCards: seededReminders.length + seededTopicReviews.length, indexedNotes: releaseState.realizedSearchCounts.notes, indexedConversations: releaseState.realizedSearchCounts.conversationMessages } };
    });
    await collectScenario('mobile-accessibility-journey', async () => {
      requireScenario('pinned-host-startup');
      await page.close();
      page = await browser.newPage({ viewport: { width: 320, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }), (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded' });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument));
      mobileJourney = await runUiJourney(frame, { width: 320, name: 'Fictional Mobile Journey Topic', category: 'project', keyboard: true });
      releaseState.mobile = mobileJourney;
      for (const label of ['Keyboard source action', 'Keyboard snooze']) {
        await requestAuthenticatedGateway({
          gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.reminders.create',
          params: { schemaVersion: 1, topicId: mobileJourney.topicId, logicalOperationId: randomUUID(), declaration: { name: `Fictional ${label}`, enabled: true, deleteAfterRun: false, schedule: { kind: 'at', at: new Date(Date.now() - 60_000).toISOString() }, payload: { kind: 'systemEvent', text: `Fictional ${label} reminder` }, sessionTarget: 'main', wakeMode: 'next-heartbeat' } }
        });
      }
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument));
      await waitForDashboard(frame);
      const mobileCards = frame.locator('#attention-cards .attention-card').filter({ hasText: 'Fictional Keyboard' });
      await mobileCards.nth(1).waitFor({ state: 'visible' });
      await activate(mobileCards.first().getByRole('button', { name: 'View evidence', exact: true }), true);
      assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
      await page.keyboard.press('Escape');
      await chooseOption(mobileCards.first().locator('select[aria-label="Snooze duration"]'), 'PT72H', true);
      await activate(mobileCards.first().getByRole('button', { name: 'Snooze', exact: true }), true);
      await waitForFrameText(frame, '#dashboard-feedback', 'Item snoozed.');
      await activate(mobileCards.nth(1).getByRole('button', { name: 'Complete Reminder', exact: true }), true);
      await waitForFrameText(frame, '#dashboard-feedback', 'Complete Reminder accepted.');
      if (await frame.locator('#activity-load-more').isVisible()) await activate(frame.locator('#activity-load-more'), true);
      await assertResponsiveFrame(frame, page, 320);
      await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
      await page.setViewportSize({ width: 1280, height: 900 });
      await frame.evaluate(() => { document.documentElement.style.zoom = '4'; });
      const reflowJourney = await runUiJourney(frame, { width: 1280, name: 'Fictional 400 Percent Reflow Topic', category: 'resource', keyboard: true });
      assert.ok(reflowJourney.topicId);
      await assertResponsiveFrame(frame, page, 1280);
      await frame.evaluate(() => { document.documentElement.style.zoom = ''; });
      await page.setViewportSize({ width: 320, height: 900 });
      await assertKeyboardAccessibility(frame, page);
      evidence.performanceMeasurements.mobile = { ...mobileJourney.measurement, sourceActionMs: 0 };
      return { topicId: mobileJourney.topicId, viewport: '320x900', keyboardAndReflow: true, reflow400TopicId: reflowJourney.topicId };
    });
    await collectScenario('desktop-primary-journey-review', async () => {
      requireScenario('pinned-host-startup', 'mobile-accessibility-journey');
      await activate(frame.locator('#analysis-run'), true);
      await waitForFrameText(frame, '#analysis-feedback', 'Analysis completed.');
      const mobileRow = frame.locator('.topic-row').filter({ hasText: 'Fictional Mobile Journey Topic' });
      await page.once('dialog', (dialog) => dialog.accept('Area: Fictional Mobile Journey Topic'));
      await activate(mobileRow.getByRole('button', { name: 'Rename', exact: true }), true);
      await waitForFrameText(frame, '#topic-status', 'Topic renamed.');
      await activate(frame.locator('#analysis-run'), true);
      await waitForFrameText(frame, '#analysis-feedback', 'Analysis completed.');
      const proposal = frame.locator('.topic-review-proposal').first();
      await proposal.waitFor({ state: 'visible', timeout: 15_000 });
      await activate(proposal.getByRole('button', { name: 'Approve', exact: true }), true);
      await waitForFrameText(frame, '#analysis-feedback', 'Proposal decision saved.');
      const checkpoint = frame.locator('#topic-review-checkpoint');
      await checkpoint.waitFor({ state: 'visible' });
      await page.once('dialog', (dialog) => dialog.dismiss());
      await activate(checkpoint, true);
      await waitForFrameText(frame, '#topic-review-plan', 'Frozen application plan');
      const frozenPlanText = await frame.locator('#topic-review-plan').innerText();
      const frozenPlan = JSON.parse(frozenPlanText.slice(frozenPlanText.indexOf('{')));
      assert.match(frozenPlan.planRevision, /^sha256:[a-f0-9]{64}$/u);
      await page.once('dialog', (dialog) => dialog.accept());
      await activate(checkpoint, true);
      await waitForFrameText(frame, '#topic-review-plan', 'Application outcomes:');
      const appliedReviewResponse = await frame.evaluate(async () => {
        const response = await fetch('/plugins/command-center/api/topic-analysis', { credentials: 'omit', headers: { accept: 'application/json' } });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(appliedReviewResponse.status, 200);
      const appliedReview = appliedReviewResponse.body?.result ?? appliedReviewResponse.body;
      assert.equal(appliedReview?.review?.state ?? appliedReview?.state, 'Resolved');
      const durableProposals = appliedReview?.review?.proposals ?? appliedReview?.proposals ?? [];
      assert.deepEqual(durableProposals.map(({ proposalId, revision }) => ({ proposalId, revision })), frozenPlan.proposalRevisions);
      releaseState.reviewApplied = true;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      await assertResponsiveFrame(frame, page, 320);
      return { planRevision: frozenPlan.planRevision, appliedProposalCount: durableProposals.length };
    });
    if (scenarioFailures.length > 0) failure = new AggregateError(scenarioFailures.map(({ error }) => error), `Release scenarios failed: ${scenarioFailures.map(({ id }) => id).join(', ')}`);
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
    const rows = await runAcceptanceRows([
      { id: 'pinned-host-startup', run: async () => ({ ...requireScenario('pinned-host-startup')['pinned-host-startup'], globalTabLifecycle: requireScenario('scale-performance')['scale-performance'], secureLifecycle: await exerciseSecureHostVariant({ descriptor, buildReceipt }) }) },
      { id: 'desktop-primary-journey', run: async () => ({ ...requireScenario('desktop-primary-journey')['desktop-primary-journey'], lifecycle: requireScenario('scale-performance')['scale-performance'], review: requireScenario('desktop-primary-journey-review')['desktop-primary-journey-review'] }) },
      { id: 'mobile-accessibility-journey', run: async () => requireScenario('mobile-accessibility-journey')['mobile-accessibility-journey'] },
      { id: 'scale-performance', run: async () => { const executed = requireScenario('scale-performance')['scale-performance']; assert.deepEqual((await readdir(releaseState.projectionRoot)).sort(), COMMITTED_SEARCH_PROJECTION_FILES); return { ...executed, fixtureIdentity: releaseState.baseline.fixtureIdentity, fixtureCounts: releaseState.baseline.fixtureCounts }; } },
      { id: 'degraded-bridge-grants', run: async () => exerciseOperatingModeMatrix(path.join(world.tempRoot, 'mode-row-bridge')) },
      { id: 'degraded-source-availability', run: async () => exerciseOperatingModeMatrix(path.join(world.tempRoot, 'mode-row-source')) },
      { id: 'recovery-only-compatibility', run: async () => exerciseOperatingModeMatrix(path.join(world.tempRoot, 'mode-row-recovery')) },
      { id: 'destructive-migration-restoration', run: async () => exerciseRestorationMatrix(path.join(world.tempRoot, 'release-restoration-row')) },
      { id: 'privacy-artifact-output', run: async () => { await scanRepositorySafety(process.cwd(), { generated: [path.join(process.cwd(), 'dist')] }); scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(boundedHostEvidence(host.diagnostics)), redactBrowserEvidence(failure?.message || '')]); return { scanned: true }; } }
    ]);
    assert.deepEqual(rows.map((row) => row.id), RELEASE_ROW_IDS);
    const finalizationPhases = ['browser-close', 'host-stop', 'browser-traffic', 'host-traffic', 'child-traffic', 'build-digest'].map((phase) => ({ phase, error: finalizationErrors.find((entry) => entry.phase === phase)?.error }));
    const report = createAcceptanceReport({ buildDigest: buildReceipt.digest, rows, finalization: finalizationPhases });
    if (!failure && finalizationErrors.length > 0) failure = finalizationErrors[0].error;
    if (!failure) {
      try { assertAcceptanceReportPassed(report); }
      catch (error) { failure = error; }
    }
    const diagnosticPayload = {
      ...evidence,
      host: boundedHostEvidence(host.diagnostics),
      finalizationErrors: finalizationErrors.map(({ phase, error }) => ({ phase, error: redactBrowserEvidence(error?.message || error) })),
      acceptanceReport: report,
      failure: failure ? redactBrowserEvidence(failure.message || failure) : undefined
    };
    scanPublicEvidence([JSON.stringify(report), JSON.stringify(diagnosticPayload)]);
    if (failure) {
      failure.diagnostics = { ...(failure.diagnostics || {}), ...diagnosticPayload };
      throw failure;
    }
  }, { candidateRoot: process.cwd() });
  testContext.diagnostic(`acceptance-result=${JSON.stringify({
    schemaVersion: 1,
    outcome: 'passed',
    releaseRows: RELEASE_ROW_IDS,
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
