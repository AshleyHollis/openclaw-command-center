import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';

function fakePublishedApi(stateDir, { bindingAvailable = false, pluginConfig = {} } = {}) {
  const declarations = [];
  const descriptors = [];
  const routes = [];
  const methods = new Map();
  const services = [];
  const candidates = [];
  let currentBindingAvailable = bindingAvailable;
  let revoked = false;
  let bindingCaptures = 0;
  const binding = {
    async emit(candidate) { if (revoked) return { status: 'failed', attempted: 0, delivered: 0, failed: 1, ambiguous: 0 }; candidates.push(structuredClone(candidate)); return { status: 'sent', attempted: 1, delivered: 1, failed: 0, ambiguous: 0 }; },
    async clear() { return { status: 'cleared', attempted: 1, cleared: 1, failed: 0, ambiguous: 0 }; }
  };
  const api = {
    config: { agents: { defaults: { userTimezone: 'UTC' } } },
    pluginConfig,
    logger: { warn() {} },
    runtime: { state: { resolveStateDir: () => stateDir } },
    session: { controls: { registerControlUiDescriptor(value) { descriptors.push(structuredClone(value)); } } },
    lifecycle: { registerRuntimeLifecycle() {} },
    notifications: {
      registerEmitter(declaration) {
        declarations.push(structuredClone(declaration));
        return { bindCurrentOperator() { bindingCaptures += 1; return currentBindingAvailable ? binding : undefined; } };
      }
    },
    registerHttpRoute(value) { routes.push(value); },
    registerGatewayMethod(name, handler) { methods.set(name, handler); },
    registerTool() {},
    registerService(service) { services.push(service); }
  };
  return {
    api, declarations, descriptors, routes, methods, services, candidates,
    async authenticatedGatewayRequest(name, params) {
      const handler = methods.get(name);
      if (!handler) throw new Error(`Missing fake Gateway method ${name}`);
      currentBindingAvailable = true;
      let response;
      try {
        await handler({ req: { id: 'fictional-request' }, params, client: { authenticatedUserId: 'fictional-operator' }, context: { authenticated: true }, respond(ok, result, error) { response = { ok, result, error }; } });
      } finally { currentBindingAvailable = false; }
      if (!response?.ok) throw response?.error ?? new Error('Fake authenticated Gateway request failed');
      return response.result;
    },
    revokeBinding() { revoked = true; },
    restoreBinding() { revoked = false; },
    get bindingCaptures() { return bindingCaptures; }
  };
}

test('real plugin registers one required emitter and reconciles in the background with an authenticated binding', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-notifications-'));
  const host = fakePublishedApi(stateDir);
  try {
    plugin.register(host.api);
    assert.deepEqual(host.declarations, [{ version: 1, id: 'command-center-attention-v1', requiredScopes: ['operator.read'], destinations: [{ id: 'attention-card', tabId: 'command-center' }] }]);
    assert.equal(host.descriptors.length, 1);
    assert.deepEqual({ ...host.descriptors[0], capabilityBridge: undefined }, { surface: 'tab', id: 'command-center', label: 'Command Center', group: 'control', path: '/plugins/command-center', capabilityBridge: undefined });
    assert.equal(host.descriptors[0].capabilityBridge.protocolVersion, 1);
    assert.ok(host.descriptors[0].capabilityBridge.requiredMethods.includes('command-center.v1.sessions.browse'));
    assert.equal(host.services.length, 1);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center' && route.auth === 'gateway'), true);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center/api/search/rebuild' && route.auth === 'plugin' && route.match === 'exact'), true);
    const service = host.services[0];
    await service.start();
    service.notificationService.updateSettings({
      schemaVersion: 1,
      logicalOperationId: '8f111111-1111-4111-8111-111111111111',
      expectedRevision: 1,
      settings: { quietHoursEnabled: false }
    });
    service.attentionService.registerSourceCapability({ sourceCapabilityId: 'integration-monitor', sourceKind: 'operational', monitoring: true, deriveEvidence: (occurrence) => occurrence.evidenceFacts, actions: [] });
    await service.attentionService.ingest({ schemaVersion: 1, sourceCapabilityId: 'integration-monitor', stableSubjectId: 'fictional-high', attentionReason: 'fictional-failure', occurrenceId: 'fictional-high-occurrence', occurredAt: new Date().toISOString(), evidenceFacts: { 'failed-operation': true } });
    await service.notificationReconcile();
    assert.equal(host.candidates.length, 0, 'an unbound operator must fail closed');
    await host.authenticatedGatewayRequest('command-center.v1.topics.list', { schemaVersion: 1 });
    await service.notificationReconcile();
    assert.equal(host.candidates.length, 1, 'background reconciliation must not depend on an iframe request');
    assert.equal(host.bindingCaptures, 1, 'background reconciliation must reuse the opaque request-captured binding');
    host.revokeBinding();
    await service.attentionService.ingest({ schemaVersion: 1, sourceCapabilityId: 'integration-monitor', stableSubjectId: 'fictional-high', attentionReason: 'fictional-failure', occurrenceId: 'fictional-critical-occurrence', occurredAt: new Date(Date.now() + 1_000).toISOString(), evidenceFacts: { 'active-security-exposure': true } });
    await service.notificationReconcile();
    assert.equal(host.candidates.length, 1, 'a revoked retained binding must fail closed before delivery');
    host.restoreBinding();
    await host.authenticatedGatewayRequest('command-center.v1.topics.list', { schemaVersion: 1 });
    await service.notificationReconcile();
    assert.equal(host.candidates.length, 2, 'fresh authenticated reconciliation restores a current opaque binding');

    for (const sourceKind of ['chat', 'activity', 'topic-review']) {
      const sourceCapabilityId = `routine-${sourceKind}`;
      service.attentionService.registerSourceCapability({ sourceCapabilityId, sourceKind, monitoring: true, deriveEvidence: (occurrence) => occurrence.evidenceFacts, actions: [] });
      await service.attentionService.ingest({ schemaVersion: 1, sourceCapabilityId, stableSubjectId: `fictional-${sourceKind}`, attentionReason: 'routine-history', occurrenceId: `fictional-${sourceKind}-occurrence`, occurredAt: new Date().toISOString(), evidenceFacts: { context: 'Fictional routine history' } });
    }
    await service.notificationReconcile();
    assert.equal(host.candidates.length, 2, 'routine Chat, Activity, and Topic Review must not emit');
    service.stop();
  } finally {
    host.services[0]?.stop?.();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('plugin activation refuses a host without the published notification emitter API', () => {
  const host = fakePublishedApi(path.join(os.tmpdir(), 'fictional-command-center-state'));
  delete host.api.notifications;
  assert.throws(() => plugin.register(host.api), /requires the published notification emitter API/u);
  const refused = fakePublishedApi(path.join(os.tmpdir(), 'fictional-command-center-state-refused'));
  refused.api.notifications.registerEmitter = () => undefined;
  assert.throws(() => plugin.register(refused.api), /registration was refused/u);
});

test('isolated grant loss withholds the tab and rejects every public mutation route', async () => {
  const host = fakePublishedApi(path.join(os.tmpdir(), 'fictional-command-center-grant-state'), { pluginConfig: { controlUiGrant: false } });
  plugin.register(host.api);
  assert.equal(host.descriptors.length, 0);
  assert.equal(host.methods.has('command-center.v1.sources.status'), true);
  const mutationPaths = [
    '/plugins/command-center/api/attention/actions',
    '/plugins/command-center/api/dashboard/actions',
    '/plugins/command-center/api/topics/actions',
    '/plugins/command-center/api/topic/actions',
    '/plugins/command-center/api/search/rebuild',
    '/plugins/command-center/api/topic-analysis/actions'
  ];
  for (const routePath of mutationPaths) {
    const route = host.routes.find((candidate) => candidate.path === routePath);
    assert.ok(route, `missing mutation route ${routePath}`);
    let body = '';
    const response = { setHeader() {}, end(value) { body = value; } };
    assert.equal(await route.handler({ method: 'POST' }, response), true);
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(body).code, 'capability-unavailable');
  }
  await assert.rejects(() => host.authenticatedGatewayRequest('command-center.v1.topics.create', {
    schemaVersion: 1,
    name: 'Blocked bridge mutation',
    paraCategory: 'resource',
    logicalOperationId: randomUUID()
  }), (error) => error?.code === 'capability-unavailable');
});

