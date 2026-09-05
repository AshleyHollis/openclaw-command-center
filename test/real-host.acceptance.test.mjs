import assert from 'node:assert/strict';
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createECDH, createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import test from 'node:test';
import path from 'node:path';
import { chromium } from 'playwright';
import 'playwright-core';
import { fetchWithRuntimeDispatcher as fetch } from 'openclaw/plugin-sdk/runtime-fetch';
import { finalizeAcceptanceJourney } from '../src/acceptance-finalization.mjs';
import { assertAcceptanceReportPassed, createAcceptanceReport, RELEASE_ROW_IDS, runAcceptanceRows } from '../src/acceptance-report.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, observedBrowserResponseStatus, recordBounded } from '../src/browser-evidence.mjs';
import { build, assertBuiltDigest, readBuiltReceipt } from '../src/build.mjs';
import { withIsolatedWorld } from '../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, fetchJsonWithDeadline, HarnessFailure, launchPinnedHost, parseHostDescriptor, redact, stopPinnedHost, waitForConsecutiveReadiness } from '../src/host-harness.mjs';
import { assertWebSocketDestination, boundedTrafficEvidence, TrafficGuard } from '../src/isolation.mjs';
import { runtimeCapability } from '../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../src/metadata/path.mjs';
import { COMMAND_CENTER_SCHEMA_VERSION, metadataSchemaV1Sql } from '../src/metadata/schema.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { expectedRollbackRelease } from '../src/metadata/recovery.mjs';
import { importedProvenance } from '../src/migration/transcript.mjs';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isControlUiBootstrapUrl, isControlUiPluginUrl } from '../src/acceptance-readiness.mjs';
import { assertPerformanceObservationWithinBaseline, captureFirstReleasePerformanceBaseline, RELEASE_FIXTURE_COUNTS, RELEASE_FIXTURE_IDENTITY, RELEASE_MEASUREMENTS, releasePerformanceIdentity, validateReleasePerformanceBaseline } from '../src/performance-baseline.mjs';
import { scanPublicEvidence, scanRepositorySafety } from '../src/safety.mjs';
import { compatibilityTuple } from '../src/compatibility.mjs';
import { createAcceptanceScenarioCoordinator, requireBoundedMutationResponse, runAbortableAcceptanceBoundary, runBoundedAcceptanceSlice } from '../src/acceptance-scenario-coordinator.mjs';
import { readVerifiedImportedHistoryEvidence, readVerifiedMigrationCompletion, retainPreparedMigrationFixtureEvidence, verifiedMigrationStatusReady } from '../src/acceptance-migration.mjs';
import { captureSearchProjectionEvidence, COMMITTED_SEARCH_PROJECTION_FILES, verifyCommittedSearchProjectionSet } from '../src/acceptance-search-projections.mjs';
import { resolveRealHostAcceptancePlan } from '../src/test-selection.mjs';
const EXTERNAL_OPERATION_TIMEOUT_MS = 60_000;
// The UI retains queued requests for 180s while honoring the host's rolling
// quotas. Queue time remains inside all performance measurements.
const BRIDGE_UI_OPERATION_BUDGET_MS = 185_000;
const acceptanceSignalContext = new AsyncLocalStorage();
const RELEASE_ALPHA_TOPIC_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_SCALE_TOPIC_ID = '22222222-2222-4222-8222-222222222222';
const RELEASE_ACTIVITY_TOPIC_ID = '33333333-3333-4333-8333-333333333333';
const READY_CAPABILITIES = Object.freeze(Object.fromEntries(['notes', 'sessions', 'scheduler', 'activity', 'analysis', 'attention', 'search'].map((name) => [name, true])));
const capturePerformanceBaseline = process.env.COMMAND_CENTER_CAPTURE_PERFORMANCE_BASELINE === '1';
const capturedPerformanceBaselinePath = '/tmp/command-center-release-performance-baseline.v1.json';
const acceptancePlan = resolveRealHostAcceptancePlan(process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO);
if (acceptancePlan.kind === 'focused' && capturePerformanceBaseline) throw new Error('Focused real-host acceptance cannot capture a performance baseline.');

function executeFile(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, (error) => error ? reject(error) : resolve()));
}

async function createLoopbackNotificationReceiver(tempRoot) {
  const keyPath = path.join(tempRoot, 'notification-loopback.key.pem');
  const certificatePath = path.join(tempRoot, 'notification-loopback.cert.pem');
  await executeFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  const deliveries = [];
  const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      deliveries.push({ method: request.method, bytes: Buffer.concat(chunks).byteLength });
      response.writeHead(201);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback notification receiver did not bind a TCP port.');
  return Object.freeze({ certificatePath, endpoint: `https://127.0.0.1:${address.port}/push`, deliveries, close: () => new Promise((resolve) => server.close(resolve)) });
}

function createGatewayDeviceIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return Object.freeze({ privateKey, publicKey: rawPublicKey.toString('base64url'), deviceId: createHash('sha256').update(rawPublicKey).digest('hex') });
}

function signedGatewayDevice(identity, { nonce, credential, scopes, client }) {
  const signedAt = Date.now();
  const payload = ['v3', identity.deviceId, client.id, client.mode, 'operator', scopes.join(','), String(signedAt), credential, nonce, client.platform.toLowerCase(), ''].join('|');
  return { id: identity.deviceId, publicKey: identity.publicKey, signature: sign(null, Buffer.from(payload), identity.privateKey).toString('base64url'), signedAt, nonce };
}

function releaseScaleConversationOperationId(index) {
  assert.ok(Number.isInteger(index) && index > 0 && index < RELEASE_FIXTURE_COUNTS.conversations);
  return `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
}

function reportProgress(testContext, phase, detail = {}) {
  testContext.diagnostic(`release-progress=${JSON.stringify({ schemaVersion: 1, phase, ...detail })}`);
}

async function withDeadline(label, operation, timeoutMs = EXTERNAL_OPERATION_TIMEOUT_MS, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const pending = Promise.resolve().then(() => operation(controller.signal));
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  void pending.then(async (value) => {
    if (!timedOut) return;
    try {
      if (value?.child) await stopPinnedHost(value.child);
      else await value?.close?.();
    } catch { /* a timed-out operation remains failed; cleanup is best effort */ }
  }, () => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new HarnessFailure('operation-timeout', `${label} exceeded its ${timeoutMs} ms deadline`)); }, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function stopHostOnAbort(signal, host) {
  const stop = () => { void stopPinnedHost(host.child); };
  signal?.addEventListener('abort', stop, { once: true });
  return () => signal?.removeEventListener('abort', stop);
}

function delayWithSignal(delayMs, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() { signal?.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Operation aborted.')); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function launchManagedBrowser(options) {
  const server = await chromium.launchServer({ ...options, args: ['--no-proxy-server', ...(options?.args ?? [])] });
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, server, close: async () => { await browser.close(); await server.close().catch(() => {}); } };
  } catch (error) {
    await server.kill().catch(() => {});
    throw error;
  }
}

async function closeManagedBrowser(managed, signal) {
  if (!managed) return;
  const forceClose = () => { void managed.server.kill(); };
  if (signal?.aborted) forceClose();
  else signal?.addEventListener('abort', forceClose, { once: true });
  try { await managed.close(); }
  finally { signal?.removeEventListener('abort', forceClose); }
}

async function fetchWithDeadline(url, options = {}, label = 'HTTP operation', timeoutMs = EXTERNAL_OPERATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const parentSignal = options.signal ?? acceptanceSignalContext.getStore();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    if (timedOut) throw new HarnessFailure('transport-timeout', `${label} exceeded its ${timeoutMs} ms deadline`);
    throw error;
  } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abortFromParent); }
}

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
  page.setDefaultTimeout(BRIDGE_UI_OPERATION_BUDGET_MS);
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
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let diagnostics;
  try {
    diagnostics = {
      emissions: database.prepare('SELECT emission_id, episode_id, status, emitted_at_ms, updated_at_ms FROM notification_emissions ORDER BY updated_at_ms DESC LIMIT 5').all(),
      clears: database.prepare('SELECT logical_operation_id, episode_id, status, attempt_count, updated_at_ms FROM notification_clear_operations ORDER BY updated_at_ms DESC LIMIT 5').all(),
      slots: database.prepare('SELECT episode_id, slot_kind, status, due_at_ms, emitted_at_ms FROM notification_slots ORDER BY due_at_ms DESC LIMIT 8').all(),
      episodes: database.prepare('SELECT episode_id, source_capability_id, state, severity, evidence_json, attention_since, updated_at FROM attention_episodes ORDER BY updated_at DESC LIMIT 5').all(),
      attempts: database.prepare('SELECT attempt_id, episode_id, action_id, expected_source_revision, state, outcome, verification_revision, retry_count, updated_at FROM attention_attempts ORDER BY updated_at DESC LIMIT 5').all()
    };
  } finally { database.close(); }
  throw new HarnessFailure('notification-reconciliation-timeout', `Closed-tab notification emission did not reach durable ${status} state: ${JSON.stringify(diagnostics)}`);
}

async function mountedPluginFrame(page, pluginDocument, evidence) {
  const iframe = page.locator('iframe.plugin-tab-embed__frame');
  try {
    await iframe.waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForFunction(() => {
      const candidate = document.querySelector('iframe.plugin-tab-embed__frame');
      return candidate?.getAttribute('sandbox') === 'allow-scripts' && typeof candidate.getAttribute('srcdoc') === 'string' && candidate.getAttribute('srcdoc').length > 0;
    }, undefined, { timeout: 10_000 });
  } catch {
    throw new HarnessFailure('missing-plugin-frame', 'Command Center external tab did not attach its iframe');
  }
  if (await iframe.getAttribute('sandbox') !== 'allow-scripts' || await iframe.getAttribute('title') !== 'Command Center') {
    throw new HarnessFailure('sandbox-mismatch', 'Command Center external tab iframe provenance did not match its scripts-only descriptor');
  }
  if (!pluginDocument?.observed || !pluginDocument.value.ok() || new URL(pluginDocument.value.url()).pathname !== '/plugins/command-center') {
    throw new HarnessFailure('plugin-document-mismatch', 'Command Center plugin document did not return a successful exact-route response');
  }
  const declaredLength = pluginDocument.value.headers()['content-length'];
  if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) === 0 || Number(declaredLength) > 2_000_000)) {
    throw new HarnessFailure('plugin-document-mismatch', 'Command Center plugin document response declared an empty or unbounded body');
  }
  const srcdoc = await iframe.getAttribute('srcdoc');
  const src = await iframe.getAttribute('src');
  if (typeof srcdoc !== 'string' || srcdoc.length === 0 || srcdoc.length > 2_100_000 || (src !== null && src !== '')) throw new HarnessFailure('plugin-frame-url-mismatch', `Command Center capability frame was not mounted through the pinned host srcdoc boundary (srcdocLength=${typeof srcdoc === 'string' ? srcdoc.length : -1}; directSrc=${src !== null && src !== ''})`);
  let frame;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const handle = await iframe.elementHandle();
    const candidate = await handle?.contentFrame();
    if (candidate) {
      try {
        if (await candidate.evaluate(() => Boolean(window.CommandCenterTopics && window.CommandCenterSearch))) {
          frame = candidate;
          break;
        }
      } catch {
        // The host may replace the srcdoc browsing context while binding its
        // authenticated MessagePort. Reacquire the current frame on retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!frame) {
    const handle = await iframe.elementHandle();
    const currentFrame = await handle?.contentFrame();
    if (!currentFrame) throw new HarnessFailure('missing-plugin-frame', 'Command Center external tab iframe had no attached document');
    const state = await currentFrame.evaluate(() => ({
      readyState: document.readyState,
      scriptPaths: Array.from(document.scripts, (script) => {
        try { return new URL(script.src, document.baseURI).pathname; } catch { return ''; }
      }).filter(Boolean).slice(0, 10),
      hasTopics: Boolean(window.CommandCenterTopics),
      hasSearch: Boolean(window.CommandCenterSearch),
      hasMarkdown: Boolean(window.CommandCenterMarkdown),
      scriptLengths: Array.from(document.scripts, (script) => script.textContent?.length ?? 0),
      bodyChildren: document.body?.children.length ?? -1
    }));
    const recentErrors = Array.isArray(evidence?.errors) ? evidence.errors.slice(-5) : [];
    const recentConsole = Array.isArray(evidence?.console) ? evidence.console.slice(-5) : [];
    const shellResponses = Array.isArray(evidence?.responses)
      ? evidence.responses.filter((entry) => typeof entry === 'string' && entry.includes('/plugins/command-center')).slice(-10)
      : [];
    throw new HarnessFailure('plugin-script-timeout', `Command Center script did not publish its bounded shell markers: ${JSON.stringify({ state, recentErrors, recentConsole, shellResponses })}`);
  }
  const provenance = await frame.evaluate(async () => {
    await Promise.all([window.CommandCenterTopics.ready, window.CommandCenterSearch.ready]);
    const destination = await window.CommandCenterTopics.read('destination');
    await window.CommandCenterTopics.loadTopics();
    return {
      baseURI: document.baseURI,
      title: document.title,
      heading: document.querySelector('h1')?.textContent,
      shell: typeof window.CommandCenterTopics.loadTopics === 'function' && typeof window.CommandCenterSearch.search === 'function',
      bridgeReady: ['project', 'area', 'resource'].every((category) => Array.isArray(destination?.activeGroups?.[category])) && document.querySelector('#topic-status')?.textContent === 'Topics are current.'
    };
  });
  if (!isControlUiPluginUrl(provenance.baseURI, { gatewayUrl: page.url(), pluginId: 'command-center', routeId: 'command-center' }) || provenance.title !== 'Command Center' || provenance.heading !== 'Dashboard' || !provenance.shell || !provenance.bridgeReady) {
    throw new HarnessFailure('plugin-document-mismatch', `Command Center srcdoc did not retain the authenticated parent route, shell markers, and ready capability bridge: ${redactBrowserEvidence(JSON.stringify(provenance))}`);
  }
  return { iframe, frame };
}

async function remountPluginFrame(page) {
  const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  return (await mountedPluginFrame(page, await pluginDocument)).frame;
}

async function waitForMigrationCompletion(databasePath, topicId, { attempts = 100, delayMs = 100, signal } = {}) {
  signal ??= acceptanceSignalContext.getStore();
  let lastState = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const completion = readVerifiedMigrationCompletion(database, { completionId: 'legacy-discord-v1', topicId });
      if (completion) return completion;
      lastState = database.prepare("SELECT phase, failure_code AS failureCode, failure_summary AS failureSummary FROM migration_state WHERE state_id = 'legacy-discord-v1'").get() ?? lastState;
    } catch (error) {
      const pendingDatabase = error?.code === 'SQLITE_BUSY' || error?.errcode === 14 || /database is locked|unable to open database file/iu.test(error?.message ?? '');
      if (!pendingDatabase) throw error;
    } finally { database?.close(); }
    await delayWithSignal(delayMs, signal);
  }
  throw new HarnessFailure('migration-incomplete', `Pinned-host startup did not durably complete the configured legacy migration; durable state=${redact(JSON.stringify(lastState), 1_000)}`);
}

async function waitForCommittedSearchProjections(projectionRoot, { attempts = 100, signal, requiredTopicIds = [], expectedRowCounts, expectedTopicRowCounts } = {}) {
  signal ??= acceptanceSignalContext.getStore();
  const metadataDatabasePath = path.join(path.dirname(projectionRoot), 'metadata.sqlite');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const verified = verifyCommittedSearchProjectionSet({ projectionRoot, metadataDatabasePath, requiredTopicIds });
      const totalsMatch = !expectedRowCounts || Object.entries(expectedRowCounts).every(([kind, count]) => verified.rowCounts[kind] === count);
      const topicsMatch = !expectedTopicRowCounts || Object.entries(expectedTopicRowCounts).every(([kind, topics]) => Object.entries(topics).every(([topicId, count]) => verified.topicRowCounts[kind]?.[topicId] === count));
      if (totalsMatch && topicsMatch) return verified;
    } catch { /* A partial, corrupt, or mismatched-bookkeeping generation is not complete. */ }
    await delayWithSignal(25, signal);
  }
  throw new HarnessFailure('search-rebuild-timeout', 'Search rebuild did not publish an integrity-checked committed projection set');
}

async function rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential, topicId, signal, label }) {
  const logicalOperationId = randomUUID();
  await requestAuthenticatedGateway({ gatewayUrl, credential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.search.prepare-rebuild', params: { schemaVersion: 1, topicId, logicalOperationId }, responseTimeoutMs: 180_000, signal });
  const response = await fetchWithDeadline(`${gatewayUrl}/plugins/command-center/api/search/rebuild`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, topicId, logicalOperationId }),
    signal
  }, label, 180_000);
  const body = await response.json();
  assert.equal(response.status, 200, `${label} returned ${response.status} (${body?.code ?? 'unknown'})`);
  assert.equal(body?.status, 'applied');
  assert.equal(body?.result?.topicId, topicId);
  return body;
}

async function verifyReleaseSearchResults({ gatewayUrl, credential, projectionRoot, signal }) {
  const notesResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, query: 'Fictional scale search phrase', limit: 50 }, responseTimeoutMs: 60_000, signal });
  const conversationsResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, query: 'Fictional indexed conversation phrase', limit: 50 }, responseTimeoutMs: 60_000, signal });
  const notes = (notesResponse?.result ?? notesResponse)?.notes?.results ?? [];
  const conversations = (conversationsResponse?.result ?? conversationsResponse)?.conversations?.results ?? [];
  assert.equal(notes.length, 50);
  assert.equal(conversations.length, 50);
  assert.equal(notes.every((result) => result.topicId === RELEASE_SCALE_TOPIC_ID), true);
  assert.equal(conversations.every((result) => result.topicId === RELEASE_SCALE_TOPIC_ID), true);
  const notePaths = new Set();
  const noteReferences = new Set();
  for (const result of notes) {
    const match = result.path?.match(/^indexed-(\d{4})\.md$/u);
    assert.ok(match, 'indexed Note result must retain its exact fictional fixture path');
    assert.match(result.snippet, new RegExp(`Fictional scale search phrase ${Number(match[1])}\\.`, 'u'));
    assert.equal(typeof result.sourceReference?.referenceId, 'string');
    notePaths.add(result.path);
    noteReferences.add(result.sourceReference.referenceId);
  }
  assert.equal(notePaths.size, notes.length);
  assert.equal(noteReferences.size, notes.length);
  const messageIds = new Set();
  const sessionReferences = new Set();
  for (const result of conversations) {
    const match = result.messageId?.match(/^fictional-scale-message-(\d{4})$/u);
    assert.ok(match, 'Conversation result must retain its exact fictional message identity');
    assert.match(result.snippet, new RegExp(`Fictional indexed conversation phrase ${Number(match[1])}\\.`, 'u'));
    assert.equal(typeof result.sessionKey, 'string');
    assert.equal(typeof result.sourceReference?.referenceId, 'string');
    messageIds.add(result.messageId);
    sessionReferences.add(result.sourceReference.referenceId);
  }
  assert.equal(messageIds.size, conversations.length);
  assert.equal(sessionReferences.size, 1, 'all imported scale messages must retain one exact authoritative Session binding');

  const exactNoteResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, query: 'Fictional exact Note sentinel', limit: 50 }, responseTimeoutMs: 60_000, signal });
  const exactNotes = (exactNoteResponse?.result ?? exactNoteResponse)?.notes?.results ?? [];
  assert.deepEqual(exactNotes.map((result) => result.path), ['indexed-4242.md']);
  const exactNote = exactNotes[0];
  const authoritativeNoteResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.notes.read', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, referenceId: exactNote.sourceReference.referenceId, path: exactNote.path, offset: 0 }, signal });
  const authoritativeNote = authoritativeNoteResponse?.result ?? authoritativeNoteResponse;
  assert.equal(authoritativeNote?.sourceReference?.referenceId, exactNote.sourceReference.referenceId);
  assert.equal(authoritativeNote?.path, 'indexed-4242.md');
  assert.match(Buffer.from(authoritativeNote.contentBase64, 'base64').toString('utf8'), /Fictional exact Note sentinel\./u);

  const exactConversationResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, query: 'Fictional exact Conversation sentinel', limit: 50 }, responseTimeoutMs: 60_000, signal });
  const exactConversations = (exactConversationResponse?.result ?? exactConversationResponse)?.conversations?.results ?? [];
  assert.deepEqual(exactConversations.map((result) => result.messageId), ['fictional-scale-message-4242']);
  const exactConversation = exactConversations[0];
  const authoritativeSessionsResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
  const authoritativeSessions = (authoritativeSessionsResponse?.result ?? authoritativeSessionsResponse)?.conversations ?? [];
  const authoritativeSession = authoritativeSessions.find((session) => session.referenceId === exactConversation.sourceReference.referenceId);
  assert.ok(authoritativeSession?.sessionId, 'exact projected Conversation must retain an authoritative Session catalog identity');
  const navigationResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, referenceId: authoritativeSession.referenceId }, signal });
  const navigation = navigationResponse?.result ?? navigationResponse;
  assert.equal(navigation?.sessionId, authoritativeSession.sessionId);
  assert.equal(navigation?.sessionKey, exactConversation.sessionKey);
  return waitForCommittedSearchProjections(projectionRoot, {
    signal,
    requiredTopicIds: [RELEASE_ALPHA_TOPIC_ID, RELEASE_SCALE_TOPIC_ID],
    expectedTopicRowCounts: {
      notes: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedNotes },
      conversations: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }
    }
  });
}

async function restoreReleaseSearchBaseline({ gatewayUrl, credential, projectionRoot, signal, label }) {
  try {
    await waitForCommittedSearchProjections(projectionRoot, {
      attempts: 1200,
      signal,
      requiredTopicIds: [RELEASE_ALPHA_TOPIC_ID, RELEASE_SCALE_TOPIC_ID],
      expectedTopicRowCounts: {
        notes: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedNotes },
        conversations: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }
      }
    });
    return verifyReleaseSearchResults({ gatewayUrl, credential, projectionRoot, signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.category !== 'search-rebuild-timeout') throw error;
  }
  await rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential, topicId: RELEASE_ALPHA_TOPIC_ID, signal, label: `${label} Alpha baseline rebuild` });
  return verifyReleaseSearchResults({ gatewayUrl, credential, projectionRoot, signal });
}

async function seedReleaseNoteCorpus(folder, onBatch) {
  const entries = [
    ['large-note.md', `${'x'.repeat(8_388_608)}\n`]
  ];
  for (let index = entries.length; index < RELEASE_FIXTURE_COUNTS.indexedNotes; index += 1) entries.push([`indexed-${String(index).padStart(4, '0')}.md`, `# Fictional indexed Note ${index}\n\nFictional scale search phrase ${index}.${index === 4242 ? ' Fictional exact Note sentinel.' : ''}`]);
  for (let offset = 0; offset < entries.length; offset += 100) {
    await withDeadline(`Note fixture batch ${offset / 100 + 1}`, () => Promise.all(entries.slice(offset, offset + 100).map(([name, content]) => writeFile(path.join(folder, name), content))));
    onBatch?.({ completed: Math.min(offset + 100, entries.length), total: entries.length });
  }
  const realized = await readdir(folder);
  assert.equal(realized.filter((name) => name.endsWith('.md')).length, RELEASE_FIXTURE_COUNTS.indexedNotes);
  assert.equal(Buffer.byteLength(await readFile(path.join(folder, 'large-note.md'))), RELEASE_FIXTURE_COUNTS.largeNoteBytes);
  return Object.freeze({ indexedNotes: realized.filter((name) => name.endsWith('.md')).length, largeNoteBytes: RELEASE_FIXTURE_COUNTS.largeNoteBytes });
}

async function prepareRestoredRuntimeState(stateDir, topicId) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const seed = new DatabaseSync(databasePath);
  try {
    seed.exec(metadataSchemaV1Sql);
    seed.prepare('INSERT INTO topics (topic_id, para_category, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(topicId, 'area', 'active', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  } finally { seed.close(); }
  const migrated = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try { assert.equal(migrated.getOperatingStatus().mode, 'ready'); }
  finally { migrated.close(); }
  const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
  const manifest = JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8'));
  const currentBytes = await readFile(databasePath);
  const verifier = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    const verification = verifier.verifyRollbackSnapshot({ snapshotId: manifest.snapshotId, priorRelease: expectedRollbackRelease(stateDir) });
    assert.equal(verification.snapshotId, manifest.snapshotId);
  } finally { verifier.close(); }
  await copyFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'), databasePath);
  const restored = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    assert.equal(restored.getOperatingStatus().mode, 'recovery-only');
  } finally { restored.close(); }
  await chmod(databasePath, 0o600);
  await writeFile(databasePath, currentBytes);
  const revalidated = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try { assert.equal(revalidated.getOperatingStatus().mode, 'ready'); }
  finally { revalidated.close(); }
  return databasePath;
}

