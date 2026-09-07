import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { finalizeAcceptanceJourney } from '../../src/acceptance-finalization.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse } from '../../src/browser-evidence.mjs';
import { assertBuiltDigest } from '../../src/build.mjs';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, fetchJsonWithDeadline, launchPinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { TrafficGuard } from '../../src/isolation.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../../src/metadata/path.mjs';
import { COMMAND_CENTER_SCHEMA_VERSION, metadataSchemaV1Sql } from '../../src/metadata/schema.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { expectedRollbackRelease } from '../../src/metadata/recovery.mjs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { scanPublicEvidence } from '../../src/safety.mjs';
import { withDeadline, stopHostOnAbort, launchManagedBrowser, closeManagedBrowser, boundedHostEvidence, configureEvidencePage, requestAuthenticatedGateway, readAuthenticatedHistory } from './real-host-runtime.mjs';
import { seedNativeExistingTopic } from './first-live-native-journey.mjs';

// These capabilities qualify the metadata migration owner in isolation. They
// do not enable deferred product services in the launched native application.
const READY_CAPABILITIES = Object.freeze(Object.fromEntries(['notes', 'sessions', 'scheduler', 'activity', 'analysis', 'attention', 'search'].map((name) => [name, true])));

export async function prepareNativeRestoredRuntimeState(stateDir, topicId) {
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

export async function exerciseNativeRestorationMatrix({ stateDir, descriptor, buildReceipt, world, signal, onFinalization }) {
  assert.equal(path.resolve(stateDir), path.resolve(world.root, '.openclaw'), 'Restoration state must belong to the issued fictional world');
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

  const runtime = await exerciseNativeRestoredSurface({ world, descriptor, buildReceipt, signal, recoveryOnly: false, onFinalization });
  return Object.freeze({ ...result, ...runtime, realStartupValidated: true });
}

// This fixture deliberately mutates only its issued synthetic database. The
// byte/artifact assertions run after the real host and browser have stopped.
export async function exerciseNativeRecoveryOnlyHostVariant({ descriptor, buildReceipt, signal, onFinalization }) {
  return withIsolatedWorld(async (world) => {
    const stateDir = path.join(world.root, '.openclaw');
    const databasePath = await prepareNativeRestoredRuntimeState(stateDir, 'fictional-restored-schema-topic');
    const future = new DatabaseSync(databasePath);
    try { future.exec('CREATE TABLE fictional_future_marker (id TEXT) STRICT; PRAGMA user_version = 99;'); }
    finally { future.close(); }
    const recoveryDirectory = resolveCommandCenterRecoveryMigrationPath(stateDir);
    const before = {
      database: await readFile(databasePath),
      snapshot: await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')),
      manifest: await readFile(path.join(recoveryDirectory, 'manifest.json')),
      artifacts: (await readdir(recoveryDirectory)).sort(),
      sidecars: (await readdir(path.dirname(databasePath))).filter(name => name.startsWith(`${path.basename(databasePath)}-`)).sort()
    };
    const runtime = await exerciseNativeRestoredSurface({ world, descriptor, buildReceipt, signal, recoveryOnly: true, onFinalization });
    assert.deepEqual(await readFile(databasePath), before.database, 'Recovery-only host must preserve exact future-schema database bytes');
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'metadata.sqlite.snapshot')), before.snapshot);
    assert.deepEqual(await readFile(path.join(recoveryDirectory, 'manifest.json')), before.manifest);
    assert.deepEqual((await readdir(recoveryDirectory)).sort(), before.artifacts);
    assert.deepEqual((await readdir(path.dirname(databasePath))).filter(name => name.startsWith(`${path.basename(databasePath)}-`)).sort(), before.sidecars);
    const readonly = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(readonly.prepare('PRAGMA user_version').get().user_version, 99); }
    finally { readonly.close(); }
    return Object.freeze({ schemaVersion: 1, mode: 'recovery-only', ...runtime, futureSchemaBytesPreserved: true, recoveryArtifactsPreserved: true, mismatches: ['schema'] });
  }, { candidateRoot: process.cwd() });
}

