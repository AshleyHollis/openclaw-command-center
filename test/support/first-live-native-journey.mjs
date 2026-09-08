import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { finalizeAcceptanceJourney } from '../../src/acceptance-finalization.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, recordBounded } from '../../src/browser-evidence.mjs';
import { assertBuiltDigest } from '../../src/build.mjs';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, fetchJsonWithDeadline, launchPinnedHost, restartPinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { assertWebSocketDestination, TrafficGuard } from '../../src/isolation.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath } from '../../src/metadata/path.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { enrollNoteFolderIdentity } from '../../src/sources/note-folder-identity.mjs';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isCommandCenterMigrationReady, readCommandCenterMigrationProgress, recordStartupObservation } from '../../src/acceptance-readiness.mjs';
import { scanPublicEvidence } from '../../src/safety.mjs';
import { withDeadline, stopHostOnAbort, launchManagedBrowser, closeManagedBrowser, redactBrowserEvidence, boundedHostEvidence, configureEvidencePage, requestAuthenticatedGateway, readAuthenticatedHistory } from './real-host-runtime.mjs';
import { exerciseNativeKeyboardStates } from './first-live-native-keyboard.mjs';
import { prepareNativeLegacyBootstrap, readNativeLegacyBootstrap } from './first-live-native-bootstrap.mjs';
import { prepareNativeScaleConversations, exerciseNativeScaleStates } from './first-live-native-scale.mjs';