async function exerciseRestorationMatrix({ stateDir, descriptor, buildReceipt, world, signal }) {
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
  const beforeInterruptedMigration = await readFile(databasePath);
  const previousNodeEnv = process.env.NODE_ENV;
  let result;
  process.env.NODE_ENV = 'test';
  try {
  const interrupted = openCommandCenterMetadataService({
    stateDir,
    capabilities: READY_CAPABILITIES,
    [migrationHooks]: { beforeCommit() { throw new Error('fictional before-commit interruption'); } }
  });
  assert.equal(interrupted.getOperatingStatus().mode, 'recovery-only');
  interrupted.close();
  assert.deepEqual(await readFile(databasePath), beforeInterruptedMigration, 'pre-commit destructive migration failure must preserve exact database bytes');
  const afterCommitState = `${stateDir}-after-commit`;
  await seedV1(afterCommitState, 'fictional-after-commit-topic');
  const interruptedAfterCommit = openCommandCenterMetadataService({
    stateDir: afterCommitState,
    capabilities: READY_CAPABILITIES,
    [migrationHooks]: { afterDatabaseCommit() { throw new Error('fictional post-commit interruption'); } }
  });
  assert.equal(interruptedAfterCommit.getOperatingStatus().mode, 'recovery-only');
  interruptedAfterCommit.close();
  const afterCommitDatabase = resolveCommandCenterDatabasePath(afterCommitState);
  const afterCommitRecovery = resolveCommandCenterRecoveryMigrationPath(afterCommitState);
  const committedBytes = await readFile(afterCommitDatabase);
  const committedSnapshot = await readFile(path.join(afterCommitRecovery, 'metadata.sqlite.snapshot'));
  const committedManifest = JSON.parse(await readFile(path.join(afterCommitRecovery, 'manifest.json'), 'utf8'));
  const committedRecoveryEntries = (await readdir(afterCommitRecovery)).sort();
  const committedSidecars = (await readdir(path.dirname(afterCommitDatabase))).filter((name) => name.startsWith(`${path.basename(afterCommitDatabase)}-`)).sort();
  const reconciled = openCommandCenterMetadataService({ stateDir: afterCommitState, capabilities: READY_CAPABILITIES });
  assert.equal(reconciled.getOperatingStatus().mode, 'ready');
  assert.equal(reconciled.getTopic('fictional-after-commit-topic').topicId, 'fictional-after-commit-topic');
  reconciled.close();
  assert.deepEqual(await readFile(afterCommitDatabase), committedBytes, 'post-commit reconciliation must preserve exact committed database bytes');
  assert.deepEqual(await readFile(path.join(afterCommitRecovery, 'metadata.sqlite.snapshot')), committedSnapshot, 'post-commit reconciliation must preserve exact rollback snapshot bytes');
  assert.deepEqual((await readdir(afterCommitRecovery)).sort(), committedRecoveryEntries, 'post-commit reconciliation must preserve the verified recovery artifact set');
  assert.deepEqual((await readdir(path.dirname(afterCommitDatabase))).filter((name) => name.startsWith(`${path.basename(afterCommitDatabase)}-`)).sort(), committedSidecars, 'post-commit reconciliation must not leave SQLite sidecars');
  const reconciledManifest = JSON.parse(await readFile(path.join(afterCommitRecovery, 'manifest.json'), 'utf8'));
  assert.equal(reconciledManifest.snapshotId, committedManifest.snapshotId);
  assert.deepEqual(reconciledManifest.snapshot, committedManifest.snapshot);
  const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
  const manifest = JSON.parse(await readFile(path.join(recoveryDirectory, 'manifest.json'), 'utf8'));
  const migrated = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    assert.equal(migrated.getOperatingStatus().mode, 'ready');
    const verification = migrated.verifyRollbackSnapshot({ snapshotId: manifest.snapshotId, priorRelease: expectedRollbackRelease(stateDir) });
    assert.equal(verification.snapshotId, manifest.snapshotId);
  } finally { migrated.close(); }
  const currentDatabase = `${databasePath}.current`;
  await copyFile(databasePath, currentDatabase);
  await copyFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'), databasePath);
  const restored = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    assert.equal(restored.getOperatingStatus().mode, 'recovery-only');
    assert.throws(() => restored.createTopic({ topicId: 'blocked-before-validation', paraCategory: 'project', lifecycle: 'active' }), (error) => error.code === 'recovery-only');
  } finally { restored.close(); }
  await chmod(databasePath, 0o600);
  await copyFile(currentDatabase, databasePath);
  const validatedCurrent = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    validatedCurrent.createTopic({ topicId: 'validated-post-restore-topic', paraCategory: 'project', lifecycle: 'active' });
    assert.equal(validatedCurrent.getTopic('validated-post-restore-topic').topicId, 'validated-post-restore-topic');
  } finally { validatedCurrent.close(); }
  result = { snapshotId: manifest.snapshotId, writesBlocked: true, exactIdentityValidated: true, postValidationMutation: true, beforeCommitBytesPreserved: true, afterCommitBytesPreserved: true };
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  const restoredHost = await withDeadline('validated restoration host launch', (launchSignal) => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
  const removeAbortCleanup = stopHostOnAbort(signal, restoredHost);
  let restoredBrowser;
  const restoredBrowserGuard = new TrafficGuard();
  try {
    await waitForConsecutiveReadiness(async () => (await fetchWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${world.gatewayCredential}` } }, 'validated restoration readiness', 10_000)).ok, restoredHost.earlyExit, { required: 2, attempts: 100, delayMs: 100 });
    const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
    assert.equal((statusResponse?.result ?? statusResponse).mode, 'ready');
    // Provision real required Sources after restoration; a metadata-only anchor is not a usable Topic.
    restoredBrowser = await launchManagedBrowser({ headless: true, timeout: 60_000 });
    const page = await restoredBrowser.browser.newPage();
    await configureEvidencePage(page, restoredBrowserGuard, { console: [], errors: [], requests: [], responses: [] });
    const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
    await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const { frame } = await mountedPluginFrame(page, await pluginDocument);
    await frame.locator('#topic-create input[name="name"]').fill('Fictional restored runtime Topic');
    await submitFrameForm(frame, '#topic-create', false);
    await waitForFrameText(frame, '#topic-status', 'Topic created and verified.');
    const restoredTopicId = await frame.locator('.topic-row').filter({ hasText: 'Fictional restored runtime Topic' }).getAttribute('data-topic-id');
    const restoredTopicResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: restoredTopicId } });
    const restoredTopic = (restoredTopicResponse?.result ?? restoredTopicResponse)?.topic;
    const mutation = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.rename', params: { schemaVersion: 1, topicId: restoredTopic.topicId, name: 'Validated restored runtime Topic', expectedRevision: restoredTopic.revision, logicalOperationId: randomUUID() } });
    assert.equal((mutation?.result ?? mutation)?.value?.name, 'Validated restored runtime Topic');
    const readback = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: restoredTopicId } });
    assert.equal((readback?.result ?? readback).topic.name, 'Validated restored runtime Topic');
    assert.equal((readback?.result ?? readback).topic.revision, restoredTopic.revision + 1);
  } finally {
    removeAbortCleanup();
    if (restoredBrowser) await closeManagedBrowser(restoredBrowser);
    await withDeadline('validated restoration host stop', async () => { await stopPinnedHost(restoredHost.child); await restoredHost.outputDrained; });
    restoredBrowserGuard.assertClean();
    assertNoFatalHostOutput(restoredHost.diagnostics);
    await assertRecordedChildTraffic(world);
    restoredHost.diagnostics.guard.assertClean();
  }
  return Object.freeze({ ...result, realStartupValidated: true });
}

async function assertMountedReadOnlyOperatingMode({ world, expectedMode }) {
  const managedBrowser = await withDeadline(`${expectedMode} UI browser launch`, () => launchManagedBrowser({ headless: true, timeout: 60_000 }));
  const guard = new TrafficGuard();
  const evidence = { console: [], errors: [], requests: [], responses: [] };
  try {
    const page = await managedBrowser.browser.newPage({ viewport: { width: 320, height: 900 } });
    await configureEvidencePage(page, guard, evidence);
    const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
    await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const { frame } = await mountedPluginFrame(page, await pluginDocument);
    const expectedText = expectedMode === 'degraded' ? 'Degraded · safe reads only' : 'Recovery-only · diagnostics and safe reads only';
    await frame.getByText(expectedText, { exact: true }).waitFor();
    await frame.locator('#topic-search-form button[type="submit"]').waitFor({ state: 'visible' });
    for (const selector of ['#topic-create', '#notification-settings-form', '#topic-analysis-schedule', '#topic-search-rebuild']) assert.equal(await frame.locator(selector).isHidden(), true, `${expectedMode} mounted UI exposed ${selector}`);
    assert.equal(await frame.locator('[data-command-center-mutation]:visible').count(), 0, `${expectedMode} mounted UI exposed a mutation control`);
    return true;
  } finally {
    await closeManagedBrowser(managedBrowser);
    guard.assertClean();
  }
}

async function assertPluginFrameUnavailable({ world, label }) {
  const managedBrowser = await withDeadline(`${label} UI browser launch`, () => launchManagedBrowser({ headless: true, timeout: 60_000 }));
  const guard = new TrafficGuard();
  const evidence = { console: [], errors: [], requests: [], responses: [] };
  try {
    const page = await managedBrowser.browser.newPage({ viewport: { width: 320, height: 900 } });
    await configureEvidencePage(page, guard, evidence);
    const bootstrap = observeBrowserResponse(page.waitForResponse((response) => isControlUiBootstrapUrl(response.url(), { gatewayUrl: world.gateway.url, bootstrapPath: runtimeCapability.bootstrap.path }), { timeout: 10_000 }));
    await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const bootstrapResponse = await bootstrap;
    assert.equal(hasSuccessfulBrowserResponse(bootstrapResponse), true, `${label} did not reach an authenticated terminal bootstrap response`);
    assert.equal(routeGrant(await bootstrapResponse.value.json()), false, `${label} unexpectedly advertised a frame grant`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('iframe.plugin-tab-embed__frame').count(), 0, `${label} unexpectedly mounted a mutation-capable plugin frame`);
    return true;
  } finally {
    await closeManagedBrowser(managedBrowser);
    guard.assertClean();
  }
}

async function exerciseDegradedSourceRow({ descriptor, buildReceipt, combined = false, signal }) {
  return withIsolatedWorld(async (sourceWorld) => {
    const stateDir = path.join(sourceWorld.root, '.openclaw');
    const seeded = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
    try { seeded.createTopic({ topicId: 'fictional-source-degraded-topic', paraCategory: 'resource', lifecycle: 'active' }); }
    finally { seeded.close(); }
    const config = JSON.parse(await readFile(sourceWorld.manifest.configPath, 'utf8'));
    config.plugins.entries['command-center'].config = { sourceCapabilities: { sessions: false }, ...(combined ? { controlUiGrant: false } : {}) };
    await writeFile(sourceWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
    const sourceHost = await withDeadline('source-degraded host launch', (launchSignal) => launchPinnedHost({ descriptor, world: sourceWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, sourceHost);
    try {
      let bootstrap;
      await waitForConsecutiveReadiness(async () => {
        const response = await fetchWithDeadline(`${sourceWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${sourceWorld.gatewayCredential}` } }, 'source-degraded readiness probe', 10_000);
        if (response.ok) bootstrap = await response.clone().json();
        return response.ok;
      }, sourceHost.earlyExit, { required: 2, attempts: 100, delayMs: 100, signal });
      const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: sourceWorld.gateway.url, credential: sourceWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
      const status = statusResponse?.result ?? statusResponse;
      assert.equal(status.mode, 'degraded');
      assert.ok(status.unavailableCapabilities.includes('sessions'));
      if (combined) assert.equal(routeGrant(bootstrap), false, 'combined degraded runtime must independently withhold the frame grant');
      const safeRead = await requestAuthenticatedGateway({ gatewayUrl: sourceWorld.gateway.url, credential: sourceWorld.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 } });
      assert.ok(JSON.stringify(safeRead).includes('fictional-source-degraded-topic'));
      const blockedOperationId = randomUUID();
      await assert.rejects(() => requestAuthenticatedGateway({
        gatewayUrl: sourceWorld.gateway.url,
        credential: sourceWorld.gatewayCredential,
        scopes: ['operator.read', 'operator.write'],
        method: 'command-center.v1.sessions.create',
        params: { schemaVersion: 1, topicId: 'fictional-source-degraded-topic', logicalOperationId: blockedOperationId, label: 'Blocked source mutation', authoritativeSession: { key: 'agent:main:blocked-source', sessionId: 'blocked-source-session', revision: '1', idempotencyKey: blockedOperationId, label: 'Blocked source mutation' } }
      }), /sessions.*unavailable|capability-unavailable/iu);
      const mountedUiObserved = combined ? false : await assertMountedReadOnlyOperatingMode({ world: sourceWorld, expectedMode: status.mode });
      const frameUnavailableObserved = combined ? await assertPluginFrameUnavailable({ world: sourceWorld, label: 'combined degraded' }) : false;
      return Object.freeze({ schemaVersion: 1, mode: status.mode, safeReadObserved: true, mutationRejected: true, mountedUiObserved, frameUnavailableObserved, unsupportedControlsAbsent: mountedUiObserved, source: { capability: 'sessions', available: false, bindingObserved: true }, ...(combined ? { combinedGrantDenied: true } : {}) });
    } finally {
      removeAbortCleanup();
      await withDeadline('source-degraded host stop', async () => { await stopPinnedHost(sourceHost.child); await sourceHost.outputDrained; });
      assertNoFatalHostOutput(sourceHost.diagnostics);
      await assertRecordedChildTraffic(sourceWorld);
      sourceHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseDegradedBridgeHostVariant({ descriptor, buildReceipt, signal }) {
  return withIsolatedWorld(async (degradedWorld) => {
    await prepareRestoredRuntimeState(path.join(degradedWorld.root, '.openclaw'), 'fictional-restored-grant-topic');
    const config = JSON.parse(await readFile(degradedWorld.manifest.configPath, 'utf8'));
    config.plugins.entries['command-center'].config = {
      controlUiGrant: false
    };
    await writeFile(degradedWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
    const degradedHost = await withDeadline('grant-degraded host launch', (launchSignal) => launchPinnedHost({ descriptor, world: degradedWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, degradedHost);
    try {
      let bootstrap;
      await waitForConsecutiveReadiness(async () => {
        const response = await fetchWithDeadline(`${degradedWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${degradedWorld.gatewayCredential}` } }, 'grant-degraded readiness probe', 10_000);
        if (!response.ok) return false;
        bootstrap = await response.json();
        return true;
      }, degradedHost.earlyExit, { required: 2, attempts: 100, delayMs: 100, signal });
      assert.equal(routeGrant(bootstrap), false, 'isolated plugin must not receive a withheld Control UI frame grant');
      const safeReadResponse = await requestAuthenticatedGateway({ gatewayUrl: degradedWorld.gateway.url, credential: degradedWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
      const safeRead = safeReadResponse?.result ?? safeReadResponse;
      assert.equal(safeRead.mode, 'degraded');
      const mutation = await fetchWithDeadline(`${degradedWorld.gateway.url}/plugins/command-center/api/topics/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action: 'create', name: 'Blocked grant mutation', paraCategory: 'resource', logicalOperationId: randomUUID() }) }, 'grant-degraded mutation', 10_000);
      assert.equal(mutation.status, 422);
      assert.equal((await mutation.json()).code, 'capability-unavailable');
      const frameUnavailableObserved = await assertPluginFrameUnavailable({ world: degradedWorld, label: 'missing frame grant' });
      return Object.freeze({ schemaVersion: 1, mode: safeRead.mode, safeReadObserved: true, mutationRejected: true, mountedUiObserved: false, frameUnavailableObserved, unsupportedControlsAbsent: false, bridge: { protocolVersion: runtimeCapability.schemaVersion, writeGrant: false, observedFromBootstrap: true } });
    } finally {
      removeAbortCleanup();
      await withDeadline('grant-degraded host stop', async () => { await stopPinnedHost(degradedHost.child); await degradedHost.outputDrained; });
      assertNoFatalHostOutput(degradedHost.diagnostics);
      await assertRecordedChildTraffic(degradedWorld);
      degradedHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseBindingMismatchHostVariant({ descriptor, buildReceipt, signal }) {
  return withIsolatedWorld(async (bindingWorld) => {
    const stateDir = path.join(bindingWorld.root, '.openclaw');
    await prepareRestoredRuntimeState(stateDir, 'fictional-restored-binding-anchor');
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    try {
      metadata.createTopic({ topicId: 'fictional-binding-mismatch-topic', paraCategory: 'project', lifecycle: 'active' });
      metadata.createSourceReference({ version: 1, referenceId: 'fictional-binding-mismatch-folder', topicId: 'fictional-binding-mismatch-topic', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: path.join(bindingWorld.paths.vault, 'elsewhere'), observedRevision: null });
    } finally { metadata.close(); }
    const sourceExport = JSON.parse(await readFile(new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
    sourceExport.channels[0].channelId = 'fictional-binding-mismatch-channel';
    const exportPath = path.join(bindingWorld.tempRoot, 'binding-mismatch-export.json');
    await writeFile(exportPath, `${JSON.stringify(sourceExport)}\n`);
    const expectedFolder = path.join(bindingWorld.paths.vault, 'expected');
    await mkdir(expectedFolder, { recursive: true });
    const config = JSON.parse(await readFile(bindingWorld.manifest.configPath, 'utf8'));
    config.plugins.entries['command-center'].config.legacyDiscordMigration = { schemaVersion: 1, exportPath, channels: [{ channelId: 'fictional-binding-mismatch-channel', topicId: 'fictional-binding-mismatch-topic', paraCategory: 'project', noteFolderPath: expectedFolder }] };
    await writeFile(bindingWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
    const bindingHost = await withDeadline('binding-mismatch host launch', (launchSignal) => launchPinnedHost({ descriptor, world: bindingWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, bindingHost);
    try {
      await waitForConsecutiveReadiness(async () => (await fetchWithDeadline(`${bindingWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${bindingWorld.gatewayCredential}` } }, 'binding-mismatch readiness', 10_000)).ok, bindingHost.earlyExit, { required: 2, attempts: 100, delayMs: 100 });
      const topics = await requestAuthenticatedGateway({ gatewayUrl: bindingWorld.gateway.url, credential: bindingWorld.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 } });
      const destination = topics?.result ?? topics;
      assert.equal(Object.values(destination.activeGroups).flat().some((topic) => topic.topicId === 'fictional-binding-mismatch-topic'), false, 'conflicting binding must be absent from usable Topics');
      const quarantined = destination.recovery.find((topic) => topic.topicId === 'fictional-binding-mismatch-topic');
      assert.equal(quarantined?.usable, false, 'the conflicted Topic must remain visible only as Source Recovery');
      assert.ok(quarantined.recovery.some((item) => item.state === 'required'));
      const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: bindingWorld.gateway.url, credential: bindingWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
      const status = statusResponse?.result ?? statusResponse;
      const blockedBindingOperationId = randomUUID();
      await assert.rejects(() => requestAuthenticatedGateway({ gatewayUrl: bindingWorld.gateway.url, credential: bindingWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.sessions.create', params: { schemaVersion: 1, topicId: 'fictional-binding-mismatch-topic', logicalOperationId: blockedBindingOperationId, label: 'Blocked binding mutation', authoritativeSession: { key: 'agent:main:blocked-binding', sessionId: 'blocked-binding-session', revision: '1', idempotencyKey: blockedBindingOperationId, label: 'Blocked binding mutation' } } }), /source-recovery|binding|unavailable/iu);
      const browser = await launchManagedBrowser({ headless: true, timeout: 60_000 });
      const guard = new TrafficGuard();
      try {
        const page = await browser.browser.newPage();
        await configureEvidencePage(page, guard, { console: [], errors: [], requests: [], responses: [] });
        const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
        await page.goto(controlUiPluginUrl({ gatewayUrl: bindingWorld.gateway.url, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: bindingWorld.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const { frame } = await mountedPluginFrame(page, await pluginDocument);
        const recoveryRow = frame.locator('#topics-recovery [data-topic-id="fictional-binding-mismatch-topic"]');
        await recoveryRow.waitFor();
        for (const name of ['Open Topic', 'Rename', 'Archive']) assert.equal(await recoveryRow.getByRole('button', { name, exact: true }).count(), 0, `quarantined Topic exposed ${name}`);
        await recoveryRow.getByRole('button', { name: 'Verify exact source', exact: true }).waitFor();
      } finally { await closeManagedBrowser(browser); guard.assertClean(); }
      const mountedUiObserved = true;
      return Object.freeze({ kind: 'binding', mode: status.mode, safeReadObserved: true, mutationRejected: true, bindingObserved: true, mountedUiObserved, unsupportedControlsAbsent: true });
    } finally {
      removeAbortCleanup();
      await withDeadline('binding-mismatch host stop', async () => { await stopPinnedHost(bindingHost.child); await bindingHost.outputDrained; });
      assertNoFatalHostOutput(bindingHost.diagnostics);
      await assertRecordedChildTraffic(bindingWorld);
      bindingHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseForeignDatabaseRestorationVariant({ descriptor, buildReceipt, signal }) {
  return withIsolatedWorld(async (foreignWorld) => {
    const stateDir = path.join(foreignWorld.root, '.openclaw');
    await prepareRestoredRuntimeState(stateDir, 'fictional-restored-database-topic');
    const foreignState = path.join(foreignWorld.tempRoot, 'foreign-state');
    await prepareRestoredRuntimeState(foreignState, 'fictional-foreign-database-topic');
    await cp(resolveCommandCenterRecoveryMigrationPath(foreignState), resolveCommandCenterRecoveryMigrationPath(stateDir), { recursive: true, force: true });
    const foreignHost = await withDeadline('foreign-database restoration host launch', (launchSignal) => launchPinnedHost({ descriptor, world: foreignWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, foreignHost);
    try {
      await waitForConsecutiveReadiness(async () => (await fetchWithDeadline(`${foreignWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${foreignWorld.gatewayCredential}` } }, 'foreign-database readiness', 10_000)).ok, foreignHost.earlyExit, { required: 2, attempts: 100, delayMs: 100 });
      const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: foreignWorld.gateway.url, credential: foreignWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
      assert.equal((statusResponse?.result ?? statusResponse).mode, 'recovery-only');
      const blockedForeignOperationId = randomUUID();
      await assert.rejects(() => requestAuthenticatedGateway({ gatewayUrl: foreignWorld.gateway.url, credential: foreignWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.create', params: { schemaVersion: 1, topicId: randomUUID(), name: 'Blocked foreign restoration', paraCategory: 'resource', logicalOperationId: blockedForeignOperationId, authoritativeSession: { key: 'agent:main:blocked-foreign', sessionId: 'blocked-foreign-session', revision: '1', idempotencyKey: blockedForeignOperationId, label: 'Blocked foreign restoration' } } }), /recovery-only/iu);
      return Object.freeze({ kind: 'database-identity', mutationRejected: true, restoredStateValidated: true });
    } finally {
      removeAbortCleanup();
      await withDeadline('foreign-database restoration host stop', async () => { await stopPinnedHost(foreignHost.child); await foreignHost.outputDrained; });
      assertNoFatalHostOutput(foreignHost.diagnostics);
      await assertRecordedChildTraffic(foreignWorld);
      foreignHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseRecoveryOnlyHostVariant({ descriptor, buildReceipt, signal }) {
  return withIsolatedWorld(async (recoveryWorld) => {
    const stateDir = path.join(recoveryWorld.root, '.openclaw');
    const databasePath = await prepareRestoredRuntimeState(stateDir, 'fictional-restored-schema-topic');
    const future = new DatabaseSync(databasePath);
    try { future.exec('CREATE TABLE fictional_future_marker (id TEXT) STRICT; PRAGMA user_version = 99;'); }
    finally { future.close(); }
    const recoveryHost = await withDeadline('recovery-only host launch', (launchSignal) => launchPinnedHost({ descriptor, world: recoveryWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, recoveryHost);
    try {
      await waitForConsecutiveReadiness(async () => {
        const response = await fetchWithDeadline(`${recoveryWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${recoveryWorld.gatewayCredential}` } }, 'recovery-only readiness probe', 10_000);
        return response.ok;
      }, recoveryHost.earlyExit, { required: 2, attempts: 100, delayMs: 100, signal });
      const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: recoveryWorld.gateway.url, credential: recoveryWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
      const status = statusResponse?.result ?? statusResponse;
      assert.equal(status.mode, 'recovery-only');
      const safeRead = await requestAuthenticatedGateway({ gatewayUrl: recoveryWorld.gateway.url, credential: recoveryWorld.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 } });
      assert.ok(safeRead && typeof safeRead === 'object');
      const blockedRecoveryOperationId = randomUUID();
      await assert.rejects(() => requestAuthenticatedGateway({ gatewayUrl: recoveryWorld.gateway.url, credential: recoveryWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.create', params: { schemaVersion: 1, topicId: randomUUID(), name: 'Blocked Recovery Topic', paraCategory: 'resource', logicalOperationId: blockedRecoveryOperationId, authoritativeSession: { key: 'agent:main:blocked-recovery', sessionId: 'blocked-recovery-session', revision: '1', idempotencyKey: blockedRecoveryOperationId, label: 'Blocked Recovery Topic' } } }), /recovery-only/iu);
      assert.equal(releasePerformanceIdentity.hostReceipt.commit, '01072cc079ff2ba088daab493501c0b95b41428a', 'the launched runtime must match the exact stable compatibility tuple');
      assert.equal(runtimeCapability.schemaVersion, 1, 'the active bootstrap must expose the supported bridge protocol');
      const recoveryDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try { assert.equal(recoveryDatabase.prepare('PRAGMA user_version').get().user_version, 99); }
      finally { recoveryDatabase.close(); }
      assert.ok(status.diagnostics.some((entry) => entry?.code === 'future-schema'));
      const mountedUiObserved = await assertMountedReadOnlyOperatingMode({ world: recoveryWorld, expectedMode: status.mode });
      return Object.freeze({ schemaVersion: 1, mode: 'recovery-only', safeReadObserved: true, mutationsRejected: true, mountedUiObserved, unsupportedControlsAbsent: true, mismatches: ['schema'] });
    } finally {
      removeAbortCleanup();
      await withDeadline('recovery-only host stop', async () => { await stopPinnedHost(recoveryHost.child); await recoveryHost.outputDrained; });
      assertNoFatalHostOutput(recoveryHost.diagnostics);
      await assertRecordedChildTraffic(recoveryWorld);
      recoveryHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseSecureHostVariant({ descriptor, buildReceipt, signal }) {
  return withIsolatedWorld(async (secureWorld) => {
    const numericSecureUrl = new URL(secureWorld.gateway.url.replace(/^http:/u, 'https:'));
    const fictionalTailnetHost = 'command-center.fictional.ts.net';
    const secureUrl = `https://${fictionalTailnetHost}:${numericSecureUrl.port}`;
    const config = JSON.parse(await readFile(secureWorld.manifest.configPath, 'utf8'));
    config.gateway.tls = { enabled: true, autoGenerate: true };
    config.gateway.controlUi = { allowedOrigins: [secureUrl] };
    await writeFile(secureWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
    const secureHost = await withDeadline('secure-origin host launch', (launchSignal) => launchPinnedHost({ descriptor, world: secureWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, secureHost);
    let managedBrowser;
    let browser;
    const secureBrowserGuard = new TrafficGuard();
    const readinessAttempts = [];
    let finalReadinessError = 'Secure endpoint did not become ready.';
    let readinessAttempt = 0;
    try {
      managedBrowser = await withDeadline('secure-origin browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000, args: [`--host-resolver-rules=MAP ${fictionalTailnetHost} 127.0.0.1,EXCLUDE localhost`] }));
      browser = managedBrowser.browser;
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 900 } });
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        const hostname = new URL(route.request().url()).hostname;
        if (hostname !== fictionalTailnetHost) { await route.abort(); throw new HarnessFailure('secure-origin-escape', 'Secure-origin fixture attempted an unexpected hostname.'); }
        secureBrowserGuard.assert('127.0.0.1', `browser-host-map:${fictionalTailnetHost}`);
        await route.continue();
      });
      try { await waitForConsecutiveReadiness(async () => {
        const attempt = ++readinessAttempt;
        const url = `${numericSecureUrl.origin}${runtimeCapability.bootstrap.path}`;
        try {
          const response = await context.request.get(url, { headers: { authorization: `Bearer ${secureWorld.gatewayCredential}` }, timeout: 10_000 });
          let bodyKeys = [];
          try { const body = await response.json(); bodyKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : []; }
          catch { bodyKeys = []; }
          readinessAttempts.push({ attempt, url, status: response.status(), error: null, bodyKeys });
          if (readinessAttempts.length > 20) readinessAttempts.shift();
          if (!response.ok()) finalReadinessError = `HTTPS readiness returned HTTP ${response.status()}.`;
          return response.ok();
        } catch (error) {
          finalReadinessError = redactBrowserEvidence(error?.message || error);
          readinessAttempts.push({ attempt, url, status: null, error: finalReadinessError, bodyKeys: [] });
          if (readinessAttempts.length > 20) readinessAttempts.shift();
          return false;
        }
      }, secureHost.earlyExit, { attempts: 60, delayMs: 250 }); }
      catch (error) {
        const failure = new HarnessFailure('secure-origin-readiness', `${finalReadinessError} (${error?.category ?? 'readiness'})`);
        failure.diagnostics = { readinessAttempts: readinessAttempts.map((entry) => ({ ...entry })) };
        throw failure;
      }
      const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.goto(controlUiPluginUrl({ gatewayUrl: secureUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: secureWorld.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await mountedPluginFrame(page, await pluginDocument);
      assert.equal(new URL(page.url()).hostname, fictionalTailnetHost);
      assert.equal(new URL(page.url()).protocol, 'https:');
      return Object.freeze({ secureOrigin: new URL(page.url()).origin, actualTlsLoad: true, fictionalTailnetHost, loopbackResolution: '127.0.0.1', readinessAttempts: Object.freeze(readinessAttempts.map((entry) => Object.freeze({ ...entry }))) });
    } finally {
      removeAbortCleanup();
      const finalizationErrors = await finalizeAcceptanceJourney({
        closeBrowser: async (signal) => await closeManagedBrowser(managedBrowser, signal),
        stopHost: async () => { await stopPinnedHost(secureHost.child); await secureHost.outputDrained; },
        assertBrowserTraffic: () => secureBrowserGuard.assertClean(),
        assertHostTraffic: () => assertNoFatalHostOutput(secureHost.diagnostics),
        assertChildTraffic: async () => await assertRecordedChildTraffic(secureWorld),
        assertBuildDigest: async () => await assertBuiltDigest(buildReceipt),
        timeoutMs: 60_000
      });
      if (finalizationErrors.length) throw new AggregateError(finalizationErrors.map(({ error }) => error), 'Secure-origin finalization failed');
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseRejectedCandidateVariant({ descriptor, buildReceipt, kind, signal }) {
  return withIsolatedWorld(async (variantWorld) => {
    const restoredStateDir = path.join(variantWorld.root, '.openclaw');
    const restoredDatabase = await prepareRestoredRuntimeState(restoredStateDir, `fictional-restored-${kind}-topic`);
    const restoredRecovery = resolveCommandCenterRecoveryMigrationPath(restoredStateDir);
    const variantRoot = path.join(variantWorld.tempRoot, `candidate-${kind}`);
    await mkdir(variantRoot, { recursive: true });
    await Promise.all([
      copyFile(path.join(process.cwd(), 'package.json'), path.join(variantRoot, 'package.json')),
      copyFile(path.join(process.cwd(), 'openclaw.plugin.json'), path.join(variantRoot, 'openclaw.plugin.json')),
      cp(path.join(process.cwd(), 'dist'), path.join(variantRoot, 'dist'), { recursive: true })
    ]);
    if (kind === 'build') {
      const recoveryManifestPath = path.join(restoredRecovery, 'manifest.json');
      const recoveryManifest = JSON.parse(await readFile(recoveryManifestPath, 'utf8'));
      recoveryManifest.targetRelease.package.build = 'fictional-mismatched-build';
      await writeFile(recoveryManifestPath, `${JSON.stringify(recoveryManifest)}\n`);
    } else if (kind === 'plugin-api') {
      const packageManifest = JSON.parse(await readFile(path.join(variantRoot, 'package.json'), 'utf8'));
      packageManifest.openclaw.compat.pluginApi = '=1900.1.1';
      await writeFile(path.join(variantRoot, 'package.json'), `${JSON.stringify(packageManifest)}\n`);
    } else {
      const entryPath = path.join(variantRoot, 'dist', 'plugin.mjs');
      const entry = await readFile(entryPath, 'utf8');
      assert.equal(entry.split('protocolVersion: 1,').length - 1, 1, 'variant must change exactly the registered bridge declaration');
      await writeFile(entryPath, entry.replace('protocolVersion: 1,', 'protocolVersion: 2,'));
    }
    const restoredBytes = await readFile(restoredDatabase);
    const restoredArtifacts = await Promise.all(['manifest.json', 'metadata.sqlite.snapshot'].map((name) => readFile(path.join(restoredRecovery, name))));
    const config = JSON.parse(await readFile(variantWorld.manifest.configPath, 'utf8'));
    config.plugins.load.paths = [variantRoot];
    await writeFile(variantWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
    const variantHost = await withDeadline(`${kind} variant host launch`, (launchSignal) => launchPinnedHost({ descriptor, world: variantWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
    const removeAbortCleanup = stopHostOnAbort(signal, variantHost);
    let expectedAdmissionFailure = false;
    let variantFailure;
    try {
      if (kind === 'plugin-api') {
        const refusal = await withDeadline('incompatible plugin API admission', () => variantHost.earlyExit, 30_000, signal);
        assert.equal(refusal.category, 'plugin-not-found');
        assert.match(`${variantHost.diagnostics.stdout}\n${variantHost.diagnostics.stderr}`, /plugin requires plugin API =1900\.1\.1, but this host is 2026\.9\.1; skipping (?:discovery|load)/u);
        expectedAdmissionFailure = true;
        const exited = () => new HarnessFailure('host-early-exit', 'The incompatible plugin prevented host startup');
        const processExit = variantHost.child.exitCode !== null ? Promise.resolve(exited()) : new Promise((resolve) => variantHost.child.once('exit', () => resolve(exited())));
        let bootstrap;
        let startupRejected = false;
        try {
          await waitForConsecutiveReadiness(async () => {
            const response = await fetchWithDeadline(`${variantWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${variantWorld.gatewayCredential}` } }, 'host health after plugin API refusal', 10_000);
            if (response.ok) bootstrap = await response.json();
            return response.ok;
          }, processExit, { required: 2, deadlineMs: 30_000, signal });
        } catch (error) { if (error?.category === 'host-early-exit') startupRejected = true; else throw error; }
        const mutationRequest = () => fetchWithDeadline(`${variantWorld.gateway.url}/plugins/command-center/api/topics/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(refusedTopicCreateRequest('Blocked incompatible API Topic')) }, 'rejected plugin mutation', 10_000);
        if (startupRejected) {
          assert.notEqual(variantHost.child.exitCode, 0);
          await variantHost.outputDrained;
          await assert.rejects(mutationRequest, (error) => (error?.cause?.code ?? error?.code) === 'ECONNREFUSED');
        } else {
          assert.equal(routeGrant(bootstrap), false);
          assert.equal((await mutationRequest()).status, 404);
          await assertPluginFrameUnavailable({ world: variantWorld, label: 'plugin API activation rejection' });
        }
        assert.deepEqual(await readFile(restoredDatabase), restoredBytes);
        for (const [index, name] of ['manifest.json', 'metadata.sqlite.snapshot'].entries()) assert.deepEqual(await readFile(path.join(restoredRecovery, name)), restoredArtifacts[index]);
        return Object.freeze({ kind, activationRejected: true, mutationRejected: true, restoredStatePreserved: true, startupRejected, frameUnavailableObserved: true, mountedUiObserved: false, unsupportedControlsAbsent: true });
      }
      let bootstrap;
      await waitForConsecutiveReadiness(async () => {
        const response = await fetchWithDeadline(`${variantWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${variantWorld.gatewayCredential}` } }, `${kind} variant readiness`, 10_000);
        if (response.ok) bootstrap = await response.clone().json();
        return response.ok;
      }, variantHost.earlyExit, { required: 2, attempts: 100, delayMs: 100 });
      assert.equal(routeGrant(bootstrap), kind === 'build', `${kind} variant frame grant differs from its activation boundary`);
      if (kind === 'build') {
        const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: variantWorld.gateway.url, credential: variantWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
        assert.equal((statusResponse?.result ?? statusResponse).mode, 'recovery-only');
        const safeRead = await requestAuthenticatedGateway({ gatewayUrl: variantWorld.gateway.url, credential: variantWorld.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 } });
        assert.ok(safeRead && typeof safeRead === 'object');
      }
      const mutation = await fetchWithDeadline(`${variantWorld.gateway.url}/plugins/command-center/api/topics/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(refusedTopicCreateRequest(`Blocked ${kind} restored Topic`)) }, `${kind} rejected mutation`, 10_000);
      assert.equal(mutation.status, kind === 'build' ? 422 : 404);
      assert.deepEqual(await readFile(restoredDatabase), restoredBytes, `${kind} rejection must preserve restored database bytes`);
      for (const [index, name] of ['manifest.json', 'metadata.sqlite.snapshot'].entries()) assert.deepEqual(await readFile(path.join(restoredRecovery, name)), restoredArtifacts[index], `${kind} rejection must preserve ${name}`);
      const mountedUiObserved = kind === 'build' ? await assertMountedReadOnlyOperatingMode({ world: variantWorld, expectedMode: 'recovery-only' }) : false;
      const frameUnavailableObserved = kind === 'build' ? false : await assertPluginFrameUnavailable({ world: variantWorld, label: `${kind} activation rejection` });
      return Object.freeze({ kind, ...(kind === 'build' ? { mode: 'recovery-only', safeReadObserved: true, mountedUiObserved, frameUnavailableObserved, unsupportedControlsAbsent: true } : { activationRejected: true, mountedUiObserved: false, frameUnavailableObserved, unsupportedControlsAbsent: false }), mutationRejected: true, restoredStatePreserved: true });
    } catch (error) { variantFailure = error; throw error; }
    finally {
      removeAbortCleanup();
      await withDeadline(`${kind} variant host stop`, async () => { await stopPinnedHost(variantHost.child); await variantHost.outputDrained; });
      try {
        if (expectedAdmissionFailure) assert.equal(variantHost.diagnostics.category, 'plugin-not-found');
        else assertNoFatalHostOutput(variantHost.diagnostics);
      } catch (error) { if (variantFailure) throw new AggregateError([variantFailure, error], `Variant failed: ${variantFailure.message}; host finalization also failed`); throw error; }
      await assertRecordedChildTraffic(variantWorld);
      variantHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function exerciseFreshScenarioFixture({ descriptor, buildReceipt, kind, width, signal }) {
  return withIsolatedWorld(async (scenarioWorld) => {
    const scaleTopicId = '11111111-1111-4111-8111-111111111151';
    let scaleProjectionRoot;
    if (kind === 'scale') {
      const migrationFolder = path.join(scenarioWorld.paths.vault, 'fictional-scale');
      await mkdir(migrationFolder, { recursive: true });
      await seedReleaseNoteCorpus(migrationFolder);
      const scaleExport = { schemaVersion: 1, source: 'discord', channels: [{ channelId: 'fictional-fresh-scale-channel', displayName: 'Fictional Scale Corpus', messages: Array.from({ length: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }, (_, index) => ({ messageId: `fictional-fresh-scale-${index}`, displayOrder: index, author: { id: 'fictional-scale-user', displayName: 'Fictional Scale User' }, timestamp: new Date(Date.UTC(2026, 7, 22) + index).toISOString(), text: `Fictional indexed scale phrase ${index}.${index === 4242 ? ' Fictional exact Conversation sentinel.' : ''}`, edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: [] })) }] };
      const exportPath = path.join(scenarioWorld.tempRoot, 'fresh-scale-export.json');
      await writeFile(exportPath, `${JSON.stringify(scaleExport)}\n`);
      const config = JSON.parse(await readFile(scenarioWorld.manifest.configPath, 'utf8'));
      config.plugins.entries['command-center'].config.legacyDiscordMigration = { schemaVersion: 1, exportPath, channels: [{ channelId: 'fictional-fresh-scale-channel', topicId: scaleTopicId, paraCategory: 'resource', noteFolderPath: migrationFolder }] };
      await writeFile(scenarioWorld.manifest.configPath, `${JSON.stringify(config)}\n`);
      const stateDir = path.join(scenarioWorld.root, '.openclaw');
      const activity = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
      try {
        activity.createTopic({ topicId: 'fictional-fresh-scale-activity', paraCategory: 'resource', lifecycle: 'active' });
      } finally { activity.close(); }
      scaleProjectionRoot = path.join(path.dirname(resolveCommandCenterDatabasePath(stateDir)), 'projections');
    }
    const scenarioHost = await withDeadline(`${kind} fresh host launch`, (signal) => launchPinnedHost({ descriptor, world: scenarioWorld, buildReceipt, signal }), 120_000);
    let managedBrowser;
    const abortCleanup = () => {
      void stopPinnedHost(scenarioHost.child);
      void managedBrowser?.close?.();
    };
    signal?.addEventListener('abort', abortCleanup, { once: true });
    const browserGuard = new TrafficGuard();
    try {
      signal?.throwIfAborted();
      const readinessProgress = [];
      const readinessStarted = Date.now();
      const observeMigration = () => {
        if (kind !== 'scale') return;
        const state = readMigrationProgress(path.join(scenarioWorld.root, '.openclaw'));
        readinessProgress.push({ elapsedMs: Date.now() - readinessStarted, ...state });
        if (readinessProgress.length > 12) readinessProgress.shift();
      };
      try {
        await waitForConsecutiveReadiness(async (probeSignal) => {
          try { return (await fetchWithDeadline(`${scenarioWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${scenarioWorld.gatewayCredential}` }, signal: probeSignal }, `${kind} fresh readiness`, 10_000)).ok; }
          catch (error) { if (error?.category === 'transport-timeout') { observeMigration(); return false; } throw error; }
        }, scenarioHost.earlyExit, { required: 2, deadlineMs: 120_000, delayMs: 100, signal });
      } catch (error) { observeMigration(); throw new Error(`Host transport readiness failed; durableStartupProgress=${JSON.stringify(readinessProgress)}`, { cause: error }); }
      if (kind === 'scale') {
        let lastMigrationStatus;
        try {
          await waitForConsecutiveReadiness(async (probeSignal) => {
            const response = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.migration.status', params: { schemaVersion: 1 }, signal: probeSignal });
            lastMigrationStatus = response.result ?? response;
            return verifiedMigrationStatusReady(lastMigrationStatus, { channelCount: 1, occurrenceCount: RELEASE_FIXTURE_COUNTS.indexedConversationMessages });
          }, scenarioHost.earlyExit, { required: 1, deadlineMs: 120_000, delayMs: 500, signal });
        } catch (error) { throw new Error(`Scale migration setup did not complete: ${JSON.stringify(lastMigrationStatus)}`, { cause: error }); }
        const database = new DatabaseSync(resolveCommandCenterDatabasePath(path.join(scenarioWorld.root, '.openclaw')), { readOnly: true });
        try { assert.ok(readVerifiedMigrationCompletion(database, { completionId: 'legacy-discord-v1', topicId: scaleTopicId }), 'verified scale migration must have a durable completion and exact Primary binding'); }
        finally { database.close(); }
      }
      managedBrowser = await withDeadline(`${kind} fresh browser launch`, () => launchManagedBrowser({ headless: true, timeout: 60_000 }));
      const page = await managedBrowser.browser.newPage({ viewport: { width, height: 900 } });
      const evidence = { console: [], errors: [], requests: [], responses: [] };
      await configureEvidencePage(page, browserGuard, evidence);
      await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: width <= 320 ? 'active' : 'none' });
      const pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.goto(controlUiPluginUrl({ gatewayUrl: scenarioWorld.gateway.url, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: scenarioWorld.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      let { frame } = await mountedPluginFrame(page, await pluginDocument);
      const scenarioName = kind === 'review' ? 'Area: Fictional Fresh Review Topic' : kind === 'scale-analysis' ? 'Area: Fictional Fresh Scale Analysis Topic' : `Fictional Fresh ${kind} Topic`;
      const journey = await runUiJourney(frame, { page, width, name: scenarioName, category: 'project', keyboard: true });
      const authoritativeSessions = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: journey.topicId } });
      const authoritativeConversations = (authoritativeSessions?.result ?? authoritativeSessions)?.conversations ?? authoritativeSessions?.conversations ?? [];
      assert.ok(authoritativeConversations.some((item) => item.isPrimary) && authoritativeConversations.some((item) => item.displayName === journey.conversationName));
      if (kind === 'scale') {
        const scaleTopicResponse = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: scaleTopicId } });
        const scaleTopic = (scaleTopicResponse?.result ?? scaleTopicResponse)?.topic;
        if (scaleTopic?.lifecycle !== 'active') {
          const migration = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.migration.status', params: { schemaVersion: 1 } });
          assert.fail(`Imported Topic is not active; durableMigration=${JSON.stringify(migration)}`);
        }
        assert.equal(scaleTopic?.revision, 1);
        assert.equal(typeof scaleTopic?.activatedAt, 'string');
        const initialScaleSessions = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: scaleTopicId } });
        const initialCount = ((initialScaleSessions?.result ?? initialScaleSessions)?.conversations ?? initialScaleSessions?.conversations ?? []).length;
        assert.equal(initialCount, 1, 'fresh imported scale Topic must start with one authoritative Primary Conversation');
        await seedAuthoritativeSessionCatalog({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, stateDir: path.join(scenarioWorld.root, '.openclaw'), topicId: scaleTopicId, initialCount, labelPrefix: 'Fresh scale Conversation', signal });
        const sessions = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: journey.topicId } });
        assert.ok(((sessions?.result ?? sessions)?.conversations ?? sessions?.conversations ?? []).length >= 2, 'fresh journey Topic remains independently authoritative');
        const scaleSessions = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: scaleTopicId } });
        const freshScaleAuthoritativeCount = ((scaleSessions?.result ?? scaleSessions)?.conversations ?? scaleSessions?.conversations ?? []).length;
        assert.equal(freshScaleAuthoritativeCount, RELEASE_FIXTURE_COUNTS.conversations);
        const largeNote = await exerciseLargeNoteFixture(frame, { gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, topicId: scaleTopicId });

        await prepareExactActivityFixture({ stateDir: path.join(scenarioWorld.root, '.openclaw'), gatewayUrl: scenarioWorld.gateway.url, topicId: 'fictional-fresh-scale-activity' });
        const firstActivity = await readDashboard(scenarioWorld.gateway.url, { activityOffset: 0, activityLimit: 50 });
        const secondActivity = await readDashboard(scenarioWorld.gateway.url, { activityOffset: 50, activityLimit: 50 });
        const thirdActivity = await readDashboard(scenarioWorld.gateway.url, { activityOffset: 100, activityLimit: 50 });
        assert.deepEqual([firstActivity.activity.records.length, secondActivity.activity.records.length, thirdActivity.activity.records.length], [50, 50, 1]);
        assert.equal(new Set([...firstActivity.activity.records, ...secondActivity.activity.records, ...thirdActivity.activity.records].map((record) => record.activityId)).size, RELEASE_FIXTURE_COUNTS.activityRecords);

        await Promise.all(COMMITTED_SEARCH_PROJECTION_FILES.map((name) => unlink(path.join(scaleProjectionRoot, name))));
        assert.deepEqual(await readdir(scaleProjectionRoot), [], 'fresh scale query must begin with a missing disposable projection');
        await rebuildSearchThroughAuthenticatedPost({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, topicId: scaleTopicId, signal, label: 'fresh missing Search projection rebuild' });
        await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: scaleTopicId, query: 'Fictional indexed scale phrase', limit: 50 } });
        await waitForCommittedSearchProjections(scaleProjectionRoot);
        const notesProjection = new DatabaseSync(path.join(scaleProjectionRoot, 'topic-search-notes.sqlite'), { readOnly: true });
        const conversationProjection = new DatabaseSync(path.join(scaleProjectionRoot, 'topic-search-conversations.sqlite'), { readOnly: true });
        try {
          assert.equal(notesProjection.prepare('SELECT count(*) AS count FROM note_documents WHERE topic_id = ?').get(scaleTopicId).count, RELEASE_FIXTURE_COUNTS.indexedNotes);
          assert.equal(conversationProjection.prepare('SELECT count(*) AS count FROM conversation_documents WHERE topic_id = ?').get(scaleTopicId).count, RELEASE_FIXTURE_COUNTS.indexedConversationMessages);
        } finally { notesProjection.close(); conversationProjection.close(); }
        const staleManifestPath = path.join(scaleProjectionRoot, 'topic-search-notes.json');
        const staleManifest = JSON.parse(await readFile(staleManifestPath, 'utf8'));
        await writeFile(staleManifestPath, `${JSON.stringify({ ...staleManifest, generation: 'fictional-fresh-stale-generation' })}\n`);
        await assert.rejects(() => requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: scaleTopicId, query: 'Fictional indexed scale phrase', limit: 50 } }), /capability-unavailable|projection/iu);
        await rebuildSearchThroughAuthenticatedPost({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, topicId: scaleTopicId, signal, label: 'fresh stale Search projection rebuild' });
        await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: scaleTopicId, query: 'Fictional indexed scale phrase', limit: 50 } });
        await waitForCommittedSearchProjections(scaleProjectionRoot);
        const repairedManifest = JSON.parse(await readFile(staleManifestPath, 'utf8'));
        assert.notEqual(repairedManifest.generation, 'fictional-fresh-stale-generation');
        return Object.freeze({ kind, topicId: journey.topicId, freshWorld: scenarioWorld.root, assertionsCompleted: true, scale: { largeNoteBytes: RELEASE_FIXTURE_COUNTS.largeNoteBytes, conversations: RELEASE_FIXTURE_COUNTS.conversations, activityRecords: RELEASE_FIXTURE_COUNTS.activityRecords, actionCards: RELEASE_FIXTURE_COUNTS.actionCards, indexedNotes: RELEASE_FIXTURE_COUNTS.indexedNotes, indexedConversationMessages: RELEASE_FIXTURE_COUNTS.indexedConversationMessages, largeNoteLifecycleMs: largeNote.largeNoteLifecycleMs, missingProjectionRebuilt: true, staleProjectionRebuilt: true } });
      } else if (kind === 'scale-analysis') {
        await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, scopes: ['operator.read', 'operator.write', 'operator.admin'], method: 'command-center.v1.reminders.create', params: { schemaVersion: 1, topicId: journey.topicId, logicalOperationId: randomUUID(), declaration: { name: 'Fictional fresh scale analysis reminder', enabled: true, deleteAfterRun: false, schedule: { kind: 'at', at: new Date(Date.now() - 30_000).toISOString() }, payload: { kind: 'systemEvent', text: 'Fictional fresh scale analysis reminder' }, sessionTarget: 'main', wakeMode: 'next-heartbeat' } } });
        await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: journey.topicId, input: {}, logicalOperationId: randomUUID() } });
        let cards = (await readDashboard(scenarioWorld.gateway.url, { activityOffset: 0, activityLimit: 50 })).attention;
        if (!cards.some((card) => card.sourceCapabilityId === 'topic-review')) {
          const topicResponse = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: journey.topicId } });
          const topic = (topicResponse?.result ?? topicResponse)?.topic;
          await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.rename', params: { schemaVersion: 1, topicId: journey.topicId, name: 'Area: Fictional Fresh Scale Analysis Topic Revised', expectedRevision: topic.revision, logicalOperationId: randomUUID() } });
          await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: journey.topicId, input: {}, logicalOperationId: randomUUID() } });
          cards = (await readDashboard(scenarioWorld.gateway.url, { activityOffset: 0, activityLimit: 50 })).attention;
        }
        assert.equal(cards.filter((card) => card.sourceCapabilityId === 'reminders').length, 1);
        assert.equal(cards.filter((card) => card.sourceCapabilityId === 'topic-review').length, 1);
        return Object.freeze({ kind, topicId: journey.topicId, freshWorld: scenarioWorld.root, assertionsCompleted: true, actionCards: RELEASE_FIXTURE_COUNTS.actionCards });
      } else if (kind === 'mobile') {
        assert.ok(journey.accessibilityStates.length >= 8 && journey.focusRestorations.length >= 4 && journey.announcementTransitions.length >= 4);
        await assertResponsiveFrame(frame, page, 320);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
        assert.deepEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, visualWidth: visualViewport.width, scale: visualViewport.scale, ratio: devicePixelRatio })), { width: 320, visualWidth: 160, scale: 2, ratio: 1 });
        assert.equal(await frame.evaluate(() => devicePixelRatio), 1, 'zoom must not be simulated by device pixel density');
        const zoomJourney = await runUiJourney(frame, { page, width: 320, name: 'Fictional Fresh 200 Percent Zoom Topic', category: 'area', keyboard: true });
        assert.ok(zoomJourney.topicId);
        await assertResponsiveFrame(frame, page, 320);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
        await cdp.detach();
      } else if (kind === 'review') {
        await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: journey.topicId, input: {}, logicalOperationId: randomUUID() } });
        const topicResponse = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: journey.topicId } });
        const topic = (topicResponse?.result ?? topicResponse).topic;
        await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.rename', params: { schemaVersion: 1, topicId: journey.topicId, name: 'Area: Fictional Fresh Review Topic Revised', expectedRevision: topic.revision, logicalOperationId: randomUUID() } });
        await activate(frame.locator('#analysis-run'), true);
        await waitForFrameText(frame, '#analysis-feedback', 'Analysis completed.');
        await frame.locator('.topic-review-proposal').first().waitFor({ state: 'visible' });
        const proposals = frame.locator('.topic-review-proposal');
        const proposalCount = await proposals.count();
        assert.equal(proposalCount, 1, 'the fresh single-Topic fixture must produce exactly its explicit category proposal');
        await activate(proposals.first().getByRole('button', { name: 'Approve', exact: true }), true);
        for (let index = 1; index < proposalCount; index += 1) await activate(proposals.nth(index).getByRole('button', { name: 'Keep as-is', exact: true }), true);
        const checkpoint = frame.locator('#topic-review-checkpoint');
        await checkpoint.waitFor({ state: 'visible' });
        await activate(checkpoint, true);
        await respondToCommandDialog(frame, { confirm: false });
        await waitForFrameText(frame, '#topic-review-plan', 'Frozen application plan');
        await activate(checkpoint, true);
        await respondToCommandDialog(frame);
        await waitForFrameText(frame, '#topic-review-plan', 'Application outcomes:');
        const appliedResponse = await frame.evaluate(async () => {
          const response = await fetch('/plugins/command-center/api/topic-analysis', { credentials: 'omit', headers: { accept: 'application/json' } });
          return { status: response.status, body: await response.json() };
        });
        assert.equal(appliedResponse.status, 200);
        const applied = appliedResponse.body?.result ?? appliedResponse.body;
        assert.equal(applied?.review?.state ?? applied?.state, 'Resolved');
        const summary = applied.review.applicationSummary;
        assert.equal(summary.status, 'complete');
        const outcomes = Object.values(summary.outcomes);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].status, 'applied');
        assert.equal(outcomes[0].result.topicId, journey.topicId);
        assert.deepEqual(applied.review.proposals, [], 'resolved proposals leave the actionable review list');
        const readbackResponse = await requestAuthenticatedGateway({ gatewayUrl: scenarioWorld.gateway.url, credential: scenarioWorld.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: journey.topicId } });
        const readback = (readbackResponse?.result ?? readbackResponse).topic;
        assert.equal(readback.paraCategory, 'area');
        assert.equal(readback.name, 'Area: Fictional Fresh Review Topic Revised');
        assert.equal(readback.revision, topic.revision + 2, 'rename and approved recategorization each advance the Topic revision once');
        assert.equal(readback.noteFolderReferenceId, topic.noteFolderReferenceId);
      }
      return Object.freeze({ kind, topicId: journey.topicId, freshWorld: scenarioWorld.root, assertionsCompleted: true });
    } finally {
      signal?.removeEventListener('abort', abortCleanup);
      await closeManagedBrowser(managedBrowser).catch(() => {});
      await withDeadline(`${kind} fresh host stop`, async () => { await stopPinnedHost(scenarioHost.child); await scenarioHost.outputDrained; });
      assertNoFatalHostOutput(scenarioHost.diagnostics);
      await assertRecordedChildTraffic(scenarioWorld);
      browserGuard.assertClean();
      scenarioHost.diagnostics.guard.assertClean();
    }
  }, { candidateRoot: process.cwd() });
}

