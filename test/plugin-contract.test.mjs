import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService, runtimeHostIdentity } from '../src/plugin-service.mjs';

const pluginSource = async () => `${await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8')}\n${await readFile(new URL('../src/plugin-service.mjs', import.meta.url), 'utf8')}`;

test('plugin uses the published entry and external-tab descriptor seams', async () => {
  const source = await pluginSource();
  assert.match(source, /from 'openclaw\/plugin-sdk\/plugin-entry'/);
  assert.match(source, /definePluginEntry\(/);
  assert.doesNotMatch(source, /openclaw\/plugin-sdk';/);
  assert.match(source, /api\.session\.controls\.registerControlUiDescriptor\(/);
  assert.match(source, /surface:\s*'tab'/);
  assert.doesNotMatch(source, /registerControlUiExternalTab/);
});

test('plugin registers an authenticated shell with credentialless immutable subresources and plugin mutation routes', async () => {
  const source = await pluginSource();
  assert.match(source, /for \(const path of assets\.keys\(\)\)[\s\S]*?path,[\s\S]*?auth:\s*path === pluginPath \? 'gateway' : 'plugin',[\s\S]*?match:\s*'exact'/);
  assert.doesNotMatch(source, /auth:\s*'gateway',[\s\S]*?match:\s*'prefix'/);
  assert.doesNotMatch(source, /\[`\$\{pluginPath\}\/`, \['index\.html'/);
  assert.match(source, /api\.registerHttpRoute\(/);
  assert.match(source, /path:\s*'\/plugins\/command-center\/api\/attention\/actions',[\s\S]*?auth:\s*'plugin',[\s\S]*?match:\s*'exact'/);
  assert.doesNotMatch(source, /\/command-center\/v1\/attention\/actions/);
  assert.doesNotMatch(source, /\/plugins\/command-center\/actions/);
});

test('plugin service retains runtime state and source capability wiring', async () => {
  const source = await pluginSource();
  assert.match(source, /api\.registerService\(/);
  assert.match(source, /id:\s*'command-center-metadata'/);
  assert.match(source, /api\.runtime\.state\.resolveStateDir\(process\.env\)/);
  assert.match(source, /gatewayAvailable = typeof api\.runtime\?\.gateway\?\.request === 'function'/);
  assert.match(source, /typeof api\.runtime\.gateway\.isAvailable === 'function'/);
  assert.match(source, /sessions: gatewayAvailable && configuredSourceCapabilities\.sessions !== false/);
  assert.match(source, /scheduler: gatewayAvailable && configuredSourceCapabilities\.scheduler !== false/);
});

test('plugin registers the bridge with grant-aware mutation denial', async () => {
  const source = await pluginSource();
  assert.match(source, /registerBridgeMethods\(api, serviceProxy, \{ mutationsAllowed: controlUiMutationsAllowed \}\)/);
});

test('plugin retains tools, search, maintenance, and bounded asset serving', async () => {
  const source = await pluginSource();
  assert.match(source, /api\.registerTool\(topicContextToolFactory/);
  assert.match(source, /name:\s*'command_center_topic_context',\s*optional:\s*true/);
  assert.match(source, /searchRebuildServiceFactory = createSearchRebuildService/);
  assert.match(source, /new Promise\(\(resolve\) => setImmediate\(resolve\)\)\.then/);
  assert.match(source, /stopPromise = Promise\.resolve\(startupSearchRebuildTask\)/);
  assert.match(source, /createNoteMaintenanceService\(/);
  assert.match(source, /maintenanceService/);
  assert.match(source, /export function runNoteMaintenance\(input\)/);
  assert.match(source, /serveShellAsset\(req, res, \{ assets \}\)/);
});

test('manifest activates the route-registering plugin at Gateway startup', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.contracts?.tools, ['command_center_topic_context', 'command_center_topic_analysis']);
});

test('Conversation ingestion uses the pinned host identity and history gateway methods', async () => {
  const source = await readFile(new URL('../src/search/source-snapshot.mjs', import.meta.url), 'utf8');
  assert.match(source, /request\('sessions\.describe'/);
  assert.match(source, /includeDerivedTitles:\s*true/);
  assert.match(source, /request\('chat\.history', \{ sessionKey: reference\.externalSourceId, limit, offset \}\)/);
  assert.match(source, /assertSessionIdentity\(page, reference, expectedSessionId/);
  assert.doesNotMatch(source, /session-transcript-runtime|transcriptPath|storePath/);
});

test('Topics UI preserves Topic Search capability navigation and uses the dedicated POST mutation route', async () => {
  const source = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(source, /bridgeRequest\('command-center\.v1\.search\.query'/);
  assert.match(source, /bridgeRequest\('command-center\.v1\.notes\.read'/);
  assert.match(source, /bridgeRequest\('command-center\.v1\.sessions\.navigate'/);
  assert.match(source, /bridgeRequest\('ui\.session\.navigate', \{ sessionKey: target\.sessionKey \}\)/);
  assert.match(source, /fetch\(HTTP_ROUTE, \{ method: 'POST'/);
  assert.doesNotMatch(source, /window\.location\.(?:assign|replace)|parent\.location/);
});

test('Topic workspace declares the exact external-tab capability bridge and bounded mutation route', async () => {
  const source = await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  for (const method of ['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.send', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate']) assert.match(source, new RegExp(method.replaceAll('.', '\\.'), 'u'));
  assert.match(source, /capabilityBridge:[\s\S]*protocolVersion:\s*1/u);
  const requiredMethods = /requiredMethods:\s*\[([\s\S]*?)\]/u.exec(source)?.[1] ?? '';
  assert.match(requiredMethods, /command-center\.v1\.sessions\.send/u);
  assert.doesNotMatch(requiredMethods, /['"]chat\.send['"]/u);
  assert.match(requiredMethods, /command-center\.v1\.topics\.list/u);
  assert.doesNotMatch(requiredMethods, /command-center\.v1\.sessions\.list/u);
  assert.match(source, /path:\s*'\/plugins\/command-center\/api\/topic\/actions',[\s\S]*auth:\s*'plugin',[\s\S]*match:\s*'exact'/u);
  assert.match(requiredMethods, /sessions\.create/u);
  const html = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script type="module"/u);
  assert.match(html, /app\.js/u);
  for (const id of ['topic-workspace', 'chat-pane', 'conversations-pane', 'notes-pane', 'workspace-search-pane', 'note-action-dialog']) assert.match(html, new RegExp(`id="${id}"`, 'u'));
  const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /new URL\('\/plugins\/command-center\/markdown\.js', document\.baseURI\)\.href/u);
  assert.match(app, /import\(markdownModuleUrl\)/u);
  assert.match(app, /bridgeReady\.then\(loadOperatingState\)/u);
  assert.match(app, /if \(requestedTopicId === null\) void loadTopics\(\)/u);
  assert.match(app, /fetch\(PAGE_ACTION_ROUTE, \{ method: 'POST', credentials: 'omit'/u);
  assert.match(app, /bridgeRequest\('sessions\.create', \{ agentId: 'main', label \}, logicalOperationId\)/u);
  assert.match(app, /bridgeRequest\('command-center\.v1\.sessions\.navigate', \{ schemaVersion: 1, topicId, referenceId \}\)/u);
  assert.match(app, /bridgeRequest\('command-center\.v1\.sessions\.send', \{ schemaVersion: 1, topicId, referenceId, message: operation\.intent\.message, logicalOperationId: operation\.logicalOperationId \}, operation\.logicalOperationId\)/u);
  assert.doesNotMatch(app, /pageAction\('chat\.send'/u);
  assert.doesNotMatch(app, /targetAddressSpace|local-network-access/u);
  assert.doesNotMatch(app, /flushQuote/u);
  const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.match(app, /max-width: 47\.99rem/u);
  assert.match(styles, /@media \(max-width: 47\.99rem\)/u);
  assert.match(styles, /@media \(min-width: 48rem\)/u);
  assert.doesNotMatch(`${app}\n${styles}`, /max-width: 1023px/u);
});

test('plugin startup preserves migration wiring and binds approvals to a stable non-secret host identity', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-approval-'));
  const api = { runtime: { state: { resolveStateDir: () => stateDir } }, logger: {}, pluginConfig: {} };
  const service = createMetadataService(api);
  try {
    await service.start();
    const attention = service.attentionService;
    attention.registerSourceCapability({
      sourceCapabilityId: 'plugin-approval-monitor',
      actions: [{ actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'fictional-subject' }), parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes a fictional monitor.'], approvalMode: 'required', idempotency: { idempotent: false, transientRetryable: false }, executor: async () => ({}), authoritativeVerifier: async () => ({ outcome: 'applied' }), successTransition: async () => 'Resolved' }]
    });
    const created = await attention.ingest({ schemaVersion: 1, sourceCapabilityId: 'plugin-approval-monitor', stableSubjectId: 'fictional-subject', attentionReason: 'approval-required', occurrenceId: 'fictional-occurrence', occurredAt: '2026-08-24T00:00:00.000Z', evidenceFacts: {} });
    const pending = await attention.act({ schemaVersion: 1, logicalOperationId: '71111111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, actionId: 'monitor.change', input: {}, authenticatedOperatorId: 'fictional-operator' });
    assert.equal(pending.status, 'approval-required');
    assert.equal(pending.approval.host, runtimeHostIdentity(stateDir));
    assert.match(pending.approval.host, /^command-center-runtime:[a-f0-9]{64}$/);
    assert.doesNotMatch(pending.approval.host, new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
