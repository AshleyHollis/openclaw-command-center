import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService, runtimeHostIdentity } from '../src/plugin-service.mjs';

test('plugin uses the pinned public external-tab and gateway-route seams', async () => {
  const source = `${await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8')}\n${await readFile(new URL('../src/plugin-service.mjs', import.meta.url), 'utf8')}`;
  assert.match(source, /from 'openclaw\/plugin-sdk\/plugin-entry'/);
  assert.match(source, /definePluginEntry\(/);
  assert.doesNotMatch(source, /openclaw\/plugin-sdk';/);
  assert.match(source, /api\.session\.controls\.registerControlUiDescriptor\(/);
  assert.match(source, /surface:\s*'tab'/);
  assert.match(source, /for \(const path of assets\.keys\(\)\)[\s\S]*?path,[\s\S]*?auth:\s*'gateway',[\s\S]*?match:\s*'exact'/);
  assert.doesNotMatch(source, /auth:\s*'gateway',[\s\S]*?match:\s*'prefix'/);
  assert.doesNotMatch(source, /\[`\$\{pluginPath\}\/`, \['index\.html'/);
  assert.match(source, /api\.registerHttpRoute\(/);
  assert.match(source, /auth:\s*'gateway'/);
  assert.match(source, /path:\s*'\/plugins\/command-center\/api\/attention\/actions',[\s\S]*?auth:\s*'plugin',[\s\S]*?match:\s*'exact'/);
  assert.doesNotMatch(source, /\/command-center\/v1\/attention\/actions/);
  assert.doesNotMatch(source, /\/plugins\/command-center\/actions/);
  assert.match(source, /api\.registerService\(/);
  assert.match(source, /id:\s*'command-center-metadata'/);
  assert.match(source, /api\.runtime\.state\.resolveStateDir\(process\.env\)/);
  assert.match(source, /gatewayAvailable = typeof api\.runtime\?\.gateway\?\.request === 'function'/);
  assert.match(source, /sessions: sessionStoreAvailable, scheduler: gatewayAvailable/);
  assert.match(source, /api\.runtime\?\.agent\?\.session\?\.patchSessionEntry/);
  assert.match(source, /registerBridgeMethods\(api, serviceProxy\)/);
  assert.match(source, /createNoteMaintenanceService\(/);
  assert.match(source, /maintenanceService/);
  assert.match(source, /export function runNoteMaintenance\(input\)/);
  assert.match(source, /serveShellAsset\(req, res, \{ assets \}\)/);
  assert.doesNotMatch(source, /registerControlUiExternalTab/);
});

test('manifest activates the route-registering plugin at Gateway startup', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation?.onStartup, true);
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
    service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