async function requestAuthenticatedGateway({ gatewayUrl, credential, method, params = {}, scopes = ['operator.read'], responseTimeoutMs = 10_000, signal, deviceIdentity }) {
  signal ??= acceptanceSignalContext.getStore();
  signal?.throwIfAborted();
  const socket = new WebSocket(gatewayUrl.replace(/^http/u, 'ws'));
  const frames = [];
  const waitForFrame = (predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const inspect = (frame) => { if (predicate(frame)) { cleanup(); resolve(frame); return true; } return false; };
    const onMessage = (event) => { let frame; try { frame = JSON.parse(String(event.data)); } catch { return; } frames.push(frame); inspect(frame); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Authenticated Gateway response timed out.')); }, timeoutMs);
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('Gateway request aborted.')); };
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener('message', onMessage); signal?.removeEventListener('abort', onAbort); };
    for (const frame of frames) if (inspect(frame)) return;
    socket.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const abortSocket = () => socket.close();
  signal?.addEventListener('abort', abortSocket, { once: true });
  try {
    const challengePromise = waitForFrame((frame) => frame?.type === 'event' && frame.event === 'connect.challenge');
    const openedPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('Gateway connection aborted.')); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Authenticated Gateway connection failed.')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Authenticated Gateway connection timed out.')); }, 10_000);
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const [, challenge] = await Promise.all([openedPromise, challengePromise]);
    assert.equal(typeof challenge.payload?.nonce, 'string');
    const connectId = `command-center-acceptance-connect-${randomUUID()}`;
    const client = { id: 'cli', version: '1', platform: 'test', mode: 'cli' };
    const device = deviceIdentity ? signedGatewayDevice(deviceIdentity, { nonce: challenge.payload.nonce, credential, scopes, client }) : undefined;
    socket.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client, caps: [], commands: [], role: 'operator', scopes, auth: { ['to' + 'ken']: credential }, ...(device ? { device } : {}) } }));
    const connected = await waitForFrame((frame) => frame?.type === 'res' && frame.id === connectId);
    if (!connected.ok) throw new Error(`Authenticated Gateway connect failed: ${connected.error?.code ?? 'unknown'}`);
    const requestId = `command-center-acceptance-${randomUUID()}`;
    socket.send(JSON.stringify({ type: 'req', id: requestId, method, params }));
    const response = await waitForFrame((frame) => frame?.type === 'res' && frame.id === requestId, responseTimeoutMs);
    if (!response.ok) {
      const detail = redactBrowserEvidence(response.error?.message ?? 'no bounded detail');
      throw new Error(`Authenticated ${method} failed: ${response.error?.code ?? 'unknown'} (${detail})`);
    }
    return response.payload;
  } finally { signal?.removeEventListener('abort', abortSocket); socket.close(); }
}

function authenticatedList(response, property) {
  const value = response?.result ?? response;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[property])) return value[property];
  return Array.isArray(response?.[property]) ? response[property] : [];
}

async function seedAuthoritativeSessionCatalog({ gatewayUrl, credential, stateDir, topicId, initialCount, labelPrefix, signal, onBatch }) {
  const createdSessions = [];
  for (let offset = initialCount; offset < RELEASE_FIXTURE_COUNTS.conversations; offset += 10) {
    signal?.throwIfAborted();
    const indexes = Array.from({ length: Math.min(10, RELEASE_FIXTURE_COUNTS.conversations - offset) }, (_, batchIndex) => offset + batchIndex);
    const batch = await Promise.all(indexes.map(async (index) => {
      const label = `${labelPrefix} ${index}`;
      const key = `agent:main:command-center:acceptance-scale:${topicId}:${index}`;
      const response = await requestAuthenticatedGateway({
        gatewayUrl,
        credential,
        scopes: ['operator.read', 'operator.write'],
        method: 'sessions.create',
        params: { agentId: 'main', key, label },
        signal
      });
      const value = response?.result ?? response;
      const sessionKey = value?.key ?? value?.sessionKey;
      const sessionId = value?.sessionId ?? value?.entry?.sessionId;
      assert.equal(typeof sessionKey, 'string');
      assert.equal(typeof sessionId, 'string');
      return { label, sessionKey, sessionId };
    }));
    createdSessions.push(...batch);
    onBatch?.({ completed: Math.min(offset + indexes.length, RELEASE_FIXTURE_COUNTS.conversations), total: RELEASE_FIXTURE_COUNTS.conversations });
  }
  signal?.throwIfAborted();
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    for (const created of createdSessions) {
      const referenceId = `session:${topicId}:${created.sessionKey}`;
      if (!metadata.getSourceReference(referenceId)) metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: created.sessionKey, observedRevision: null });
      metadata.setSessionState({ referenceId, sessionId: created.sessionId, status: 'open', isPrimary: false, displayName: created.label });
    }
  } finally { metadata.close(); }
  return Object.freeze({ created: createdSessions.length, authoritativeTotal: initialCount + createdSessions.length });
}

async function createSessionThroughAuthenticatedFrame(frame, { topicId, label, logicalOperationId, authoritativeSession = null, signal }) {
  signal?.throwIfAborted();
  const evaluation = frame.evaluate(async ({ topicId: exactTopicId, label: exactLabel, logicalOperationId: operation, retainedAuthoritativeSession }) => {
    const created = retainedAuthoritativeSession ?? await new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => { cleanup(); reject(new Error('mounted capability bridge sessions.create timed out')); }, 10_000);
      const cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
      const receive = (event) => {
        const payload = event.data?.payload;
        if (event.source !== window || event.data?.type !== 'openclaw:capability-bridge-receive' || payload?.type !== 'openclaw:capability-bridge-response' || payload.requestId !== requestId) return;
        cleanup();
        if (payload.error) reject(Object.assign(new Error('mounted capability bridge sessions.create failed'), { code: payload.error.code }));
        else resolve(payload.result);
      };
      window.addEventListener('message', receive);
      window.postMessage({ type: 'openclaw:capability-bridge-send', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-request', requestId, method: 'sessions.create', params: { agentId: 'main', label: exactLabel }, operationId: operation } }, '*');
    });
    const createdValue = created?.result ?? created;
    const key = createdValue?.key ?? createdValue?.sessionKey;
    const sessionId = createdValue?.sessionId ?? createdValue?.entry?.sessionId;
    const revision = createdValue?.revision ?? createdValue?.updatedAt ?? createdValue?.entry?.updatedAt;
    if (typeof key !== 'string' || typeof sessionId !== 'string' || revision === undefined || revision === null) throw new Error('mounted sessions.create returned an incomplete authoritative identity');
    const exactSession = { key, sessionId, revision: String(revision), idempotencyKey: operation, label: exactLabel };
    const mutationResponse = await fetch('/plugins/command-center/api/topic/actions', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, action: 'conversations.create', topicId: exactTopicId, label: exactLabel, expectedRevision: 1, logicalOperationId: operation, authoritativeSession: exactSession }) });
    return { status: mutationResponse.status, body: await mutationResponse.json(), authoritativeSession: exactSession };
  }, { topicId, label, logicalOperationId, retainedAuthoritativeSession: authoritativeSession });
  let abortEvaluation;
  const aborted = signal && new Promise((_, reject) => { abortEvaluation = () => reject(signal.reason ?? new Error('mounted Session creation aborted')); signal.addEventListener('abort', abortEvaluation, { once: true }); });
  let response;
  try { response = aborted ? await Promise.race([evaluation, aborted]).catch(async (error) => { await evaluation.catch(() => undefined); throw error; }) : await evaluation; }
  finally { if (abortEvaluation) signal.removeEventListener('abort', abortEvaluation); }
  signal?.throwIfAborted();
  if (response.status !== 200) throw new Error(`authenticated Session creation failed with status ${response.status}; code=${response.body?.code ?? 'unavailable'}`);
  return { ...response.body, authoritativeSession: response.authoritativeSession };
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
  const response = await fetchWithDeadline(`${gatewayUrl}/plugins/command-center/api/dashboard?activityOffset=${activityOffset}&activityLimit=${activityLimit}`, { headers: { accept: 'application/json' } }, 'dashboard read');
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

async function completeReminder(gatewayUrl, episode, { credential, signal, deviceIdentity } = {}) {
  const payload = await requestAuthenticatedGateway({
    gatewayUrl,
    credential,
    scopes: ['operator.read', 'operator.write', 'operator.admin'],
    method: 'command-center.v1.attention.act',
    params: reminderActionRequest(episode),
    signal,
    deviceIdentity
  });
  if (payload?.status !== 'applied' || payload?.result?.episode?.state !== 'Resolved') {
    throw new HarnessFailure('reminder-completion-not-applied', `Reminder completion did not reach its durable terminal state: ${JSON.stringify({ status: payload?.status ?? null, episodeState: payload?.result?.episode?.state ?? null, attemptState: payload?.result?.attempt?.state ?? null, attemptOutcome: payload?.result?.attempt?.outcome ?? null, verificationRevision: payload?.result?.attempt?.verificationRevision ?? null, evidenceFacts: payload?.result?.episode?.evidenceFacts ?? null })}`);
  }
  return payload;
}

