import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService, runtimeHostIdentity } from '../src/plugin-service.mjs';

const pluginSource = async () => `${await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8')}\n${await readFile(new URL('../src/plugin-service.mjs', import.meta.url), 'utf8')}`;

test('plugin uses the published entry and native manifest contribution', async () => {
  const source = await pluginSource();
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.match(source, /from 'openclaw\/plugin-sdk\/plugin-entry'/);
  assert.match(source, /definePluginEntry\(/);
  assert.doesNotMatch(source, /openclaw\/plugin-sdk';/);
  assert.equal(manifest.controlUi.entry, 'dist/native-ui/entry.mjs');
  assert.doesNotMatch(source, /registerControlUiDescriptor\(/);
  assert.doesNotMatch(source, /registerControlUiExternalTab/);
});

test('plugin registers exact authenticated native routes without legacy shell authority', async () => {
  const source = await pluginSource();
  assert.match(source, /api\.registerHttpRoute\(/);
  assert.match(source, /path:\s*'\/plugins\/command-center\/api\/topic\/actions',[\s\S]*?auth:\s*'gateway',[\s\S]*?match:\s*'exact'/);
  assert.match(source, /for \(const path of legacyPaths\)[\s\S]*?unavailableFirstLiveFeature/);
  assert.doesNotMatch(source, /auth:\s*'none'/);
  assert.doesNotMatch(source, /\/command-center\/v1\/attention\/actions/);
  assert.doesNotMatch(source, /\/plugins\/command-center\/actions/);
});

test('plugin service retains runtime state and source capability wiring', async () => {
  const source = await pluginSource();
  assert.match(source, /api\.registerService\(/);
  assert.match(source, /id:\s*'command-center-metadata'/);
  assert.match(source, /api\.runtime\.state\.resolveStateDir\(process\.env\)/);
  assert.match(source, /gatewayAvailable = typeof api\.runtime\?\.gateway\?\.request === 'function'/);
  assert.match(source, /sessions: FIRST_LIVE_FEATURES\.conversations && \(gatewayAvailable \|\| sessionCatalogAvailable\)/);
  assert.match(source, /scheduler: false, search: false, analysis: false, attention: false/);
});

test('plugin registers the bridge with grant-aware mutation denial', async () => {
  const source = await pluginSource();
  assert.match(source, /registerBridgeMethods\(api, serviceProxy, \{ mutationsAllowed: controlUiMutationsAllowed \}\)/);
});

test('plugin keeps deferred tools, Search and maintenance out of first-live startup', async () => {
  const source = await pluginSource();
  assert.match(source, /get searchService\(\) \{ return undefined; \}/);
  assert.match(source, /get maintenanceService\(\) \{ return undefined; \}/);
  assert.match(source, /export function runNoteMaintenance\(\) \{ return unavailable\('noteMaintenance'\); \}/);
  assert.match(source, /contracts\.tools|registerTool/);
  assert.match(source, /unavailableFirstLiveFeature/);
});

test('manifest activates the route-registering plugin at Gateway startup', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.contracts?.tools, []);
});

test('Conversation ingestion uses the pinned host identity and history gateway methods', async () => {
  const source = await readFile(new URL('../src/search/source-snapshot.mjs', import.meta.url), 'utf8');
  assert.match(source, /request\('sessions\.describe'/);
  assert.match(source, /includeDerivedTitles:\s*true/);
  assert.match(source, /request\('chat\.history', \{ sessionKey, limit, offset \}\)/);
  assert.match(source, /assertSessionIdentity\(page, sessionKey, expectedSessionId/);
  assert.doesNotMatch(source, /session-transcript-runtime|transcriptPath|storePath/);
});

test('Topics UI preserves Topic Search capability navigation and uses the dedicated POST mutation route', async () => {
  const source = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(source, /bridgeRequest\('command-center\.v1\.search\.query'/);
  assert.match(source, /bridgeRequest\('command-center\.v1\.notes\.read'/);
  assert.match(source, /bridgeRequest\('command-center\.v1\.sessions\.navigate'/);
  assert.match(source, /bridgeRequest\('ui\.session\.navigateResolved', \{/);
  assert.match(source, /expectedSessionKey: target\.sessionKey/);
  assert.doesNotMatch(source, /bridgeRequest\('ui\.session\.navigate'/);
  assert.match(source, /relayHttp\(HTTP_ROUTE, \{ method: 'POST'/);
  assert.doesNotMatch(source, /window\.location\.(?:assign|replace)|parent\.location/);
});

test('retained legacy Topic assets preserve their guarded routes until native workflow cutover', async () => {
  const source = await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  assert.match(source, /path:\s*'\/plugins\/command-center\/api\/topic\/actions',[\s\S]*auth:\s*'gateway',[\s\S]*match:\s*'exact'/u);
  const html = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script type="module"/u);
  assert.match(html, /app\.js/u);
  for (const id of ['topic-workspace', 'chat-pane', 'conversations-pane', 'notes-pane', 'workspace-search-pane', 'note-action-dialog']) assert.match(html, new RegExp(`id="${id}"`, 'u'));
  const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /method === 'command-center\.v1\.notes\.browse' \? 120_000 : 30_000/u);
  assert.match(app, /new URL\('\/plugins\/command-center\/markdown\.js', document\.baseURI\)\.href/u);
  assert.match(app, /import\(markdownModuleUrl\)/u);
  assert.match(app, /bridgeReady\.then\(loadOperatingState\)/u);
  assert.match(app, /if \(requestedTopicId === null\) void loadTopics\(\)/u);
  assert.match(app, /relayHttp\(PAGE_ACTION_ROUTE, \{ method: 'POST', credentials: 'omit'/u);
  assert.match(app, /bridgeRequest\('sessions\.create', \{ agentId: 'main', label \}, logicalOperationId\)/u);
  assert.match(app, /bridgeRequest\('command-center\.v1\.sessions\.navigate', \{ schemaVersion: 1, topicId: operation\.topicId, referenceId: operation\.referenceId, nativeChat: true \}\)/u);
  assert.doesNotMatch(app, /bridgeRequest\('command-center\.v1\.sessions\.send'/u);
  assert.doesNotMatch(app, /pageAction\('chat\.send'/u);
  assert.doesNotMatch(app, /targetAddressSpace|local-network-access/u);
  assert.doesNotMatch(app, /flushQuote/u);
  const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.match(app, /max-width: 47\.99rem/u);
  assert.match(styles, /@media \(max-width: 47\.99rem\)/u);
  assert.match(styles, /@media \(min-width: 48rem\)/u);
  assert.doesNotMatch(`${app}\n${styles}`, /max-width: 1023px/u);
});

test('plugin startup preserves migration wiring without activating deferred approval owners', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-approval-'));
  const api = { runtime: { state: { resolveStateDir: () => stateDir } }, logger: {}, pluginConfig: {} };
  const service = createMetadataService(api);
  try {
    await service.start();
    assert.equal(service.attentionService, undefined);
    const identity = runtimeHostIdentity(stateDir);
    assert.match(identity, /^command-center-runtime:[a-f0-9]{64}$/);
    assert.doesNotMatch(identity, new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
