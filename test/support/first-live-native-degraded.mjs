import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finalizeAcceptanceJourney } from '../../src/acceptance-finalization.mjs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, recordBounded } from '../../src/browser-evidence.mjs';
import { assertBuiltDigest } from '../../src/build.mjs';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, fetchJsonWithDeadline, launchPinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { TrafficGuard } from '../../src/isolation.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { scanPublicEvidence } from '../../src/safety.mjs';
import { seedNativeExistingTopic } from './first-live-native-journey.mjs';
import { boundedHostEvidence, closeManagedBrowser, configureEvidencePage, launchManagedBrowser, redactBrowserEvidence, requestAuthenticatedGateway, stopHostOnAbort, withDeadline } from './real-host-runtime.mjs';

const actionPath = '/plugins/command-center/api/topic/actions';
const unwrap = response => response?.result ?? response;

export function exerciseNativeDegradedSourceRow({ descriptor, buildReceipt, combined = false, signal, onFinalization }) {
  return exerciseNativeDegraded({ descriptor, buildReceipt, sessionsUnavailable: true, writeGrantDenied: combined, signal, onFinalization });
}

export function exerciseNativeDegradedBridgeHostVariant({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeDegraded({ descriptor, buildReceipt, sessionsUnavailable: false, writeGrantDenied: true, signal, onFinalization });
}

// The native Session owner stays available for exact fixture setup/readback;
// plugin source availability is the deliberately degraded boundary under test.
async function sessionIdentities(world, fixture, signal) {
  const result = unwrap(await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: 'sessions.list', params: { agentId: 'main', limit: 100, offset: 0, includeGlobal: true, includeUnknown: true, archived: 'all' }, signal }));
  assert.ok(Array.isArray(result?.sessions));
  assert.equal(result.hasMore, false, 'The isolated fixture must fit one complete bounded native Session page');
  assert.equal(result.totalCount, result.sessions.length);
  const identities = result.sessions.map(row => {
    assert.equal(typeof row.key, 'string');
    assert.equal(typeof row.sessionId, 'string');
    return { key: row.key, sessionId: row.sessionId };
  }).sort((left, right) => left.key.localeCompare(right.key));
  assert.equal(new Set(identities.map(row => row.key)).size, identities.length);
  assert.ok(identities.some(row => row.key === fixture.sessionKey && row.sessionId === fixture.sessionId));
  return identities;
}