function refusedTopicCreateRequest(name) {
  const logicalOperationId = randomUUID();
  return { schemaVersion: 1, action: 'create', topicId: randomUUID(), name, paraCategory: 'resource', logicalOperationId, authoritativeSession: { key: 'agent:main:fictional-refused-topic', sessionId: 'fictional-refused-session', revision: '1', idempotencyKey: logicalOperationId, label: name } };
}

function readMigrationProgress(stateDir) {
  let db;
  try {
    db = new DatabaseSync(resolveCommandCenterDatabasePath(stateDir), { readOnly: true });
    return { state: db.prepare('SELECT phase FROM migration_state').all(), channels: db.prepare('SELECT phase, imported_count AS importedCount, next_ordinal AS nextOrdinal, expected_count AS expectedCount FROM migration_channels LIMIT 3').all(), anchoredOccurrences: db.prepare('SELECT count(*) AS count FROM migration_occurrences WHERE destination_anchor_json IS NOT NULL').get().count };
  } catch { return { state: 'unavailable' }; }
  finally { db?.close(); }
}

async function prepareExactActivityFixture({ stateDir, gatewayUrl, topicId }) {
  const readIds = async () => {
    const ids = [];
    for (let offset = 0; offset <= RELEASE_FIXTURE_COUNTS.activityRecords; offset += 50) {
      const page = (await readDashboard(gatewayUrl, { activityOffset: offset, activityLimit: 50 })).activity;
      ids.push(...page.records.map((record) => record.activityId));
      assert.ok(ids.length <= RELEASE_FIXTURE_COUNTS.activityRecords, 'genuine Activity exceeds the exact release fixture; never delete or hide it');
      if (!page.hasMore) return ids;
    }
    throw new Error('Activity fixture exceeds its bounded pagination contract');
  };
  const genuine = await readIds();
  assert.equal(new Set(genuine).size, genuine.length);
  // Fixture-only synthetic rows go through the canonical metadata writer, never a new product write API.
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: READY_CAPABILITIES });
  try {
    assert.equal(metadata.getOperatingStatus().mode, 'ready');
    for (let index = genuine.length; index < RELEASE_FIXTURE_COUNTS.activityRecords; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 0, 1) + index).toISOString();
      metadata.recordActivity({ activityId: `fictional-scale-top-up-${index}`, topicId, logicalOperationId: randomUUID(), transportRequestId: randomUUID(), operationKind: 'fixture.scale', outcome: 'applied', observedRevision: `sha256:${String(index).padStart(64, '0')}`, createdAt, updatedAt: createdAt });
    }
  } finally { metadata.close(); }
  const finalIds = await readIds();
  assert.equal(finalIds.length, RELEASE_FIXTURE_COUNTS.activityRecords);
  for (const id of genuine) assert.ok(finalIds.includes(id), 'real source Activity must remain in the exact fixture');
}

async function readAuthenticatedHistory({ gatewayUrl, credential, sessionKey, signal }) {
  return requestAuthenticatedGateway({ gatewayUrl, credential, method: 'chat.history', params: { sessionKey }, signal });
}

async function waitForFrameText(frame, selector, expected, timeout = BRIDGE_UI_OPERATION_BUDGET_MS) {
  try {
    await frame.waitForFunction(({ selector: target, expectedText }) => document.querySelector(target)?.textContent?.includes(expectedText), { selector, expectedText: expected }, { timeout });
  } catch (error) {
    const state = await frame.evaluate((target) => ({
      text: document.querySelector(target)?.textContent?.trim().slice(0, 500) ?? null,
      operatingMode: document.documentElement.dataset.operatingMode ?? null,
      active: document.activeElement?.id || document.activeElement?.getAttribute?.('name') || document.activeElement?.tagName || null
    }), selector).catch(() => null);
    throw new Error(`${selector} did not include ${JSON.stringify(expected)}; state=${JSON.stringify(state)}; ${error.message}`);
  }
}

async function waitForDashboard(frame, timeout = 10_000) {
  await frame.waitForFunction(() => {
    const dashboard = document.querySelector('#dashboard');
    return dashboard && !dashboard.textContent?.includes('Loading current Attention…') && !dashboard.textContent?.includes('Loading Activity…');
  }, undefined, { timeout });
}

async function assertNoFrameOverflow(frame, label) {
  const audit = await frame.evaluate(() => {
    const selectors = ['html', 'body', 'main', '#dashboard', '.dashboard-panel', '#topic-groups', '.topic-group', '#topic-exceptions', '#topic-workspace', '.workspace-layout', '.workspace-layout > [data-pane]', 'dialog[open]', '.evidence-scroll', '.card-list', '#activity', '#conversation-list', '#chat-messages', '#notes-tree', '.note-editor', '.markdown-preview', '.search-grid', '#notes-results', '#conversations-results', '#workspace-notes-results', '#workspace-conversations-results', '#topic-review-groups'];
    const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
    const visible = nodes.filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]') && node.clientWidth > 0;
    });
    return {
      checked: visible.map((node) => node.id || node.getAttribute('data-pane') || node.className || node.tagName),
      overflowing: visible.filter((node) => node.scrollWidth > node.clientWidth).map((node) => ({ name: node.id || node.getAttribute('data-pane') || node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }))
    };
  });
  assert.ok(audit.checked.length > 0, `${label} did not audit any visible layout containers`);
  assert.deepEqual(audit.overflowing, [], `${label} has pane-level horizontal overflow`);
}

async function tabTo(locator, { reverse = false, limit = 240 } = {}) {
  await locator.waitFor({ state: 'visible' });
  const page = locator.page();
  const order = await locator.evaluate((target) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      return !node.disabled && node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
    };
    const tabbable = (node) => visible(node) && (node.tabIndex >= 0 && node.matches('button,input,select,textarea,a[href],[tabindex]') || ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
    const tabbables = [...document.querySelectorAll('*')].filter(tabbable);
    return {
      count: tabbables.length,
      current: tabbables.indexOf(document.activeElement),
      target: tabbables.indexOf(target),
      inDialog: Boolean(target.closest('dialog[open]')),
      targetState: {
        name: target.id || target.getAttribute('aria-label') || target.getAttribute('name') || target.tagName,
        disabled: Boolean(target.disabled),
        tabIndex: target.tabIndex,
        rects: target.getClientRects().length,
        hiddenAncestor: target.closest('[hidden], [inert]')?.id || target.closest('[hidden], [inert]')?.tagName || null,
        display: getComputedStyle(target).display,
        visibility: getComputedStyle(target).visibility
      }
    };
  });
  assert.notEqual(order.target, -1, `Requested keyboard target is absent from the sequential focus order: ${JSON.stringify(order.targetState)}`);
  if (order.current === order.target) return;
  if (order.current < 0) await locator.evaluate((target) => {
    const body = target.ownerDocument.body;
    const previousTabIndex = body.getAttribute('tabindex');
    body.setAttribute('tabindex', '-1');
    body.focus({ preventScroll: true });
    if (previousTabIndex === null) body.removeAttribute('tabindex');
    else body.setAttribute('tabindex', previousTabIndex);
  });
  const backwards = reverse || (order.current >= 0 && order.target < order.current);
  assert.ok(order.count <= limit, 'Sequential keyboard traversal exceeded its bounded focus path.');
  for (let step = 1; step <= limit; step += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    const state = await locator.evaluate((target) => {
      const visible = (node) => {
        const style = getComputedStyle(node);
        return !node.disabled && node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
      };
      const tabbable = (node) => visible(node) && (node.tabIndex >= 0 && node.matches('button,input,select,textarea,a[href],[tabindex]') || ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
      const tabbables = [...document.querySelectorAll('*')].filter(tabbable);
      const active = document.activeElement;
      const nativeComposite = active instanceof HTMLInputElement && ['date', 'datetime-local', 'month', 'time', 'week'].includes(active.type);
      return { index: tabbables.indexOf(active), name: active?.id || active?.getAttribute?.('aria-label') || active?.tagName || 'unknown', target: active === target, hidden: Boolean(active?.closest?.('[hidden], [inert]')) || active?.getClientRects?.().length === 0, outline: active ? getComputedStyle(active).outlineStyle : 'none', nativeComposite, escapedDialog: Boolean(target.closest('dialog[open]')) && !active?.closest?.('dialog[open]') };
    });
    assert.notEqual(state.index, -1, `Sequential keyboard focus left the mounted shell at ${state.name}.`);
    assert.equal(state.hidden, false, 'Sequential keyboard focus entered hidden or inert content.');
    assert.ok(state.outline !== 'none' || state.nativeComposite, `Sequential keyboard focus must remain visible at ${state.name}.`);
    assert.equal(state.escapedDialog, false, 'Sequential keyboard focus escaped an open modal dialog.');
    if (state.target) return;
  }
  throw new Error(`Sequential keyboard traversal did not reach ${await locator.getAttribute('id') || await locator.getAttribute('aria-label') || 'the requested control'}.`);
}

async function respondToCommandDialog(frame, { value, confirm = true } = {}) {
  await frame.locator('#command-dialog').waitFor({ state: 'visible' });
  if (value !== undefined) await enterText(frame.locator('#command-dialog-input'), value, true);
  await activate(frame.locator(confirm ? '#command-dialog-submit' : '#command-dialog-cancel'), true);
  await frame.locator('#command-dialog').waitFor({ state: 'hidden' });
}
async function activate(locator, keyboard = false, key = 'Enter') {
  if (keyboard) {
    await locator.scrollIntoViewIfNeeded();
    await tabTo(locator);
    await locator.page().keyboard.press(key);
  }
  else await locator.click();
}

async function enterText(locator, value, keyboard = false) {
  if (!keyboard) return locator.fill(value);
  await tabTo(locator);
  await locator.page().keyboard.press('ControlOrMeta+A');
  await locator.page().keyboard.type(value);
}

async function chooseOption(locator, value, keyboard = false) {
  if (!keyboard) return locator.selectOption(value);
  const index = await locator.locator('option').evaluateAll((options, target) => options.findIndex((option) => option.value === target), value);
  assert.ok(index >= 0, `Missing keyboard-select option ${value}`);
  await tabTo(locator);
  await locator.page().keyboard.press('Home');
  for (let position = 0; position < index; position += 1) await locator.page().keyboard.press('ArrowDown');
  await locator.page().keyboard.press('Enter');
  assert.equal(await locator.inputValue(), value);
}

async function submitFrameForm(frame, selector, keyboard = false) {
  const form = frame.locator(selector);
  assert.equal(await form.evaluate((node) => node.checkValidity()), true, `${selector} must be valid before submission`);
  if (keyboard) {
    await activate(form.locator('button[type="submit"]'), true, 'Space');
  }
  else await form.locator('button[type="submit"]').click();
}

async function selectWorkspaceSection(frame, name, width, keyboard = false) {
  if (width < 768) await activate(frame.locator(`.workspace-sections button[data-section="${name}"]`), keyboard);
}

async function auditDynamicAccessibilityState(frame, page, width, label, keyboard) {
  const responsive = await assertResponsiveFrame(frame, page, width);
  const state = await frame.evaluate((keyboardMode) => {
    const modal = [...document.querySelectorAll('[role="dialog"]')].find((node) => node instanceof HTMLDialogElement && node.open);
    const active = document.activeElement;
    const style = active instanceof HTMLElement ? getComputedStyle(active) : null;
    return {
      modalLabelled: !modal || (modal.getAttribute('aria-modal') === 'true' && Boolean(modal.getAttribute('aria-labelledby') || modal.getAttribute('aria-label'))),
      focusInModal: !modal || modal.contains(active),
      focusVisible: !keyboardMode || (active instanceof HTMLElement && active !== document.body && style?.outlineStyle !== 'none'),
      liveRegions: [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].map((node) => node.textContent?.trim() ?? ''),
      colorIndependent: [...document.querySelectorAll('[aria-selected], [aria-current], [aria-checked], [data-status]')].filter((node) => {
        const nodeStyle = getComputedStyle(node);
        return nodeStyle.display !== 'none' && nodeStyle.visibility !== 'hidden';
      }).every((node) => Boolean(node.textContent?.trim() || node.getAttribute('aria-label') || node.getAttribute('aria-selected') || node.getAttribute('aria-current') || node.getAttribute('aria-checked') || node.getAttribute('data-status'))),
      reducedMotion: !matchMedia('(prefers-reduced-motion: reduce)').matches || [...document.querySelectorAll('*')].every((node) => {
        const nodeStyle = getComputedStyle(node);
        return parseFloat(nodeStyle.animationDuration || '0') <= 0.001 && parseFloat(nodeStyle.transitionDuration || '0') <= 0.001 && nodeStyle.scrollBehavior !== 'smooth';
      }),
      reducedMotionPreference: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forcedColorsPreference: matchMedia('(forced-colors: active)').matches,
      headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .filter((node) => {
          const headingStyle = getComputedStyle(node);
          return headingStyle.display !== 'none' && headingStyle.visibility !== 'hidden' && !node.closest('[hidden], [inert]');
        })
        .map((node) => Number(node.tagName.slice(1)))
    };
  }, keyboard);
  assert.equal(state.modalLabelled, true, `${label} dialog is not labelled`);
  assert.equal(state.focusInModal, true, `${label} focus escaped its modal dialog`);
  assert.equal(state.focusVisible, true, `${label} has no visible keyboard focus`);
  assert.ok(state.liveRegions.length > 0, `${label} has no live status announcement region`);
  assert.equal(state.colorIndependent, true, `${label} conveys state only by color`);
  assert.equal(state.reducedMotion, true, `${label} retains motion under reduced-motion preference`);
  for (let index = 1; index < state.headings.length; index += 1) assert.ok(state.headings[index] - state.headings[index - 1] <= 1, `${label} skips a heading level`);
  return Object.freeze({ label, colorIndependent: state.colorIndependent, reducedMotion: state.reducedMotion, reducedMotionPreference: state.reducedMotionPreference, forcedColorsPreference: state.forcedColorsPreference, minimumTargetCssPx: responsive.minimumTargetCssPx, noPageOverflow: responsive.noPageOverflow, modalLabelled: state.modalLabelled });
}

async function runUiJourney(frame, { page, width, name, category = 'project', keyboard = false, projectionRoot } = {}) {
  const measurement = {};
  const accessibilityStates = [];
  const focusRestorations = [];
  const announcementTransitions = [];
  const audit = async (label) => { accessibilityStates.push(await auditDynamicAccessibilityState(frame, page, width, label, keyboard)); };
  const statusText = (selector) => frame.evaluate((target) => {
    window.__acceptanceStatusTransitions ??= new Map();
    window.__acceptanceStatusTransitions.get(target)?.observer.disconnect();
    const node = document.querySelector(target);
    const state = { samples: [], observer: new MutationObserver(() => { if (state.samples.length < 20) state.samples.push(node.textContent.trim()); }) };
    state.observer.observe(node, { childList: true, characterData: true, subtree: true });
    window.__acceptanceStatusTransitions.set(target, state);
    return node.textContent.trim();
  }, selector);
  const recordAnnouncement = async (selector, before, label) => {
    const observed = await frame.evaluate((target) => {
      const state = window.__acceptanceStatusTransitions.get(target); state.observer.disconnect();
      return { after: document.querySelector(target).textContent.trim(), samples: state.samples };
    }, selector);
    assert.ok(observed.after && (observed.after !== before || observed.samples.some((text) => text && text !== before)), `${label} did not announce an observable status transition`);
    announcementTransitions.push(label);
  };
  const recordFocusRestoration = async (locator, label) => {
    const restored = await locator.evaluate((node) => document.activeElement === node);
    assert.equal(restored, true, `${label} did not restore invoking focus`);
    focusRestorations.push(label);
  };
  const actionDurations = [];
  const timed = async (run) => { const started = Date.now(); await run(); actionDurations.push(Math.max(1, Date.now() - started)); };
  const dashboardStarted = Date.now();
  await waitForDashboard(frame);
  measurement.dashboardLoadMs = Math.max(1, Date.now() - dashboardStarted);
  await enterText(frame.locator('#topic-create input[name="name"]'), name, keyboard);
  await chooseOption(frame.locator('#topic-create select[name="paraCategory"]'), category, keyboard);
  const topicStatusBefore = await statusText('#topic-status');
  const topicCreateStarted = Date.now();
  const topicMutation = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/plugins/command-center/api/topics/actions', { timeout: 10_000 });
  await submitFrameForm(frame, '#topic-create', keyboard);
  const topicMutationResponse = await topicMutation;
  if (!topicMutationResponse.ok()) {
    const body = await topicMutationResponse.json().catch(() => ({}));
    let durableStep = null;
    if (projectionRoot) {
      const metadata = new DatabaseSync(path.join(path.dirname(projectionRoot), 'metadata.sqlite'), { readOnly: true });
      try {
        const operation = metadata.prepare("SELECT state, current_step, result_json FROM topic_operations WHERE operation_kind = 'topics.create' ORDER BY updated_at DESC LIMIT 1").get();
        durableStep = operation ? { state: operation.state, currentStep: operation.current_step, result: JSON.parse(operation.result_json ?? '{}') } : null;
      } finally { metadata.close(); }
    }
    throw new Error(`Topic creation HTTP ${topicMutationResponse.status()} code=${String(body?.code ?? 'unavailable').slice(0, 80)} durableStep=${JSON.stringify(durableStep)}`);
  }
  await waitForFrameText(frame, '#topic-status', 'Topic created and verified.');
  const topicCreateMs = Math.max(1, Date.now() - topicCreateStarted);
  await recordAnnouncement('#topic-status', topicStatusBefore, `${width}px Topic creation`);
  await assertNoFrameOverflow(frame, `${width}px Topic creation`);
  await audit(`${width}px Topic creation`);
  const row = frame.locator('.topic-row').filter({ hasText: name });
  const topicOpenStarted = Date.now();
  await activate(row.getByRole('button', { name: 'Open Topic', exact: true }), keyboard);
  await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
  measurement.topicOpenCreateMs = topicCreateMs + Math.max(1, Date.now() - topicOpenStarted);
  const topicId = await row.getAttribute('data-topic-id');
  assert.match(topicId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  await selectWorkspaceSection(frame, 'chat', width, keyboard);
  const primaryMessage = `Fictional Primary Chat message for ${name}.`;
  await enterText(frame.locator('#chat-message'), primaryMessage, keyboard);
  const chatStatusBefore = await statusText('#chat-status');
  const chatStarted = Date.now();
  await submitFrameForm(frame, '#chat-form', keyboard);
  await waitForFrameText(frame, '#chat-status', 'Message sent.');
  measurement.chatSendMs = Math.max(1, Date.now() - chatStarted);
  await recordAnnouncement('#chat-status', chatStatusBefore, `${width}px Primary Chat`);
  await assertNoFrameOverflow(frame, `${width}px Primary Chat`);

  await selectWorkspaceSection(frame, 'conversations', width, keyboard);
  const conversationLifecycleStarted = Date.now();
  const conversationName = `Fictional Conversation ${name}`;
  await enterText(frame.locator('#conversation-create input[name="label"]'), conversationName, keyboard);
  await timed(() => submitFrameForm(frame, '#conversation-create', keyboard));
  const conversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
  const conversationSwitchStarted = Date.now();
  await activate(conversation.getByRole('button', { name: conversationName, exact: true }), keyboard);
  await waitForFrameText(frame, '#chat-conversation-name', conversationName);
  await audit(`${width}px open Conversation`);
  actionDurations.push(Math.max(1, Date.now() - conversationSwitchStarted));
  await timed(() => activate(conversation.getByRole('button', { name: 'Close', exact: true }), keyboard));
  await chooseOption(frame.locator('#conversation-view'), 'closed', keyboard);
  const closedConversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
  await closedConversation.getByText('Closed', { exact: true }).waitFor();
  await audit(`${width}px closed Conversation`);
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
  try { await closedConversation.waitFor({ state: 'detached', timeout: BRIDGE_UI_OPERATION_BUDGET_MS }); }
  catch (error) {
    const state = await frame.evaluate(() => ({ view: document.querySelector('#conversation-view').value, status: document.querySelector('#conversation-status').textContent, rows: [...document.querySelectorAll('.conversation-item')].map((row) => ({ referenceId: row.dataset.referenceId, text: row.textContent })) }));
    throw new Error(`Reopen did not settle; reopenPresentation=${JSON.stringify(state)}`, { cause: error });
  }
  await chooseOption(frame.locator('#conversation-view'), 'open', keyboard);
  await frame.locator('.conversation-item').filter({ hasText: conversationName }).getByText('Open', { exact: true }).waitFor();
  measurement.conversationLifecycleMs = Math.max(1, Date.now() - conversationLifecycleStarted);
  await assertNoFrameOverflow(frame, `${width}px Conversation lifecycle`);

  await selectWorkspaceSection(frame, 'notes', width, keyboard);
  const noteNew = frame.locator('#note-new');
  await activate(noteNew, keyboard);
  const noteDialog = frame.locator('#note-action-dialog');
  await noteDialog.waitFor();
  await audit(`${width}px Create Note dialog`);
  const notePath = `journey-${width}.md`;
  await enterText(frame.locator('#note-action-path'), notePath, keyboard);
  await enterText(frame.locator('#note-action-text'), `# ${name}\n\nFictional journey search evidence.`, keyboard);
  await timed(() => activate(frame.locator('#note-action-submit'), keyboard));
  await noteDialog.waitFor({ state: 'hidden' });
  if (keyboard) await recordFocusRestoration(noteNew, `${width}px Create Note dialog`);
  await frame.locator('#notes-tree').getByRole('button', { name: notePath, exact: true }).waitFor();
  const noteStarted = Date.now();
  await activate(frame.locator('#notes-tree').getByRole('button', { name: notePath, exact: true }), keyboard);
  await waitForFrameText(frame, '#notes-status', 'Authoritative Note opened.');
  await frame.locator('#note-editor').waitFor({ state: 'visible' });
  await audit(`${width}px Note editor`);
  actionDurations.push(Math.max(1, Date.now() - noteStarted));
  const editedText = `# ${name}\n\nEdited fictional journey evidence.`;
  await enterText(frame.locator('#note-content'), editedText, keyboard);
  const noteStatusBefore = await statusText('#notes-status');
  await timed(() => activate(frame.locator('#note-save'), keyboard));
  await waitForFrameText(frame, '#notes-status', 'Note saved.');
  await recordAnnouncement('#notes-status', noteStatusBefore, `${width}px Note save`);
  await activate(frame.locator('#note-preview-mode'), keyboard, 'Space');
  await frame.locator('#note-preview').waitFor({ state: 'visible' });
  await waitForFrameText(frame, '#note-preview', 'Edited fictional journey evidence.');
  await audit(`${width}px Note preview`);
  await activate(frame.locator('#note-edit-mode'), keyboard, 'Space');
  const noteRename = frame.locator('#note-rename');
  await activate(noteRename, keyboard);
  await audit(`${width}px Rename Note dialog`);
  await enterText(frame.locator('#note-action-path'), `renamed-${width}.md`, keyboard);
  await timed(() => activate(frame.locator('#note-action-submit'), keyboard));
  await noteDialog.waitFor({ state: 'hidden' });
  if (keyboard) await recordFocusRestoration(noteRename, `${width}px Rename Note dialog`);
  const renamedPath = `renamed-${width}.md`;
  await frame.locator('#notes-tree').getByRole('button', { name: renamedPath, exact: true }).waitFor();
  await activate(frame.locator('#notes-tree').getByRole('button', { name: renamedPath, exact: true }), keyboard);
  const noteMove = frame.locator('#note-move');
  await activate(noteMove, keyboard);
  await audit(`${width}px Move Note dialog`);
  const movedPath = `nested/journey-${width}.md`;
  await enterText(frame.locator('#note-action-path'), movedPath, keyboard);
  await timed(() => activate(frame.locator('#note-action-submit'), keyboard));
  await noteDialog.waitFor({ state: 'hidden' });
  if (keyboard) await recordFocusRestoration(noteMove, `${width}px Move Note dialog`);
  await frame.locator('#notes-tree').getByRole('button', { name: movedPath, exact: true }).waitFor();
  await assertNoFrameOverflow(frame, `${width}px Note lifecycle`);
  if (keyboard) {
    const beforeCancel = await frame.locator('#notes-tree').innerText();
    for (const cancellation of ['Cancel', 'Escape']) {
      await activate(noteNew, true);
      await noteDialog.waitFor({ state: 'visible' });
      await enterText(frame.locator('#note-action-path'), `cancelled-${width}.md`, true);
      await audit(`${width}px ${cancellation} Note dialog`);
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      else await activate(frame.locator('#note-action-cancel'), true);
      await noteDialog.waitFor({ state: 'hidden' });
      await recordFocusRestoration(noteNew, `${width}px ${cancellation} Note dialog`);
      const priorNoteControl = await frame.locator('#notes-tree button').first().elementHandle();
      await activate(frame.locator('#notes-refresh'), true);
      await frame.waitForFunction((node) => !node.isConnected, priorNoteControl);
      await priorNoteControl.dispose();
      assert.equal(await frame.locator('#notes-tree').innerText(), beforeCancel, 'cancelled Note dialog must not alter the authoritative catalog');
    }
  }

  await selectWorkspaceSection(frame, 'search', width, keyboard);
  await enterText(frame.locator('#workspace-search-query'), 'Edited fictional journey evidence', keyboard);
  const rebuildStarted = Date.now();
  await activate(frame.locator('#workspace-search-rebuild'), keyboard);
  await waitForFrameText(frame, '#workspace-search-status', 'rebuilt from authoritative sources');
  if (projectionRoot) {
    await waitForCommittedSearchProjections(projectionRoot);
    actionDurations.push(Math.max(1, Date.now() - rebuildStarted));
  }
  const searchStarted = Date.now();
  const workspaceSearchBefore = await statusText('#workspace-search-status');
  await submitFrameForm(frame, '#workspace-search-form', keyboard);
  await waitForFrameText(frame, '#workspace-search-status', '1 Notes');
  await recordAnnouncement('#workspace-search-status', workspaceSearchBefore, `${width}px workspace Search`);
  await audit(`${width}px search results`);
  measurement.indexedSearchMs = Math.max(1, Date.now() - searchStarted);
  actionDurations.push(measurement.indexedSearchMs);
  await activate(frame.locator('#workspace-notes-results').getByRole('button', { name: 'Open Note', exact: true }), keyboard);
  await frame.locator('#note-editor').waitFor({ state: 'visible' });

  await timed(() => activate(frame.locator('#workspace-back'), keyboard));
  await waitForDashboard(frame);
  await chooseOption(frame.locator('#topic-search-topic-id'), topicId, keyboard);
  await enterText(frame.locator('#topic-search-query'), 'Edited fictional journey evidence', keyboard);
  const topicSearchBefore = await statusText('#topic-search-status');
  await timed(() => submitFrameForm(frame, '#topic-search-form', keyboard));
  await waitForFrameText(frame, '#topic-search-status', '1 Notes');
  await recordAnnouncement('#topic-search-status', topicSearchBefore, `${width}px Topic Search`);
  await activate(frame.locator('#notes-results').getByRole('button', { name: 'Open Note', exact: true }), keyboard);
  await waitForFrameText(frame, '#topic-search-detail', 'Edited fictional journey evidence.');
  await assertNoFrameOverflow(frame, `${width}px Topic Search`);
  assert.equal(await frame.locator('#dashboard').isHidden(), false);
  return { topicId, conversationName, movedPath, primaryMessage, measurement, accessibilityStates, focusRestorations, announcementTransitions };
}

async function locatePaginatedNote(frame, pathName) {
  const note = frame.locator('#notes-tree').getByRole('button', { name: pathName, exact: true });
  try {
    await frame.waitForFunction((expectedPath) => /^[0-9]+ Notes\.$/u.test(document.querySelector('#notes-status')?.textContent ?? '') || [...document.querySelectorAll('#notes-tree button')].some((button) => button.textContent?.trim() === expectedPath), pathName, { timeout: 130_000 });
  } catch (error) {
    const state = await frame.evaluate(() => ({
      notesStatus: document.querySelector('#notes-status')?.textContent ?? null,
      pageStatus: document.querySelector('#note-page-status')?.textContent ?? null,
      renderedNotes: document.querySelectorAll('#notes-tree .note-tree-item').length
    }));
    throw new Error(`${error.message}; Notes hydration state=${JSON.stringify(state)}`);
  }
  if (await note.count()) return note;
  const next = frame.locator('#note-next');
  const last = frame.locator('#note-last');
  if (!await note.count() && await last.count() && !await last.isDisabled()) {
    const previousStatus = await frame.locator('#note-page-status').textContent();
    await last.click();
    await frame.waitForFunction((status) => document.querySelector('#note-page-status')?.textContent !== status, previousStatus);
    if (await note.count()) return note;
  }
  for (let page = 0; page < 100; page += 1) {
    if (await note.count()) return note;
    if (await next.isDisabled()) break;
    const previousStatus = await frame.locator('#note-page-status').textContent();
    await next.click();
    try { await frame.waitForFunction((status) => document.querySelector('#note-page-status')?.textContent !== status, previousStatus); }
    catch (error) {
      const state = await frame.evaluate(() => ({ notesStatus: document.querySelector('#notes-status')?.textContent ?? null, pageStatus: document.querySelector('#note-page-status')?.textContent ?? null, nextDisabled: document.querySelector('#note-next')?.disabled ?? null }));
      throw new Error(`${error.message}; Notes page transition state=${JSON.stringify(state)}`);
    }
  }
  throw new Error(`The paginated Notes catalog omitted ${pathName}.`);
}

async function exerciseLargeNoteFixture(frame, { gatewayUrl, credential, topicId = RELEASE_SCALE_TOPIC_ID }) {
  const lifecycleStarted = Date.now();
  const importedTopic = frame.locator('.topic-row').filter({ hasText: 'Fictional Scale Corpus' });
  await importedTopic.getByRole('button', { name: 'Open Topic', exact: true }).click();
  await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
  await selectWorkspaceSection(frame, 'notes', 1440);
  const measurements = {};
  for (const [pathName, edit] of [['large-note.md', true]]) {
    const note = await locatePaginatedNote(frame, pathName);
    const started = Date.now();
    await note.click();
    await frame.locator('#note-editor').waitFor({ state: 'visible' });
    const bytes = await frame.locator('#note-content').inputValue().then((value) => Buffer.byteLength(value));
    assert.equal(bytes, RELEASE_FIXTURE_COUNTS.largeNoteBytes);
    measurements[`${pathName}OpenMs`] = Math.max(1, Date.now() - started);
    if (edit) {
      const saveStarted = Date.now();
      const measuredEdit = 'Fictional measured edit.';
      await frame.locator('#note-content').press('Control+Home');
      for (let index = 0; index < measuredEdit.length; index += 1) await frame.locator('#note-content').press('Shift+ArrowRight');
      await frame.locator('#note-content').pressSequentially(measuredEdit);
      assert.equal(await frame.locator('#note-content').inputValue().then((value) => Buffer.byteLength(value)), RELEASE_FIXTURE_COUNTS.largeNoteBytes);
      await activate(frame.locator('#note-save'), true);
      await waitForFrameText(frame, '#notes-status', 'Note saved.');
      measurements.largeNoteSaveMs = Math.max(1, Date.now() - saveStarted);
    }
    const previewStarted = Date.now();
    await frame.locator('#note-preview-mode').press('Space');
    await frame.locator('#note-preview').waitFor({ state: 'visible' });
    measurements[`${pathName}PreviewMs`] = Math.max(1, Date.now() - previewStarted);
    await frame.locator('#note-edit-mode').press('Space');
    if (edit) {
      const moveStarted = Date.now();
      await activate(frame.locator('#note-move'), true);
      await enterText(frame.locator('#note-action-path'), 'measured/large-note.md', true);
      await activate(frame.locator('#note-action-submit'), true);
      await frame.locator('#note-action-dialog').waitFor({ state: 'hidden' });
      await locatePaginatedNote(frame, 'measured/large-note.md');
      measurements.largeNoteMoveMs = Math.max(1, Date.now() - moveStarted);
    }
    await assertNoFrameOverflow(frame, `large Note ${pathName}`);
  }
  await selectWorkspaceSection(frame, 'conversations', 1440);
  await chooseOption(frame.locator('#conversation-view'), 'all', true);
  const conversationPageCount = Math.ceil(RELEASE_FIXTURE_COUNTS.conversations / 50);
  await frame.locator('#conversation-page-status').getByText(`Page 1 of ${conversationPageCount}`, { exact: true }).waitFor();
  assert.equal(await frame.locator('#conversation-list .conversation-item').count(), 50);
  await assertNoFrameOverflow(frame, `1440px ${RELEASE_FIXTURE_COUNTS.conversations}-Conversation page one`);
  const firstPageReferences = await frame.locator('#conversation-list .conversation-item button:first-child').allTextContents();
  await activate(frame.locator('#conversation-next'), true);
  await frame.locator('#conversation-page-status').getByText(`Page 2 of ${conversationPageCount}`, { exact: true }).waitFor();
  assert.equal(await frame.locator('#conversation-list .conversation-item').count(), 50);
  const pageTwoConversation = frame.locator('#conversation-list .conversation-item button:first-child').first();
  const pageTwoRow = frame.locator('#conversation-list .conversation-item').first();
  const pageTwoName = await pageTwoConversation.textContent();
  assert.equal(firstPageReferences.includes(pageTwoName), false);
  const pageTwoIdentity = await pageTwoRow.evaluate((row) => ({ referenceId: row.dataset.referenceId, sessionId: row.dataset.sessionId }));
  await activate(pageTwoConversation, true);
  await waitForFrameText(frame, '#chat-conversation-name', pageTwoName);
  const catalogResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId } });
  const conversations = (catalogResponse?.result ?? catalogResponse)?.conversations ?? catalogResponse?.conversations ?? [];
  const authoritativePageTwo = conversations.find((item) => item.displayName === pageTwoName);
  assert.deepEqual(pageTwoIdentity, { referenceId: authoritativePageTwo?.referenceId, sessionId: authoritativePageTwo?.sessionId });
  const navigationResponse = await requestAuthenticatedGateway({ gatewayUrl, credential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId, referenceId: pageTwoIdentity.referenceId } });
  const navigation = navigationResponse?.result ?? navigationResponse;
  assert.deepEqual({ referenceId: navigation.sourceReference?.referenceId, sessionId: navigation.sessionId, sessionKeyPresent: Boolean(navigation.sessionKey) }, { referenceId: pageTwoIdentity.referenceId, sessionId: pageTwoIdentity.sessionId, sessionKeyPresent: true });
  await assertNoFrameOverflow(frame, `1440px ${RELEASE_FIXTURE_COUNTS.conversations}-Conversation page two`);
  await frame.page().setViewportSize({ width: 320, height: 900 });
  await selectWorkspaceSection(frame, 'conversations', 320, true);
  await assertNoFrameOverflow(frame, `320px ${RELEASE_FIXTURE_COUNTS.conversations}-Conversation page two`);
  await frame.page().setViewportSize({ width: 1440, height: 900 });
  await activate(frame.locator('#workspace-back'), true);
  await waitForDashboard(frame);
  measurements.largeNoteLifecycleMs = Math.max(1, Date.now() - lifecycleStarted);
  return Object.freeze(measurements);
}