// The receipt wrapper and future retained variants share this actual native
// journey. Host admission, exact source proofs and finalization stay mandatory.
export async function seedNativeExistingTopic({ world, host, signal }) {
  const stateDir = path.join(world.root, '.openclaw');
  await waitForConsecutiveReadiness(async () => isCommandCenterMetadataReady(resolveCommandCenterDatabasePath(stateDir)), host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
  const topicId = '44444444-4444-4444-8444-444444444444';
  const name = 'Fictional Native Journey';
  const folderReferenceId = 'fictional-native-journey-folder';
  const sessionReferenceId = 'fictional-native-journey-primary';
  const notePath = 'Overview.md';
  const noteText = '# Fictional Native Journey\nExisting authoritative Note — read only.\n';
  const sessionKey = `agent:main:command-center:acceptance-native:${topicId}`;
  // Fixture setup uses the real Session owner, not a fabricated catalog row or
  // the deferred Topic-provisioning/legacy authoritativeSession escape hatch.
  const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: 'sessions.create', params: { agentId: 'main', key: sessionKey, label: name }, scopes: ['operator.read', 'operator.write'], signal });
  const created = response?.result ?? response;
  assert.equal(created?.key, sessionKey);
  assert.equal(typeof created?.sessionId, 'string');
  assert.ok(created.sessionId.length > 0);
  assert.equal(created.runStarted, false, 'Fixture setup must not start an agent run');
  const folder = path.join(world.paths.vault, 'Projects', name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, notePath), noteText, { flag: 'wx' });
  const identity = await enrollNoteFolderIdentity(folder);
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
  try {
    metadata.createTopic({ topicId, name, paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: folderReferenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
    metadata.setSourceLocator({ referenceId: folderReferenceId, locator: folder, ownership: 'external', observedRevision: identity });
    metadata.createSourceReference({ version: 1, referenceId: sessionReferenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
    metadata.setSessionState({ referenceId: sessionReferenceId, sessionId: created.sessionId, status: 'open', isPrimary: true, displayName: name });
  } finally { metadata.close(); }
  return Object.freeze({ topicId, name, sessionReferenceId, sessionKey, sessionId: created.sessionId, notePath, noteText, folder });
}

async function waitForNativeControlUiReadiness({ world, host, signal, scale, observations }) {
  const startedAt = Date.now();
  const record = value => {
    if (!observations) return;
    recordStartupObservation(observations, { elapsedMs: Date.now() - startedAt, ...value });
  };
  if (scale) {
    // The scale import deliberately keeps the plugin startup owner busy before
    // the Control UI route can serve a complete response. Wait on that owner's
    // durable completion marker first so an accepted HTTP request cannot sit
    // behind the migration and consume the entire transport deadline.
    const stateDir = path.join(world.root, '.openclaw');
    await waitForConsecutiveReadiness(
      async () => {
        const databasePath = resolveCommandCenterDatabasePath(stateDir);
        if (observations) record({ stage: 'migration', ...readCommandCenterMigrationProgress(databasePath) });
        return isCommandCenterMigrationReady(databasePath);
      },
      host.earlyExit,
      { deadlineMs: 180_000, delayMs: 250, signal }
    );
  }
  let attempt = 0;
  await waitForConsecutiveReadiness(async (probeSignal) => {
    const observation = { stage: 'http', attempt: ++attempt, url: `${world.gateway.url}${runtimeCapability.bootstrap.path}`, status: null, error: null, bodyKeys: [] };
    try {
      const { response, body, parseError } = await fetchJsonWithDeadline(observation.url, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal: probeSignal }, { label: 'native Control UI readiness', timeoutMs: 30_000 });
      observation.status = response.status;
      observation.bodyKeys = body && typeof body === 'object' ? Object.keys(body).sort().slice(0, 24) : [];
      observation.error = parseError ? redactBrowserEvidence(parseError.message) : null;
      return response.ok && !parseError;
    } catch (error) {
      observation.error = redactBrowserEvidence(`${error?.category ?? error?.cause?.code ?? error?.code ?? 'transport'}: ${error?.message ?? 'readiness failed'}`);
      throw error;
    } finally {
      record(observation);
    }
  }, host.earlyExit, { required: 2, deadlineMs: scale ? 180_000 : 120_000, delayMs: 250, signal });
  // Static bootstrap HTTP can be available before authenticated Gateway
  // admission opens. Probe the read-only route before issuing any mutations.
  await waitForConsecutiveReadiness(async () => {
    const catalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url,
      credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
    return !!catalog?.plugins?.find(entry => entry.pluginId === 'command-center')?.revision;
  }, host.earlyExit, { required: 1, deadlineMs: 30_000, delayMs: 250, signal });
}

export async function exerciseNativeControlUiActivation({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, keyboard: false });
}

export async function exerciseNativeScaleStartup({ descriptor, buildReceipt, signal, onFinalization, onDiagnostic }) {
  // Qualify the complete preparation/restart transition before measurement.
  return exerciseNativeStartup({ descriptor, buildReceipt, signal, onFinalization, onDiagnostic }, { scale: true, conversations: true, restart: true });
}

// Non-measuring reproduction of the preparation boundary. It shares startup,
// authenticated source reads and finalization, but never restarts for timing or
// launches the measured browser journey.
export async function exerciseNativeConversationPreparation(options, { scale = true } = {}) {
  return exerciseNativeStartup(options, { scale, conversations: true });
}

export async function exerciseNativeRetainedStartup(options, { scale = true, conversations = true } = {}) {
  return exerciseNativeStartup(options, { scale, conversations, restart: true });
}

export async function readRetainedNativeBootstrap(options, { waitForReady = waitForNativeControlUiReadiness, readBootstrap = readNativeLegacyBootstrap } = {}) {
  // A spawned successor is not yet an authenticated, listening Gateway.
  // This wait remains inside the caller's startup measurement and deadline.
  await waitForReady({ ...options, scale: false });
  return readBootstrap(options);
}

async function exerciseNativeStartup({ descriptor, buildReceipt, signal, onFinalization, onDiagnostic }, { scale, conversations, restart = false }) {
  return withIsolatedWorld(async (world) => {
    const bootstrap = await prepareNativeLegacyBootstrap({ world, signal, scale });
    let host = await withDeadline('native scale host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    let removeAbortCleanup = stopHostOnAbort(signal, host);
    const stages = [];
    const readinessAttempts = [];
    let failure;
    let result;
    try {
      await waitForNativeControlUiReadiness({ world, host, signal, scale, observations: readinessAttempts });
      const catalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
      const plugin = catalog?.plugins?.find(entry => entry.pluginId === 'command-center');
      assert.ok(plugin?.revision);
      const imported = await readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 1 });
      if (conversations) await prepareNativeScaleConversations({ world, host, signal, fixture: imported.fixture });
      stages.push('initial-readback-passed');
      if (restart) {
        await stopPinnedHost(host.child);
        await host.outputDrained;
        stages.push('predecessor-stopped');
        host = await withDeadline('native retained diagnostic restart', restartSignal => restartPinnedHost(host, { signal: restartSignal }), 120_000, signal);
        removeAbortCleanup();
        removeAbortCleanup = stopHostOnAbort(signal, host);
        stages.push('successor-launched');
        await readRetainedNativeBootstrap({ world, host, signal, bootstrap, expectedConversationCount: conversations ? 100 : 1 });
        stages.push('retained-readback-passed');
      }
      result = Object.freeze({ schemaVersion: 1, pluginId: 'command-center', revision: plugin.revision, fixtureCounts: Object.freeze({ noteBytes: Buffer.byteLength(bootstrap.noteText), noteFiles: (bootstrap.scaleNotes?.length ?? 0) + 1, conversationMessages: bootstrap.prepared.occurrenceCount, conversations: conversations ? 100 : 1 }), readinessAttempts: Object.freeze([...readinessAttempts]), migrationReady: Boolean(imported.completion), retainedRestartVerified: restart });
    } catch (error) { failure = error; }
    finally {
      const cleanup = await finalizeAcceptanceJourney({
        closeBrowser: async () => {},
        stopHost: async () => { for (const generation of [...host.generations].reverse()) { await stopPinnedHost(generation.child); await generation.outputDrained; } },
        assertBrowserTraffic: () => {},
        assertHostTraffic: () => { for (const generation of host.generations) { generation.diagnostics.guard.assertClean(); assertNoFatalHostOutput(generation.diagnostics); if (generation.diagnostics.cleanupError) throw generation.diagnostics.cleanupError; } },
        assertChildTraffic: () => assertRecordedChildTraffic(world),
        assertBuildDigest: () => assertBuiltDigest(buildReceipt),
        onProgress: onFinalization
      });
      removeAbortCleanup();
      if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map(entry => entry.error)], 'Native scale startup finalization failed');
    }
    const diagnostic = Object.freeze({ schemaVersion: 1, scenario: restart ? 'diagnostic-retained-startup' : conversations ? 'diagnostic-conversation-preparation' : 'diagnostic-scale-startup', outcome: failure ? 'failed' : 'passed',
      stages: Object.freeze(stages), readinessAttempts: Object.freeze([...readinessAttempts]), host: boundedHostEvidence(host.diagnostics) });
    scanPublicEvidence([JSON.stringify(diagnostic)]);
    // Publish after cleanup and privacy checks, including on failure. The outer
    // slice may replace a timeout error, so error properties alone lose evidence.
    onDiagnostic?.(diagnostic);
    if (failure) throw failure;
    return result;
  }, { candidateRoot: process.cwd() });
}