async function exerciseNativeRestoredSurface({ world, descriptor, buildReceipt, signal, recoveryOnly, onFinalization }) {
  const guard = new TrafficGuard();
  const evidence = { requests: [], responses: [], console: [], errors: [] };
  let host;
  let managedBrowser;
  let removeAbortCleanup = () => {};
  const abortBrowser = () => { void managedBrowser?.server.kill().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  let failure;
  let result;
  try {
    host = await withDeadline('native restoration host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    removeAbortCleanup = stopHostOnAbort(signal, host);
    let catalog;
    await waitForConsecutiveReadiness(async () => {
      const response = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'native restoration bootstrap', timeoutMs: 10_000 });
      return response.response.ok;
    }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
    catalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
    const plugins = catalog?.plugins?.filter(plugin => plugin.pluginId === 'command-center') ?? [];
    assert.equal(plugins.length, 1, 'The actual host must expose one native Command Center contribution');
    const native = plugins[0];
    assert.match(native.revision, /^[a-f0-9]{64}$/u);
    const grantPrefix = '/__openclaw__/plugins/control-ui/command-center/';
    const entryUrl = new URL(native.entryUrl, world.gateway.url);
    assert.equal(entryUrl.origin, new URL(world.gateway.url).origin);
    assert.equal(entryUrl.pathname, `${grantPrefix}${native.revision}/entry.mjs`);
    assert.equal(entryUrl.search, '');
    assert.equal(entryUrl.hash, '');
    const bootstrap = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'native restoration grants', timeoutMs: 10_000 });
    assert.equal(bootstrap.response.ok, true);
    assert.equal(bootstrap.parseError, undefined);
    assert.equal(bootstrap.body?.pluginAssetsRequireAuth, true);
    assert.equal(bootstrap.body?.pluginFrameGrants?.some(grant => grant.pluginId === 'command-center' && grant.match === 'prefix' && grant.path === grantPrefix), true);
    assert.equal(JSON.stringify(bootstrap.body).includes(world.gatewayCredential), false);
    const statusResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.sources.status', params: { schemaVersion: 1 }, signal });
    const status = statusResponse?.result ?? statusResponse;
    if (recoveryOnly) {
      assert.equal(status.mode, 'recovery-only');
      assert.ok(status.diagnostics.some(entry => entry?.code === 'future-schema'));
    } else {
      // First-live intentionally disables optional capabilities. Their degraded
      // status must not masquerade as either core failure or full readiness.
      assert.ok(['ready', 'degraded'].includes(status.mode));
      assert.equal(status.metadataSchemaVersion, COMMAND_CENTER_SCHEMA_VERSION);
      assert.equal(status.unavailableCapabilities.some(name => ['notes', 'sessions'].includes(name)), false);
    }
    const fixture = recoveryOnly ? null : await seedNativeExistingTopic({ world, host, signal });
    const topicsResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
    const topics = topicsResponse?.result ?? topicsResponse;
    assert.ok(topics?.activeGroups && Array.isArray(topics.activeGroups.project), 'The real source owner must supply a safe Topics response');
    managedBrowser = await withDeadline('native restoration browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }), 60_000, signal);
    const page = await managedBrowser.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await configureEvidencePage(page, guard, evidence);
    const entryResponse = observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'GET' && response.url() === entryUrl.href, { timeout: 60_000 }));
    await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const loadedEntry = await entryResponse;
    assert.equal(hasSuccessfulBrowserResponse(loadedEntry), true);
    assert.deepEqual(await loadedEntry.value.body(), await readFile(path.join(process.cwd(), 'dist/native-ui/entry.mjs')));
    const nativePage = page.locator('openclaw-plugin-page');
    await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await nativePage.locator('iframe').count(), 0, 'Restoration must use the native loader, not an obsolete frame');
    if (recoveryOnly) {
      // An empty Topics list is NOT visible recovery evidence. This assertion is
      // deliberately unmet until the native UI exposes the real operating mode.
      await nativePage.getByRole('status').filter({ hasText: /Recovery-only/iu }).first().waitFor({ timeout: 30_000 });
      assert.equal(await nativePage.getByRole('button', { name: 'Create Conversation', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Create Topic', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      const blockedId = randomUUID();
      const refused = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
        body: JSON.stringify({ schemaVersion: 1, action: 'conversations.create', topicId: '44444444-4444-4444-8444-444444444444', expectedRevision: 0, logicalOperationId: blockedId, label: 'Fictional refused recovery Conversation' })
      }, { label: 'native recovery-only retained write refusal', timeoutMs: 30_000 });
      assert.equal(refused.parseError, undefined);
      assert.equal(refused.response.ok, false);
      assert.equal(refused.body?.code, 'recovery-only', 'A retained write must be refused by recovery admission, not merely by the deferred-feature gate');
      result = { safeReadObserved: true, mutationsRejected: true, mountedUiObserved: true, unsupportedControlsAbsent: true };
    } else {
      const matching = topics.activeGroups.project.filter(topic => topic.topicId === fixture.topicId);
      assert.equal(matching.length, 1);
      assert.equal(matching[0].usable, true);
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      const content = nativePage.getByRole('region', { name: 'Note content', exact: true });
      await content.filter({ hasText: fixture.noteText.trim() }).waitFor();
      assert.equal(await content.textContent(), fixture.noteText);
      assert.equal(await readFile(path.join(fixture.folder, fixture.notePath), 'utf8'), fixture.noteText);
      assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      const label = 'Fictional restored Conversation';
      const creationResponse = observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/plugins/command-center/api/topic/actions'
        && response.request().postDataJSON()?.action === 'conversations.create', { timeout: 30_000 }));
      await nativePage.getByRole('textbox', { name: 'Conversation label', exact: true }).fill(label);
      await nativePage.getByRole('button', { name: 'Create Conversation', exact: true }).press('Enter');
      const observed = await creationResponse;
      assert.equal(hasSuccessfulBrowserResponse(observed), true);
      assert.equal(observed.value.request().headers()['x-openclaw-control-ui-relay'], '1');
      const input = observed.value.request().postDataJSON();
      assert.deepEqual(Object.keys(input).sort(), ['action', 'expectedRevision', 'label', 'logicalOperationId', 'schemaVersion', 'topicId']);
      assert.equal(input.topicId, fixture.topicId);
      assert.equal(input.label, label);
      const receipt = await observed.value.json();
      assert.equal(receipt.status, 'applied');
      assert.equal(receipt.logicalOperationId, input.logicalOperationId);
      assert.equal(receipt.result?.action, 'conversations.create');
      assert.equal(receipt.result.topicId, fixture.topicId);
      assert.equal(typeof receipt.result.referenceId, 'string');
      assert.notEqual(receipt.result.referenceId, fixture.sessionReferenceId);
      const conversationsResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false }, signal });
      const conversations = conversationsResponse?.result ?? conversationsResponse;
      assert.equal(conversations.topicId, fixture.topicId);
      assert.equal(conversations.conversations.length, 2);
      assert.equal(conversations.conversations.find(row => row.isPrimary)?.referenceId, fixture.sessionReferenceId);
      const created = conversations.conversations.filter(row => row.referenceId === receipt.result.referenceId);
      assert.equal(created.length, 1);
      assert.equal(created[0].isPrimary, false);
      assert.equal(created[0].status, 'open');
      assert.notEqual(created[0].sessionId, fixture.sessionId);
      const navigationResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.sessions.navigate', params: { schemaVersion: 1, topicId: fixture.topicId, referenceId: receipt.result.referenceId, nativeChat: true }, signal });
      const navigation = navigationResponse?.result ?? navigationResponse;
      assert.equal(navigation.sourceReference.referenceId, receipt.result.referenceId);
      assert.equal(navigation.sourceReference.topicId, fixture.topicId);
      assert.equal(navigation.sessionId, created[0].sessionId);
      const historyResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: navigation.sessionKey, signal });
      const history = historyResponse?.result ?? historyResponse;
      assert.equal(history.sessionKey, navigation.sessionKey);
      assert.equal(history.sessionId, created[0].sessionId);
      await page.locator('openclaw-chat-pane[aria-hidden="false"]').waitFor({ timeout: 30_000 });
      await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, navigation.sessionKey);
      result = { existingTopicVerified: true, authoritativeNoteRead: true, readOnlyNotesObserved: true, retainedConversationCreation: true, exactNativeChatHandoff: true };
    }
    let activation;
    await waitForConsecutiveReadiness(async () => {
      const report = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.status', params: { pluginId: 'command-center' }, scopes: ['operator.admin'], signal });
      activation = report?.clients?.flatMap(client => client.activations ?? []).find(entry => entry.pluginId === 'command-center' && entry.revision === native.revision && entry.status === 'activated');
      return !!activation;
    }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
    result = { ...result, nativeActivationObserved: true, revision: native.revision };
  } catch (error) { failure = error; }
  finally {
    const cleanup = await finalizeAcceptanceJourney({
      closeBrowser: cleanupSignal => closeManagedBrowser(managedBrowser, cleanupSignal),
      stopHost: async () => { if (host) { await stopPinnedHost(host.child); await host.outputDrained; } },
      assertBrowserTraffic: () => guard.assertClean(),
      assertHostTraffic: () => { if (host) { host.diagnostics.guard.assertClean(); assertNoFatalHostOutput(host.diagnostics); if (host.diagnostics.cleanupError) throw host.diagnostics.cleanupError; } },
      assertChildTraffic: () => assertRecordedChildTraffic(world),
      assertBuildDigest: () => assertBuiltDigest(buildReceipt),
      onProgress: onFinalization
    });
    removeAbortCleanup();
    signal?.removeEventListener('abort', abortBrowser);
    if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map(entry => entry.error)], 'Native restoration finalization failed');
  }
  scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(host ? boundedHostEvidence(host.diagnostics) : {})]);
  if (failure) throw failure;
  return result;
}