test('isolated source availability produces observable Degraded reads and rejects dependent writes', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-degraded-source-'));
  const host = fakePublishedApi(stateDir, { pluginConfig: { sourceCapabilities: { sessions: false } } });
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    try { seed.createTopic({ topicId: 'fictional-degraded-source-topic', paraCategory: 'resource', lifecycle: 'active' }); }
    finally { seed.close(); }
    plugin.register(host.api);
    const service = host.services[0];
    await service.start();
    const statusResponse = await host.authenticatedGatewayRequest('command-center.v1.sources.status', { schemaVersion: 1 });
    const status = statusResponse?.result ?? statusResponse;
    assert.equal(status.mode, 'degraded');
    assert.ok(status.unavailableCapabilities.includes('sessions'));
    assert.ok(status.unavailableCapabilities.includes('scheduler'));
    const topics = await host.authenticatedGatewayRequest('command-center.v1.topics.list', { schemaVersion: 1 });
    assert.ok(JSON.stringify(topics).includes('fictional-degraded-source-topic'));
    await assert.rejects(() => host.authenticatedGatewayRequest('command-center.v1.sessions.create', {
      schemaVersion: 1,
      topicId: 'fictional-degraded-source-topic',
      logicalOperationId: randomUUID(),
      label: 'Blocked source mutation'
    }), (error) => error?.code === 'capability-unavailable' && error?.details?.status === 'unavailable');
  } finally {
    host.services[0]?.stop?.();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('background notification reconciliation excludes a future Reminder and routine source kinds', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-notification-exclusions-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  const candidates = [];
  const episodes = [
    { episodeId: 'episode-future-reminder', sourceCapabilityId: 'reminders', sourceKind: 'reminder', state: 'Snoozed', severity: 'Routine', snoozedUntil: '2026-08-28T09:00:00.000Z', attentionSince: '2026-08-27T12:00:00.000Z', evidenceFacts: { dueAt: '2026-08-28T09:00:00.000Z' } },
    ...['chat', 'activity', 'topic-review'].map((sourceKind) => ({ episodeId: `episode-routine-${sourceKind}`, sourceCapabilityId: `routine-${sourceKind}`, sourceKind, state: 'Active', severity: 'Routine', attentionSince: '2026-08-27T12:00:00.000Z', evidenceFacts: {} }))
  ];
  const notification = createNotificationService({
    metadata,
    attentionService: { allEpisodes: () => episodes },
    now: () => Date.parse('2026-08-27T12:00:00.000Z'),
    emitter: { bindCurrentOperator: () => ({ async emit(candidate) { candidates.push(candidate); return { status: 'sent' }; }, async clear() { return { status: 'cleared' }; } }) }
  });
  try {
    assert.equal(notification.captureCurrentOperatorBinding(), true);
    await notification.reconcile();
    assert.deepEqual(candidates, []);
  } finally {
    notification.close();
    metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