// This is a separate retained row, not additional work inside the activation
// diagnostic's deadline. The dispatcher owns its total row budget; stage and
// resource deadlines remain bounded here. Runtime duration is not yet measured.
export async function exerciseNativeKeyboardJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, keyboard: true });
}

export async function exerciseNativeJourney({ descriptor, buildReceipt, signal, keyboard = false, scale = false, onFinalization }) {
  assert.equal(keyboard && scale, false, 'Performance qualification cannot share a keyboard diagnostic');
  return withIsolatedWorld(async (world) => {
    const bootstrap = keyboard ? null : await prepareNativeLegacyBootstrap({ world, signal, scale });
    let host = await withDeadline('native pinned host launch', (launchSignal) => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    let removeAbortCleanup = stopHostOnAbort(signal, host);
    const browserGuard = new TrafficGuard();
    const evidence = { requests: [], responses: [], console: [], errors: [] };
    let managedBrowser;
    const abortBrowser = () => { void managedBrowser?.server.kill().catch(() => {}); };
    signal.addEventListener('abort', abortBrowser, { once: true });
    let failure;
    let result;
    const restartHost = async () => {
      const predecessor = host;
      await withDeadline('native retained host restart', async (restartSignal) => {
        host = await restartPinnedHost(predecessor, { signal: restartSignal });
        return host;
      }, 120_000, signal);
      removeAbortCleanup();
      removeAbortCleanup = stopHostOnAbort(signal, host);
      assert.notEqual(host.child, predecessor.child);
      assert.equal(host.endpoint, predecessor.endpoint);
      assert.equal(host.generations.length, predecessor.generations.length + 1);
      assert.ok(predecessor.child.exitCode !== null || predecessor.child.signalCode !== null);
      return host;
    };
    try {
      let catalog;
      // Startup-only diagnosis and measured scale use this exact owner.
      await waitForNativeControlUiReadiness({ world, host, signal, scale });
      await waitForConsecutiveReadiness(async () => {
        try {
          catalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
          return Array.isArray(catalog?.plugins) && catalog.plugins.some((plugin) => plugin.pluginId === 'command-center');
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
      const matches = catalog.plugins.filter((plugin) => plugin.pluginId === 'command-center');
      assert.equal(matches.length, 1);
      const native = matches[0];
      assert.match(native.revision, /^[a-f0-9]{64}$/u);
      const grantPrefix = '/__openclaw__/plugins/control-ui/command-center/';
      const entryUrl = new URL(native.entryUrl, world.gateway.url);
      assert.equal(entryUrl.origin, new URL(world.gateway.url).origin);
      assert.equal(entryUrl.pathname, `${grantPrefix}${native.revision}/entry.mjs`);
      assert.equal(entryUrl.search, '');
      assert.equal(entryUrl.hash, '');
      const { response, body, parseError } = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'native authenticated bootstrap', timeoutMs: 10_000 });
      assert.equal(response.ok, true);
      assert.equal(parseError, undefined);
      assert.equal(body?.pluginAssetsRequireAuth, true);
      assert.equal(body?.pluginFrameGrants?.some((grant) => grant.pluginId === 'command-center' && grant.match === 'prefix' && grant.path === grantPrefix), true);
      assert.equal(JSON.stringify(body).includes(world.gatewayCredential), false);

      let bootstrapped = keyboard ? null : await readNativeLegacyBootstrap({ world, host, signal, bootstrap });
      let startupReadinessMs;
      if (scale) {
        await prepareNativeScaleConversations({ world, host, signal, fixture: bootstrapped.fixture });
        // Corpus preparation is not timed. Stop the setup generation before the
        // measured restart; reuse the issued owner, state and reserved endpoint.
        await stopPinnedHost(host.child);
        await host.outputDrained;
        const started = performance.now();
        await restartHost();
        bootstrapped = await readRetainedNativeBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 100,
          onReady: () => { startupReadinessMs = performance.now() - started; } });
      }
      const fixture = keyboard ? await seedNativeExistingTopic({ world, host, signal }) : bootstrapped.fixture;
      managedBrowser = await withDeadline('native browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }), 60_000, signal);
      const page = await managedBrowser.browser.newPage({ viewport: { width: 1440, height: 900 } });
      if (keyboard) await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await configureEvidencePage(page, browserGuard, evidence);
      let browserTopics;
      let browserNavigation;
      let browserNote;
      let browserChatSend;
      let browserChatAcknowledgement;
      const scaleResponses = { notes: undefined, rosters: [], rosterOverflow: false };
      const conversationLabel = scale ? 'Fictional Native Scale 100' : 'Fictional Native Follow-up';
      const messageText = 'Fictional native Conversation message for exact Session readback.';
      // Observe the existing real-server WebSocket route without substituting
      // any request, response, authentication or activation report.
      await page.routeWebSocket('**/*', (socket) => {
        try { assertWebSocketDestination(browserGuard, socket.url()); }
        catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); void socket.close(); return; }
        const server = socket.connectToServer();
        const requests = new Map();
        socket.onMessage((payload) => {
          server.send(payload);
          let message; try { message = JSON.parse(String(payload)); } catch { return; }
          if (message?.type === 'req' && (['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.notes.read', 'command-center.v1.sessions.navigate', ...(scale ? ['command-center.v1.notes.browse'] : [])].includes(message.method) && message.params?.schemaVersion === 1 || scale && message.method === 'sessions.list') && requests.size < 32) requests.set(message.id, { method: message.method, params: message.params });
          if (message?.type === 'req' && message.method === 'chat.send' && message.params?.message === messageText) {
            browserChatSend = message;
          }
        });
        server.onMessage((payload) => {
          socket.send(payload);
          let message; try { message = JSON.parse(String(payload)); } catch { return; }
          if (message?.type !== 'res') return;
          if (browserChatSend?.id === message.id) browserChatAcknowledgement = message;
          const request = requests.get(message.id);
          requests.delete(message.id);
          if (!request || message.ok !== true) return;
          const value = message.payload?.result ?? message.payload;
          if (request.method === 'command-center.v1.topics.list') browserTopics = value;
          if (request.method === 'command-center.v1.notes.read') browserNote = { input: request.params, value };
          if (request.method === 'command-center.v1.sessions.navigate') browserNavigation = { input: request.params, value };
          if (scale && request.method === 'command-center.v1.notes.browse') scaleResponses.notes = { input: request.params, value };
          if (scale && request.method === 'sessions.list') {
            if (scaleResponses.rosters.length < 256) scaleResponses.rosters.push({ input: request.params, value });
            else scaleResponses.rosterOverflow = true;
          }
        });
      });
      const entryResponse = observeBrowserResponse(page.waitForResponse((candidate) => candidate.request().method() === 'GET' && candidate.url() === entryUrl.href, { timeout: 60_000 }), (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      // Navigate only through the real host router; its native loader imports
      // the revisioned entry and reports activation on its own live connection.
      const topicsStarted = performance.now();
      await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const loadedEntry = await entryResponse;
      assert.equal(hasSuccessfulBrowserResponse(loadedEntry), true, 'The actual native loader must fetch its granted revisioned asset');
      assert.deepEqual(await loadedEntry.value.body(), await readFile(path.join(process.cwd(), 'dist/native-ui/entry.mjs')), 'Native entry bytes must belong to the sealed candidate');
      const nativePage = page.locator('openclaw-plugin-page');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
      assert.equal(await nativePage.locator('iframe').count(), 0, 'Native activation must not fall back to the legacy iframe');
      if (keyboard) {
        result = await exerciseNativeKeyboardStates({ page, world, host, fixture, native, signal, restartHost, browserGuard });
      } else if (scale) {
        result = await exerciseNativeScaleStates({ page, world, host, signal, fixture, bootstrap, conversationLabel, messageText,
          startupReadinessMs, topicsStarted,
          observed: () => ({ topics: browserTopics, navigation: browserNavigation, chatSend: browserChatSend, chatAcknowledgement: browserChatAcknowledgement, ...scaleResponses }) });
        const playwrightPackage = JSON.parse(await readFile(new URL(import.meta.resolve('playwright-core/package.json')), 'utf8'));
        result = { ...result, browser: { engine: 'chromium', playwrightVersion: playwrightPackage.version, version: managedBrowser.browser.version() }, viewport: page.viewportSize() };
      } else {
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const authoritative = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
      const topics = authoritative?.result ?? authoritative;
      for (const category of ['project', 'area', 'resource']) {
        assert.ok(Array.isArray(topics?.activeGroups?.[category]));
        assert.deepEqual(browserTopics.activeGroups[category], topics.activeGroups[category]);
      }
      await nativePage.getByRole('button', { name: 'Refresh Topics', exact: true }).waitFor();
      const fixtureTopic = topics.activeGroups.project.find((topic) => topic.name === 'Fictional Native Journey');
      assert.ok(fixtureTopic, 'The native journey must exercise an existing Topic, not an empty Topics diagnostic');
      assert.equal(fixtureTopic.usable, true, 'The existing Topic must have verified source bindings');
      assert.equal(fixtureTopic.topicId, fixture.topicId);
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      const noteContent = nativePage.getByRole('region', { name: 'Note content', exact: true });
      await noteContent.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await noteContent.textContent(), fixture.noteText);
      assert.equal(browserNote?.input.topicId, fixture.topicId);
      assert.equal(browserNote?.input.path, fixture.notePath);
      assert.equal(browserNote?.value.sourceReference.topicId, fixture.topicId);
      assert.equal(browserNote?.value.sourceReference.referenceId, browserNote.input.referenceId);
      assert.equal(browserNote?.value.revision, `sha256:${createHash('sha256').update(fixture.noteText).digest('hex')}`);
      const originalNoteRead = structuredClone(browserNote);
      assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey);
      assert.equal(browserNavigation?.input.topicId, fixture.topicId);
      assert.equal(browserNavigation?.input.referenceId, fixture.sessionReferenceId);
      assert.equal(browserNavigation?.input.nativeChat, true);
      assert.equal(browserNavigation?.value.sessionKey, fixture.sessionKey);
      assert.equal(browserNavigation?.value.sessionId, fixture.sessionId);
      assert.equal(browserNavigation?.value.sourceReference.topicId, fixture.topicId);
      assert.equal(browserNavigation?.value.sourceReference.referenceId, fixture.sessionReferenceId);
      // Return through the host's native navigation contribution, not a new
      // page.goto/document or a synthetic plugin activation.
      await page.locator('openclaw-app-sidebar openclaw-plugin-contributions').getByRole('link', { name: 'Topics', exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await noteContent.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await noteContent.textContent(), fixture.noteText);
      assert.equal(await readFile(path.join(fixture.folder, fixture.notePath), 'utf8'), fixture.noteText, 'Native reading and Chat handoff must preserve the authoritative Note');
      const creationResponse = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).origin === new URL(world.gateway.url).origin
        && new URL(response.url()).pathname === '/plugins/command-center/api/topic/actions'
        && response.request().postDataJSON()?.action === 'conversations.create', { timeout: 30_000 }),
      (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      browserNavigation = undefined;
      await nativePage.getByRole('textbox', { name: 'Conversation label', exact: true }).fill(conversationLabel);
      await nativePage.getByRole('button', { name: 'Create Conversation', exact: true }).press('Enter');
      const observedCreation = await creationResponse;
      assert.equal(hasSuccessfulBrowserResponse(observedCreation), true);
      const creationInput = observedCreation.value.request().postDataJSON();
      assert.deepEqual(Object.keys(creationInput).sort(), ['action', 'expectedRevision', 'label', 'logicalOperationId', 'schemaVersion', 'topicId']);
      assert.equal(creationInput.topicId, fixture.topicId);
      assert.equal(creationInput.label, conversationLabel);
      assert.equal(creationInput.schemaVersion, 1);
      assert.match(creationInput.logicalOperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      const creationReceipt = await observedCreation.value.json();
      assert.equal(creationReceipt.status, 'applied');
      assert.equal(creationReceipt.logicalOperationId, creationInput.logicalOperationId);
      assert.equal(creationReceipt.result?.action, 'conversations.create');
      assert.equal(creationReceipt.result?.topicId, fixture.topicId);
      const newReferenceId = creationReceipt.result?.referenceId;
      assert.equal(typeof newReferenceId, 'string');
      assert.notEqual(newReferenceId, fixture.sessionReferenceId, 'Creating a Conversation must not reuse the existing Primary');
      // Replay the exact captured intent through the same declared authenticated
      // HTTP boundary. In particular, do not refresh its original Topic revision.
      assert.equal(observedCreation.value.request().headers()['x-openclaw-control-ui-relay'], '1');
      const replay = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
        body: JSON.stringify(creationInput)
      }, { label: 'native Conversation exact-intent replay', timeoutMs: 30_000 });
      assert.equal(replay.response.ok, true);
      assert.equal(replay.parseError, undefined);
      assert.deepEqual(replay.body, creationReceipt, 'Completed replay must preserve the original receipt, not create or rebind a Conversation');
      const catalogResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false }, signal });
      const conversations = catalogResponse?.result ?? catalogResponse;
      assert.equal(conversations.topicId, fixture.topicId);
      assert.equal(conversations.conversations.length, 2, 'The existing Primary and one new Conversation must remain the complete Topic catalog after replay');
      assert.equal(conversations.conversations.find((row) => row.isPrimary)?.referenceId, fixture.sessionReferenceId);
      const createdConversations = conversations.conversations.filter((row) => row.referenceId === newReferenceId);
      assert.equal(createdConversations.length, 1, 'The exact created Conversation must belong to the original Topic');
      const createdConversation = createdConversations[0];
      assert.equal(createdConversation.status, 'open');
      assert.equal(createdConversation.isPrimary, false);
      assert.notEqual(createdConversation.sessionId, fixture.sessionId);
      await waitForConsecutiveReadiness(async () => browserNavigation?.value.sourceReference?.referenceId === newReferenceId,
        host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const createdTarget = browserNavigation.value;
      assert.equal(browserNavigation.input.topicId, fixture.topicId);
      assert.equal(browserNavigation.input.referenceId, newReferenceId);
      assert.equal(createdTarget.sourceReference.topicId, fixture.topicId);
      assert.equal(createdTarget.sessionId, createdConversation.sessionId);
      assert.notEqual(createdTarget.sessionKey, fixture.sessionKey);
      assert.match(createdTarget.sessionKey, /^agent:main:.+$/u);
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, createdTarget.sessionKey);
      await chatPane.locator('.agent-chat__composer-combobox textarea').fill(messageText);
      await chatPane.getByRole('button', { name: 'Send message', exact: true }).press('Enter');
      await waitForConsecutiveReadiness(async () => !!browserChatAcknowledgement,
        host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      assert.equal(browserChatSend.params.sessionKey, createdTarget.sessionKey, 'The actual native composer must send to the newly linked Session');
      assert.equal(browserChatAcknowledgement.ok, true, 'The real host must acknowledge the native send');
      const containsUserMessage = (history) => history?.messages?.some((message) => message.role === 'user'
        && (message.text === messageText || message.content === messageText || Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && part.text === messageText)));
      let newHistory;
      await waitForConsecutiveReadiness(async () => {
        const response = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: createdTarget.sessionKey, signal });
        newHistory = response?.result ?? response;
        assert.equal(newHistory.sessionKey, createdTarget.sessionKey);
        assert.equal(newHistory.sessionId, createdTarget.sessionId);
        return containsUserMessage(newHistory);
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const primaryHistoryResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: fixture.sessionKey, signal });
      const primaryHistory = primaryHistoryResponse?.result ?? primaryHistoryResponse;
      assert.equal(primaryHistory.sessionId, fixture.sessionId);
      assert.equal(containsUserMessage(primaryHistory), false, 'New Conversation input must not leak into the existing Primary');
      await page.locator('openclaw-app-sidebar openclaw-plugin-contributions').getByRole('link', { name: 'Topics', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
      await nativePage.getByRole('button', { name: 'Refresh Notes', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await noteContent.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await noteContent.textContent(), fixture.noteText);
      // Restart the issued host into this same world. No state copy, new
      // descriptor, source rebinding or fixture reseeding is permitted here.
      await nativePage.getByRole('button', { name: 'All Topics', exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
      const predecessor = host;
      await restartHost();
      assert.notEqual(host.child, predecessor.child);
      assert.equal(host.endpoint, predecessor.endpoint);
      assert.equal(host.generations.length, 2);
      assert.equal(host.generations[0].diagnostics, predecessor.diagnostics);
      assert.ok(predecessor.child.exitCode !== null || predecessor.child.signalCode !== null);
      let restartedCatalog;
      await waitForConsecutiveReadiness(async () => {
        try {
          restartedCatalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
            method: 'plugins.controlUi.list', signal });
          return restartedCatalog?.plugins?.some((plugin) => plugin.pluginId === 'command-center');
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
      const restartedNative = restartedCatalog.plugins.filter((plugin) => plugin.pluginId === 'command-center');
      assert.equal(restartedNative.length, 1);
      assert.equal(restartedNative[0].revision, native.revision);
      assert.equal(restartedNative[0].entryUrl, native.entryUrl);
      const restartedBootstrap = await readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 2 });
      assert.deepEqual(restartedBootstrap, bootstrapped, 'Default startup must retain the exact bootstrap completion, source bindings and immutable imported prefix after restart');
      await waitForConsecutiveReadiness(async () => {
        try {
          const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
            method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
          const topics = response?.result ?? response;
          return topics?.activeGroups?.project?.some((topic) => topic.topicId === fixture.topicId && topic.usable === true);
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const restartedReplay = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
        body: JSON.stringify(creationInput)
      }, { label: 'native Conversation original-intent replay after restart', timeoutMs: 30_000 });
      assert.equal(restartedReplay.response.ok, true);
      assert.equal(restartedReplay.parseError, undefined);
      assert.deepEqual(restartedReplay.body, creationReceipt, 'Restart must preserve the original creation receipt and stale original Topic revision');
      const restartedConversationsResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false }, signal });
      const restartedConversations = restartedConversationsResponse?.result ?? restartedConversationsResponse;
      const catalogIdentities = (catalog) => catalog.conversations.map(({ referenceId, sessionId, isPrimary, status }) => ({ referenceId, sessionId, isPrimary, status }))
        .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
      assert.equal(restartedConversations.topicId, fixture.topicId);
      assert.equal(restartedConversations.conversations.length, 2);
      assert.deepEqual(catalogIdentities(restartedConversations), catalogIdentities(conversations), 'Both exact Session identities and the original Primary must survive restart/replay');
      const restartedHistoryResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: createdTarget.sessionKey, signal });
      const restartedHistory = restartedHistoryResponse?.result ?? restartedHistoryResponse;
      assert.equal(restartedHistory.sessionKey, createdTarget.sessionKey);
      assert.equal(restartedHistory.sessionId, createdTarget.sessionId);
      assert.equal(containsUserMessage(restartedHistory), true, 'The native user message must remain authoritative after host restart');
      const restartedPrimaryResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: fixture.sessionKey, signal });
      const restartedPrimary = restartedPrimaryResponse?.result ?? restartedPrimaryResponse;
      assert.equal(restartedPrimary.sessionKey, fixture.sessionKey);
      assert.equal(restartedPrimary.sessionId, fixture.sessionId);
      assert.equal(containsUserMessage(restartedPrimary), false);
      // Use a real document reload and native loader reconnect, discarding all
      // earlier observed values so a cached pre-restart projection cannot pass.
      browserTopics = undefined;
      browserNote = undefined;
      browserNavigation = undefined;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const restartedTopicResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
      const restartedTopics = restartedTopicResponse?.result ?? restartedTopicResponse;
      for (const category of ['project', 'area', 'resource']) assert.deepEqual(browserTopics.activeGroups[category], restartedTopics.activeGroups[category]);
      const restartedTopic = restartedTopics.activeGroups.project.filter((topic) => topic.topicId === fixture.topicId);
      assert.equal(restartedTopic.length, 1);
      assert.equal(restartedTopic[0].name, fixture.name);
      assert.equal(restartedTopic[0].usable, true);
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await noteContent.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await noteContent.textContent(), fixture.noteText);
      assert.deepEqual(browserNote?.input, originalNoteRead.input);
      assert.equal(browserNote?.value.path, fixture.notePath);
      assert.equal(browserNote?.value.revision, originalNoteRead.value.revision);
      // Observation timestamps can advance on reads; durable identity and
      // content revision must not. Do not confuse metadata freshness with loss.
      for (const field of ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt']) {
        assert.deepEqual(browserNote?.value.sourceReference[field], originalNoteRead.value.sourceReference[field]);
      }
      assert.equal(await readFile(path.join(fixture.folder, fixture.notePath), 'utf8'), fixture.noteText);
      assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey);
      assert.equal(browserNavigation?.input.topicId, fixture.topicId);
      assert.equal(browserNavigation?.input.referenceId, fixture.sessionReferenceId);
      assert.equal(browserNavigation?.value.sessionKey, fixture.sessionKey);
      assert.equal(browserNavigation?.value.sessionId, fixture.sessionId);
      assert.equal(browserNavigation?.value.sourceReference.referenceId, fixture.sessionReferenceId);
      assert.equal(browserNavigation?.value.sourceReference.topicId, fixture.topicId);
      let activation;
      await waitForConsecutiveReadiness(async () => {
        // Admin is restricted to this diagnostic read; no synthetic activation
        // report or browser authority is supplied by the harness.
        const status = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.status', params: { pluginId: 'command-center' }, scopes: ['operator.admin'], signal });
        const activations = status?.clients?.flatMap((client) => client.activations ?? []) ?? [];
        activation = activations.find((entry) => entry.pluginId === 'command-center' && entry.revision === native.revision && entry.status === 'activated');
        return !!activation;
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      result = { pluginId: 'command-center', revision: native.revision, entryPath: entryUrl.pathname, grantPrefix, activationStatus: activation.status, topicsResponseObserved: true, nativeTopicsRendered: true,
        existingTopicVerified: true, authoritativeNoteRead: true, exactNativeChatHandoff: true, nativeReturnNoteRead: true,
        conversationCreationExercised: true, conversationExactReplayExercised: true, nativeChatSendExercised: true, authoritativeNewConversationMessageRead: true,
        retainedHostRestartExercised: true, nativeReloadAfterRestartExercised: true, originalCreationReplayAfterRestartExercised: true,
        assistantCompletionExercised: false,
        // These facts are emitted only after the actual native actions, exact
        // authoritative readbacks and retained host restart above all succeed.
        primary: { schemaVersion: 2, topicId: fixture.topicId,
          authoritativeReadback: { existingTopics: true, primarySession: true, conversation: true, note: true, chatSend: true, conversationAfterRestart: true },
          actions: ['existing-topic-open', 'note-read', 'native-chat-open', 'native-chat-send', 'conversation-create', 'conversation-replay', 'conversation-refresh', 'native-return'] },
        startup: { hostReceipt: { schemaVersion: descriptor.schemaVersion ?? 1, commit: host.host.commit, ...descriptor.integrity }, startupMigrationVerified: !!bootstrapped.completion, routeGrantObserved: true,
          nativeUi: { pluginId: 'command-center', revision: native.revision, activationObserved: activation.status === 'activated', authenticatedHttpObserved: true } } };
      }
    } catch (error) { failure = error; }
    finally {
      const cleanup = await finalizeAcceptanceJourney({
        closeBrowser: (cleanupSignal) => closeManagedBrowser(managedBrowser, cleanupSignal),
        stopHost: async () => {
          for (const generation of [...host.generations].reverse()) {
            await stopPinnedHost(generation.child);
            await generation.outputDrained;
          }
        },
        assertBrowserTraffic: () => browserGuard.assertClean(),
        assertHostTraffic: () => {
          for (const generation of host.generations) {
            generation.diagnostics.guard.assertClean();
            assertNoFatalHostOutput(generation.diagnostics);
            if (generation.diagnostics.cleanupError) throw generation.diagnostics.cleanupError;
          }
        },
        assertChildTraffic: () => assertRecordedChildTraffic(world),
        assertBuildDigest: () => assertBuiltDigest(buildReceipt),
        onProgress: onFinalization
      });
      removeAbortCleanup();
      signal.removeEventListener('abort', abortBrowser);
      if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map((entry) => entry.error)], 'Native activation finalization failed');
    }
    scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(host.generations.map((generation) => boundedHostEvidence(generation.diagnostics)))]);
    if (failure) throw failure;
    return result;
  }, { candidateRoot: process.cwd() });
}
