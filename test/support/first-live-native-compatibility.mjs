import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { finalizeAcceptanceJourney } from '../../src/acceptance-finalization.mjs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, recordBounded } from '../../src/browser-evidence.mjs';
import { assertBuiltDigest } from '../../src/build.mjs';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { HarnessFailure, assertNoFatalHostOutput, assertRecordedChildTraffic, fetchJsonWithDeadline, launchPinnedHost, parseHostDescriptor, pinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { TrafficGuard } from '../../src/isolation.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterRecoveryMigrationPath } from '../../src/metadata/path.mjs';
import { readRecoveryMaterial, verifyRollbackMaterial } from '../../src/metadata/recovery.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { scanPublicEvidence } from '../../src/safety.mjs';
import { prepareNativeRestoredRuntimeState } from './first-live-native-restoration.mjs';
import { boundedHostEvidence, closeManagedBrowser, configureEvidencePage, launchManagedBrowser, redactBrowserEvidence, requestAuthenticatedGateway, stopHostOnAbort, withDeadline } from './real-host-runtime.mjs';

const actionPath = '/plugins/command-center/api/topic/actions';
const unwrap = response => response?.result ?? response;

// Exact file evidence is read only while the owning host is stopped. These
// tiny fictional stores retain the pre-existing migration byte-proof seam.
async function recoveryBytes(stateDir) {
  const databasePath = resolveCommandCenterDatabasePath(stateDir);
  const directory = resolveCommandCenterRecoveryMigrationPath(stateDir);
  return {
    database: await readFile(databasePath),
    snapshot: await readFile(path.join(directory, 'metadata.sqlite.snapshot')),
    manifest: await readFile(path.join(directory, 'manifest.json')),
    artifacts: (await readdir(directory)).sort(),
    sidecars: (await readdir(path.dirname(databasePath))).filter(name => name.startsWith(`${path.basename(databasePath)}-`)).sort(),
    identities: await Promise.all([databasePath, path.join(directory, 'metadata.sqlite.snapshot'), path.join(directory, 'manifest.json')].map(async file => {
      const stat = await lstat(file, { bigint: true });
      assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
      return Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs', 'size'].map(key => [key, String(stat[key])]));
    }))
  };
}

export async function exerciseNativeBindingMismatchHostVariant({ descriptor, buildReceipt, signal, onFinalization }) {
  return withIsolatedWorld(async world => {
    const stateDir = path.join(world.root, '.openclaw');
    await prepareNativeRestoredRuntimeState(stateDir, 'fictional-restored-binding-anchor');
    // A canonical Topic UUID lets the retained HTTP command reach its actual
    // recovery owner instead of failing syntactic validation or a feature gate.
    const topicId = '55555555-5555-4555-8555-555555555555';
    const name = 'Fictional binding mismatch Topic';
    const referenceId = 'fictional-binding-mismatch-folder';
    const originalFolder = path.join(world.paths.vault, 'elsewhere');
    const expectedFolder = path.join(world.paths.vault, 'expected');
    let originalTopic;
    let originalReference;
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    try {
      metadata.createTopic({ topicId, name, paraCategory: 'project', lifecycle: 'active' });
      metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: originalFolder, observedRevision: null });
      originalTopic = metadata.getTopic(topicId);
      originalReference = metadata.getSourceReference(referenceId);
    } finally { metadata.close(); }
    const sourceExport = JSON.parse(await readFile(new URL('../fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
    const channelId = 'fictional-binding-mismatch-channel';
    sourceExport.channels[0].channelId = channelId;
    const exportPath = path.join(world.tempRoot, 'binding-mismatch-export.json');
    const exportBytes = `${JSON.stringify(sourceExport)}\n`;
    await writeFile(exportPath, exportBytes);
    await mkdir(expectedFolder, { recursive: true });
    const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    config.plugins.entries['command-center'].config.legacyDiscordMigration = { schemaVersion: 1, exportPath, channels: [{ channelId, topicId, paraCategory: 'project', noteFolderPath: expectedFolder }] };
    await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
    const before = await recoveryBytes(stateDir);
    const blockedOperationId = randomUUID();
    const runtime = await exerciseNativeCompatibilitySurface({ world, descriptor, buildReceipt, signal, kind: 'binding', topicId, name,
      expectedRevision: originalTopic.revision, logicalOperationId: blockedOperationId, channelId, onFinalization });
    // Bootstrap may record its failure, but must not rebind/adopt this Topic or
    // create a Session under the conflicting migration's proposed ownership.
    const after = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
    try {
      assert.deepEqual(after.getTopic(topicId), originalTopic);
      assert.deepEqual(after.getSourceReference(referenceId), originalReference);
      assert.deepEqual(after.listSourceReferences(topicId), [originalReference]);
      assert.equal(after.getSourceLocator(referenceId), null);
      assert.equal(after.getOperation(blockedOperationId), null);
      assert.equal(after.listTopicOperations(topicId).some(operation => operation.logicalOperationId === blockedOperationId), false);
      assert.equal(after.getMigrationCompletion(), null);
      assert.equal(after.getMigrationState().failureCode, 'topic-conflict');
    } finally { after.close(); }
    const preserved = await recoveryBytes(stateDir);
    assert.deepEqual(preserved.snapshot, before.snapshot);
    assert.deepEqual(preserved.manifest, before.manifest);
    assert.deepEqual(preserved.artifacts, before.artifacts);
    assert.deepEqual(preserved.sidecars, before.sidecars);
    assert.equal(await readFile(exportPath, 'utf8'), exportBytes);
    assert.deepEqual(await readdir(expectedFolder), [], 'Refused binding must not enroll or populate the proposed Note Folder');
    await assert.rejects(lstat(originalFolder), error => error?.code === 'ENOENT');
    return Object.freeze({ kind: 'binding', ...runtime, bindingObserved: true, bindingPreserved: true, recoveryArtifactsPreserved: true });
  }, { candidateRoot: process.cwd() });
}

export async function exerciseNativeForeignDatabaseRestorationVariant({ descriptor, buildReceipt, signal, onFinalization }) {
  return withIsolatedWorld(async world => {
    const stateDir = path.join(world.root, '.openclaw');
    const topicId = '66666666-6666-4666-8666-666666666666';
    const foreignTopicId = '77777777-7777-4777-8777-777777777777';
    const databasePath = await prepareNativeRestoredRuntimeState(stateDir, topicId);
    const foreignState = path.join(world.tempRoot, 'foreign-state');
    const foreignDatabase = await prepareNativeRestoredRuntimeState(foreignState, foreignTopicId);
    const localMaterial = readRecoveryMaterial(stateDir);
    const foreignMaterial = readRecoveryMaterial(foreignState);
    assert.notEqual(localMaterial.manifest.snapshotId, foreignMaterial.manifest.snapshotId, 'Foreign material must have a different actual source-data identity');
    const foreignProof = { snapshotId: foreignMaterial.manifest.snapshotId, priorRelease: foreignMaterial.manifest.sourceRelease };
    assert.equal(verifyRollbackMaterial(foreignState, foreignProof, foreignDatabase).verified, true, 'The foreign snapshot is valid for its own database, not corrupted evidence');
    const original = await recoveryBytes(stateDir);
    const foreign = await recoveryBytes(foreignState);
    const readonly = new DatabaseSync(databasePath, { readOnly: true });
    let originalTopics;
    let expectedRevision;
    try {
      originalTopics = readonly.prepare('SELECT * FROM topics ORDER BY topic_id').all();
      assert.equal(originalTopics.length, 1);
      assert.equal(originalTopics[0].topic_id, topicId);
      expectedRevision = originalTopics[0].revision;
    } finally { readonly.close(); }
    // Same existing foreign-restoration scenario: replace only the retained
    // recovery material, never the local current database or its ledger.
    await cp(resolveCommandCenterRecoveryMigrationPath(foreignState), resolveCommandCenterRecoveryMigrationPath(stateDir), { recursive: true, force: true });
    const substituted = await recoveryBytes(stateDir);
    assert.deepEqual(substituted.database, original.database);
    assert.deepEqual(substituted.snapshot, foreign.snapshot);
    assert.deepEqual(substituted.manifest, foreign.manifest);
    assert.equal(readRecoveryMaterial(stateDir).manifest.snapshotId, foreignMaterial.manifest.snapshotId);
    assert.throws(() => verifyRollbackMaterial(stateDir, foreignProof, databasePath), error => error?.code === 'rollback-database-mismatch',
      'A valid copied snapshot must not authorize recovery of another database');
    const runtime = await exerciseNativeCompatibilitySurface({ world, descriptor, buildReceipt, signal, kind: 'database-identity', topicId,
      expectedRevision, logicalOperationId: randomUUID(), onFinalization });
    assert.deepEqual(await recoveryBytes(stateDir), substituted, 'Recovery-only startup, native reads and refused creation must preserve every local database/recovery byte and artifact');
    assert.deepEqual(await recoveryBytes(foreignState), foreign, 'The foreign source store must remain untouched');
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(preserved.prepare('SELECT * FROM topics ORDER BY topic_id').all(), originalTopics);
      assert.equal(preserved.prepare('SELECT topic_id FROM topics WHERE topic_id = ?').get(foreignTopicId), undefined);
    } finally { preserved.close(); }
    assert.throws(() => verifyRollbackMaterial(stateDir, foreignProof, databasePath), error => error?.code === 'rollback-database-mismatch');
    return Object.freeze({ kind: 'database-identity', ...runtime, restoredStateValidated: true, foreignOwnershipRefused: true, databaseBytesPreserved: true, recoveryArtifactsPreserved: true });
  }, { candidateRoot: process.cwd() });
}

/** Corrupt one actually enforced recovery contract, never a removed iframe declaration. */
export async function prepareNativeReleaseMismatchState(stateDir, kind, topicId) {
  assert.ok(['host', 'build', 'bridge-protocol'].includes(kind));
  await prepareNativeRestoredRuntimeState(stateDir, topicId);
  const original = readRecoveryMaterial(stateDir);
  const manifest = structuredClone(original.manifest);
  if (kind === 'host') manifest.targetRelease.host = { ...manifest.targetRelease.host, commit: '0'.repeat(40) };
  else if (kind === 'build') manifest.targetRelease.package.build = `${manifest.targetRelease.package.build}-fictional-mismatch`;
  else {
    const protocol = manifest.targetRelease.capabilityBridgeProtocol;
    assert.ok(Number.isSafeInteger(protocol?.max));
    manifest.targetRelease.capabilityBridgeProtocol = { min: protocol.max + 1, max: protocol.max + 1 };
  }
  assert.notDeepEqual(manifest.targetRelease, original.manifest.targetRelease);
  await writeFile(path.join(resolveCommandCenterRecoveryMigrationPath(stateDir), 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  assert.throws(() => readRecoveryMaterial(stateDir), error => error?.code === 'recovery-manifest-invalid', 'The current recovery owner must enforce the altered release contract');
  return recoveryBytes(stateDir);
}

export async function exerciseNativeReleaseMismatchVariant({ descriptor, buildReceipt, signal, kind, onFinalization }) {
  assert.ok(['host', 'build', 'bridge-protocol'].includes(kind));
  return withIsolatedWorld(async world => {
    const stateDir = path.join(world.root, '.openclaw');
    const topicId = '88888888-8888-4888-8888-888888888888';
    const before = await prepareNativeReleaseMismatchState(stateDir, kind, topicId);
    if (kind === 'host') {
      assert.throws(() => parseHostDescriptor(JSON.stringify({ ...descriptor, commit: '0'.repeat(40) })), error => error?.category === 'invalid-commit');
      const incompatibleDescriptor = { ...descriptor, integrity: { ...descriptor.integrity, sourceDigest: `sha256:${'0'.repeat(64)}` } };
      await assert.rejects(() => launchPinnedHost({ descriptor: incompatibleDescriptor, world, buildReceipt, signal }), error => error?.category === 'host-integrity');
      assert.deepEqual(await recoveryBytes(stateDir), before, 'Rejected host integrity must not reach the existing restored store');
    }
    const runtime = await exerciseNativeCompatibilitySurface({ world, descriptor, buildReceipt, signal, kind, topicId,
      expectedRevision: 0, logicalOperationId: randomUUID(), onFinalization });
    assert.deepEqual(await recoveryBytes(stateDir), before, 'Native recovery-only startup and refused retained creation must preserve the exact altered store');
    return Object.freeze({ kind, ...runtime, restoredStatePreserved: true, recoveryArtifactsPreserved: true, compatibilityRefusalObserved: true });
  }, { candidateRoot: process.cwd() });
}

export async function exerciseNativePluginApiMismatchVariant({ descriptor, buildReceipt, signal, onFinalization }) {
  return withIsolatedWorld(async world => {
    const stateDir = path.join(world.root, '.openclaw');
    const topicId = '99999999-9999-4999-8999-999999999999';
    await prepareNativeRestoredRuntimeState(stateDir, topicId);
    const before = await recoveryBytes(stateDir);
    await assertBuiltDigest(buildReceipt);
    const candidateRoot = path.join(world.tempRoot, 'candidate-plugin-api');
    await mkdir(candidateRoot);
    for (const name of ['package.json', 'openclaw.plugin.json', 'dist']) await cp(path.join(process.cwd(), name), path.join(candidateRoot, name), { recursive: true, verbatimSymlinks: true });
    const packagePath = path.join(candidateRoot, 'package.json');
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    const requiredPluginApi = '=1900.1.1';
    manifest.openclaw.compat.pluginApi = requiredPluginApi;
    await writeFile(packagePath, `${JSON.stringify(manifest)}\n`);
    const hostPackage = JSON.parse(await readFile(path.join(descriptor.checkout, 'package.json'), 'utf8'));
    assert.equal(hostPackage.name, 'openclaw');
    assert.equal(hostPackage.version, pinnedHost.packageVersion, 'API refusal evidence must name the same host version verified by launch');
    const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    config.plugins.load.paths = [candidateRoot];
    await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
    const runtime = await exerciseNativeCompatibilitySurface({ world, descriptor, buildReceipt, signal, kind: 'plugin-api', topicId,
      expectedRevision: 0, logicalOperationId: randomUUID(), requiredPluginApi, hostVersion: hostPackage.version, onFinalization });
    assert.deepEqual(await recoveryBytes(stateDir), before, 'Skipped plugin activation must not open or migrate its restored store');
    assert.equal(JSON.parse(await readFile(packagePath, 'utf8')).openclaw.compat.pluginApi, requiredPluginApi);
    return Object.freeze({ kind: 'plugin-api', ...runtime, restoredStatePreserved: true, recoveryArtifactsPreserved: true });
  }, { candidateRoot: process.cwd() });
}

async function nativeSessionIdentities(gatewayRead) {
  const response = await gatewayRead('sessions.list', { agentId: 'main', limit: 100, offset: 0, includeGlobal: true, includeUnknown: true, archived: 'all' });
  assert.ok(Array.isArray(response.sessions)); assert.equal(response.hasMore, false); assert.equal(response.totalCount, response.sessions.length);
  return response.sessions.map(({ key, sessionId }) => ({ key, sessionId })).sort((left, right) => left.key.localeCompare(right.key));
}

async function observeNativePluginApiRefusal({ world, host, signal, topicId, expectedRevision, logicalOperationId, requiredPluginApi, hostVersion, gatewayRead, openPage }) {
  const refusalMessage = `plugin requires plugin API ${requiredPluginApi}, but this host is ${hostVersion}; skipping `;
  // Rejection may end the Gateway or leave it alive without this plugin. The
  // exact loader diagnostic is mandatory before either outcome is accepted.
  await withDeadline('native plugin API compatibility refusal', async probeSignal => {
    while (!['discovery', 'load'].some(phase => `${host.diagnostics.stdout}\n${host.diagnostics.stderr}`.includes(`${refusalMessage}${phase}`))) {
      probeSignal.throwIfAborted(); signal?.throwIfAborted();
      if (host.child.exitCode !== null || host.child.signalCode !== null) throw new Error('Host exited without the expected plugin API refusal');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }, 30_000, signal);
  const exited = new HarnessFailure('plugin-api-host-exit', 'The incompatible plugin prevented Gateway startup');
  const processExit = host.child.exitCode !== null || host.child.signalCode !== null
    ? Promise.resolve(exited) : new Promise(resolve => host.child.once('exit', () => resolve(exited)));
  let bootstrap;
  let startupRejected = false;
  try {
    await waitForConsecutiveReadiness(async probeSignal => {
      bootstrap = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, {
        headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal: probeSignal
      }, { label: 'Gateway after plugin API refusal', timeoutMs: 10_000 });
      return bootstrap.response.ok;
    }, processExit, { deadlineMs: 30_000, delayMs: 100, signal });
  } catch (error) {
    if (error?.category !== 'plugin-api-host-exit') throw error;
    startupRejected = true;
  }
  const attempt = () => fetchJsonWithDeadline(`${world.gateway.url}${actionPath}`, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
    body: JSON.stringify({ schemaVersion: 1, action: 'conversations.create', topicId, expectedRevision, logicalOperationId, label: 'Fictional refused API Conversation' })
  }, { label: 'incompatible native plugin retained creation refusal', timeoutMs: 10_000 });
  if (startupRejected) {
    assert.ok(host.child.exitCode !== null || host.child.signalCode !== null);
    assert.notEqual(host.child.exitCode, 0);
    await assert.rejects(attempt, error => (error?.cause?.code ?? error?.code) === 'ECONNREFUSED');
    return { activationRejected: true, mutationRejected: true, startupRejected: true, hostStoppedObserved: true, mountedUiObserved: false };
  }
  assert.equal(bootstrap.parseError, undefined);
  assert.equal(bootstrap.body.pluginFrameGrants?.some(grant => grant.pluginId === 'command-center') ?? false, false);
  const catalog = await gatewayRead('plugins.controlUi.list', {});
  assert.ok(Array.isArray(catalog.plugins));
  assert.equal(catalog.plugins.some(plugin => plugin.pluginId === 'command-center'), false);
  const sessions = await nativeSessionIdentities(gatewayRead);
  const refused = await attempt();
  assert.equal(refused.parseError, undefined);
  assert.equal(refused.response.status, 401, 'An unloaded plugin has no declared relay authority even with valid operator credentials');
  assert.deepEqual(await nativeSessionIdentities(gatewayRead), sessions);
  const page = await openPage();
  await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const nativePage = page.locator('openclaw-plugin-page');
  await nativePage.getByRole('status').filter({ hasText: 'Plugin panel unavailable' }).waitFor({ timeout: 30_000 });
  assert.equal(await nativePage.locator('iframe').count(), 0);
  for (const control of ['Create Conversation', 'Create Topic', 'Save Note']) assert.equal(await nativePage.getByRole('button', { name: control, exact: true }).count(), 0);
  const report = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.status', params: { pluginId: 'command-center' }, scopes: ['operator.admin'], signal });
  assert.equal(report?.clients?.flatMap(client => client.activations ?? []).some(entry => entry.pluginId === 'command-center' && entry.status === 'activated') ?? false, false);
  return { activationRejected: true, mutationRejected: true, startupRejected: false, nativeUnavailableObserved: true, mountedUiObserved: false, unsupportedControlsAbsent: true };
}

// Refusal variants share one native surface owner, not a copied Gateway or
// browser implementation. All transport/lifetime primitives remain shared.
async function exerciseNativeCompatibilitySurface({ world, descriptor, buildReceipt, signal, kind, topicId, name, expectedRevision, logicalOperationId, channelId, requiredPluginApi, hostVersion, onFinalization }) {
  const guard = new TrafficGuard();
  const evidence = { requests: [], responses: [], console: [], errors: [] };
  let host;
  let managedBrowser;
  let removeAbortCleanup = () => {};
  const abortBrowser = () => { void managedBrowser?.server.kill().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  let failure;
  let result;
  let expectedAdmissionFailure = false;
  const openPage = async () => {
    managedBrowser = await withDeadline('native compatibility browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }), 60_000, signal);
    const page = await managedBrowser.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await configureEvidencePage(page, guard, evidence);
    return page;
  };
  try {
    host = await withDeadline('native compatibility host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    removeAbortCleanup = stopHostOnAbort(signal, host);
    const gatewayRead = async (method, params = { schemaVersion: 1 }) => unwrap(await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method, params, signal }));
    if (kind === 'plugin-api') {
      result = await observeNativePluginApiRefusal({ world, host, signal, topicId, expectedRevision, logicalOperationId, requiredPluginApi, hostVersion, gatewayRead, openPage });
      expectedAdmissionFailure = host.diagnostics.category === 'plugin-not-found';
    } else {
    let catalog;
    await waitForConsecutiveReadiness(async () => {
      try {
        catalog = await gatewayRead('plugins.controlUi.list', {});
        return catalog?.plugins?.some(plugin => plugin.pluginId === 'command-center');
      } catch (error) { signal?.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
    }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
    const plugins = catalog.plugins.filter(plugin => plugin.pluginId === 'command-center');
    assert.equal(plugins.length, 1);
    const native = plugins[0];
    assert.match(native.revision, /^[a-f0-9]{64}$/u);
    const grantPrefix = '/__openclaw__/plugins/control-ui/command-center/';
    const entryUrl = new URL(native.entryUrl, world.gateway.url);
    assert.equal(entryUrl.origin, new URL(world.gateway.url).origin);
    assert.equal(entryUrl.pathname, `${grantPrefix}${native.revision}/entry.mjs`);
    assert.equal(entryUrl.search, ''); assert.equal(entryUrl.hash, '');
    const bootstrap = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'native compatibility authenticated bootstrap', timeoutMs: 10_000 });
    assert.equal(bootstrap.response.ok, true); assert.equal(bootstrap.parseError, undefined);
    assert.equal(bootstrap.body?.pluginAssetsRequireAuth, true);
    assert.equal(bootstrap.body?.pluginFrameGrants?.some(grant => grant.pluginId === 'command-center' && grant.match === 'prefix' && grant.path === grantPrefix), true);
    assert.equal(JSON.stringify(bootstrap.body).includes(world.gatewayCredential), false);
    const status = await gatewayRead('command-center.v1.sources.status');
    const topics = await gatewayRead('command-center.v1.topics.list');
    assert.ok(topics?.activeGroups && Array.isArray(topics.recovery));
    if (kind === 'binding') {
      assert.equal(status.mode, 'degraded');
      assert.equal(Object.values(topics.activeGroups).flat().some(topic => topic.topicId === topicId), false);
      const quarantined = topics.recovery.filter(topic => topic.topicId === topicId);
      assert.equal(quarantined.length, 1); assert.equal(quarantined[0].usable, false);
      assert.equal(quarantined[0].name, name);
      assert.ok(quarantined[0].recovery.some(item => item.state === 'required'));
      const migration = await gatewayRead('command-center.v1.migration.status');
      assert.equal(migration.complete, false); assert.equal(migration.phase, 'review');
      assert.ok(migration.failures.some(item => item.failureCode === 'topic-conflict'), 'This must be the original binding refusal, not an unrelated migration failure');
      assert.equal(migration.actions.some(action => action.method === 'command-center.v1.migration.resume'), false);
    } else {
      assert.equal(status.mode, 'recovery-only');
      const expectedDiagnostic = kind === 'database-identity' ? 'recovery-ledger-mismatch' : 'recovery-manifest-invalid';
      assert.ok(status.diagnostics.some(item => item.code === expectedDiagnostic), 'The selected recovery contract must be the actual admission failure');
      assert.deepEqual(topics.activeGroups, { project: [], area: [], resource: [] });
      assert.deepEqual(topics.recovery, []);
    }
    const page = await openPage();
    const entryResponse = observeBrowserResponse(page.waitForResponse(response => response.request().method() === 'GET' && response.url() === entryUrl.href, { timeout: 60_000 }));
    await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const entry = await entryResponse;
    assert.equal(hasSuccessfulBrowserResponse(entry), true, 'The real host loader must mount the granted native entry despite refused mutations');
    assert.deepEqual(await entry.value.body(), await readFile(path.join(process.cwd(), 'dist/native-ui/entry.mjs')));
    const nativePage = page.locator('openclaw-plugin-page');
    await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await nativePage.locator('iframe').count(), 0);
    await nativePage.getByRole('status').filter({ hasText: kind === 'binding' ? /Degraded ·/u : /Recovery-only ·/u }).waitFor({ timeout: 30_000 });
    for (const control of ['Create Topic', 'Create Conversation', 'Save Note', 'Verify exact source', 'Rename', 'Archive']) {
      assert.equal(await nativePage.getByRole('button', { name: control, exact: true }).count(), 0, `Recovery must not advertise ${control}`);
    }
    if (kind === 'binding') {
      await nativePage.getByRole('heading', { name: 'Source Recovery', exact: true }).waitFor();
      const row = nativePage.getByRole('listitem').filter({ hasText: `${name} — Source Recovery required.` });
      await row.waitFor(); assert.equal(await row.count(), 1);
      assert.equal(await row.locator('button, a, input, select, textarea').count(), 0, 'Quarantined Topic is passive until an approved recovery surface exists');
      assert.equal(await nativePage.getByRole('button', { name: `Open ${name} in Chat`, exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: `View Notes for ${name}`, exact: true }).count(), 0);
    } else {
      assert.equal(await nativePage.getByRole('status').filter({ hasText: 'No active Topics.' }).count(), 0, 'Unavailable metadata must not masquerade as a successful empty list');
    }
    const sessionIdentities = () => nativeSessionIdentities(gatewayRead);
    const beforeSessions = await sessionIdentities();
    if (kind === 'binding') assert.equal(beforeSessions.some(row => row.key === `agent:main:command-center:legacy-discord:${channelId}`), false, 'Conflicting bootstrap must not create its proposed Primary Session');
    const beforeTopics = await gatewayRead('command-center.v1.topics.list');
    const refused = await fetchJsonWithDeadline(`${world.gateway.url}${actionPath}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json', 'x-openclaw-control-ui-relay': '1' },
      body: JSON.stringify({ schemaVersion: 1, action: 'conversations.create', topicId, expectedRevision, logicalOperationId, label: 'Fictional refused compatibility Conversation' })
    }, { label: 'native compatibility retained Conversation refusal', timeoutMs: 30_000 });
    assert.equal(refused.parseError, undefined); assert.equal(refused.response.status, 422);
    assert.equal(refused.body.schemaVersion, 1); assert.equal(refused.body.status, 'error');
    assert.equal(refused.body.code, kind === 'binding' ? 'source-recovery' : 'recovery-only', 'Refusal must come from source/metadata ownership, not deferred-feature or invalid-payload admission');
    assert.deepEqual(await sessionIdentities(), beforeSessions, 'Refused retained creation must not leave an unattached native Session');
    assert.deepEqual(await gatewayRead('command-center.v1.topics.list'), beforeTopics);
    await nativePage.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter');
    await nativePage.getByRole('status').filter({ hasText: kind === 'binding' ? /Degraded ·/u : /Recovery-only ·/u }).waitFor();
    await waitForConsecutiveReadiness(async () => {
      const report = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.status', params: { pluginId: 'command-center' }, scopes: ['operator.admin'], signal });
      return report?.clients?.flatMap(client => client.activations ?? []).some(entry => entry.pluginId === 'command-center' && entry.revision === native.revision && entry.status === 'activated');
    }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
    result = { mode: status.mode, safeReadObserved: true, mutationRejected: true, mountedUiObserved: true, unsupportedControlsAbsent: true, nativeActivationObserved: true, revision: native.revision };
    }
  } catch (error) { failure = error; }
  finally {
    const cleanup = await finalizeAcceptanceJourney({
      closeBrowser: cleanupSignal => closeManagedBrowser(managedBrowser, cleanupSignal),
      stopHost: async () => { if (host) { await stopPinnedHost(host.child); await host.outputDrained; } },
      assertBrowserTraffic: () => guard.assertClean(),
      assertHostTraffic: () => { if (host) { host.diagnostics.guard.assertClean(); assertNoFatalHostOutput(host.diagnostics, { expectedPluginNotFound: expectedAdmissionFailure }); if (host.diagnostics.cleanupError) throw host.diagnostics.cleanupError; } },
      assertChildTraffic: () => assertRecordedChildTraffic(world),
      assertBuildDigest: () => assertBuiltDigest(buildReceipt),
      onProgress: onFinalization
    });
    removeAbortCleanup(); signal?.removeEventListener('abort', abortBrowser);
    if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map(entry => entry.error)], 'Native compatibility finalization failed');
  }
  scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(host ? boundedHostEvidence(host.diagnostics) : {})]);
  if (failure) throw failure;
  return result;
}