async function assertResponsiveFrame(frame, page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px page has horizontal overflow`);
  await assertNoFrameOverflow(frame, `${width}px responsive frame`);
  const interactive = await frame.locator('button, input, select, textarea, a').evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0 && !node.closest('[hidden], [inert]');
  }).map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, name: node.getAttribute('aria-label') || node.labels?.[0]?.textContent?.trim() || node.textContent?.trim().slice(0, 80) || node.getAttribute('title') })));
  for (const node of interactive) {
    assert.ok(node.name, `${width}px interactive target has no observable name`);
    assert.ok(node.width >= 44 && node.height >= 44, `${width}px interactive target is below 44px: ${node.name}`);
  }
  assert.equal(await frame.locator('h1').count(), 1);
  assert.equal(await frame.locator('[role="dialog"]').count(), 2);
  return Object.freeze({ minimumTargetCssPx: Math.min(...interactive.map((node) => Math.min(node.width, node.height))), noPageOverflow: true });
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
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '400% reflow at a 320 CSS-pixel content width has page-level overflow');
  await assertResponsiveFrame(frame, page, 320);
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
}

test('mounts the built plugin through the isolated authenticated external tab', { timeout: 2_400_000, concurrency: true }, async (testContext) => {
  let descriptor, buildReceipt, baseline, baselineSeed;
  await testContext.test('release preparation: candidate build and authenticated descriptor', async () => {
    reportProgress(testContext, 'build:started');
    descriptor = parseHostDescriptor(); // Mandatory: never skip absent controller input.
    buildReceipt = await withDeadline('candidate build', () => process.env.COMMAND_CENTER_SEALED_CANDIDATE === '1' ? readBuiltReceipt() : build(), 120_000);
    await withDeadline('candidate build digest verification', () => assertBuiltDigest(buildReceipt));
    if (!capturePerformanceBaseline && acceptancePlan.kind === 'release') {
      baseline = validateReleasePerformanceBaseline(JSON.parse(await readFile(new URL('./fixtures/release-performance-baseline.v1.json', import.meta.url), 'utf8')));
      assert.equal(baseline.pluginBuildDigest, `sha256:${buildReceipt.digest}`);
    }
    reportProgress(testContext, 'build:passed');
  });
  const isolatedEvidence = new Map();
  const isolatedErrors = new Map();
  let isolatedActive = 0;
  const isolatedWaiters = [];
  let isolatedFatalError;
  const acquireIsolatedLane = async () => {
    if (isolatedFatalError) throw isolatedFatalError;
    if (isolatedActive >= 2) await new Promise((resolve, reject) => isolatedWaiters.push({ resolve, reject }));
    if (isolatedFatalError) throw isolatedFatalError;
    isolatedActive += 1;
    return () => {
      isolatedActive -= 1;
      if (!isolatedFatalError) isolatedWaiters.shift()?.resolve();
    };
  };
  const startIsolatedSlice = (id, run) => () => testContext.test(`release isolated slice: ${id}`, async () => {
    const releaseLane = await acquireIsolatedLane();
    reportProgress(testContext, `isolated:${id}:started`);
    try {
      const evidence = await runBoundedAcceptanceSlice(id, run, { timeoutMs: 240_000, cleanupTimeoutMs: 15_000 });
      isolatedEvidence.set(id, evidence);
      reportProgress(testContext, `isolated:${id}:passed`);
    } catch (error) {
      isolatedErrors.set(id, error);
      if (error?.fatalAcceptanceCleanup === true) {
        isolatedFatalError = error;
        for (const waiter of isolatedWaiters.splice(0)) waiter.reject(error);
      }
      throw error;
    } finally { releaseLane(); }
  });
  const isolatedSlices = new Map([
    ['fresh-desktop', startIsolatedSlice('fresh-desktop', (signal) => exerciseFreshScenarioFixture({ descriptor, buildReceipt, kind: 'desktop', width: 1440, signal }))],
    ['fresh-scale', startIsolatedSlice('fresh-scale', (signal) => exerciseFreshScenarioFixture({ descriptor, buildReceipt, kind: 'scale', width: 1440, signal }))],
    ['fresh-scale-analysis', startIsolatedSlice('fresh-scale-analysis', (signal) => exerciseFreshScenarioFixture({ descriptor, buildReceipt, kind: 'scale-analysis', width: 1440, signal }))],
    ['fresh-mobile', startIsolatedSlice('fresh-mobile', (signal) => exerciseFreshScenarioFixture({ descriptor, buildReceipt, kind: 'mobile', width: 320, signal }))],
    ['fresh-review', startIsolatedSlice('fresh-review', (signal) => exerciseFreshScenarioFixture({ descriptor, buildReceipt, kind: 'review', width: 320, signal }))],
    ['host-tuple-refusal', startIsolatedSlice('host-tuple-refusal', async (signal) => {
      return withIsolatedWorld(async (hostWorld) => {
        const restoredStateDir = path.join(hostWorld.root, '.openclaw');
        const restoredDatabase = await prepareRestoredRuntimeState(restoredStateDir, 'fictional-restored-host-tuple-topic');
        const raw = JSON.parse(process.env.COMMAND_CENTER_ISOLATED_HOST);
        const productCompatibilityCommit = ['30f2924e437857935f03', '4ac349bae8cc22ef9fb0'].join('');
        assert.throws(() => parseHostDescriptor(JSON.stringify({ ...raw, commit: productCompatibilityCommit })), (error) => error?.category === 'invalid-commit');
        const incompatibleDescriptor = { ...descriptor, integrity: { ...descriptor.integrity, sourceDigest: `sha256:${'0'.repeat(64)}` } };
        await assert.rejects(() => launchPinnedHost({ descriptor: incompatibleDescriptor, world: hostWorld, buildReceipt }), (error) => error?.category === 'host-integrity');
        const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(restoredStateDir);
        const manifestPath = path.join(recoveryDirectory, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.targetRelease.host = compatibilityTuple.priorRelease.host;
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
        const mismatchedBytes = await readFile(restoredDatabase);
        const mismatchedSnapshot = await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot'));
        const hostTupleRuntime = await withDeadline('host-tuple restoration launch', (launchSignal) => launchPinnedHost({ descriptor, world: hostWorld, buildReceipt, signal: launchSignal }), 120_000, signal);
        const removeAbortCleanup = stopHostOnAbort(signal, hostTupleRuntime);
        try {
          await waitForConsecutiveReadiness(async () => (await fetchWithDeadline(`${hostWorld.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${hostWorld.gatewayCredential}` } }, 'host-tuple restoration readiness', 10_000)).ok, hostTupleRuntime.earlyExit, { required: 2, attempts: 100, delayMs: 100 });
          const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: hostWorld.gateway.url, credential: hostWorld.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 } });
          assert.equal((statusResponse?.result ?? statusResponse).mode, 'recovery-only');
          const safeRead = await requestAuthenticatedGateway({ gatewayUrl: hostWorld.gateway.url, credential: hostWorld.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 } });
          assert.ok(safeRead && typeof safeRead === 'object');
          const mutation = await fetchWithDeadline(`${hostWorld.gateway.url}/plugins/command-center/api/topics/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(refusedTopicCreateRequest('Blocked host tuple Topic')) }, 'host-tuple restoration mutation', 10_000);
          assert.equal(mutation.status, 422);
          assert.deepEqual(await readFile(restoredDatabase), mismatchedBytes);
          assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), mismatchedSnapshot);
          const mountedUiObserved = await assertMountedReadOnlyOperatingMode({ world: hostWorld, expectedMode: 'recovery-only' });
          return Object.freeze({ kind: 'host', admissionRejected: true, mode: 'recovery-only', safeReadObserved: true, mutationRejected: true, restoredStateValidated: true, mountedUiObserved, unsupportedControlsAbsent: true });
        } finally {
          removeAbortCleanup();
          await withDeadline('host-tuple restoration stop', async () => { await stopPinnedHost(hostTupleRuntime.child); await hostTupleRuntime.outputDrained; });
          assertNoFatalHostOutput(hostTupleRuntime.diagnostics);
          await assertRecordedChildTraffic(hostWorld);
          hostTupleRuntime.diagnostics.guard.assertClean();
        }
      }, { candidateRoot: process.cwd() });
    })],
    ['build-variant', startIsolatedSlice('build-variant', (signal) => exerciseRejectedCandidateVariant({ descriptor, buildReceipt, kind: 'build', signal }))],
    ['plugin-api-variant', startIsolatedSlice('plugin-api-variant', (signal) => exerciseRejectedCandidateVariant({ descriptor, buildReceipt, kind: 'plugin-api', signal }))],
    ['bridge-protocol-variant', startIsolatedSlice('bridge-protocol-variant', (signal) => exerciseRejectedCandidateVariant({ descriptor, buildReceipt, kind: 'bridge-protocol', signal }))],
    ['binding-mismatch', startIsolatedSlice('binding-mismatch', (signal) => exerciseBindingMismatchHostVariant({ descriptor, buildReceipt, signal }))],
    ['foreign-database-restoration', startIsolatedSlice('foreign-database-restoration', (signal) => exerciseForeignDatabaseRestorationVariant({ descriptor, buildReceipt, signal }))],
    ['secure-origin', startIsolatedSlice('secure-origin', (signal) => exerciseSecureHostVariant({ descriptor, buildReceipt, signal }))],
    ['degraded-bridge-grants', startIsolatedSlice('degraded-bridge-grants', (signal) => exerciseDegradedBridgeHostVariant({ descriptor, buildReceipt, signal }))],
    ['degraded-source-availability', startIsolatedSlice('degraded-source-availability', (signal) => exerciseDegradedSourceRow({ descriptor, buildReceipt, signal }))],
    ['combined-degraded', startIsolatedSlice('combined-degraded', (signal) => exerciseDegradedSourceRow({ descriptor, buildReceipt, combined: true, signal }))],
    ['recovery-only-compatibility', startIsolatedSlice('recovery-only-compatibility', (signal) => exerciseRecoveryOnlyHostVariant({ descriptor, buildReceipt, signal }))],
    ['destructive-migration-restoration', startIsolatedSlice('destructive-migration-restoration', (signal) => withIsolatedWorld((rowWorld) => exerciseRestorationMatrix({ stateDir: path.join(rowWorld.root, '.openclaw'), descriptor, buildReceipt, world: rowWorld, signal }), { candidateRoot: process.cwd() }))]
  ]);
  const isolatedRunPromises = new Map();
  const isolatedResult = async (id) => {
    if (!isolatedRunPromises.has(id)) isolatedRunPromises.set(id, isolatedSlices.get(id)?.());
    await isolatedRunPromises.get(id);
    if (isolatedErrors.has(id)) throw isolatedErrors.get(id);
    if (!isolatedEvidence.has(id)) throw new HarnessFailure('release-row-missing', `Independent release slice produced no evidence for ${id}`);
    return isolatedEvidence.get(id);
  };
  if (acceptancePlan.isolatedSliceIds) {
    const failures = [];
    // Each external job owns one sequential subsystem lane; qualification remains exclusive.
    for (const id of acceptancePlan.isolatedSliceIds) {
      try { await isolatedResult(id); }
      catch (error) { failures.push(error); if (error?.fatalAcceptanceCleanup) break; }
    }
    await assertBuiltDigest(buildReceipt);
    await scanRepositorySafety(process.cwd(), { generated: [path.join(process.cwd(), 'dist')] });
    scanPublicEvidence([JSON.stringify([...isolatedEvidence])]);
    if (failures.length) throw new AggregateError(failures, 'Independent diagnostic slices failed');
    assert.equal(isolatedEvidence.size, acceptancePlan.isolatedSliceIds.length);
    testContext.diagnostic(`acceptance-scenario-result=${JSON.stringify({ schemaVersion: 1, outcome: 'passed', scenario: process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO, isolatedSliceIds: [...isolatedEvidence.keys()], buildDigest: buildReceipt.digest, performanceQualified: false })}`);
    return;
  }
  let emittedBaseline;
  await withIsolatedWorld(async (world) => {
    const resolvedStateDir = path.join(world.root, '.openclaw');
    let notificationReceiver;
    let notificationDevice;
    let realizedScaleSeed;
    let migrationFixtureEvidence;
    await testContext.test('release preparation: deterministic source fixtures', async () => withDeadline('deterministic release fixture preparation', async () => {
      reportProgress(testContext, 'fixture:started');
      const migrationExportPath = path.join(world.tempRoot, 'legacy-discord-export.v1.json');
      const migrationFolderPath = path.join(world.paths.vault, 'fictional-alpha');
      if (acceptancePlan.kind === 'focused' && !acceptancePlan.scenarioIds.includes('focused-full-corpus-fixture')) {
        const focusedScale = acceptancePlan.scenarioIds.includes('focused-scale-session-seeding');
        const focusedFullCorpus = acceptancePlan.scenarioIds.includes('focused-invalidated-projection-recovery') || acceptancePlan.scenarioIds.includes('focused-full-corpus-fixture');
        const focusedHeavyCorpus = acceptancePlan.scenarioIds.includes('focused-heavy-corpus-mutation-journey') || acceptancePlan.scenarioIds.includes('focused-heavy-corpus-fixture') || focusedFullCorpus;
        const focusedUiState = acceptancePlan.scenarioIds.includes('focused-ui-state-regression');
        const focusedScaleFolderPath = path.join(world.paths.vault, 'fictional-scale');
        await Promise.all([mkdir(migrationFolderPath, { recursive: true }), ...(focusedScale || focusedHeavyCorpus || focusedUiState ? [mkdir(focusedScaleFolderPath, { recursive: true })] : [])]);
        const migrationExport = JSON.parse(await readFile(new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
        if (focusedScale || focusedHeavyCorpus || focusedUiState) migrationExport.channels.push({
          channelId: 'fictional-channel-scale',
          displayName: 'Fictional Scale Corpus',
          messages: focusedFullCorpus
            ? Array.from({ length: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }, (_, index) => ({ messageId: `fictional-focused-scale-${index}`, displayOrder: index, author: { id: 'fictional-scale-user', displayName: 'Fictional Scale User' }, timestamp: new Date(Date.UTC(2026, 7, 21) + index).toISOString(), text: `Fictional indexed conversation phrase ${index}.${index === 4242 ? ' Fictional exact Conversation sentinel.' : ''}`, edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: [] }))
            : [{ messageId: 'fictional-focused-scale-message', displayOrder: 0, author: { id: 'fictional-scale-user', displayName: 'Fictional Scale User' }, timestamp: '2026-08-21T00:00:00.000Z', text: 'Fictional focused scale source message.', edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: [] }]
        });
        if (focusedHeavyCorpus) realizedScaleSeed = await seedReleaseNoteCorpus(focusedScaleFolderPath, ({ completed, total }) => reportProgress(testContext, 'fixture:note-batch', { completed, total }));
        migrationFixtureEvidence = retainPreparedMigrationFixtureEvidence(migrationExport);
        await writeFile(migrationExportPath, `${JSON.stringify(migrationExport)}\n`);
        const configured = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
        configured.plugins.entries[world.manifest.candidate.id].config = {
          ...configured.plugins.entries[world.manifest.candidate.id].config,
          legacyDiscordMigration: {
            schemaVersion: 1,
            exportPath: migrationExportPath,
            channels: [
              { channelId: 'fictional-channel-alpha', topicId: RELEASE_ALPHA_TOPIC_ID, paraCategory: 'project', noteFolderPath: migrationFolderPath },
              ...(focusedScale || focusedHeavyCorpus || focusedUiState ? [{ channelId: 'fictional-channel-scale', topicId: RELEASE_SCALE_TOPIC_ID, paraCategory: 'resource', noteFolderPath: focusedScaleFolderPath }] : [])
            ]
          }
        };
        await writeFile(world.manifest.configPath, `${JSON.stringify(configured)}\n`);
        reportProgress(testContext, 'fixture:passed');
        return;
      }
      const scaleMigrationFolderPath = path.join(world.paths.vault, 'fictional-scale');
    await Promise.all([mkdir(migrationFolderPath, { recursive: true }), mkdir(scaleMigrationFolderPath, { recursive: true })]);
    const migrationExport = JSON.parse(await readFile(new URL('./fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
    migrationExport.channels.push({
      channelId: 'fictional-channel-scale',
      displayName: 'Fictional Scale Corpus',
      messages: Array.from({ length: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }, (_, index) => ({
        messageId: `fictional-scale-message-${String(index).padStart(4, '0')}`,
        displayOrder: index,
        author: { id: 'fictional-user-scale', displayName: 'Fictional Scale User' },
        timestamp: new Date(Date.UTC(2026, 7, 21) + index).toISOString(),
        text: `Fictional indexed conversation phrase ${index}.${index === 4242 ? ' Fictional exact Conversation sentinel.' : ''}`,
        edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: []
      }))
    });
    migrationFixtureEvidence = retainPreparedMigrationFixtureEvidence(migrationExport);
    realizedScaleSeed = await seedReleaseNoteCorpus(scaleMigrationFolderPath, ({ completed, total }) => reportProgress(testContext, 'fixture:note-batch', { completed, total }));
    await writeFile(migrationExportPath, `${JSON.stringify(migrationExport)}\n`);
    const configured = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    configured.plugins.entries[world.manifest.candidate.id].config = {
      ...configured.plugins.entries[world.manifest.candidate.id].config,
      legacyDiscordMigration: {
        schemaVersion: 1,
        exportPath: migrationExportPath,
        channels: [
          { channelId: 'fictional-channel-alpha', topicId: RELEASE_ALPHA_TOPIC_ID, paraCategory: 'project', noteFolderPath: migrationFolderPath },
          { channelId: 'fictional-channel-scale', topicId: RELEASE_SCALE_TOPIC_ID, paraCategory: 'resource', noteFolderPath: scaleMigrationFolderPath }
        ]
      }
    };
    await writeFile(world.manifest.configPath, `${JSON.stringify(configured)}\n`);
    const activityFixture = openCommandCenterMetadataService({ stateDir: resolvedStateDir, capabilities: READY_CAPABILITIES });
    try {
      activityFixture.createTopic({ topicId: RELEASE_ACTIVITY_TOPIC_ID, paraCategory: 'resource', lifecycle: 'active' });
    } finally { activityFixture.close(); }
      reportProgress(testContext, 'fixture:passed');
    }, 240_000));
    let host;
    const startupMilestoneStartedAt = Date.now();
    await testContext.test('release preparation: pinned host launch', async () => {
      reportProgress(testContext, 'host-launch:started');
      notificationReceiver = await createLoopbackNotificationReceiver(world.tempRoot);
      try {
        host = await withDeadline('pinned host launch', (signal) => launchPinnedHost({ descriptor, world, buildReceipt, signal, notificationCaPath: notificationReceiver.certificatePath }), 120_000);
      } catch (error) {
        await notificationReceiver.close();
        throw error;
      }
      reportProgress(testContext, 'host-launch:passed');
    });
    const gatewayUrl = world.gateway.url;
    const databasePath = resolveCommandCenterDatabasePath(resolvedStateDir);
    assert.deepEqual(host.endpoint, world.gateway);
    assert.notEqual(world.gateway.port, 18789);
    assert.ok(host.child.pid, 'spawned host must own the isolated endpoint before probing it');
    const browserGuard = new TrafficGuard();
    const evidence = { console: [], errors: [], requests: [], responses: [], bootstrapStatus: undefined, parentBootstrapBodyKeys: [], routeGrant: false, parentBootstrap: false, cookieProbe: false, cookieProbeStatus: undefined, frame: false, readinessAttempts: [] };
    const releaseState = { startup: false, desktop: undefined, mobile: undefined, restored: false, forgedMutationRejected: false, projectionRoot: undefined, baseline: undefined, activityPaged: false, reviewApplied: false, missingProjectionRebuilt: false, staleProjectionRebuilt: false, realizedScaleSeed };
    let managedBrowser, browser, page, iframe, frame, qualifiedBaseline, desktopJourney, scaleJourney, mobileJourney, reviewJourney, pluginDocument;
    let failure;
    const scenarioCoordinator = createAcceptanceScenarioCoordinator({
      execute: async (id, run) => {
        let result;
        await testContext.test(`release scenario: ${id}`, async () => {
          result = await runBoundedAcceptanceSlice(id, (signal) => runAbortableAcceptanceBoundary(
            () => acceptanceSignalContext.run(signal, () => run(signal)),
            { signal, onAbort: () => { if (page && !page.isClosed()) void page.close(); } }
          ), { timeoutMs: 240_000, cleanupTimeoutMs: 15_000 });
        });
        return result;
      },
      onProgress: ({ id, status }) => reportProgress(testContext, `scenario:${id}:${status}`),
      normalizeFailure: (id, error) => {
        const message = redactBrowserEvidence(error?.message || `Scenario ${id} failed without bounded diagnostics`);
        reportProgress(testContext, `scenario:${id}:failure`, { error: message });
        process.stderr.write(`release-scenario-failure=${JSON.stringify({ schemaVersion: 1, id, error: message })}\n`);
        return new HarnessFailure('release-row-failed', message);
      }
    });
    const { failures: scenarioFailures, evidence: scenarioEvidence, collect: collectPlannedScenario } = scenarioCoordinator;
    const focusedScenarioIds = acceptancePlan.kind === 'focused' ? new Set(acceptancePlan.scenarioIds) : null;
    const collectScenario = (id, run) => focusedScenarioIds && !focusedScenarioIds.has(id) ? Promise.resolve() : collectPlannedScenario(id, run);
    const ensureNotificationTarget = async (signal) => {
      if (notificationDevice) return notificationDevice;
      const deviceIdentity = createGatewayDeviceIdentity();
      const receiverKey = createECDH('prime256v1');
      receiverKey.generateKeys();
      await requestAuthenticatedGateway({
        gatewayUrl,
        credential: world.gatewayCredential,
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
        method: 'push.web.subscribe',
        params: { endpoint: notificationReceiver.endpoint, keys: { p256dh: receiverKey.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } },
        signal,
        deviceIdentity
      });
      notificationDevice = deviceIdentity;
      return notificationDevice;
    };
    const scenarioResult = (id) => {
      try { return scenarioCoordinator.result(id); }
      catch { throw new HarnessFailure('release-row-missing', `Release scenario produced no evidence for ${id}`); }
    };
    const ensureMigrationBinding = async (signal) => {
      // The release fixture imports 5,000 conversation messages before plugin
      // registration and search projections become authoritative. Keep this
      // poll within the scenario's 240-second boundary instead of treating the
      // old 10-second unit-sized default as a durable startup failure.
      const completed = await waitForMigrationCompletion(databasePath, RELEASE_ALPHA_TOPIC_ID, { attempts: 2_300, delayMs: 100, signal });
      releaseState.migrationBinding = Object.freeze({ ...completed.binding });
      return completed;
    };
    const requireMigrationFixtureEvidence = () => {
      assert.ok(migrationFixtureEvidence, 'prepared migration fixture evidence must remain available after fixture preparation');
      return migrationFixtureEvidence;
    };
    const readVerifiedImportedHistory = async (signal) => {
      return readVerifiedImportedHistoryEvidence({
        ensureMigrationBinding,
        requireMigrationFixtureEvidence,
        signal,
        readHistory: async (binding, readSignal) => {
          host.diagnostics.guard.assert('127.0.0.1', 'authenticated chat.history verification');
          return readAuthenticatedHistory({ gatewayUrl, credential: world.gatewayCredential, sessionKey: binding.sessionKey, signal: readSignal });
        }
      });
    };
    const createScaleConversationThroughAuthenticatedRoute = async (signal) => {
      const topicResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      const scaleTopic = (topicResponse?.result ?? topicResponse)?.topic;
      assert.equal(scaleTopic?.revision, 1);
      const logicalOperationId = releaseScaleConversationOperationId(1);
      const accepted = await createSessionThroughAuthenticatedFrame(frame, { topicId: RELEASE_SCALE_TOPIC_ID, logicalOperationId, label: 'Fictional scale Conversation 1', signal });
      assert.equal(accepted?.logicalOperationId, logicalOperationId);
      assert.equal(accepted?.result?.topicId, RELEASE_SCALE_TOPIC_ID);
      assert.equal(typeof accepted?.result?.referenceId, 'string');
      return { logicalOperationId, referenceId: accepted.result.referenceId, authoritativeSession: accepted.authoritativeSession };
    };
    let readinessAttempt = 0;
    const recordReadinessObservation = (observation) => {
      evidence.readinessAttempts.push(Object.freeze({ ...observation }));
      if (evidence.readinessAttempts.length > 20) evidence.readinessAttempts.shift();
    };
    const ensureScaleConversationFixture = async (signal) => {
      signal?.throwIfAborted();
      const topicResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      const scaleTopic = (topicResponse?.result ?? topicResponse)?.topic;
      assert.equal(scaleTopic?.lifecycle, 'active');
      assert.equal(scaleTopic?.revision, 1);
      assert.equal(typeof scaleTopic?.activatedAt, 'string');
      const listed = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      const initialCount = ((listed?.result ?? listed)?.conversations ?? listed?.conversations ?? []).length;
      assert.ok(initialCount >= 1 && initialCount <= RELEASE_FIXTURE_COUNTS.conversations, 'migrated scale Topic must retain a bounded authoritative Conversation catalog');
      releaseState.realizedConversationCount = initialCount;
      if (initialCount === RELEASE_FIXTURE_COUNTS.conversations) return { created: 0, authoritativeTotal: initialCount };
      await seedAuthoritativeSessionCatalog({ gatewayUrl, credential: world.gatewayCredential, stateDir: resolvedStateDir, topicId: RELEASE_SCALE_TOPIC_ID, initialCount, labelPrefix: 'Fictional scale Conversation', signal, onBatch: ({ completed, total }) => reportProgress(testContext, 'fixture:session-batch', { completed, total }) });
      const seeded = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      releaseState.realizedConversationCount = ((seeded?.result ?? seeded)?.conversations ?? seeded?.conversations ?? []).length;
      assert.equal(releaseState.realizedConversationCount, RELEASE_FIXTURE_COUNTS.conversations);
      return { reconciledOperations: RELEASE_FIXTURE_COUNTS.conversations - 1, authoritativeTotal: releaseState.realizedConversationCount };
    };
    await collectScenario('pinned-host-startup', async (signal) => {
      try {
        await waitForConsecutiveReadiness(async () => {
          const observation = { attempt: ++readinessAttempt, url: `${gatewayUrl}${runtimeCapability.bootstrap.path}`, status: null, error: null, bodyKeys: [] };
          try {
            host.diagnostics.guard.assert('127.0.0.1', 'harness bootstrap');
            const { response, body, parseError } = await fetchJsonWithDeadline(observation.url, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'Control UI readiness probe', timeoutMs: 3_000 });
            observation.status = response.status;
            observation.bodyKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : [];
            if (!response.ok) observation.error = `bootstrap-http-${response.status}`;
            else if (parseError || !body || typeof body !== 'object' || Array.isArray(body)) observation.error = 'bootstrap-invalid-response';
            else if (!isCommandCenterMetadataReady(databasePath)) observation.error = 'metadata-not-ready';
            recordReadinessObservation(observation);
            return observation.error === null;
          } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            observation.error = redactBrowserEvidence(error?.message ?? error);
            recordReadinessObservation(observation);
            return false;
          }
        }, host.earlyExit, { deadlineMs: 220_000, delayMs: 250, signal });
      } catch (error) {
        const observations = redact(JSON.stringify(evidence.readinessAttempts.slice(-5)), 1_500);
        throw new HarnessFailure(error.category || 'readiness-timeout', `${error.message}; last readiness observations: ${observations}; host stdout: ${host.diagnostics.stdout}; host stderr: ${host.diagnostics.stderr}`);
      }
      // The service receives the pinned host's resolved stateDir. Verify the
      // startup-created store is beneath this disposable fixture and that no
      // sibling Command Center storage was created.
      await access(databasePath);
      const { binding } = await ensureMigrationBinding(signal);
      releaseState.startupReadinessMs = Math.max(1, Date.now() - startupMilestoneStartedAt);
      return { schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, migrationVerified: true, sourceReferenceId: binding.referenceId };
    });
    await collectScenario('startup-migration-channel-count', async (signal) => {
      const { completion, binding } = await ensureMigrationBinding(signal);
      const prepared = requireMigrationFixtureEvidence();
      assert.equal(completion.verified_channel_count, prepared.channelCount);
      return { channelCount: prepared.channelCount, sourceReferenceId: binding.referenceId };
    });
    await collectScenario('startup-migration-occurrence-count', async (signal) => {
      const { completion, binding } = await ensureMigrationBinding(signal);
      const prepared = requireMigrationFixtureEvidence();
      assert.equal(completion.verified_occurrence_count, prepared.occurrenceCount);
      return { occurrenceCount: prepared.occurrenceCount, sourceReferenceId: binding.referenceId };
    });
    await collectScenario('startup-authenticated-history', async (signal) => {
      const { binding, channel, history, imported } = await readVerifiedImportedHistory(signal);
      assert.equal(history.sessionId ?? history.session?.sessionId ?? binding.sessionId, binding.sessionId);
      assert.equal(imported.length, channel.messages.length);
      return { sessionId: binding.sessionId, importedCount: imported.length };
    });
    await collectScenario('startup-imported-history-text', async (signal) => {
      const { binding, channel, imported } = await readVerifiedImportedHistory(signal);
      assert.equal(imported.length, channel.messages.length);
      for (const [index, occurrence] of channel.messages.entries()) assert.equal(imported[index].text, occurrence.text);
      return { sourceReferenceId: binding.referenceId, verifiedTextCount: imported.length };
    });
    await collectScenario('startup-imported-history-provenance', async (signal) => {
      const { binding, channel, imported } = await readVerifiedImportedHistory(signal);
      assert.equal(imported.length, channel.messages.length);
      for (const [index, occurrence] of channel.messages.entries()) assert.deepEqual(imported[index].__openclaw.legacyDiscordV1, importedProvenance(channel.channelId, occurrence));
      return { sourceReferenceId: binding.referenceId, verifiedProvenanceCount: imported.length };
    });
    await collectScenario('startup-projection-recovery', async (signal) => {
      const pluginStateRoot = path.dirname(databasePath);
      assert.deepEqual((await readdir(pluginStateRoot)).sort(), ['metadata.sqlite', 'projections']);
      const projectionRoot = path.join(pluginStateRoot, 'projections');
      releaseState.projectionRoot = projectionRoot;
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
      host.diagnostics.guard.assert('127.0.0.1', 'startup projection completion verification');
      await restoreReleaseSearchBaseline({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal, label: 'startup' });
      await waitForCommittedSearchProjections(projectionRoot, {
        attempts: 1200,
        signal,
        requiredTopicIds: [RELEASE_ALPHA_TOPIC_ID, RELEASE_SCALE_TOPIC_ID],
        expectedTopicRowCounts: {
          notes: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedNotes },
          conversations: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }
        }
      });
      const verified = await verifyReleaseSearchResults({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal });
      releaseState.realizedSearchCounts = {
        notes: verified.topicRowCounts.notes[RELEASE_SCALE_TOPIC_ID],
        conversationMessages: verified.topicRowCounts.conversations[RELEASE_SCALE_TOPIC_ID]
      };
      return { projectionRoot, indexedNotes: releaseState.realizedSearchCounts.notes, indexedConversationMessages: releaseState.realizedSearchCounts.conversationMessages, integrityChecked: true };
    });
    await collectScenario('invalidated-projection-recovery', async (signal) => {
      const projectionRoot = path.join(path.dirname(databasePath), 'projections');
      await restoreReleaseSearchBaseline({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal, label: 'invalidated recovery' });
      await Promise.all(COMMITTED_SEARCH_PROJECTION_FILES.map(async (name) => {
        try { await unlink(path.join(projectionRoot, name)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }));
      const markerPath = path.join(projectionRoot, '.topic-search.invalidated.json');
      await writeFile(markerPath, `${JSON.stringify({ schemaVersion: 1, state: 'invalidated' })}\n`);
      const before = captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath });
      await assert.rejects(
        requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, query: 'Fictional scale search phrase', limit: 50 }, signal }),
        /capability-unavailable|projection/iu
      );
      assert.deepEqual(captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath }), before, 'invalidated read must remain side-effect free');
      await rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential: world.gatewayCredential, topicId: RELEASE_ALPHA_TOPIC_ID, signal, label: 'invalidated Alpha Search projection rebuild' });
      const verified = await verifyReleaseSearchResults({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal });
      assert.equal((await readdir(projectionRoot)).includes('.topic-search.invalidated.json'), false);
      return { recovered: true, rowCounts: verified.rowCounts };
    });
    await collectScenario('missing-projection-recovery', async (signal) => {
      const projectionRoot = path.join(path.dirname(databasePath), 'projections');
      await restoreReleaseSearchBaseline({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal, label: 'missing recovery' });
      await Promise.all(COMMITTED_SEARCH_PROJECTION_FILES.map((name) => unlink(path.join(projectionRoot, name))));
      const before = captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath });
      await assert.rejects(
        requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, query: 'Fictional scale search phrase', limit: 50 }, signal }),
        /capability-unavailable|projection/iu
      );
      assert.deepEqual(captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath }), before, 'missing projection read must remain side-effect free');
      await rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential: world.gatewayCredential, topicId: RELEASE_ALPHA_TOPIC_ID, signal, label: 'missing Alpha Search projection rebuild' });
      const verified = await verifyReleaseSearchResults({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal });
      releaseState.missingProjectionRebuilt = true;
      return { recovered: true, rowCounts: verified.rowCounts };
    });
    await collectScenario('startup-authenticated-topic-analysis', async (signal) => {
      const { binding } = await ensureMigrationBinding(signal);
      const logicalOperationId = randomUUID();
      const params = { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, input: {}, logicalOperationId };
      const response = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params, signal });
      const mutation = response?.result ?? response;
      const value = mutation?.value ?? mutation?.result?.value;
      assert.equal(value?.status, 'applied');
      assert.equal(typeof value?.analysisId, 'string');
      assert.equal(value.observedRevision, value.analysisId);
      const activity = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.activity.get', params: { schemaVersion: 1, activityId: `activity:topic-analysis:${value.analysisId}` }, signal });
      const record = (activity?.result ?? activity)?.record;
      assert.equal(record?.operationKind, 'topic-analysis.run');
      assert.equal(record?.outcome, 'applied');
      assert.equal(record?.topicId, RELEASE_ALPHA_TOPIC_ID);
      const topicResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID }, signal });
      const topic = (topicResponse?.result ?? topicResponse)?.topic;
      const activitySource = topic.sourceReferences.find((reference) => reference.referenceId === record?.sourceReferenceId);
      assert.ok(activitySource);
      assert.equal(record.verificationRevision, activitySource.observedRevision);
      const replay = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params, signal });
      const replayMutation = replay?.result ?? replay;
      assert.deepEqual(replayMutation?.value ?? replayMutation?.result?.value, value);
      return { analysisId: value.analysisId, activityId: record.activityId, replayed: true };
    });
    await collectScenario('malformed-topic-route-rejection', async () => {
      host.diagnostics.guard.assert('127.0.0.1', 'bounded attention action route verification');
      const actionResponse = await fetchWithDeadline(`${gatewayUrl}/plugins/command-center/api/attention/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1 })
      }, 'bounded attention action route verification');
      assert.equal(actionResponse.status, 400);
      assert.deepEqual(await actionResponse.json(), { schemaVersion: 1, status: 'unavailable' });
      releaseState.forgedMutationRejected = true;
      return { rejected: true };
    });
    if (acceptancePlan.kind === 'focused') {
      await collectScenario('focused-control-ui-migration-readiness', async (signal) => {
        const completed = await ensureMigrationBinding(signal);
        return { completionId: completed.completion.completion_id, referenceId: completed.binding.referenceId };
      });
      scenarioResult('focused-control-ui-migration-readiness');
      await collectScenario('focused-control-ui-search-projection', async (signal) => {
        const projectionRoot = path.join(path.dirname(databasePath), 'projections');
        const rebuildStartedAt = Date.now();
        await rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential: world.gatewayCredential, topicId: RELEASE_ALPHA_TOPIC_ID, signal, label: 'focused Control UI Search baseline rebuild' });
        const rebuildMs = Date.now() - rebuildStartedAt;
        const fullCorpus = focusedScenarioIds.has('focused-invalidated-projection-recovery') || focusedScenarioIds.has('focused-full-corpus-fixture');
        const heavyCorpus = focusedScenarioIds.has('focused-heavy-corpus-mutation-journey') || focusedScenarioIds.has('focused-heavy-corpus-fixture') || fullCorpus;
        const verified = await waitForCommittedSearchProjections(projectionRoot, {
          attempts: 1200,
          signal,
          requiredTopicIds: heavyCorpus ? [RELEASE_ALPHA_TOPIC_ID, RELEASE_SCALE_TOPIC_ID] : [RELEASE_ALPHA_TOPIC_ID],
          ...(heavyCorpus ? {
            expectedTopicRowCounts: {
              notes: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedNotes },
              conversations: { [RELEASE_SCALE_TOPIC_ID]: fullCorpus ? RELEASE_FIXTURE_COUNTS.indexedConversationMessages : 1 }
            }
          } : {})
        });
        releaseState.projectionRoot = projectionRoot;
        releaseState.focusedSearchRebuildMs = rebuildMs;
        return { rowCounts: verified.rowCounts, rebuildMs };
      });
      scenarioResult('focused-control-ui-search-projection');
      if (focusedScenarioIds.has('focused-heavy-corpus-fixture')) await collectScenario('focused-heavy-corpus-fixture', async () => ({ indexedNotes: releaseState.realizedScaleSeed?.indexedNotes, rebuildMs: releaseState.focusedSearchRebuildMs }));
      if (focusedScenarioIds.has('focused-full-corpus-fixture')) await collectScenario('focused-full-corpus-fixture', async () => ({ indexedNotes: releaseState.realizedScaleSeed?.indexedNotes, indexedConversationMessages: RELEASE_FIXTURE_COUNTS.indexedConversationMessages, rebuildMs: releaseState.focusedSearchRebuildMs }));
    }
    await collectScenario('authenticated-control-ui-mount', async (signal) => {
      const projectionRoot = path.join(path.dirname(databasePath), 'projections');
      if (acceptancePlan.kind === 'focused') {
        try {
          await waitForConsecutiveReadiness(async () => {
            const observation = { attempt: ++readinessAttempt, url: `${gatewayUrl}${runtimeCapability.bootstrap.path}`, status: null, error: null, bodyKeys: [] };
            try {
              host.diagnostics.guard.assert('127.0.0.1', 'focused Control UI readiness probe');
              const { response, body, parseError } = await fetchJsonWithDeadline(observation.url, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'focused Control UI readiness probe', timeoutMs: 3_000 });
              observation.status = response.status;
              observation.bodyKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : [];
              if (!response.ok) observation.error = `bootstrap-http-${response.status}`;
              else if (parseError || !body || typeof body !== 'object' || Array.isArray(body)) observation.error = 'bootstrap-invalid-response';
              else if (!isCommandCenterMetadataReady(databasePath)) observation.error = 'metadata-not-ready';
              else if (!routeGrant(body)) observation.error = 'route-grant-not-ready';
              recordReadinessObservation(observation);
              return observation.error === null;
            } catch (error) {
              if (signal.aborted) throw signal.reason ?? error;
              observation.error = redactBrowserEvidence(error?.message ?? error);
              recordReadinessObservation(observation);
              return false;
            }
          }, host.earlyExit, { deadlineMs: 220_000, delayMs: 250, signal });
        } catch (error) {
          const observations = redact(JSON.stringify(evidence.readinessAttempts.slice(-5)), 1_500);
          throw new HarnessFailure(error.category || 'readiness-timeout', `${error.message}; last readiness observations: ${observations}; host stdout: ${host.diagnostics.stdout}; host stderr: ${host.diagnostics.stderr}`);
        }
      } else {
        await verifyReleaseSearchResults({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal });
        releaseState.projectionRoot = projectionRoot;
      }
      managedBrowser = await withDeadline('primary browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }));
      browser = managedBrowser.browser;
      if (capturePerformanceBaseline) {
        baselineSeed = {
          schemaVersion: 1,
          hostVersion: releasePerformanceIdentity.hostVersion,
          hostReceipt: releasePerformanceIdentity.hostReceipt,
          pluginBuildDigest: `sha256:${buildReceipt.digest}`,
          browser: { engine: 'chromium', playwrightVersion: releasePerformanceIdentity.playwrightVersion, version: browser.version() },
          viewport: releasePerformanceIdentity.viewport,
          fixtureIdentity: RELEASE_FIXTURE_IDENTITY,
          fixtureCounts: RELEASE_FIXTURE_COUNTS,
          capture: { policy: 'first-successful-pinned-harness-observation', successfulRunOrdinal: null }
        };
      } else if (acceptancePlan.kind === 'release') assert.equal(browser.version(), baseline.browser.version, 'Running Chromium version must match the measured baseline identity');
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
      await page.goto(controlUiPluginUrl({
        gatewayUrl,
        pluginId: 'command-center',
        routeId: 'command-center',
        fragmentParameter: runtimeCapability.authentication.urlFragmentParameter,
        credential: world.gatewayCredential
      }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const observedBootstrap = await parentBootstrap;
      evidence.parentBootstrap = observedBootstrap.observed;
      if (!evidence.parentBootstrap) throw new HarnessFailure('bootstrap-authentication-failure', 'Parent token-fragment authentication did not fetch the Control UI bootstrap response');
      evidence.bootstrapStatus = observedBootstrap.value.status();
      if (!observedBootstrap.value.ok()) throw new HarnessFailure('bootstrap-authentication-failure', 'Parent token-fragment authentication could not read the Control UI bootstrap response');
      const parentConfig = await observedBootstrap.value.json();
      releaseState.parentBootstrapConfig = structuredClone(parentConfig);
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
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      evidence.frame = true;
      const sandbox = await iframe.getAttribute('sandbox');
      if (sandbox !== 'allow-scripts') throw new HarnessFailure('sandbox-mismatch', 'External tab iframe is not scripts-only');
      await waitForDashboard(frame);
      await chooseOption(frame.locator('#topic-search-topic-id'), RELEASE_ALPHA_TOPIC_ID, true);
      assert.equal(await frame.locator('#topic-search-topic-id').inputValue(), RELEASE_ALPHA_TOPIC_ID, 'capability bridge-backed Topic read did not populate the authenticated shell');
      await enterText(frame.locator('#topic-search-query'), 'Fictional', true);
      await submitFrameForm(frame, '#topic-search-form', true);
      try {
        await frame.waitForFunction(() => /Notes.*Conversations|^Topic Search failed/u.test(document.querySelector('#topic-search-status')?.textContent ?? ''), undefined, { timeout: 60_000 });
        const status = await frame.locator('#topic-search-status').textContent();
        assert.match(status ?? '', /Notes.*Conversations/u, status ?? 'Topic Search produced no status');
      } catch (error) {
        const browserState = await frame.evaluate(() => ({
          status: document.querySelector('#topic-search-status')?.textContent ?? '',
          topicId: document.querySelector('#topic-search-topic-id')?.value ?? '',
          query: document.querySelector('#topic-search-query')?.value ?? '',
          active: document.activeElement?.id || document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.tagName || 'unknown'
        }));
        const diagnostic = { schemaVersion: 1, browserState, errors: evidence.errors.slice(-5), console: evidence.console.slice(-5) };
        process.stderr.write(`control-ui-search-diagnostic=${JSON.stringify(diagnostic)}\n`);
        throw new HarnessFailure('control-ui-search-timeout', `Authenticated Control UI search did not settle; page errors: ${redactBrowserEvidence(JSON.stringify(diagnostic.errors))}; state: ${redactBrowserEvidence(JSON.stringify(browserState))}; ${error.message}`);
      }
      releaseState.startup = true;
      return { schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, frame: evidence.frame, routeGrant: evidence.routeGrant, bridgeRead: true };
    });
    if (focusedScenarioIds?.has('focused-reminder-create')) await collectScenario('focused-reminder-create', async (signal) => {
      try {
        const response = await requestAuthenticatedGateway({
          gatewayUrl,
          credential: world.gatewayCredential,
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          method: 'command-center.v1.reminders.create',
          params: {
            schemaVersion: 1,
            topicId: RELEASE_ALPHA_TOPIC_ID,
            logicalOperationId: randomUUID(),
            declaration: {
              name: 'Fictional focused reminder',
              enabled: true,
              deleteAfterRun: false,
              schedule: { kind: 'at', at: new Date(Date.now() + 3_600_000).toISOString() },
              payload: { kind: 'systemEvent', text: 'Fictional focused reminder' },
              sessionTarget: 'main',
              wakeMode: 'next-heartbeat'
            }
          },
          signal
        });
        return { created: Boolean((response?.result ?? response)?.value?.job?.id) };
      } catch (error) {
        throw new Error(`${error.message}; host stdout: ${host.diagnostics.stdout}; host stderr: ${host.diagnostics.stderr}`);
      }
    });
    if (focusedScenarioIds?.has('focused-closed-tab-notification')) await collectScenario('focused-closed-tab-notification', async (signal) => {
      const deviceIdentity = await ensureNotificationTarget(signal);
      await requestAuthenticatedGateway({
        gatewayUrl,
        credential: world.gatewayCredential,
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
        method: 'command-center.v1.reminders.create',
        params: {
          schemaVersion: 1,
          topicId: RELEASE_ALPHA_TOPIC_ID,
          logicalOperationId: randomUUID(),
          declaration: { name: 'Fictional focused due reminder', enabled: true, deleteAfterRun: false, schedule: { kind: 'at', at: new Date(Date.now() - 30_000).toISOString() }, payload: { kind: 'systemEvent', text: 'Fictional focused due reminder' }, sessionTarget: 'main', wakeMode: 'next-heartbeat' }
        },
        signal,
        deviceIdentity
      });
      const dashboard = await readDashboard(gatewayUrl);
      const reminder = dashboard.attention.find((episode) => episode.sourceCapabilityId === 'reminders' && episode.actions.some((action) => action.actionId === 'reminder.complete'));
      assert.ok(reminder?.episodeId && reminder?.sourceReferenceId);
      await page.close();
      evidence.globalTabClosed = true;
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.dashboard.get', params: { schemaVersion: 1, activityOffset: 0, activityLimit: 50 }, signal, deviceIdentity });
      const emission = await waitForNotificationEmission(databasePath, { status: 'sent' });
      assert.equal(notificationReceiver.deliveries.some((delivery) => delivery.method === 'POST' && delivery.bytes > 0), true);
      await completeReminder(gatewayUrl, reminder, { credential: world.gatewayCredential, signal, deviceIdentity });
      const cleared = await waitForNotificationEmission(databasePath, { status: 'cleared' });
      assert.equal(notificationReceiver.deliveries.filter((delivery) => delivery.method === 'POST' && delivery.bytes > 0).length >= 2, true);
      return { closedTabNotificationStatus: emission.status, closedTabNotificationCleared: cleared.status === 'cleared' };
    });
    if (focusedScenarioIds?.has('focused-topic-review-projection')) await collectScenario('focused-topic-review-projection', async (signal) => {
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, input: {}, logicalOperationId: randomUUID() }, signal });
      const topicResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID }, signal });
      const topic = (topicResponse?.result ?? topicResponse)?.topic;
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.rename', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, name: 'Area: Fictional Focused Review Topic', expectedRevision: topic.revision, logicalOperationId: randomUUID() }, signal });
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, input: {}, logicalOperationId: randomUUID() }, signal });
      const analysisResponse = await fetchWithDeadline(`${gatewayUrl}/plugins/command-center/api/topic-analysis`, {}, 'focused Topic Review readback');
      const analysis = await analysisResponse.json();
      const dashboard = await readDashboard(gatewayUrl);
      const cards = dashboard.attention.filter((episode) => episode.sourceCapabilityId === 'topic-review');
      if (cards.length !== 1) throw new Error(`Focused Topic Review projection mismatch: ${JSON.stringify({ analysisStatus: analysisResponse.status, reviewState: analysis.review?.state, proposalCount: analysis.review?.proposals?.length ?? null, runOutcomes: analysis.runs?.slice(-2).map((run) => ({ outcome: run.outcome, proposalCount: run.proposalCount, baseline: run.baseline, error: run.error })) ?? [], dashboardSources: dashboard.attention.map((episode) => episode.sourceCapabilityId) })}`);
      return { projected: true, proposalCount: analysis.review.proposals.length, cardCount: cards.length };
    });
    const runFocusedProjectionRecovery = async (kind, signal) => {
      const projectionRoot = path.join(path.dirname(databasePath), 'projections');
      await restoreReleaseSearchBaseline({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal, label: `focused ${kind} recovery` });
      if (kind === 'stale') {
        const manifestPath = path.join(projectionRoot, 'topic-search-notes.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await writeFile(manifestPath, `${JSON.stringify({ ...manifest, generation: 'fictional-focused-stale-generation' })}\n`);
      } else {
        await Promise.all(COMMITTED_SEARCH_PROJECTION_FILES.map(async (name) => {
          try { await unlink(path.join(projectionRoot, name)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }));
        if (kind === 'invalidated') await writeFile(path.join(projectionRoot, '.topic-search.invalidated.json'), `${JSON.stringify({ schemaVersion: 1, state: 'invalidated' })}\n`);
      }
      const before = captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath });
      await assert.rejects(
        requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, query: 'Fictional scale search phrase', limit: 50 }, signal }),
        /capability-unavailable|projection/iu
      );
      assert.deepEqual(captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath }), before, `focused ${kind} projection read must remain side-effect free`);
      const startedAt = Date.now();
      await rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential: world.gatewayCredential, topicId: RELEASE_ALPHA_TOPIC_ID, signal, label: `focused ${kind} Search projection rebuild` });
      const verified = await waitForCommittedSearchProjections(projectionRoot, {
        attempts: 1200,
        signal,
        requiredTopicIds: [RELEASE_ALPHA_TOPIC_ID, RELEASE_SCALE_TOPIC_ID],
        expectedTopicRowCounts: {
          notes: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedNotes },
          conversations: { [RELEASE_SCALE_TOPIC_ID]: RELEASE_FIXTURE_COUNTS.indexedConversationMessages }
        }
      });
      return { recovered: true, rebuildMs: Date.now() - startedAt, rowCounts: verified.rowCounts };
    };
    if (focusedScenarioIds?.has('focused-invalidated-projection-recovery')) await collectScenario('focused-invalidated-projection-recovery', (signal) => runFocusedProjectionRecovery('invalidated', signal));
    if (focusedScenarioIds?.has('focused-missing-projection-recovery')) await collectScenario('focused-missing-projection-recovery', (signal) => runFocusedProjectionRecovery('missing', signal));
    if (focusedScenarioIds?.has('focused-stale-projection-recovery')) await collectScenario('focused-stale-projection-recovery', (signal) => runFocusedProjectionRecovery('stale', signal));
    if (focusedScenarioIds?.has('focused-session-create-after-recovery')) {
      await collectScenario('focused-session-create-after-recovery', async (signal) => {
        frame = await remountPluginFrame(page);
        const before = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
        const beforeConversations = (before?.result ?? before)?.conversations ?? before?.conversations ?? [];
        const original = await createScaleConversationThroughAuthenticatedRoute(signal);
        const after = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
        const afterConversations = (after?.result ?? after)?.conversations ?? after?.conversations ?? [];
        const conversation = afterConversations.find((item) => item.referenceId === original.referenceId);
        assert.equal(afterConversations.length, beforeConversations.length + 1);
        assert.equal(typeof conversation?.sessionId, 'string');
        const replay = await createSessionThroughAuthenticatedFrame(frame, { topicId: RELEASE_SCALE_TOPIC_ID, logicalOperationId: original.logicalOperationId, label: 'Fictional scale Conversation 1', authoritativeSession: original.authoritativeSession, signal });
        assert.equal(replay.result?.referenceId, original.referenceId);
        return { referenceId: original.referenceId, authoritativeCount: afterConversations.length, replayed: true };
      });
    }
    if (focusedScenarioIds?.has('focused-session-create-idempotent-replay')) {
      await collectScenario('focused-session-create-idempotent-replay', async (signal) => {
        frame = await remountPluginFrame(page);
        const before = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID }, signal });
        const beforeConversations = (before?.result ?? before)?.conversations ?? before?.conversations ?? [];
        const logicalOperationId = '55555555-5555-4555-8555-555555555555';
        const label = 'Fictional retained Session replay';
        const created = await createSessionThroughAuthenticatedFrame(frame, { topicId: RELEASE_ALPHA_TOPIC_ID, label, logicalOperationId, signal });
        const replayed = await createSessionThroughAuthenticatedFrame(frame, { topicId: RELEASE_ALPHA_TOPIC_ID, label, logicalOperationId, authoritativeSession: created.authoritativeSession, signal });
        assert.equal(replayed.logicalOperationId, logicalOperationId);
        assert.equal(replayed.result?.referenceId, created.result?.referenceId);
        const after = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID }, signal });
        const afterConversations = (after?.result ?? after)?.conversations ?? after?.conversations ?? [];
        assert.equal(afterConversations.length, beforeConversations.length + 1);
        assert.equal(afterConversations.filter((item) => item.referenceId === created.result?.referenceId).length, 1);
        return { logicalOperationId, referenceId: created.result?.referenceId, authoritativeCount: afterConversations.length, replayed: true };
      });
    }
    if (focusedScenarioIds?.has('focused-scale-session-seeding')) {
      await collectScenario('focused-scale-session-seeding', async (signal) => ensureScaleConversationFixture(signal));
    }
    if (focusedScenarioIds?.has('focused-scale-workspace-readiness')) {
      await collectScenario('focused-scale-workspace-readiness', async (signal) => {
        assert.ok(frame && page, 'scale workspace readiness requires its authenticated mounted fixture');
        const browseStarted = Date.now();
        const response = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
        const conversations = (response?.result ?? response)?.conversations ?? response?.conversations ?? [];
        const browseMs = Math.max(1, Date.now() - browseStarted);
        assert.equal(conversations.length, RELEASE_FIXTURE_COUNTS.conversations);
        await frame.evaluate(() => window.CommandCenterTopics.loadTopics());
        const importedTopic = frame.locator('.topic-row').filter({ hasText: 'Fictional Scale Corpus' });
        const workspaceStarted = Date.now();
        await activate(importedTopic.getByRole('button', { name: 'Open Topic', exact: true }), true);
        await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
        const workspaceMs = Math.max(1, Date.now() - workspaceStarted);
        assert.equal(await frame.locator('#conversation-list .conversation-item').count(), 50);
        return { conversations: conversations.length, browseMs, workspaceMs };
      });
    }
    if (focusedScenarioIds?.has('focused-heavy-corpus-mutation-journey')) {
      await collectScenario('focused-heavy-corpus-mutation-journey', async () => {
        assert.ok(frame && page && releaseState.projectionRoot, 'heavy-corpus mutation scenario requires its authenticated mounted fixture');
        assert.ok(releaseState.focusedSearchRebuildMs > 10_000, `heavy-corpus Search rebuild must exceed the UI send deadline; observed ${releaseState.focusedSearchRebuildMs} ms`);
        const journey = await runUiJourney(frame, { page, width: 1440, name: 'Fictional Heavy Corpus Mutation Topic', category: 'project', keyboard: true, projectionRoot: releaseState.projectionRoot });
        return { topicId: journey.topicId, primaryMessage: journey.primaryMessage, conversationMessage: journey.conversationMessage, rebuildMs: releaseState.focusedSearchRebuildMs };
      });
    }
    if (focusedScenarioIds?.has('focused-ui-state-regression')) {
      await collectScenario('focused-ui-state-regression', async () => {
        assert.ok(frame && page, 'UI state regression requires its authenticated mounted fixture');
        const destinationResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 } });
        const destination = destinationResponse?.result ?? destinationResponse;
        const destinationSummary = Object.fromEntries(Object.entries({ ...(destination?.activeGroups ?? {}), provisioning: destination?.provisioning, recovery: destination?.recovery, archived: destination?.archived }).map(([kind, topics]) => [kind, (topics ?? []).map((topic) => ({ topicId: topic.topicId, name: topic.name, lifecycle: topic.lifecycle, usable: topic.usable }))]));
        assert.ok((destination?.activeGroups?.resource ?? []).some((topic) => topic.topicId === RELEASE_SCALE_TOPIC_ID), `authoritative destination omitted the active scale Topic: ${JSON.stringify(destinationSummary)}`);
        await frame.evaluate(() => window.CommandCenterTopics.loadTopics());
        const renderedTopicNames = await frame.locator('.topic-row strong').allTextContents();
        assert.ok(renderedTopicNames.includes('Fictional Scale Corpus'), `Control UI omitted the authoritative scale Topic: ${JSON.stringify({ destinationSummary, renderedTopicNames, status: await frame.locator('#topic-status').textContent() })}`);
        const importedTopic = frame.locator('.topic-row').filter({ hasText: 'Fictional Scale Corpus' });
        await importedTopic.getByRole('button', { name: 'Open Topic', exact: true }).waitFor();
        await activate(importedTopic.getByRole('button', { name: 'Open Topic', exact: true }), true);
        await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
        await activate(frame.locator('#workspace-back'), true);
        await waitForDashboard(frame);
        await importedTopic.getByRole('button', { name: 'Open Topic', exact: true }).waitFor();
        assert.equal(await frame.evaluate(() => document.activeElement?.id), 'topics-heading');
        await page.setViewportSize({ width: 320, height: 900 });
        await activate(importedTopic.getByRole('button', { name: 'Open Topic', exact: true }), true);
        await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
        await selectWorkspaceSection(frame, 'conversations', 320, true);
        const conversationName = 'Fictional UI State Mobile Conversation';
        await enterText(frame.locator('#conversation-create input[name="label"]'), conversationName, true);
        await submitFrameForm(frame, '#conversation-create', true);
        const conversation = frame.locator('.conversation-item').filter({ hasText: conversationName });
        await activate(conversation.getByRole('button', { name: conversationName, exact: true }), true);
        await waitForFrameText(frame, '#chat-conversation-name', conversationName);
        await activate(conversation.getByRole('button', { name: 'Close', exact: true }), true);
        await chooseOption(frame.locator('#conversation-view'), 'closed', true);
        await frame.locator('.conversation-item').filter({ hasText: conversationName }).getByText('Closed', { exact: true }).waitFor();
        await auditDynamicAccessibilityState(frame, page, 320, '320px closed Conversation', true);
        return { topicId: RELEASE_SCALE_TOPIC_ID, conversationName, focus: await frame.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.id || '') };
      });
    }
    await collectScenario('stale-projection-recovery', async (signal) => {
      const projectionRoot = path.join(path.dirname(databasePath), 'projections');
      await restoreReleaseSearchBaseline({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal, label: 'stale recovery' });
      const staleManifestPath = path.join(projectionRoot, 'topic-search-notes.json');
      const committedManifest = JSON.parse(await readFile(staleManifestPath, 'utf8'));
      const staleManifest = `${JSON.stringify({ ...committedManifest, generation: 'fictional-stale-generation' })}\n`;
      await writeFile(staleManifestPath, staleManifest);
      const before = captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath });
      await assert.rejects(
        requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.search.query', params: { schemaVersion: 1, topicId: RELEASE_ALPHA_TOPIC_ID, query: 'Fictional scale search phrase', limit: 50 }, signal }),
        /capability-unavailable|projection/iu
      );
      assert.equal(await readFile(staleManifestPath, 'utf8'), staleManifest, 'stale projection read must not repair the manifest');
      assert.deepEqual(captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath: databasePath }), before, 'stale projection read must remain side-effect free');
      await rebuildSearchThroughAuthenticatedPost({ gatewayUrl, credential: world.gatewayCredential, topicId: RELEASE_ALPHA_TOPIC_ID, signal, label: 'stale Alpha Search projection rebuild' });
      const verified = await verifyReleaseSearchResults({ gatewayUrl, credential: world.gatewayCredential, projectionRoot, signal });
      assert.notEqual(verified.generations['topic-search-notes'], 'fictional-stale-generation');
      releaseState.staleProjectionRebuilt = true;
      return { recovered: true, rowCounts: verified.rowCounts };
    });
    await collectScenario('session-create-catalog-readback', async (signal) => {
      frame = await remountPluginFrame(page);
      const before = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      const beforeConversations = (before?.result ?? before)?.conversations ?? before?.conversations ?? [];
      const created = await createScaleConversationThroughAuthenticatedRoute(signal);
      const after = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      const afterConversations = (after?.result ?? after)?.conversations ?? after?.conversations ?? [];
      const conversation = afterConversations.find((item) => item.referenceId === created.referenceId);
      assert.equal(afterConversations.length, beforeConversations.length + 1);
      assert.equal(conversation?.displayName, 'Fictional scale Conversation 1');
      assert.equal(typeof conversation?.sessionId, 'string');
      const navigationResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID, referenceId: created.referenceId }, signal });
      const navigation = navigationResponse?.result ?? navigationResponse;
      assert.equal(navigation?.sessionId, conversation.sessionId);
      assert.equal(typeof navigation?.sessionKey, 'string');
      releaseState.singleScaleConversation = Object.freeze({ ...created, sessionId: navigation.sessionId, sessionKey: navigation.sessionKey, authoritativeCount: afterConversations.length });
      return { logicalOperationId: created.logicalOperationId, referenceId: created.referenceId, sessionId: navigation.sessionId, sessionKey: navigation.sessionKey, authoritativeCount: afterConversations.length };
    });
    await collectScenario('session-create-idempotent-replay', async (signal) => {
      const original = releaseState.singleScaleConversation;
      assert.ok(original, 'single Session creation evidence must be independently available for replay');
      const replayResponse = await createSessionThroughAuthenticatedFrame(frame, { topicId: RELEASE_SCALE_TOPIC_ID, logicalOperationId: original.logicalOperationId, label: 'Fictional scale Conversation 1', authoritativeSession: original.authoritativeSession, signal });
      const replayed = { logicalOperationId: replayResponse.logicalOperationId, referenceId: replayResponse.result?.referenceId };
      assert.deepEqual(replayed, { logicalOperationId: original.logicalOperationId, referenceId: original.referenceId });
      const readback = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: RELEASE_SCALE_TOPIC_ID }, signal });
      const conversations = (readback?.result ?? readback)?.conversations ?? readback?.conversations ?? [];
      assert.equal(conversations.length, original.authoritativeCount);
      const exact = conversations.filter((item) => item.referenceId === original.referenceId);
      assert.equal(exact.length, 1);
      assert.equal(exact[0].sessionId, original.sessionId);
      return { logicalOperationId: original.logicalOperationId, authoritativeCount: conversations.length, replayed: true };
    });
    await collectScenario('migrated-scale-conversation-seeding', async (signal) => ensureScaleConversationFixture(signal));
    await collectScenario('desktop-primary-journey', async () => {
      assert.ok(frame && page && releaseState.projectionRoot, 'desktop scenario requires its mounted fixture state');
      desktopJourney = await runUiJourney(frame, { page, width: 1440, name: 'Fictional Desktop Journey Topic', category: 'project', keyboard: true, projectionRoot: releaseState.projectionRoot });
      desktopJourney.measurement.startupReadinessMs = releaseState.startupReadinessMs;
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
      const desktopNotes = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.notes.browse', params: { schemaVersion: 1, topicId: desktopJourney.topicId, limit: 100, offset: 0 } });
      const movedNote = authenticatedList(desktopNotes, 'notes').find((note) => note.path === desktopJourney.movedPath);
      assert.ok(movedNote?.sourceReference?.referenceId && movedNote?.revision);
      releaseState.durableWorkspace = {
        conversation: { referenceId: ordinarySession.referenceId, sessionId: ordinarySession.sessionId },
        note: { referenceId: movedNote.sourceReference.referenceId, revision: movedNote.revision, path: movedNote.path }
      };
      const projectionDirectoryFiles = (await readdir(releaseState.projectionRoot)).sort();
      const committedProjectionFiles = projectionDirectoryFiles.filter((name) => COMMITTED_SEARCH_PROJECTION_FILES.includes(name));
      const durableRebuildReceipts = projectionDirectoryFiles.filter((name) => !COMMITTED_SEARCH_PROJECTION_FILES.includes(name));
      assert.deepEqual(committedProjectionFiles, COMMITTED_SEARCH_PROJECTION_FILES);
      assert.ok(durableRebuildReceipts.length <= 8, 'authenticated rebuild receipts must remain bounded');
      assert.equal(durableRebuildReceipts.every((name) => /^rebuild-operation-[0-9a-f-]{36}\.json$/u.test(name)), true, 'projection directory may contain only committed artifacts and durable rebuild receipts');
      await assertResponsiveFrame(frame, page, 1440);
      return { topicId: desktopJourney.topicId, primarySessionId: releaseState.primarySession.sessionId };
    });
    if (focusedScenarioIds?.has('focused-second-topic-journey')) {
      await collectScenario('focused-second-topic-journey', async (signal) => {
        if (page && !page.isClosed()) await page.close();
        page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await configureEvidencePage(page, browserGuard, evidence);
        pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
        await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
        const name = 'Fictional Second Journey Topic';
        try {
          const journey = await runUiJourney(frame, { page, width: 1440, name, category: 'resource', keyboard: true, projectionRoot: releaseState.projectionRoot });
          return { topicId: journey.topicId, topicOpenCreateMs: journey.measurement.topicOpenCreateMs };
        } catch (error) {
          const state = await frame.evaluate((topicName) => {
            const row = [...document.querySelectorAll('.topic-row')].find((candidate) => candidate.textContent?.includes(topicName));
            return {
              topicId: row?.dataset.topicId ?? null,
              workspace: document.querySelector('#workspace-status')?.textContent ?? null,
              conversations: document.querySelector('#conversation-status')?.textContent ?? null,
              notes: document.querySelector('#notes-status')?.textContent ?? null,
              heading: document.querySelector('#topic-workspace-heading')?.textContent ?? null,
              active: document.activeElement?.id || document.activeElement?.tagName || null
            };
          }, name);
          const probe = async (method, params) => {
            const startedAt = Date.now();
            try { await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method, params, signal }); return { method, ms: Date.now() - startedAt, outcome: 'passed' }; }
            catch (probeError) { return { method, ms: Date.now() - startedAt, outcome: 'failed', error: redactBrowserEvidence(probeError?.message ?? probeError) }; }
          };
          const probes = state.topicId ? await Promise.all([
            probe('command-center.v1.topics.get', { schemaVersion: 1, topicId: state.topicId }),
            probe('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: state.topicId }),
            probe('command-center.v1.notes.browse', { schemaVersion: 1, topicId: state.topicId, limit: 100, offset: 0 })
          ]) : [];
          throw new Error(`${error.message}; second-topic-diagnostic=${JSON.stringify({ state, probes, pageErrors: evidence.errors.slice(-5) })}`);
        }
      });
    }
    await collectScenario('scale-performance', async (signal) => {
      assert.ok(browser && releaseState.projectionRoot, 'scale scenario requires the independently seeded authoritative fixture');
      const notificationDeviceIdentity = await ensureNotificationTarget(signal);
      await ensureScaleConversationFixture(signal);
      if (page && !page.isClosed()) await page.close();
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      scaleJourney = await runUiJourney(frame, { page, width: 1440, name: 'Fictional Scale Journey Topic', category: 'resource', keyboard: true, projectionRoot: releaseState.projectionRoot });
      scaleJourney.measurement.startupReadinessMs = releaseState.startupReadinessMs;
      const scaleSessions = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: scaleJourney.topicId } });
      const scalePrimary = ((scaleSessions?.result ?? scaleSessions)?.conversations ?? scaleSessions?.conversations ?? []).find((session) => session.isPrimary === true);
      const scaleOrdinary = ((scaleSessions?.result ?? scaleSessions)?.conversations ?? scaleSessions?.conversations ?? []).find((session) => session.displayName === scaleJourney.conversationName);
      assert.ok(scalePrimary?.referenceId && scalePrimary?.sessionId && scaleOrdinary?.referenceId && scaleOrdinary?.sessionId);
      releaseState.primarySession = scalePrimary;
      const scaleNotes = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.notes.browse', params: { schemaVersion: 1, topicId: scaleJourney.topicId, limit: 100, offset: 0 } });
      const scaleNote = authenticatedList(scaleNotes, 'notes').find((note) => note.path === scaleJourney.movedPath);
      assert.ok(scaleNote?.sourceReference?.referenceId && scaleNote?.revision);
      releaseState.durableWorkspace = { conversation: { referenceId: scaleOrdinary.referenceId, sessionId: scaleOrdinary.sessionId }, note: { referenceId: scaleNote.sourceReference.referenceId, revision: scaleNote.revision, path: scaleNote.path } };
      const realizedConversationCount = releaseState.realizedConversationCount;
      assert.equal(realizedConversationCount, RELEASE_FIXTURE_COUNTS.conversations);
      releaseState.largeNoteMeasurements = await exerciseLargeNoteFixture(frame, { gatewayUrl, credential: world.gatewayCredential });
      scaleJourney.measurement.largeNoteLifecycleMs = releaseState.largeNoteMeasurements.largeNoteLifecycleMs;
      host.diagnostics.guard.assert('127.0.0.1', 'authenticated reminder fixture creation');
      for (let index = 1; index <= 1; index += 1) {
        await requestAuthenticatedGateway({
          gatewayUrl,
          credential: world.gatewayCredential,
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          method: 'command-center.v1.reminders.create',
          params: {
            schemaVersion: 1,
            topicId: scaleJourney.topicId,
            logicalOperationId: randomUUID(),
            declaration: {
              name: `Fictional due reminder ${index}`,
              enabled: true,
              deleteAfterRun: false,
              schedule: { kind: 'at', at: new Date(Date.now() - 30_000 - index).toISOString() },
              payload: { kind: 'systemEvent', text: `Fictional release journey reminder ${index}` },
              sessionTarget: 'main',
              wakeMode: 'next-heartbeat'
            }
          },
          deviceIdentity: notificationDeviceIdentity
        });
      }
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: scaleJourney.topicId, input: {}, logicalOperationId: randomUUID() } });
      let seededDashboard = await readDashboard(gatewayUrl);
      if (!seededDashboard.attention.some((episode) => episode.sourceCapabilityId === 'topic-review')) {
        const topicResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: scaleJourney.topicId } });
        const topic = (topicResponse?.result ?? topicResponse)?.topic;
        await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.rename', params: { schemaVersion: 1, topicId: scaleJourney.topicId, name: 'Area: Fictional Scale Journey Topic Revised', expectedRevision: topic.revision, logicalOperationId: randomUUID() } });
        await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.analysis.run', params: { schemaVersion: 1, topicId: scaleJourney.topicId, input: {}, logicalOperationId: randomUUID() } });
        seededDashboard = await readDashboard(gatewayUrl);
      }
      const seededReminders = seededDashboard.attention.filter((episode) => episode.sourceCapabilityId === 'reminders' && episode.actions.some((action) => action.actionId === 'reminder.complete'));
      const seededTopicReviews = seededDashboard.attention.filter((episode) => episode.sourceCapabilityId === 'topic-review');
      assert.equal(seededReminders.length, 1);
      assert.equal(seededTopicReviews.length, 1);
      let realizedActivityRecords;
      await page.close();
      evidence.globalTabClosed = true;
      const closedTabEmission = await waitForNotificationEmission(databasePath, { status: 'sent' });
      evidence.closedTabNotificationStatus = closedTabEmission.status;
      const closedDashboard = await readDashboard(gatewayUrl);
      const closedEpisode = closedDashboard.attention.find((episode) => episode.sourceCapabilityId === 'reminders' && episode.actions.some((action) => action.actionId === 'reminder.complete'));
      assert.ok(closedEpisode?.episodeId && closedEpisode?.sourceReferenceId);
      await completeReminder(gatewayUrl, closedEpisode, { credential: world.gatewayCredential, signal, deviceIdentity: notificationDeviceIdentity });
      const clearedEmission = await waitForNotificationEmission(databasePath, { status: 'cleared' });
      evidence.closedTabNotificationCleared = true;
      await requestAuthenticatedGateway({
        gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write', 'operator.admin'], method: 'command-center.v1.reminders.create',
        params: { schemaVersion: 1, topicId: scaleJourney.topicId, logicalOperationId: randomUUID(), declaration: { name: 'Fictional replacement due reminder', enabled: true, deleteAfterRun: false, schedule: { kind: 'at', at: new Date(Date.now() - 30_000).toISOString() }, payload: { kind: 'systemEvent', text: 'Fictional replacement release reminder' }, sessionTarget: 'main', wakeMode: 'next-heartbeat' } }
      });
      // Revoke the exact authoritative Primary Session binding while the tab
      // is closed. The following mutation is otherwise current and valid; its
      // refusal is therefore attributable to binding revocation, not stale UI
      // evidence or missing parent authentication.
      await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'sessions.delete', params: { key: releaseState.primarySession.sessionKey, deleteTranscript: true } });
      await assert.rejects(
        () => requestAuthenticatedGateway({
          gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.sessions.send',
          params: { schemaVersion: 1, topicId: scaleJourney.topicId, referenceId: releaseState.primarySession.referenceId, logicalOperationId: randomUUID(), message: 'Fictional current mutation after binding revocation' }
        }),
        /missing|recovery|unavailable/iu
      );
      evidence.revokedMutationRejected = true;
      releaseState.publicBindingBoundary = { safeReadObserved: Boolean(closedDashboard && typeof closedDashboard === 'object'), mutationRejected: true, bindingObserved: true };
      const replacementCreated = await requestAuthenticatedGateway({
        gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'sessions.create',
        params: { agentId: 'main', label: 'Fictional reconciled Primary Session', idempotencyKey: randomUUID() }
      });
      const replacementSession = replacementCreated?.result ?? replacementCreated;
      assert.ok(replacementSession?.key && replacementSession?.sessionId);
      const recoveryTopicResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: scaleJourney.topicId } });
      const recoveryTopic = (recoveryTopicResponse?.result ?? recoveryTopicResponse)?.topic;
      const replacementBindingResponse = await requestAuthenticatedGateway({
        gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write'], method: 'command-center.v1.topics.recovery.replace',
        params: {
          schemaVersion: 1, topicId: scaleJourney.topicId, referenceId: releaseState.primarySession.referenceId,
          sessionKey: replacementSession.key, sessionId: replacementSession.sessionId, expectedRevision: recoveryTopic.revision,
          expectedSourceRevision: releaseState.primarySession.sessionId, logicalOperationId: randomUUID()
        }
      });
      const reconciledSessions = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: scaleJourney.topicId } });
      const replacementBinding = replacementBindingResponse?.result ?? replacementBindingResponse;
      const reconciledRows = (reconciledSessions?.result ?? reconciledSessions)?.conversations ?? [];
      const revokedPrimary = reconciledRows.find((session) => session.referenceId === releaseState.primarySession.referenceId);
      const reconciledPrimary = reconciledRows.find((session) => session.referenceId === replacementBinding.replacementReferenceId);
      assert.equal(revokedPrimary?.isPrimary, false, 'revoked durable binding must remain non-Primary recovery history');
      assert.deepEqual({ sessionId: reconciledPrimary?.sessionId, status: reconciledPrimary?.status, isPrimary: reconciledPrimary?.isPrimary }, { sessionId: replacementSession.sessionId, status: 'open', isPrimary: true });
      releaseState.primarySession = { ...releaseState.primarySession, referenceId: reconciledPrimary.referenceId, sessionKey: replacementSession.key, sessionId: replacementSession.sessionId };
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
      await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const reopenedConfigResponse = await reopenedBootstrap;
      assert.equal(hasSuccessfulBrowserResponse(reopenedConfigResponse), true);
      const reopenedConfig = await reopenedConfigResponse.value.json();
      assert.equal(routeGrant(reopenedConfig), true);
      assert.equal(evidence.revokedMutationRejected, true);
      assert.doesNotMatch(JSON.stringify(reopenedConfig), /tokenHash/iu);
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
      await waitForDashboard(frame);
      const restoredTopic = frame.locator(`.topic-row[data-topic-id="${scaleJourney.topicId}"]`);
      await activate(restoredTopic.getByRole('button', { name: 'Open Topic', exact: true }), true);
      await waitForFrameText(frame, '#workspace-status', 'Topic workspace ready.');
      await selectWorkspaceSection(frame, 'conversations', 1440);
      await frame.locator('.conversation-item').filter({ hasText: scaleJourney.conversationName }).getByText('Open', { exact: true }).waitFor();
      const reopenedSessions = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: scaleJourney.topicId } });
      const reopenedPrimary = (reopenedSessions?.result ?? reopenedSessions)?.conversations?.find((session) => session.isPrimary === true) ?? (reopenedSessions?.conversations ?? []).find((session) => session.isPrimary === true);
      const reopenedNavigation = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId: scaleJourney.topicId, referenceId: reopenedPrimary.referenceId } });
      const reopenedTarget = reopenedNavigation?.result ?? reopenedNavigation;
      assert.deepEqual({ referenceId: reopenedPrimary?.referenceId, sessionId: reopenedPrimary?.sessionId, sessionKey: reopenedTarget?.sessionKey }, { referenceId: releaseState.primarySession.referenceId, sessionId: releaseState.primarySession.sessionId, sessionKey: releaseState.primarySession.sessionKey });
      const reopenedOrdinary = ((reopenedSessions?.result ?? reopenedSessions)?.conversations ?? reopenedSessions?.conversations ?? []).find((session) => session.displayName === scaleJourney.conversationName);
      assert.deepEqual({ referenceId: reopenedOrdinary?.referenceId, sessionId: reopenedOrdinary?.sessionId }, releaseState.durableWorkspace.conversation);
      await selectWorkspaceSection(frame, 'notes', 1440);
      await frame.locator('#notes-tree').getByRole('button', { name: scaleJourney.movedPath, exact: true }).waitFor();
      const reopenedNotes = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.notes.browse', params: { schemaVersion: 1, topicId: scaleJourney.topicId, limit: 100, offset: 0 } });
      const reopenedNote = authenticatedList(reopenedNotes, 'notes').find((note) => note.path === scaleJourney.movedPath);
      assert.deepEqual({ referenceId: reopenedNote?.sourceReference?.referenceId, revision: reopenedNote?.revision, path: reopenedNote?.path }, releaseState.durableWorkspace.note);
      await selectWorkspaceSection(frame, 'search', 1440);
      await enterText(frame.locator('#workspace-search-query'), 'Edited fictional journey evidence', true);
      await submitFrameForm(frame, '#workspace-search-form', true);
      await waitForFrameText(frame, '#workspace-search-status', '1 Notes');
      await waitForCommittedSearchProjections(releaseState.projectionRoot);
      await activate(frame.locator('#workspace-back'), true);
      await waitForDashboard(frame);
      releaseState.restored = true;
      const attentionCards = frame.locator('#attention-cards .attention-card');
      await assert.doesNotReject(attentionCards.nth(1).waitFor({ state: 'visible', timeout: 15_000 }));
      const attentionCard = frame.locator('#attention-cards [data-source-capability-id="topic-review"]');
      const sourceActionCard = frame.locator('#attention-cards [data-source-capability-id="reminders"]');
      const sourceAction = sourceActionCard.getByRole('button', { name: 'Reminder Complete', exact: true });
      await frame.evaluate(() => {
        window.__observedPendingSourceAction = false;
        const target = document.querySelector('#in-progress');
        const observer = new MutationObserver(() => {
          if (target.textContent.includes('Awaiting source confirmation')) { window.__observedPendingSourceAction = true; observer.disconnect(); }
        });
        observer.observe(target, { childList: true, subtree: true, characterData: true });
      });
      const sourceActionStarted = activate(sourceAction, true);
      await frame.waitForFunction(() => window.__observedPendingSourceAction === true, undefined, { timeout: 10_000 });
      await sourceActionStarted;
      await waitForFrameText(frame, '#dashboard-feedback', 'Reminder Complete accepted.');
      const actionReceipt = JSON.parse(await frame.locator('#dashboard-feedback').getAttribute('data-activity-receipt'));
      assert.ok(actionReceipt?.activityId && actionReceipt?.logicalOperationId, 'keyboard source action must expose its bounded Activity receipt');
      const sourceActivityResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.activity.get', params: { schemaVersion: 1, activityId: actionReceipt.activityId } });
      const completedActivity = (sourceActivityResponse?.result ?? sourceActivityResponse)?.record;
      const exactActivity = (value) => ({ activityId: value?.activityId, episodeId: value?.episodeId, logicalOperationId: value?.logicalOperationId, topicId: value?.topicId, sourceReferenceId: value?.sourceReferenceId, operationKind: value?.operationKind, outcome: value?.outcome, verificationRevision: value?.verificationRevision, occurredAt: value?.occurredAt });
      assert.deepEqual(exactActivity(completedActivity), exactActivity(actionReceipt));
      assert.equal(completedActivity.outcome, 'resolved');
      assert.match(completedActivity.operationKind, /reminder.*complete|complete.*reminder/iu);
      releaseState.sourceActionActivity = completedActivity;
      releaseState.verifiedActivity = completedActivity;
      assert.notEqual(clearedEmission.emission_id, undefined);
      await attentionCard.waitFor({ state: 'visible', timeout: 15_000 });
      await auditDynamicAccessibilityState(frame, page, 1440, 'desktop Attention cards', true);
      await activate(attentionCard.getByRole('button', { name: 'View evidence', exact: true }), true);
      assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
      assert.ok((await frame.locator('#evidence-content').innerText()).length > 0);
      await auditDynamicAccessibilityState(frame, page, 1440, 'desktop Evidence dialog', true);
      await activate(frame.locator('#evidence-close'), true, 'Escape');
      await activate(attentionCard.getByRole('button', { name: 'Open Topic Review', exact: true }), true);
      const actionStarted = Date.now();
      await activate(frame.locator('#topic-review-snooze'), true);
      await respondToCommandDialog(frame, { value: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString() });
      await waitForFrameText(frame, '#analysis-feedback', 'Topic Review snoozed.');
      evidence.performanceMeasurements = { desktop: { ...scaleJourney.measurement, sourceActionMs: Date.now() - actionStarted } };
      assert.ok(await frame.locator('#in-progress').count() === 1);
      await prepareExactActivityFixture({ stateDir: resolvedStateDir, gatewayUrl, topicId: RELEASE_ACTIVITY_TOPIC_ID });
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      await waitForDashboard(frame);
      const activityStarted = Date.now();
      const loadMoreActivity = frame.locator('#activity-load-more');
      await loadMoreActivity.waitFor({ state: 'visible' });
      const firstActivityPage = await readDashboard(gatewayUrl, { activityOffset: 0, activityLimit: 50 });
      const firstActivityIds = firstActivityPage.activity.records.map((record) => record.activityId);
      await activate(loadMoreActivity, true);
      await frame.waitForFunction(() => document.querySelectorAll('#activity .activity-row').length >= 100, undefined, { timeout: 10_000 });
      const secondActivityPage = await readDashboard(gatewayUrl, { activityOffset: 50, activityLimit: 50 });
      const secondActivityIds = secondActivityPage.activity.records.map((record) => record.activityId);
      await activate(loadMoreActivity, true);
      await frame.waitForFunction(() => document.querySelectorAll('#activity .activity-row').length >= 101, undefined, { timeout: 10_000 });
      const thirdActivityPage = await readDashboard(gatewayUrl, { activityOffset: 100, activityLimit: 50 });
      const thirdActivityIds = thirdActivityPage.activity.records.map((record) => record.activityId);
      assert.deepEqual([firstActivityIds.length, secondActivityIds.length, thirdActivityIds.length], [50, 50, 1]);
      realizedActivityRecords = firstActivityIds.length + secondActivityIds.length + thirdActivityIds.length;
      assert.equal(realizedActivityRecords, RELEASE_FIXTURE_COUNTS.activityRecords);
      assert.equal([...firstActivityIds, ...secondActivityIds, ...thirdActivityIds].includes(releaseState.verifiedActivity.activityId), true);
      assert.equal(new Set([...firstActivityIds, ...secondActivityIds, ...thirdActivityIds]).size, realizedActivityRecords, 'Activity pagination must not duplicate identities');
      const renderedActivityIds = await frame.locator('#activity .activity-row').evaluateAll((rows) => rows.map((row) => row.dataset.activityId).filter(Boolean));
      assert.deepEqual(renderedActivityIds.slice(0, firstActivityIds.length), firstActivityIds, 'Activity page append must not replace or reorder page one');
      await assertNoFrameOverflow(frame, '1440px 101-record Activity');
      await page.setViewportSize({ width: 320, height: 900 });
      await assertNoFrameOverflow(frame, '320px 101-record Activity');
      await page.setViewportSize({ width: 1440, height: 900 });
      const verifiedActivityRow = frame.locator(`#activity .activity-row[data-activity-id="${releaseState.verifiedActivity.activityId}"]`);
      await verifiedActivityRow.waitFor({ state: 'visible' });
      scaleJourney.measurement.activityNextPageMs = Math.max(1, Date.now() - activityStarted);
      releaseState.activityPaged = true;
      return { restored: true, sentEmissionId: closedTabEmission.emission_id, clearedEmissionId: clearedEmission.emission_id, activityId: completedActivity.activityId, realizedFixtureCounts: { ...releaseState.realizedScaleSeed, conversations: realizedConversationCount, activityRecords: realizedActivityRecords, actionCards: seededReminders.length + seededTopicReviews.length, indexedNotes: releaseState.realizedSearchCounts.notes, indexedConversationMessages: releaseState.realizedSearchCounts.conversationMessages } };
    });
    await collectScenario('verified-activity-readback', async () => {
      const receipt = releaseState.verifiedActivity;
      assert.ok(receipt?.activityId, 'verified Activity requires the prior keyboard source-action receipt');
      const activityResponse = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.activity.get', params: { schemaVersion: 1, activityId: receipt.activityId } });
      const verifiedActivity = (activityResponse?.result ?? activityResponse)?.record;
      assert.deepEqual({ activityId: verifiedActivity?.activityId, episodeId: verifiedActivity?.episodeId, logicalOperationId: verifiedActivity?.logicalOperationId, topicId: verifiedActivity?.topicId, sourceReferenceId: verifiedActivity?.sourceReferenceId, operationKind: verifiedActivity?.operationKind, outcome: verifiedActivity?.outcome, verificationRevision: verifiedActivity?.verificationRevision, occurredAt: verifiedActivity?.occurredAt }, { activityId: receipt.activityId, episodeId: receipt.episodeId, logicalOperationId: receipt.logicalOperationId, topicId: receipt.topicId, sourceReferenceId: receipt.sourceReferenceId, operationKind: receipt.operationKind, outcome: receipt.outcome, verificationRevision: receipt.verificationRevision, occurredAt: receipt.occurredAt });
      return { activityId: verifiedActivity.activityId, sourceReferenceId: verifiedActivity.sourceReferenceId, logicalOperationId: verifiedActivity.logicalOperationId };
    });
    await collectScenario('mobile-accessibility-journey', async () => {
      assert.ok(browser, 'mobile scenario requires an independently reset browser fixture');
      await page.close();
      page = await browser.newPage({ viewport: { width: 320, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }), (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
      mobileJourney = await runUiJourney(frame, { page, width: 320, name: 'Fictional Mobile Journey Topic', category: 'project', keyboard: true });
      releaseState.mobile = mobileJourney;
      for (const label of ['Keyboard source action', 'Keyboard snooze']) {
        await requestAuthenticatedGateway({
          gatewayUrl, credential: world.gatewayCredential, scopes: ['operator.read', 'operator.write', 'operator.admin'], method: 'command-center.v1.reminders.create',
          params: { schemaVersion: 1, topicId: mobileJourney.topicId, logicalOperationId: randomUUID(), declaration: { name: `Fictional ${label}`, enabled: true, deleteAfterRun: false, schedule: { kind: 'at', at: new Date(Date.now() - 30_000).toISOString() }, payload: { kind: 'systemEvent', text: `Fictional ${label} reminder` }, sessionTarget: 'main', wakeMode: 'next-heartbeat' } }
        });
      }
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      await waitForDashboard(frame);
      const mobileCards = frame.locator('#attention-cards .attention-card').filter({ hasText: 'Fictional Keyboard' });
      await mobileCards.nth(1).waitFor({ state: 'visible' });
      mobileJourney.accessibilityStates.push(await auditDynamicAccessibilityState(frame, page, 320, 'mobile Attention cards', true));
      await activate(mobileCards.first().getByRole('button', { name: 'View evidence', exact: true }), true);
      assert.equal(await frame.locator('#evidence-dialog').getAttribute('open'), '');
      mobileJourney.accessibilityStates.push(await auditDynamicAccessibilityState(frame, page, 320, 'mobile Evidence dialog', true));
      await page.keyboard.press('Escape');
      assert.equal(await mobileCards.first().getByRole('button', { name: 'View evidence', exact: true }).evaluate((node) => document.activeElement === node), true, 'Evidence dialog must restore its invoking control');
      mobileJourney.focusRestorations.push('320px Evidence dialog');
      await chooseOption(mobileCards.first().locator('select[aria-label="Snooze duration"]'), 'PT72H', true);
      await activate(mobileCards.first().getByRole('button', { name: 'Snooze', exact: true }), true);
      await waitForFrameText(frame, '#dashboard-feedback', 'Item snoozed.');
      await frame.waitForFunction(() => [...document.querySelectorAll('#attention-cards .attention-card')].filter((card) => card.textContent.includes('Fictional Keyboard')).length === 1);
      await activate(mobileCards.first().getByRole('button', { name: 'Reminder Complete', exact: true }), true);
      await waitForFrameText(frame, '#dashboard-feedback', 'Reminder Complete accepted.');
      if (await frame.locator('#activity-load-more').isVisible()) await activate(frame.locator('#activity-load-more'), true);
      await assertResponsiveFrame(frame, page, 320);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      const parentZoom = await page.evaluate(() => ({ layoutWidth: document.documentElement.clientWidth, visualWidth: visualViewport.width, scale: visualViewport.scale, frameLayoutWidth: document.querySelector('iframe')?.getBoundingClientRect().width ?? 0 }));
      const frameZoom = await frame.evaluate(() => ({ layoutWidth: document.documentElement.clientWidth, ratio: devicePixelRatio }));
      assert.equal(parentZoom.layoutWidth, 320);
      assert.equal(parentZoom.visualWidth, 160);
      assert.equal(parentZoom.scale, 2);
      assert.equal(frameZoom.ratio, 1, 'browser zoom must not be simulated with device pixel density');
      assert.ok(parentZoom.frameLayoutWidth / parentZoom.scale <= parentZoom.visualWidth, '200% browser zoom must scale the mounted frame into the effective viewport');
      const reflowStarted = Date.now();
      const zoomJourney = await runUiJourney(frame, { page, width: 320, name: 'Fictional 200 Percent Zoom Topic', category: 'area', keyboard: true });
      assert.ok(zoomJourney.topicId);
      mobileJourney.accessibilityStates.push(...zoomJourney.accessibilityStates);
      mobileJourney.focusRestorations.push(...zoomJourney.focusRestorations);
      mobileJourney.announcementTransitions.push(...zoomJourney.announcementTransitions);
      await assertResponsiveFrame(frame, page, 320);
      mobileJourney.measurement.mobileReflowMs = Math.max(1, Date.now() - reflowStarted);
      mobileJourney.zoomEvidence = { ...parentZoom, frameLayoutWidth: frameZoom.layoutWidth };
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await cdp.detach();
      await assertKeyboardAccessibility(frame, page);
      evidence.performanceMeasurements.mobile = { ...mobileJourney.measurement, sourceActionMs: 0 };
      return { topicId: mobileJourney.topicId, viewport: '320x900', keyboardAndReflow: true, zoom200TopicId: zoomJourney.topicId, zoomEvidence: mobileJourney.zoomEvidence, accessibilityStates: mobileJourney.accessibilityStates, focusRestorations: mobileJourney.focusRestorations, announcementTransitions: mobileJourney.announcementTransitions };
    });
    await collectScenario('desktop-primary-journey-review', async () => {
      assert.ok(browser, 'review scenario requires an independently mounted browser fixture');
      if (page && !page.isClosed()) await page.close();
      page = await browser.newPage({ viewport: { width: 320, height: 900 } });
      await configureEvidencePage(page, browserGuard, evidence);
      pluginDocument = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/plugins/command-center', { timeout: 10_000 }));
      await page.goto(controlUiPluginUrl({ gatewayUrl, pluginId: 'command-center', routeId: 'command-center', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      ({ iframe, frame } = await mountedPluginFrame(page, await pluginDocument, evidence));
      await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
      reviewJourney = await runUiJourney(frame, { page, width: 320, name: 'Fictional Review Journey Topic', category: 'area', keyboard: true });
      // These prompt responses seed two deterministic review proposals before
      // the measured keyboard-only decision/checkpoint/application workflow;
      // they are fixture setup, not a completed primary-journey action.
      const mobileRow = frame.locator('.topic-row').filter({ hasText: 'Fictional Review Journey Topic' });
      await activate(mobileRow.getByRole('button', { name: 'Rename', exact: true }), true);
      await respondToCommandDialog(frame, { value: 'Project: Fictional Review Journey Topic' });
      await waitForFrameText(frame, '#topic-status', 'Topic renamed.');
      const desktopRow = frame.locator('.topic-row').filter({ hasText: 'Fictional Desktop Journey Topic' });
      await activate(desktopRow.getByRole('button', { name: 'Rename', exact: true }), true);
      await respondToCommandDialog(frame, { value: 'Resource: Fictional Desktop Journey Topic' });
      await waitForFrameText(frame, '#topic-status', 'Topic renamed.');
      await activate(frame.locator('#analysis-run'), true);
      await waitForFrameText(frame, '#analysis-feedback', 'Analysis completed.');
      const proposals = frame.locator('.topic-review-proposal');
      await proposals.nth(1).waitFor({ state: 'visible', timeout: 15_000 });
      const beforeDecisions = await frame.evaluate(async () => {
        const response = await fetch('/plugins/command-center/api/topic-analysis', { credentials: 'omit', headers: { accept: 'application/json' } });
        const body = await response.json();
        return (body.result ?? body).review?.proposals ?? (body.result ?? body).proposals;
      });
      assert.equal(beforeDecisions.filter((proposal) => proposal.state === 'pending').length >= 2, true);
      const approvedBefore = beforeDecisions.find((proposal) => proposal.state === 'pending' && proposal.affectedTopicIds.includes(reviewJourney.topicId));
      const keptBefore = beforeDecisions.find((proposal) => proposal.state === 'pending' && proposal.affectedTopicIds.includes(desktopJourney.topicId));
      assert.ok(approvedBefore && keptBefore);
      const proposal = frame.locator(`[data-proposal-id="${approvedBefore.proposalId}"]`);
      reviewJourney.accessibilityStates.push(await auditDynamicAccessibilityState(frame, page, 320, 'mobile Topic Review proposal', true));
      await activate(proposal.getByRole('button', { name: 'Approve', exact: true }), true);
      await waitForFrameText(frame, '#analysis-feedback', 'Proposal decision saved.');
      const afterApproval = await frame.evaluate(async () => {
        const body = await (await fetch('/plugins/command-center/api/topic-analysis', { credentials: 'omit', headers: { accept: 'application/json' } })).json();
        return (body.result ?? body).review?.proposals ?? (body.result ?? body).proposals;
      });
      assert.equal(afterApproval.find((item) => item.proposalId === approvedBefore.proposalId)?.state, 'approved');
      assert.deepEqual(afterApproval.find((item) => item.proposalId === keptBefore.proposalId), keptBefore, 'Approving one proposal must not alter its sibling decision or revision');
      const pendingCard = frame.locator(`[data-proposal-id="${keptBefore.proposalId}"]`);
      await activate(pendingCard.getByRole('button', { name: 'Keep as-is', exact: true }), true);
      await waitForFrameText(frame, '#analysis-feedback', 'Proposal decision saved.');
      const afterKeep = await frame.evaluate(async () => {
        const body = await (await fetch('/plugins/command-center/api/topic-analysis', { credentials: 'omit', headers: { accept: 'application/json' } })).json();
        return (body.result ?? body).review?.proposals ?? (body.result ?? body).proposals;
      });
      assert.equal(afterKeep.find((item) => item.proposalId === approvedBefore.proposalId)?.state, 'approved');
      assert.equal(afterKeep.some((item) => item.proposalId === keptBefore.proposalId), false, 'kept proposal leaves the actionable view');
      for (const sibling of afterKeep.filter((item) => item.state === 'pending')) {
        await activate(frame.locator(`[data-proposal-id="${sibling.proposalId}"]`).getByRole('button', { name: 'Keep as-is', exact: true }), true);
        await frame.locator(`[data-proposal-id="${sibling.proposalId}"]`).waitFor({ state: 'detached' });
      }
      const checkpoint = frame.locator('#topic-review-checkpoint');
      await checkpoint.waitFor({ state: 'visible' });
      reviewJourney.accessibilityStates.push(await auditDynamicAccessibilityState(frame, page, 320, 'mobile Topic Review checkpoint', true));
      await activate(checkpoint, true);
      await respondToCommandDialog(frame, { confirm: false });
      await waitForFrameText(frame, '#topic-review-plan', 'Frozen application plan');
      const frozenPlanText = await frame.locator('#topic-review-plan').innerText();
      const frozenPlan = JSON.parse(frozenPlanText.slice(frozenPlanText.indexOf('{')));
      assert.match(frozenPlan.planRevision, /^sha256:[a-f0-9]{64}$/u);
      const topicReviewApplyStarted = Date.now();
      await activate(checkpoint, true);
      await respondToCommandDialog(frame);
      await waitForFrameText(frame, '#topic-review-plan', 'Application outcomes:');
      releaseState.topicReviewApplyMs = Math.max(1, Date.now() - topicReviewApplyStarted);
      const appliedReviewResponse = await frame.evaluate(async () => {
        const response = await fetch('/plugins/command-center/api/topic-analysis', { credentials: 'omit', headers: { accept: 'application/json' } });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(appliedReviewResponse.status, 200);
      const appliedReview = appliedReviewResponse.body?.result ?? appliedReviewResponse.body;
      assert.equal(appliedReview?.review?.state ?? appliedReview?.state, 'Resolved');
      assert.deepEqual(appliedReview.review.proposals, []);
      assert.equal(appliedReview.review.applicationSummary.outcomes[approvedBefore.proposalId].status, 'applied');
      const durable = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const approved = durable.prepare('SELECT proposal_id AS proposalId, revision, state FROM topic_proposals WHERE proposal_id = ?').get(approvedBefore.proposalId);
        assert.equal(approved.state, 'applied');
        assert.deepEqual([{ proposalId: approved.proposalId, revision: approved.revision }], frozenPlan.proposalRevisions);
        assert.equal(durable.prepare('SELECT state FROM topic_proposals WHERE proposal_id = ?').get(keptBefore.proposalId).state, 'kept');
      } finally { durable.close(); }
      const changedTopic = await requestAuthenticatedGateway({ gatewayUrl, credential: world.gatewayCredential, method: 'command-center.v1.topics.get', params: { schemaVersion: 1, topicId: reviewJourney.topicId } });
      assert.equal((changedTopic?.result ?? changedTopic).topic.paraCategory, 'project');
      releaseState.reviewApplied = true;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      await assertResponsiveFrame(frame, page, 320);
      return { planRevision: frozenPlan.planRevision, appliedProposalCount: frozenPlan.proposalRevisions.length };
    });
    if (acceptancePlan.kind === 'release') {
      await Promise.all([...isolatedSlices.keys()].map(async (id) => {
        try { await isolatedResult(id); }
        catch (error) {
          scenarioFailures.push({ id: `isolated:${id}`, error: new HarnessFailure('release-row-failed', redactBrowserEvidence(error?.message || error)) });
        }
      }));
    }
    const finalizationErrors = await finalizeAcceptanceJourney({
      closeBrowser: async (signal) => await closeManagedBrowser(managedBrowser, signal),
      stopHost: async () => {
        await stopPinnedHost(host.child);
        await host.outputDrained;
        await notificationReceiver?.close?.();
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
      assertBuildDigest: async () => await assertBuiltDigest(buildReceipt),
      timeoutMs: 60_000,
      onProgress: ({ phase, status }) => reportProgress(testContext, `finalization:${phase}:${status}`)
    });
    let privacyEvidence;
    try {
      await scanRepositorySafety(process.cwd(), { generated: [path.join(process.cwd(), 'dist')] });
      scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(boundedHostEvidence(host.diagnostics)), redactBrowserEvidence(failure?.message || '')]);
      privacyEvidence = { schemaVersion: 1, repository: true, generated: true, capturedOutput: true, browserDiagnostics: true, hostDiagnostics: true, trafficFinalized: finalizationErrors.length === 0 };
      if (acceptancePlan.kind === 'release' && scenarioFailures.length === 0 && finalizationErrors.length === 0) {
        assert.ok(scaleJourney && mobileJourney && releaseState.reviewApplied, 'baseline qualification requires every independently collected release phase');
        assert.equal(isolatedEvidence.size, isolatedSlices.size, 'baseline qualification requires every independent runtime slice');
        scaleJourney.measurement.topicReviewApplyMs = releaseState.topicReviewApplyMs;
        scaleJourney.measurement.mobileReflowMs = mobileJourney.measurement.mobileReflowMs;
        if (capturePerformanceBaseline) {
          assert.ok(baselineSeed, 'baseline capture requires the launched browser identity');
          qualifiedBaseline = captureFirstReleasePerformanceBaseline(baselineSeed, scaleJourney.measurement);
          baseline = qualifiedBaseline;
        } else {
          for (const name of RELEASE_MEASUREMENTS) assertPerformanceObservationWithinBaseline(name, scaleJourney.measurement[name], baseline);
          qualifiedBaseline = baseline;
        }
      }
    } catch (error) {
      scenarioFailures.push({ id: 'release-preflight', error: new HarnessFailure('release-row-failed', redactBrowserEvidence(error?.message || error)) });
    }
    if (scenarioFailures.length > 0) failure = new AggregateError(scenarioFailures.map(({ error }) => error), `Release scenarios failed: ${scenarioFailures.map(({ id }) => id).join(', ')}`);
    if (acceptancePlan.kind === 'focused') {
      try {
        for (const id of acceptancePlan.scenarioIds) scenarioResult(id);
        if (finalizationErrors.length > 0) throw finalizationErrors[0].error;
        scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(boundedHostEvidence(host.diagnostics)), JSON.stringify(privacyEvidence)]);
      } catch (error) { failure ??= error; }
      if (failure) throw failure;
      testContext.diagnostic(`acceptance-scenario-result=${JSON.stringify({ schemaVersion: 1, outcome: 'passed', scenario: process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO, scenarioIds: acceptancePlan.scenarioIds, buildDigest: buildReceipt.digest, performanceQualified: false })}`);
      return;
    }
    const rows = await runAcceptanceRows([
      { id: 'pinned-host-startup', run: async () => {
        scenarioResult('pinned-host-startup');
        scenarioResult('startup-migration-channel-count');
        scenarioResult('startup-migration-occurrence-count');
        scenarioResult('startup-authenticated-history');
        scenarioResult('startup-imported-history-text');
        scenarioResult('startup-imported-history-provenance');
        scenarioResult('session-create-catalog-readback');
        scenarioResult('session-create-idempotent-replay');
        scenarioResult('migrated-scale-conversation-seeding');
        scenarioResult('startup-projection-recovery');
        scenarioResult('invalidated-projection-recovery');
        scenarioResult('missing-projection-recovery');
        scenarioResult('stale-projection-recovery');
        scenarioResult('startup-authenticated-topic-analysis');
        scenarioResult('malformed-topic-route-rejection');
        scenarioResult('verified-activity-readback');
        scenarioResult('authenticated-control-ui-mount');
        const secure = await isolatedResult('secure-origin');
        const lifecycle = scenarioResult('scale-performance');
        return { schemaVersion: 1, hostReceipt: { ...releasePerformanceIdentity.hostReceipt }, buildDigest: buildReceipt.digest, startupMigrationVerified: true, routeGrantObserved: evidence.routeGrant, scriptsOnlyFrame: evidence.frame, secureOrigin: { protocol: 'https:', hostname: secure.fictionalTailnetHost, loopbackOnly: secure.loopbackResolution === '127.0.0.1' }, notificationLifecycle: { closedTabDelivered: Boolean(lifecycle.sentEmissionId), cleared: Boolean(lifecycle.clearedEmissionId), bindingRevoked: evidence.revokedMutationRejected === true, bindingReconciled: releaseState.restored === true } };
      } },
      { id: 'desktop-primary-journey', run: async () => {
        const desktop = scenarioResult('desktop-primary-journey');
        scenarioResult('desktop-primary-journey-review');
        for (const fresh of await Promise.all(['fresh-desktop', 'fresh-review'].map(isolatedResult))) assert.equal(fresh.assertionsCompleted, true);
        return { schemaVersion: 1, topicId: desktop.topicId, authoritativeReadback: { primarySession: Boolean(releaseState.primarySession?.sessionId), conversation: Boolean(releaseState.durableWorkspace?.conversation?.sessionId), closedConversation: true, note: Boolean(releaseState.durableWorkspace?.note?.revision), attention: Boolean(releaseState.sourceActionActivity), activity: releaseState.activityPaged, topicReview: releaseState.reviewApplied }, actions: ['dashboard-load', 'topic-select', 'topic-create', 'primary-chat-send', 'conversation-create', 'conversation-switch', 'conversation-close', 'conversation-search', 'conversation-reopen', 'note-create', 'note-edit', 'note-preview', 'note-rename', 'note-move', 'topic-search', 'attention-evidence', 'attention-snooze', 'source-action', 'activity-page', 'topic-review'] };
      } },
      { id: 'mobile-accessibility-journey', run: async () => {
        const accessibility = scenarioResult('mobile-accessibility-journey');
        scenarioResult('desktop-primary-journey-review');
        assert.equal((await isolatedResult('fresh-mobile')).assertionsCompleted, true);
        const states = accessibility.accessibilityStates;
        assert.ok(states.length >= 12, 'Accessibility evidence must cover every dynamic journey state');
        return { schemaVersion: 1, viewport: { width: 320, height: 900 }, keyboardOnly: true, zoom200: accessibility.zoomEvidence?.scale === 2 && accessibility.zoomEvidence?.visualWidth === 160, forcedColors: states.some((state) => state.forcedColorsPreference), reducedMotion: states.filter((state) => state.reducedMotionPreference).every((state) => state.reducedMotion), focusRestored: accessibility.focusRestorations.length >= 10, announcements: accessibility.announcementTransitions.length >= 9, colorIndependent: states.every((state) => state.colorIndependent), minimumTargetCssPx: Math.min(...states.map((state) => state.minimumTargetCssPx)), noPageOverflow: states.every((state) => state.noPageOverflow), states: states.map((state) => state.label) };
      } },
      { id: 'scale-performance', run: async () => {
        scenarioResult('scale-performance');
        assert.equal((await isolatedResult('fresh-scale')).assertionsCompleted, true);
        const scaleAnalysis = await isolatedResult('fresh-scale-analysis');
        assert.equal(scaleAnalysis.assertionsCompleted, true);
        assert.equal(scaleAnalysis.actionCards, RELEASE_FIXTURE_COUNTS.actionCards);
        verifyCommittedSearchProjectionSet({
          projectionRoot: releaseState.projectionRoot,
          metadataDatabasePath: databasePath,
          requiredTopicIds: [RELEASE_ALPHA_TOPIC_ID, RELEASE_SCALE_TOPIC_ID]
        });
        if (!qualifiedBaseline) throw new HarnessFailure('performance-baseline-unverified', 'Performance baseline comparison remains pending until every release preflight succeeds');
        return { schemaVersion: 1, fixtureIdentity: qualifiedBaseline.fixtureIdentity, fixtureCounts: { ...qualifiedBaseline.fixtureCounts }, observations: { ...scaleJourney.measurement }, thresholds: { ...qualifiedBaseline.thresholds }, activityPage: { firstPageCount: 50, secondPageCount: 50, thirdPageCount: 1, unique: true, orderPreserved: true }, search: { missingProjectionRebuilt: releaseState.missingProjectionRebuilt, staleProjectionRebuilt: releaseState.staleProjectionRebuilt, indexedQuery: true } };
      } },
      { id: 'degraded-bridge-grants', run: async () => isolatedResult('degraded-bridge-grants') },
      { id: 'degraded-source-availability', run: async () => {
        const source = await isolatedResult('degraded-source-availability');
        const combined = await isolatedResult('combined-degraded');
        assert.deepEqual({ mode: combined.mode, safeReadObserved: combined.safeReadObserved, mutationRejected: combined.mutationRejected, combinedGrantDenied: combined.combinedGrantDenied }, { mode: 'degraded', safeReadObserved: true, mutationRejected: true, combinedGrantDenied: true });
        return source;
      } },
      { id: 'recovery-only-compatibility', run: async () => {
        const recovery = await isolatedResult('recovery-only-compatibility');
        const [hostVariant, buildVariant, pluginApiVariant, bridgeVariant, bindingVariant] = await Promise.all(['host-tuple-refusal', 'build-variant', 'plugin-api-variant', 'bridge-protocol-variant', 'binding-mismatch'].map(isolatedResult));
        assert.deepEqual({ admissionRejected: hostVariant.admissionRejected, mode: hostVariant.mode, safeReadObserved: hostVariant.safeReadObserved, mutationRejected: hostVariant.mutationRejected }, { admissionRejected: true, mode: 'recovery-only', safeReadObserved: true, mutationRejected: true }, 'the incompatible historical host tuple must fail admission and restored startup must remain recovery-only');
        assert.deepEqual({ mode: buildVariant.mode, safeReadObserved: buildVariant.safeReadObserved, mutationRejected: buildVariant.mutationRejected, restoredStatePreserved: buildVariant.restoredStatePreserved }, { mode: 'recovery-only', safeReadObserved: true, mutationRejected: true, restoredStatePreserved: true });
        for (const variant of [pluginApiVariant, bridgeVariant]) assert.deepEqual({ activationRejected: variant.activationRejected, mutationRejected: variant.mutationRejected, restoredStatePreserved: variant.restoredStatePreserved }, { activationRejected: true, mutationRejected: true, restoredStatePreserved: true });
        assert.equal(bindingVariant.mutationRejected, true);
        return { ...recovery, mismatches: ['host', 'build', 'pluginApi', 'bridgeProtocol', 'binding', 'schema'] };
      } },
      { id: 'destructive-migration-restoration', run: async () => {
        const [restored, database, schema, grant, binding, hostVariant, buildVariant, pluginApiVariant] = await Promise.all(['destructive-migration-restoration', 'foreign-database-restoration', 'recovery-only-compatibility', 'degraded-bridge-grants', 'binding-mismatch', 'host-tuple-refusal', 'build-variant', 'plugin-api-variant'].map(isolatedResult));
        assert.equal(restored.realStartupValidated, true);
        assert.equal(database.mutationRejected, true);
        assert.equal(schema.mutationsRejected, true);
        assert.equal(grant.mutationRejected, true);
        assert.equal(binding.mutationRejected, true);
        assert.deepEqual({ mode: hostVariant.mode, mutationRejected: hostVariant.mutationRejected, restoredStateValidated: hostVariant.restoredStateValidated }, { mode: 'recovery-only', mutationRejected: true, restoredStateValidated: true });
        for (const variant of [buildVariant, pluginApiVariant]) assert.deepEqual({ mutationRejected: variant.mutationRejected, restoredStatePreserved: variant.restoredStatePreserved }, { mutationRejected: true, restoredStatePreserved: true });
        return { schemaVersion: 1, snapshotId: restored.snapshotId, writesBlockedBeforeValidation: restored.writesBlocked, exactIdentityValidated: restored.exactIdentityValidated, postValidationMutation: restored.postValidationMutation, boundaries: { beforeCommit: restored.beforeCommitBytesPreserved, afterCommitBeforeManifest: restored.afterCommitBytesPreserved } };
      } },
      { id: 'privacy-artifact-output', run: async () => {
        if (!privacyEvidence) throw new HarnessFailure('privacy-preflight-pending', 'Privacy evidence remains pending until every release preflight succeeds');
        return privacyEvidence;
      } }
    ], { timeoutMs: 240_000, onProgress: ({ id, phase }) => reportProgress(testContext, `row:${id}:${phase}`) });
    assert.deepEqual(rows.map((row) => row.id), RELEASE_ROW_IDS);
    const finalizationPhases = ['browser-close', 'host-stop', 'browser-traffic', 'host-traffic', 'child-traffic', 'build-digest'].map((phase) => ({ phase, error: finalizationErrors.find((entry) => entry.phase === phase)?.error }));
    let report;
    try { report = createAcceptanceReport({ buildDigest: buildReceipt.digest, rows, finalization: finalizationPhases, performanceBaseline: baseline }); }
    catch (error) { failure ??= error; }
    if (!failure && finalizationErrors.length > 0) failure = finalizationErrors[0].error;
    let reportPassed = false;
    if (!failure) {
      try {
        assertAcceptanceReportPassed(report);
        reportPassed = true;
      }
      catch (error) { failure = error; }
    }
    const diagnosticPayload = {
      ...evidence,
      host: boundedHostEvidence(host.diagnostics),
      finalizationErrors: finalizationErrors.map(({ phase, error }) => ({ phase, error: redactBrowserEvidence(error?.message || error) })),
      acceptanceReport: report,
      failure: failure ? redactBrowserEvidence(failure.message || failure) : undefined
    };
    try { scanPublicEvidence([JSON.stringify(report), JSON.stringify(diagnosticPayload), JSON.stringify(qualifiedBaseline)]); }
    catch (error) { failure ??= error; }
    if (!failure && reportPassed) {
      emittedBaseline = qualifiedBaseline;
      releaseState.baseline = qualifiedBaseline;
      scenarioEvidence.set('performance-baseline-comparison', { checkpointCount: Object.keys(qualifiedBaseline.observations).length, successfulRunOrdinal: qualifiedBaseline.capture.successfulRunOrdinal });
      if (capturePerformanceBaseline) await writeFile(capturedPerformanceBaselinePath, `${JSON.stringify(qualifiedBaseline, null, 2)}\n`, { flag: 'wx' });
    }
    if (failure) {
      failure.diagnostics = { ...(failure.diagnostics || {}), ...diagnosticPayload };
      throw failure;
    }
  }, { candidateRoot: process.cwd() });
  // A diagnostic slice must never emit the canonical complete-release receipt.
  if (acceptancePlan.kind !== 'release') return;
  assert.ok(emittedBaseline, 'a complete release receipt requires the coherently qualified baseline');
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
    buildDigest: buildReceipt.digest,
    performanceBaseline: emittedBaseline
  })}`);
});
