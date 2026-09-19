import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

const qualifyOpenLoop = (service, method, params) => invokeBridgeMethod(service, method, params, 'fictional-qualification-request', 'fictional-operator');

function fakePublishedApi(stateDir, { bindingAvailable = false, pluginConfig = {}, gateway } = {}) {
  const declarations = [];
  const descriptors = [];
  const routes = [];
  const methods = new Map();
  const services = [];
  const lifecycles = [];
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
    runtime: { state: { resolveStateDir: () => stateDir }, ...(gateway ? { gateway } : {}) },
    session: { controls: { registerControlUiDescriptor(value) { descriptors.push(structuredClone(value)); } } },
    lifecycle: { registerRuntimeLifecycle(value) { lifecycles.push(value); } },
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
    api, declarations, descriptors, routes, methods, services, lifecycles, candidates,
    async authenticatedGatewayRequest(name, params) {
      const handler = methods.get(name);
      if (!handler) throw new Error(`Missing fake Gateway method ${name}`);
      currentBindingAvailable = true;
      let response;
      const client = { connId: 'fictional-current-connection', authenticatedUserProfile: { profileId: 'fictional-operator' }, connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
      try {
        await handler({ req: { id: 'fictional-request' }, params, client, context: { authenticated: true, getClientConnIds: predicate => new Set(predicate(client) ? [client.connId] : []) }, respond(ok, result, error) { response = { ok, result, error }; } });
      } finally { currentBindingAvailable = false; }
      if (!response?.ok) throw response?.error ?? new Error('Fake authenticated Gateway request failed');
      return response.result;
    },
    revokeBinding() { revoked = true; },
    restoreBinding() { revoked = false; },
    get bindingCaptures() { return bindingCaptures; }
  };
}

function fictionalSchedulerGateway() {
  const jobs = new Map(); let revision = 0;
  return { jobs, async request(method, params) {
    if (method === 'cron.list') return { jobs: [...jobs.values()].map(job => structuredClone(job)) };
    if (method === 'cron.get') return structuredClone(jobs.get(params.id));
    if (method === 'cron.add') { const id = `fictional-open-loop-${jobs.size + 1}`; const job = { ...structuredClone(params), id, configRevision: `revision-${++revision}` }; jobs.set(id, job); return { created: true, job: structuredClone(job) }; }
    if (method === 'cron.update') { const current = jobs.get(params.id); if (current.configRevision !== params.expectedConfigRevision) throw Object.assign(new Error('changed'), { code: 'CRON_JOB_CHANGED', actualConfigRevision: current.configRevision }); const job = { ...current, ...structuredClone(params.patch), configRevision: `revision-${++revision}` }; jobs.set(job.id, job); return structuredClone(job); }
    throw new Error(`Unexpected fictional Scheduler method ${method}`);
  } };
}