async function exerciseNativeDegraded({ descriptor, buildReceipt, sessionsUnavailable, writeGrantDenied, signal = new AbortController().signal, onFinalization }) {
  return withIsolatedWorld(async world => {
    const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    const pluginConfig = config.plugins.entries['command-center'].config;
    // Preserve the fixture's exact Note root, auth and native-plugin allowlist.
    if (sessionsUnavailable) pluginConfig.sourceCapabilities = { ...pluginConfig.sourceCapabilities, sessions: false };
    if (writeGrantDenied) pluginConfig.controlUiGrant = false;
    await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
    const host = await withDeadline('native degraded host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, host);
    const browserGuard = new TrafficGuard();
    const evidence = { requests: [], responses: [], console: [], errors: [] };
    let managedBrowser;
    let failure;
    let result;
    const abortBrowser = () => { void managedBrowser?.server.kill().catch(() => {}); };
    signal.addEventListener('abort', abortBrowser, { once: true });
    try {
      const gatewayRead = async (method, params = { schemaVersion: 1 }) => unwrap(await requestAuthenticatedGateway({
        gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method, params, signal
      }));
      let catalog;
      await waitForConsecutiveReadiness(async () => {
        try {
          catalog = await gatewayRead('plugins.controlUi.list', {});
          return Array.isArray(catalog?.plugins) && catalog.plugins.some(plugin => plugin.pluginId === 'command-center');
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
      const matchingPlugins = catalog.plugins.filter(plugin => plugin.pluginId === 'command-center');
      assert.equal(matchingPlugins.length, 1);
      const native = matchingPlugins[0];
      assert.match(native.revision, /^[a-f0-9]{64}$/u);
      const grantPrefix = '/__openclaw__/plugins/control-ui/command-center/';
      const entryUrl = new URL(native.entryUrl, world.gateway.url);
      assert.equal(entryUrl.origin, new URL(world.gateway.url).origin);
      assert.equal(entryUrl.pathname, `${grantPrefix}${native.revision}/entry.mjs`);
      assert.equal(entryUrl.search, ''); assert.equal(entryUrl.hash, '');
      const bootstrap = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, {
        headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal
      }, { label: 'native degraded authenticated bootstrap', timeoutMs: 10_000 });
      assert.equal(bootstrap.response.ok, true);
      assert.equal(bootstrap.parseError, undefined);
      assert.equal(bootstrap.body?.pluginAssetsRequireAuth, true);
      assert.equal(bootstrap.body?.pluginFrameGrants?.some(grant => grant.pluginId === 'command-center' && grant.match === 'prefix' && grant.path === grantPrefix), true,
        'Native asset permission remains distinct from the plugin mutation gate');
      assert.equal(JSON.stringify(bootstrap.body).includes(world.gatewayCredential), false);

      const fixture = await seedNativeExistingTopic({ world, host, signal });
      const status = await gatewayRead('command-center.v1.sources.status');
      assert.equal(status.mode, 'degraded');
      assert.equal(status.unavailableCapabilities.includes('sessions'), sessionsUnavailable);
      assert.equal(status.unavailableCapabilities.includes('control-ui-grant'), writeGrantDenied);
      const topics = await gatewayRead('command-center.v1.topics.list');
      const destination = topics.activeGroups.project.find(topic => topic.topicId === fixture.topicId);
      assert.equal(destination?.usable, true, 'Exact source identity remains readable despite the configured operation capability refusal');
      assert.equal(destination.name, fixture.name);

      managedBrowser = await withDeadline('native degraded browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }), 60_000, signal);
      const page = await managedBrowser.browser.newPage({ viewport: { width: 1440, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
      const entryResponse = observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'GET' && response.url() === entryUrl.href, { timeout: 60_000 }),
        error => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics',
        fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const entry = await entryResponse;
      assert.equal(hasSuccessfulBrowserResponse(entry), true);
      assert.deepEqual(await entry.value.body(), await readFile(path.join(process.cwd(), 'dist/native-ui/entry.mjs')));
      const nativePage = page.locator('openclaw-plugin-page');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
      assert.equal(await nativePage.locator('iframe').count(), 0);
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      const note = nativePage.getByRole('region', { name: 'Note content', exact: true });
      await note.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await note.textContent(), fixture.noteText);
      assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      const notes = await gatewayRead('command-center.v1.notes.browse', { schemaVersion: 1, topicId: fixture.topicId, offset: 0, limit: 50 });
      assert.equal(notes.notes.length, 1);
      const exactNote = notes.notes[0];
      assert.equal(exactNote.path, fixture.notePath);
      assert.equal(exactNote.sourceReference.topicId, fixture.topicId);
      assert.equal(exactNote.revision, `sha256:${createHash('sha256').update(fixture.noteText).digest('hex')}`);
      if (sessionsUnavailable) {
        await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
        await nativePage.getByRole('status').filter({ hasText: /capability.*unavailable/iu }).waitFor();
        assert.equal(await page.locator('openclaw-chat-pane[aria-hidden="false"]').count(), 0, 'Unavailable Sessions must not open an unverified native Chat');
        assert.equal(await note.textContent(), fixture.noteText);
      }

      // Admission may correctly disable the native form before any submission.
      // Prove the server gate independently through its authenticated relay;
      // never manufacture request authority or an authoritativeSession shortcut.
      const beforeTopic = await gatewayRead('command-center.v1.topics.get', { schemaVersion: 1, topicId: fixture.topicId });
      const beforeSessions = await sessionIdentities(world, fixture, signal);
      const input = { schemaVersion: 1, action: 'conversations.create', topicId: fixture.topicId,
        expectedRevision: beforeTopic.topic.revision, label: 'Fictional refused native Conversation', logicalOperationId: randomUUID() };
      const rejected = await fetchJsonWithDeadline(`${world.gateway.url}${actionPath}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
        body: JSON.stringify(input)
      }, { label: 'native degraded authenticated Conversation refusal', timeoutMs: 30_000 });
      assert.equal(rejected.parseError, undefined);
      assert.equal(rejected.response.status, 422);
      const refused = rejected.body;
      assert.equal(refused.schemaVersion, 1);
      assert.equal(refused.status, 'error');
      assert.equal(refused.code, 'capability-unavailable');
      if (writeGrantDenied) assert.equal(refused.message, 'Control UI grant is unavailable.');
      const creation = nativePage.locator('form').filter({ has: page.getByRole('heading', { name: 'New Conversation', exact: true }) });
      await creation.getByRole('status').filter({ hasText: /unavailable|recovery|unknown|write access|refused/iu }).waitFor();
      assert.equal(await creation.getByRole('button', { name: 'Create Conversation', exact: true }).isDisabled(), true);
      assert.equal(await creation.getByRole('status').filter({ hasText: /created and verified/iu }).count(), 0);
      assert.deepEqual(await sessionIdentities(world, fixture, signal), beforeSessions, 'Rejected creation must not leave an unattached native Session');
      const afterTopic = await gatewayRead('command-center.v1.topics.get', { schemaVersion: 1, topicId: fixture.topicId });
      assert.deepEqual(afterTopic, beforeTopic, 'Rejected creation must not change Topic revision, Primary identity or local source membership');
      assert.equal(await readFile(path.join(fixture.folder, fixture.notePath), 'utf8'), fixture.noteText);
      await nativePage.getByRole('button', { name: 'Refresh Notes', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await note.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await note.textContent(), fixture.noteText, 'Safe authoritative Note reading survives the refused write');

      await waitForConsecutiveReadiness(async () => {
        const activation = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
          method: 'plugins.controlUi.status', params: { pluginId: 'command-center' }, scopes: ['operator.admin'], signal });
        return activation?.clients?.some(client => client.activations?.some(value => value.pluginId === 'command-center' && value.revision === native.revision && value.status === 'activated')) === true;
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const source = Object.freeze({ capability: 'sessions', available: false, bindingObserved: true });
      const bridge = Object.freeze({ protocolVersion: runtimeCapability.schemaVersion, writeGrant: false, observedFromAuthenticatedAction: true,
        action: input.action, httpStatus: rejected.response.status, errorCode: refused.code });
      result = Object.freeze({ schemaVersion: 2, mode: status.mode, safeReadObserved: true, mutationRejected: true,
        ...(sessionsUnavailable ? { source } : { bridge }), ...(sessionsUnavailable && writeGrantDenied ? { combinedGrantDenied: true, bridge } : {}) });
    } catch (error) { failure = error; }
    finally {
      const cleanup = await finalizeAcceptanceJourney({
        closeBrowser: cleanupSignal => closeManagedBrowser(managedBrowser, cleanupSignal),
        stopHost: async () => { for (const generation of host.generations) { await stopPinnedHost(generation.child); await generation.outputDrained; } },
        assertBrowserTraffic: () => browserGuard.assertClean(),
        assertHostTraffic: () => { for (const generation of host.generations) { generation.diagnostics.guard.assertClean(); assertNoFatalHostOutput(generation.diagnostics); if (generation.diagnostics.cleanupError) throw generation.diagnostics.cleanupError; } },
        assertChildTraffic: () => assertRecordedChildTraffic(world),
        assertBuildDigest: () => assertBuiltDigest(buildReceipt),
        onProgress: onFinalization
      });
      removeAbortCleanup(); signal.removeEventListener('abort', abortBrowser);
      if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map(entry => entry.error)], 'Native degraded journey finalization failed');
    }
    scanPublicEvidence([JSON.stringify(evidence), ...host.generations.map(generation => JSON.stringify(boundedHostEvidence(generation.diagnostics)))]);
    if (failure) throw failure;
    return result;
  }, { candidateRoot: process.cwd() });
}