test('native registration exposes authenticated Topic methods without an iframe descriptor API', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-descriptor-'));
  let service;
  try {
    const host = fakePublishedApi(stateDir);
    delete host.api.session;
    plugin.register(host.api);
    assert.equal(host.descriptors.length, 0);
    for (const method of [
      'command-center.v1.sources.status', 'command-center.v1.attention.act',
      'command-center.v1.topics.list', 'command-center.v1.topics.get',
      'command-center.v1.sessions.browse', 'command-center.v1.sessions.history',
      'command-center.v1.sessions.navigate', 'command-center.v1.sessions.resolve-native',
      'command-center.v1.notes.browse', 'command-center.v1.notes.read',
      'command-center.v1.search.query'
    ]) assert.equal(host.methods.has(method), true, `${method} remains registered without the iframe API`);
    assert.equal(host.methods.has('chat.send'), false, 'native Chat owns message sending');
    assert.equal(host.methods.has('sessions.create'), false, 'host Session creation must not be shadowed');
    service = host.services[0];
    await service.start();
    service.sourceService.sessionsNavigate = async (input) => {
      assert.equal(input.nativeChat, true);
      return { schemaVersion: 1, sessionId: 'fictional-session', sessionKey: 'agent:main:fictional' };
    };
    const resolved = await host.authenticatedGatewayRequest('command-center.v1.sessions.resolve-native', { schemaVersion: 1, topicId: 'fictional-topic', referenceId: 'fictional-reference', expectedSessionId: 'fictional-session' });
    assert.deepEqual(resolved, { sessionKey: 'agent:main:fictional' });
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('registered open-loop bridge applies authenticated lifecycle changes and replays them safely', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-open-loop-bridge-'));
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    const created = seed.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'seed-fictional-bill', message: {
      schemaVersion: 1,
      channel: 'email',
      source: { system: 'fictional-mail', externalId: 'bill-source-private', version: 'v1' },
      occurredAt: '2026-09-20T00:55:00.000Z',
      observedAt: '2026-09-20T01:00:00.000Z',
      historicalBaseline: false,
      disposition: 'confirmed-obligation',
      requestKind: 'payment',
      explicitRequest: true,
      summary: 'A fictional renovation invoice is ready.',
      payee: 'Example Renovations',
      purpose: 'fictional kitchen progress invoice',
      amount: 245000,
      currency: 'AUD',
      dueAt: '2026-09-28T13:59:59.000Z',
      invoiceId: 'INVOICE-FICTIONAL-48',
      attachmentIds: ['private-attachment-id'],
      evidenceSelectors: ['attachment:1:invoice-number']
    } });
    seed.close();
    const host = fakePublishedApi(stateDir);
    plugin.register(host.api);
    service = host.services[0];
    await service.start();
    const operationId = randomUUID();
    const intent = { schemaVersion: 1, logicalOperationId: operationId, loopId: created.loop.loopId, expectedRevision: 1, paymentState: 'payment-pending', rationale: 'A fictional transfer was initiated; settlement is not yet verified.', authenticatedOperatorId: 'fictional-operator' };
    const applied = service.openLoopsPaymentStatus(intent);
    await new Promise(resolve => setTimeout(resolve, 5));
    const replayed = service.openLoopsPaymentStatus(intent);
    assert.equal(applied.disposition, 'applied');
    assert.equal(replayed.disposition, 'duplicate');
    assert.equal(replayed.loop.revision, applied.loop.revision);
    const page = await qualifyOpenLoop(service, 'command-center.v1.open-loops.list', { schemaVersion: 1, offset: 0, limit: 20 });
    assert.equal(page.loops[0].paymentState, 'payment-pending');
    const settled = await qualifyOpenLoop(service, 'command-center.v1.open-loops.payment-status', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 2, paymentState: 'paid', rationale: 'A fictional settlement was verified.' });
    assert.equal(settled.loop.paymentState, 'paid');
    assert.equal(settled.loop.state, 'resolved');
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('bounded document intake reads authoritative content and revision through the existing source owner', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-document-'));
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-selected-document', paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'document:selected-invoice', topicId: 'topic-selected-document', sourceSystem: 'fictional-documents', sourceKind: 'document', externalSourceId: 'selected-invoice.txt', observedRevision: 'authoritative-v7' });
    seed.close();
    const host = fakePublishedApi(stateDir); plugin.register(host.api); service = host.services[0]; await service.start();
    let readInput;
    service.sourceService.notesRead = async input => {
      readInput = input;
      return { schemaVersion: 1, path: input.path, text: 'Invoice: INV-FICTIONAL-SELECTED\nPayee: Fictional Electrician\nPurpose: final switchboard work\nAmount due: AUD 480.00\nPlease pay after review.', revision: 'authoritative-v7', sourceReference: { referenceId: input.referenceId } };
    };
    const result = await service.openLoopsIngestSelected({ schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { scopeId: 'fictional-operator', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-document', path: 'selected-invoice.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] });
    assert.deepEqual(readInput, { schemaVersion: 1, topicId: 'topic-selected-document', referenceId: 'document:selected-invoice', path: 'selected-invoice.txt', observedRevision: 'authoritative-v7', sourceKind: 'document' });
    assert.equal(result.results[0].sourceVersion, 'authoritative-v7');
    assert.equal(result.results[0].loop.title, 'Pay final switchboard work from Fictional Electrician');
    await assert.rejects(() => service.openLoopsIngestSelected({ schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { scopeId: 'fictional-operator', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-document', path: 'selected-invoice.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', content: 'caller supplied' }] }), /selected document/i);
    service.sourceService.notesRead = async () => { throw Object.assign(new Error('fictional source missing'), { code: 'not-found' }); };
    const unavailable = await service.openLoopsIngestSelected({ schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { scopeId: 'fictional-operator', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-document', path: 'selected-invoice.txt', occurredAt: '2026-09-21T00:00:00.000Z', observedAt: '2026-09-21T00:01:00.000Z' }] });
    assert.equal(unavailable.freshness.status, 'unavailable');
    assert.equal(unavailable.results[0].loop, undefined);
    assert.match(unavailable.results[0].sourceVersion, /^unavailable:authoritative-v7:not-found$/u);
    assert.equal(service.openLoopsGet({ loopId: result.results[0].loop.loopId }).loop.state, 'confirmed', 'a source outage must not resolve the existing obligation');
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('registered bill actions create, defer, and cancel one native Reminder through the plugin service', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-bill-reminder-'));
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-fictional-bill', paraCategory: 'project', lifecycle: 'active' });
    const created = seed.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'seed-topic-bill', message: { schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: 'bill-reminder-source', version: 'v1' }, occurredAt: '2026-09-20T01:00:00.000Z', observedAt: '2026-09-20T01:00:00.000Z', historicalBaseline: false, topicId: 'topic-fictional-bill', disposition: 'confirmed-obligation', requestKind: 'payment', explicitRequest: true, summary: 'Pay the fictional electrical invoice.', payee: 'Fictional Electrical', purpose: 'renovation work', amount: 48000, currency: 'AUD', dueAt: '2026-10-04T00:00:00.000Z', invoiceId: 'FICTIONAL-ELEC-1', evidenceSelectors: ['subject'] } });
    seed.close();
    const gateway = fictionalSchedulerGateway(); const host = fakePublishedApi(stateDir, { gateway }); plugin.register(host.api); service = host.services[0]; await service.start();
    const corrected = await qualifyOpenLoop(service, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 1, decision: 'correct-date', dueAt: '2026-10-05T00:00:00.000Z', rationale: 'The fictional invoice date was checked.' });
    assert.equal(corrected.reminder.action, 'create'); assert.equal(gateway.jobs.size, 1); assert.equal([...gateway.jobs.values()][0].schedule.at, '2026-10-05T00:00:00.000Z');
    const deferred = await qualifyOpenLoop(service, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 2, decision: 'defer', reviewAt: '2026-10-02T09:00:00.000Z', rationale: 'Review after the fictional pay cycle.' });
    assert.equal(deferred.reminder.action, 'reschedule'); assert.equal([...gateway.jobs.values()][0].schedule.at, '2026-10-02T09:00:00.000Z');
    const paid = await qualifyOpenLoop(service, 'command-center.v1.open-loops.payment-status', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 3, paymentState: 'paid', rationale: 'The fictional settlement was verified.' });
    assert.equal(paid.reminder.action, 'cancel'); assert.equal([...gateway.jobs.values()][0].enabled, false);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('registered renovation bridge preserves exact purchase relationships and separate replacement obligations', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-renovation-bridge-'));
  let service;
  const at = '2026-09-20T02:00:00.000Z';
  const source = (externalId) => ({ system: 'fictional-renovation-source', kind: 'operator-evidence', externalId, version: 'v1' });
  const ref = (kind, id) => ({ kind, namespace: 'fictional-home-project', id });
  try {
    const host = fakePublishedApi(stateDir);
    plugin.register(host.api);
    service = host.services[0];
    await service.start();
    const requirement = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-requirement', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 0, requirement: { schemaVersion: 1, source: source('required-mixer'), requirement: ref('purchase', 'buy-mixer'), occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Buy fictional sink mixer' } });
    assert.equal(requirement.loop.state, 'waiting');
    const purchased = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-purchase', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 1, reconciliation: { schemaVersion: 1, source: source('receipt-mixer'), requirement: ref('purchase', 'buy-mixer'), purchase: ref('purchase', 'purchased-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false } });
    assert.equal(purchased.loop.state, 'resolved');
    const replacement = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-replacement', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 0, replacement: { schemaVersion: 1, source: source('replacement-mixer'), replacementPurchase: ref('purchase', 'replacement-mixer-002'), replacedItem: ref('renovation-item', 'faulty-mixer-001'), obligation: ref('return', 'return-faulty-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Return fictional faulty mixer', dueAt: '2026-09-27T00:00:00.000Z' } });
    assert.equal(replacement.loop.state, 'confirmed');
    assert.equal(replacement.loop.expectedEvent, 'return completion');
    assert.notEqual(replacement.loop.loopId, purchased.loop.loopId);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('registered renovation decision revision keeps the prior record and resolves the exact challenged loop', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-renovation-decision-'));
  let service;
  const at = '2026-09-20T02:00:00.000Z';
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.recordDecisionMemory({ schemaVersion: 1, logicalOperationId: 'seed-finish-choice', expectedRevision: 0, decision: { schemaVersion: 1, decisionId: 'cabinet-finish-choice', status: 'confirmed', decidedAt: at, actorId: 'fictional-operator', subject: { kind: 'product-choice', id: 'cabinet-finish', label: 'Fictional cabinet finish' }, chosenOption: 'warm white', alternatives: ['cool white'], rationale: 'Matches the fictional room.', assumptions: [], sourceObservationIds: [] } });
    const challenged = seed.recordRenovationDecisionConflict({ schemaVersion: 1, logicalOperationId: 'seed-finish-conflict', expectedRevision: 1, actorId: 'fictional-operator', conflict: { schemaVersion: 1, decisionId: 'cabinet-finish-choice', source: { system: 'fictional-renovation-source', kind: 'quote', externalId: 'quote-1', version: 'v2' }, conflictKind: 'revised-quote', occurredAt: at, observedAt: at, historicalBaseline: false, summary: 'The revised fictional quote names cool white.', recordedChoice: 'warm white', observedChoice: 'cool white', evidenceSelectors: ['quote:finish'] } });
    seed.close();
    const host = fakePublishedApi(stateDir); plugin.register(host.api); service = host.services[0]; await service.start();
    const revisionOperationId = randomUUID();
    const revisionParams = { schemaVersion: 1, logicalOperationId: revisionOperationId, loopId: challenged.decision.loop.loopId, expectedRevision: 2, chosenOption: 'cool white', rationale: 'The fictional revised quote was accepted after review.', decidedAt: '2026-09-20T02:05:00.000Z' };
    const revised = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-decision-revise', revisionParams);
    assert.equal(revised.loop.state, 'resolved');
    assert.equal(revised.loop.revision, 3);
    const replayed = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-decision-revise', revisionParams);
    assert.equal(replayed.disposition, 'duplicate');
    assert.equal(replayed.loop.revision, revised.loop.revision);
    await assert.rejects(() => qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-decision-revise', { ...revisionParams, chosenOption: 'warm white' }), /intent/i);
    const later = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-decision-revise', { ...revisionParams, logicalOperationId: randomUUID(), expectedRevision: 3, chosenOption: 'soft grey', rationale: 'A later fictional sample was accepted.', decidedAt: '2026-09-20T03:05:00.000Z' });
    assert.equal(later.loop.revision, 4);
    const oldReplayAfterLaterRevision = await qualifyOpenLoop(service, 'command-center.v1.open-loops.renovation-decision-revise', revisionParams);
    assert.equal(oldReplayAfterLaterRevision.disposition, 'duplicate');
    assert.equal(oldReplayAfterLaterRevision.loop.revision, 3, 'the completed receipt must not acquire the later decision revision');
    const detail = await qualifyOpenLoop(service, 'command-center.v1.open-loops.get', { schemaVersion: 1, loopId: challenged.decision.loop.loopId });
    assert.ok(detail.evidence.some(item => item.chosenOption === 'warm white'));
    assert.ok(detail.evidence.some(item => item.chosenOption === 'cool white'));
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('Session cleanup does not stop the plugin-wide service; disable and restart do', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-cleanup-'));
  try {
    const host = fakePublishedApi(stateDir);
    plugin.register(host.api);
    let stops = 0;
    host.services[0].stop = async () => { stops += 1; };
    for (const reason of ['delete', 'reset']) await host.lifecycles[0].cleanup({ reason, sessionKey: 'agent:main:fictional-deleted' });
    assert.equal(stops, 0, 'Session-scoped cleanup must not close Topic services or metadata');
    for (const reason of ['disable', 'restart']) await host.lifecycles[0].cleanup({ reason });
    assert.equal(stops, 2, 'plugin-wide lifecycle must still stop its service');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('CLI metadata discovery does not acquire runtime services or notification authority', () => {
  plugin.register({
    registrationMode: 'cli-metadata',
    get notifications() { throw new Error('Notification registration is unavailable during CLI metadata discovery.'); },
    get runtime() { throw new Error('Runtime is unavailable during CLI metadata discovery.'); },
    registerService() { assert.fail('CLI metadata discovery must not register background services.'); }
  });
});

test('started plugin keeps authenticated Topic reads alive across Session delete and reset cleanup', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-live-cleanup-'));
  let service;
  try {
    const host = fakePublishedApi(stateDir);
    plugin.register(host.api);
    service = host.services[0];
    await service.start();
    const original = service.topicService;
    const before = await host.authenticatedGatewayRequest('command-center.v1.topics.list', { schemaVersion: 1 });
    for (const reason of ['delete', 'reset']) {
      await host.lifecycles[0].cleanup({ reason, sessionKey: 'agent:main:fictional-session' });
      assert.equal(service.topicService, original);
      const response = await host.authenticatedGatewayRequest('command-center.v1.topics.list', { schemaVersion: 1 });
      assert.deepEqual(response.result, before.result);
    }
    await host.lifecycles[0].cleanup({ reason: 'disable' });
    assert.equal(service.topicService, undefined);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('native manifest uses the supported asset declaration while routes stay registered through the authenticated plugin API', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.controlUi).sort(), ['entry']);
  assert.equal(manifest.controlUi.entry, 'dist/native-ui/entry.mjs');
  assert.deepEqual(manifest.contracts.gatewayMethodDispatch, ['authenticated-request']);
  const host = fakePublishedApi(path.join(os.tmpdir(), 'fictional-native-registration'));
  delete host.api.session;
  plugin.register(host.api);
  assert.ok(host.routes.length > 0, 'the plugin must register its authenticated API routes');
  for (const route of host.routes) {
    assert.equal(route.auth, ['/plugins/command-center/styles.css', '/plugins/command-center/markdown.js', '/plugins/command-center/app.js'].includes(route.path) ? 'plugin' : 'gateway');
    assert.equal(route.match, 'exact');
  }
  assert.ok(host.routes.some((route) => route.path === '/plugins/command-center/api/topic/actions'));
});

test('production first-live plugin keeps deferred analysis unavailable without dispatch', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-analysis-'));
  const topicId = 'fictional-production-analysis-topic';
  const sourceId = 'fictional-production-analysis-source';
  const logicalOperationId = '7a111111-1111-4111-8111-111111111111';
  const gateway = { async request(method, input = {}) {
    if (method === 'cron.list') return { jobs: [] };
    if (method === 'cron.add') return { id: 'fictional-analysis-cron', declarationKey: input.declarationKey, enabled: true, schedule: input.schedule, sessionTarget: input.sessionTarget, wakeMode: input.wakeMode, payload: input.payload, delivery: input.delivery, configRevision: 'fictional-analysis-cron-r1' };
    throw new Error(`unexpected production integration Gateway method ${method}`);
  } };
  const host = fakePublishedApi(stateDir, { gateway });
  try {
    const seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true, activity: true, search: true, analysis: true, attention: true } });
    try {
      seed.createTopic({ topicId, name: 'Project: Fictional production analysis', paraCategory: 'area', lifecycle: 'active', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
      seed.createSourceReference({ version: 1, referenceId: sourceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'fictional-production-analysis', observedRevision: 'fictional-analysis-source-r1', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' });
      seed.recordTopicAnalysisRun({ runId: 'fictional-prior-analysis-run', schemaVersion: 1, trigger: 'manual', outcome: 'success', baselineCursor: { nextTopicId: null, nextSourceId: null }, successCursor: { nextTopicId: null, nextSourceId: null }, changedCount: 0, evaluatedCount: 0, proposalCount: 0, retainedOverflowCount: 0, startedAt: '2026-08-21T00:00:00.000Z', finishedAt: '2026-08-21T00:00:01.000Z' });
    } finally { seed.close(); }
    plugin.register(host.api);
    const service = host.services[0];
    await service.start();
    const statusEnvelope = await host.authenticatedGatewayRequest('command-center.v1.sources.status', { schemaVersion: 1 });
    assert.equal(statusEnvelope.result.mode, 'degraded');
    assert.equal(statusEnvelope.result.unavailableCapabilities.includes('analysis'), true);

    const params = { schemaVersion: 1, topicId, input: {}, logicalOperationId };
    await assert.rejects(host.authenticatedGatewayRequest('command-center.v1.analysis.run', params), (error) => error.code === 'feature-unavailable');
    assert.equal(service.topicAnalysisRunner, undefined);
  } finally {
    await host.services[0]?.stop?.();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('plugin readiness precedes deferred Search rebuild and shutdown settles the producer', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-deferred-search-'));
  let releaseRebuild;
  const rebuild = new Promise((resolve) => { releaseRebuild = resolve; });
  const events = [];
  const api = { runtime: { state: { resolveStateDir: () => stateDir } }, logger: { warn: (message) => events.push(['warning', message]) }, pluginConfig: {} };
  const service = createMetadataService(api, {
    searchRebuildServiceFactory: () => ({
      async rebuild() { events.push(['rebuild', 'started']); await rebuild; events.push(['rebuild', 'settled']); }
    })
  });
  try {
    const startup = service.start().then(() => events.push(['service', 'ready']));
    await startup;
    assert.deepEqual(events, [['service', 'ready']], 'plugin readiness must precede disposable projection work');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [['service', 'ready']]);
    await service.stop();
    assert.deepEqual(events, [['service', 'ready']]);
  } finally {
    releaseRebuild?.();
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('plugin Search commit passes through verified freshness publication', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-search-freshness-'));
  let commits = 0;
  const service = createMetadataService({ runtime: { state: { resolveStateDir: () => stateDir } }, logger: {}, pluginConfig: {} }, {
    searchRebuildServiceFactory: () => ({
      async prepareAuthorized(input) { return { schemaVersion: 1, status: 'prepared', topicIds: [input.topicId] }; },
      async rebuildPrepared() { commits += 1; return { topicIds: [] }; }
    })
  });
  try {
    await service.start();
    await assert.rejects(service.searchPrepareRebuild({ topicId: 'fictional-topic', logicalOperationId: randomUUID() }), (error) => error?.code === 'capability-unavailable');
    await assert.rejects(service.searchRebuild({ topicId: 'fictional-topic', logicalOperationId: randomUUID() }), (error) => error?.code === 'capability-unavailable');
    assert.equal(commits, 0, 'first-live refusal must precede the deferred publisher');
  } finally {
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('plugin startup does not dispatch Gateway work before the host request context is active', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-gateway-bind-'));
  let requests = 0;
  let availabilityChecks = 0;
  let rebuilds = 0;
  const scheduled = [];
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, scheduler: true, activity: true, search: true, analysis: true, attention: true } });
  try {
    seed.setTopicAnalysisSettings({ schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', nextDueAt: dueAt, initialized: true, updatedAt: dueAt });
  } finally { seed.close(); }
  const api = {
    runtime: {
      state: { resolveStateDir: () => stateDir },
      gateway: {
        isAvailable: async () => { availabilityChecks += 1; return false; },
        request: async () => { requests += 1; throw new Error('pre-bind Gateway dispatch'); }
      }
    },
    logger: {},
    pluginConfig: {}
  };
  const service = createMetadataService(api, {
    searchRebuildServiceFactory: () => ({ async rebuild() { rebuilds += 1; } })
  });
  try {
    await service.start({ getCron: () => ({
      list: async () => scheduled,
      add: async (input) => {
        const job = { ...input, id: 'fictional-weekly-analysis', configRevision: 'revision-1' };
        scheduled.push(job);
        return job;
      }
    }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(availabilityChecks, 0, 'activation must not enter the lazily loaded Gateway runtime before binding');
    assert.equal(requests, 0);
    assert.equal(rebuilds, 0);
    assert.equal(scheduled.length, 0, 'first-live startup must leave native Cron unchanged');
    assert.equal(service.topicAnalysisSchedule, undefined);
  } finally {
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('plugin shutdown aborts a deferred Search rebuild before closing owned state', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-cancel-search-'));
  const events = [];
  const api = { runtime: { state: { resolveStateDir: () => stateDir } }, logger: {}, pluginConfig: {} };
  const service = createMetadataService(api, {
    searchRebuildServiceFactory: () => ({
      async rebuild({ signal }) {
        events.push('rebuild-started');
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => { events.push('rebuild-aborted'); reject(signal.reason); }, { once: true }));
      }
    })
  });
  try {
    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await service.stop();
    assert.deepEqual(events, [], 'deferred Search owner must not be acquired');
  } finally {
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('real first-live plugin activates Attention without acquiring the deferred notification owner', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-plugin-notifications-'));
  const host = fakePublishedApi(stateDir);
  try {
    plugin.register(host.api);
    assert.deepEqual(host.declarations, []);
    assert.equal(host.descriptors.length, 0);
    assert.equal(host.services.length, 1);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center' && route.auth === 'gateway'), true);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center/app.js' && route.auth === 'plugin'), true);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center/styles.css' && route.auth === 'plugin'), true);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center/markdown.js' && route.auth === 'plugin'), true);
    assert.equal(host.routes.some((route) => route.path === '/plugins/command-center/api/search/rebuild' && route.auth === 'gateway' && route.match === 'exact'), true);
    const service = host.services[0];
    await service.start();
    assert.equal(service.notificationService, undefined);
    assert.ok(service.attentionService);
    assert.ok(service.dashboardService);
    assert.equal(host.candidates.length, 0);
    await service.stop();
  } finally {
    await host.services[0]?.stop?.();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('plugin activation does not require the deferred notification emitter API', () => {
  const host = fakePublishedApi(path.join(os.tmpdir(), 'fictional-command-center-state'));
  delete host.api.notifications;
  assert.doesNotThrow(() => plugin.register(host.api));
  const refused = fakePublishedApi(path.join(os.tmpdir(), 'fictional-command-center-state-refused'));
  refused.api.notifications.registerEmitter = () => undefined;
  assert.doesNotThrow(() => plugin.register(refused.api));
  assert.deepEqual(refused.declarations, []);
});

test('explicit Control UI mutation disablement retains reads and rejects every public mutation route', async () => {
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
    const blockedOperationId = randomUUID();
    await assert.rejects(() => host.authenticatedGatewayRequest('command-center.v1.sessions.create', {
      schemaVersion: 1,
      topicId: 'fictional-degraded-source-topic',
      logicalOperationId: blockedOperationId,
      expectedRevision: 1,
      label: 'Blocked source mutation'
    }), (error) => error?.code === 'capability-unavailable' && error?.details?.status === 'unavailable');
  } finally {
    await host.services[0]?.stop?.();
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
