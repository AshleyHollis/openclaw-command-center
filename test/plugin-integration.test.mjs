import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import plugin from '../src/plugin.mjs';
import { createMetadataService } from '../src/plugin-service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createNotificationService } from '../src/notifications/service.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';
import { createHostFileAccessFixture, installHostFileAccessFixture } from './support/host-file-access-fixture.mjs';
import { enrollFixtureFolder } from './support/note-folder-fixture.mjs';

const qualifyOpenLoop = (service, method, params) => invokeBridgeMethod(service, method, params, 'fictional-qualification-request', 'fictional-operator');
const qualifyRegisteredOpenLoop = async (host, method, params) => (await host.authenticatedGatewayRequest(method, params)).result;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  : value;
const operationDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
function fictionalTextPdf(lines) {
  const content = ['BT', '/F1 11 Tf', '50 740 Td', ...lines.flatMap((line, index) => index === 0 ? [`(${line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`] : ['0 -18 Td', `(${line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`]), 'ET'].join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}
const removePersistedSourceReference = (stateDir, referenceId) => {
  const database = new DatabaseSync(path.join(stateDir, 'plugins', 'command-center', 'metadata.sqlite'));
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('DELETE FROM source_references WHERE reference_id = ?').run(referenceId);
  } finally { database.close(); }
};

function fakePublishedApi(stateDir, { bindingAvailable = false, pluginConfig = {}, gateway, fileAccess } = {}) {
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
    runtime: { state: { resolveStateDir: () => stateDir }, ...(gateway ? { gateway } : {}), ...(fileAccess ? { fileAccess } : {}) },
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
      // Open-loop tests inject their Scheduler adapter directly because this
      // focused host does not emulate OpenClaw's AsyncLocalStorage-backed
      // Gateway dispatch scope. Other native routes retain their client grant.
      const client = { connId: 'fictional-current-connection', authenticatedUserProfile: { profileId: 'fictional-operator' },
        ...(name.startsWith('command-center.v1.open-loops.') ? {} : { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } }) };
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

test('recovered inbound tool registration resolves the exact active service owners', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-inbound-owner-'));
  const fileAccess = createHostFileAccessFixture();
  const host = fakePublishedApi(stateDir, { fileAccess });
  const active = createMetadataService(host.api);
  const recovered = createMetadataService(host.api);
  try {
    await active.start();
    const owners = recovered.getTopicMaintenanceOwners();
    assert.equal(owners.sourceService, active.sourceService);
    assert.equal(owners.metadata, active.sourceService.metadata);
  } finally {
    await active.stop();
    assert.deepEqual(recovered.getTopicMaintenanceOwners(), {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

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
      return { schemaVersion: 1, path: input.path, bytes: Buffer.from('Invoice: INV-FICTIONAL-SELECTED\nPayee: Fictional Electrician\nPurpose: final switchboard work\nAmount due: AUD 480.00\nPlease pay after review.'), revision: 'authoritative-v7', sourceReference: { referenceId: input.referenceId } };
    };
    const bridgeRequest = { schemaVersion: 1, logicalOperationId: randomUUID(), authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-document', path: 'selected-invoice.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] };
    const request = { ...bridgeRequest, authenticatedOperatorId: 'fictional-operator' };
    const result = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.intake-selected', bridgeRequest);
    assert.deepEqual(readInput, { schemaVersion: 1, topicId: 'topic-selected-document', referenceId: 'document:selected-invoice', path: 'selected-invoice.txt', observedRevision: 'authoritative-v7', sourceKind: 'document', returnBytes: true });
    assert.equal(result.results[0].sourceVersion, 'authoritative-v7');
    assert.equal(result.results[0].loop.title, 'Pay final switchboard work from Fictional Electrician');
    service.sourceService.notesRead = async () => ({ schemaVersion: 1, path: 'selected-invoice.txt', bytes: Buffer.from('Invoice: INV-FICTIONAL-SELECTED\nPayee: Changed Source\nPurpose: changed after response loss\nAmount due: AUD 999.00'), revision: 'authoritative-v8', sourceReference: { referenceId: 'document:selected-invoice' } });
    const replay = await service.openLoopsIngestSelected(request);
    assert.equal(replay.results[0].sourceVersion, 'authoritative-v7', 'an unchanged retry replays before rereading a newer document revision');
    assert.equal(service.openLoopsGet({ loopId: result.results[0].loop.loopId }).loop.amount, 48000);
    await assert.rejects(() => service.openLoopsIngestSelected({ schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-document', path: 'selected-invoice.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', content: 'caller supplied' }] }), /selected document/i);
    service.sourceService.notesRead = async () => { throw Object.assign(new Error('fictional source missing'), { code: 'not-found' }); };
    const unavailable = await service.openLoopsIngestSelected({ schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-document', path: 'selected-invoice.txt', occurredAt: '2026-09-21T00:00:00.000Z', observedAt: '2026-09-21T00:01:00.000Z' }] });
    assert.equal(unavailable.freshness.status, 'unavailable');
    assert.equal(unavailable.results[0].loop.state, 'confirmed');
    assert.match(unavailable.results[0].sourceVersion, /^unavailable:authoritative-v7:not-found$/u);
    const afterOutage = service.openLoopsGet({ loopId: result.results[0].loop.loopId });
    assert.equal(afterOutage.loop.state, 'confirmed', 'a source outage must not resolve the existing obligation');
    assert.equal(afterOutage.evidence.some(item => item.sourceAvailable === false), true, 'later Attention reads must expose the durable unavailable source evidence');
    await service.stop(); service = undefined;
    removePersistedSourceReference(stateDir, 'document:selected-invoice');
    const restartedHost = fakePublishedApi(stateDir); plugin.register(restartedHost.api); service = restartedHost.services[0]; await service.start();
    const replayWithoutReference = await service.openLoopsIngestSelected(request);
    assert.equal(replayWithoutReference.results[0].sourceVersion, 'authoritative-v7', 'a completed receipt replays after its Source Reference is removed');
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('authenticated quick capture uses the durable shared owner and survives restart', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-quick-capture-'));
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-quick-capture', name: 'Fictional home', paraCategory: 'area', lifecycle: 'active' });
    seed.close();
    let host = fakePublishedApi(stateDir); plugin.register(host.api); service = host.services[0]; await service.start();
    const params = { schemaVersion: 1, logicalOperationId: randomUUID(), captureId: randomUUID(), capturedAt: '2026-09-20T01:00:00.000Z', topicId: 'topic-quick-capture', captureKind: 'task', title: 'Book the fictional electrician' };
    const first = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.capture', params);
    const replay = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.capture', params);
    assert.equal(first.loop.loopId, replay.loop.loopId);
    assert.equal(first.loop.state, 'confirmed');
    assert.equal(service.openLoopsList({ limit: 20 }).total, 1);
    await service.stop(); service = undefined;

    host = fakePublishedApi(stateDir); plugin.register(host.api); service = host.services[0]; await service.start();
    assert.equal(service.openLoopsGet({ loopId: first.loop.loopId }).loop.title, 'Book the fictional electrician');
    assert.equal(service.openLoopsList({ limit: 20 }).total, 1);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('registered selected PDF intake stays suggested until an operator confirms corrected bill facts', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-pdf-'));
  const gateway = fictionalSchedulerGateway();
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-selected-pdf', paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'document:selected-pdf', topicId: 'topic-selected-pdf', sourceSystem: 'fictional-documents', sourceKind: 'document', externalSourceId: 'fictional-bill.pdf', observedRevision: 'pdf-v1' });
    seed.createSourceReference({ version: 1, referenceId: 'document:selected-pdf-reject', topicId: 'topic-selected-pdf', sourceSystem: 'fictional-documents', sourceKind: 'document', externalSourceId: 'fictional-marketing.pdf', observedRevision: 'pdf-reject-v1' });
    seed.close();
    const host = fakePublishedApi(stateDir, { gateway }); plugin.register(host.api); service = host.services[0]; await service.start();
    service.sourceService.notesRead = async input => ({ schemaVersion: 1, path: input.path, bytes: fictionalTextPdf(['Invoice: INV-PDF-REGISTERED', 'Payee: Fictional Plumber', 'Amount due: AUD 98.00', 'Due: 2026-10-10T00:00:00.000Z', 'Please pay after review.']), revision: 'pdf-v1', sourceReference: { referenceId: input.referenceId } });
    const intake = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.intake-selected', { schemaVersion: 1, logicalOperationId: randomUUID(), authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-pdf' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-pdf', path: 'fictional-bill.pdf', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] });
    assert.equal(intake.results[0].loop.state, 'suggested');
    assert.equal(intake.results[0].loop.paymentState, 'potential');
    const detail = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.get', { schemaVersion: 1, loopId: intake.results[0].loop.loopId });
    assert.equal(detail.evidence[0].extractionStatus, 'pdf-text-extracted');
    assert.deepEqual(detail.evidence[0].pageEvidence, [1]);
    const confirmed = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: intake.results[0].loop.loopId, expectedRevision: 1, decision: 'confirm', amount: 10200, currency: 'AUD', dueDate: '2026-10-12', dueTimeZone: 'Australia/Brisbane', rationale: 'Verified the fictional original and corrected the extracted total and calendar due date.' });
    assert.equal(confirmed.loop.state, 'confirmed');
    assert.equal(confirmed.loop.paymentState, 'unpaid');
    assert.equal(confirmed.loop.amount, 10200);
    assert.equal(confirmed.loop.dueDate, '2026-10-12');
    assert.equal(gateway.jobs.size, 1);
    service.sourceService.notesRead = async input => ({ schemaVersion: 1, path: input.path, bytes: fictionalTextPdf(['Invoice: INV-PDF-NOT-OURS', 'Payee: Fictional Marketing', 'Amount due: AUD 45.00', 'Please pay.']), revision: 'pdf-reject-v1', sourceReference: { referenceId: input.referenceId } });
    const rejectionCandidate = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.intake-selected', { schemaVersion: 1, logicalOperationId: randomUUID(), authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-pdf-reject' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-pdf', path: 'fictional-marketing.pdf', occurredAt: '2026-09-20T00:02:00.000Z', observedAt: '2026-09-20T00:03:00.000Z' }] });
    const dismissed = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: rejectionCandidate.results[0].loop.loopId, expectedRevision: 1, decision: 'dismiss', rationale: 'Verified the fictional original and rejected this suggestion as irrelevant.' });
    assert.equal(dismissed.loop.state, 'cancelled');
    assert.equal(dismissed.loop.paymentState, 'cancelled');
    assert.equal(gateway.jobs.size, 1, 'dismissing a PDF suggestion must not create a Reminder');
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('malformed selected-document fields complete and replay without rereading or scheduling', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-document-malformed-due-'));
  const gateway = fictionalSchedulerGateway();
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-selected-malformed-due', paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'document:selected-malformed-due', topicId: 'topic-selected-malformed-due', sourceSystem: 'fictional-documents', sourceKind: 'document', externalSourceId: 'selected-malformed-due.txt', observedRevision: 'authoritative-malformed-v1' });
    seed.close();
    const host = fakePublishedApi(stateDir, { gateway }); plugin.register(host.api); service = host.services[0]; await service.start();
    let reads = 0;
    service.sourceService.notesRead = async input => {
      reads += 1;
      return { schemaVersion: 1, path: input.path, bytes: Buffer.from('Invoice: INV-FICTIONAL-MALFORMED-DUE\nAmount due: AUD 20.00\nDue: 2026-02-30T00:00:00Z'), revision: 'authoritative-malformed-v1', sourceReference: { referenceId: input.referenceId } };
    };
    const request = { schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-malformed-due' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-malformed-due', path: 'selected-malformed-due.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] };
    const applied = await service.openLoopsIngestSelected(request);
    assert.equal(applied.results[0].loop.amount, 2000);
    assert.equal(applied.results[0].loop.dueAt, undefined);
    assert.equal(gateway.jobs.size, 0);
    assert.equal(reads, 1);
    service.sourceService.notesRead = async () => { reads += 1; throw new Error('completed malformed-date intake must not reread'); };
    const replayed = await service.openLoopsIngestSelected(request);
    assert.equal(replayed.results[0].loop.loopId, applied.results[0].loop.loopId);
    assert.equal(reads, 1);
    const overlongRequest = { ...request, logicalOperationId: randomUUID(), selections: [{ ...request.selections[0], observedAt: '2026-09-20T00:02:00.000Z' }] };
    service.sourceService.notesRead = async input => {
      reads += 1;
      return { schemaVersion: 1, path: input.path, bytes: Buffer.from(`Invoice: INV-FICTIONAL-OVERLONG-DUE\nAmount due: AUD 70.00\nDue: ${'x'.repeat(65)}`), revision: 'authoritative-malformed-v2', sourceReference: { referenceId: input.referenceId } };
    };
    const overlong = await service.openLoopsIngestSelected(overlongRequest);
    assert.equal(overlong.results[0].loop.amount, 7000);
    assert.equal(overlong.results[0].loop.dueAt, undefined);
    assert.equal(gateway.jobs.size, 0);
    service.sourceService.notesRead = async () => { reads += 1; throw new Error('completed overlong-date intake must not reread'); };
    const overlongReplay = await service.openLoopsIngestSelected(overlongRequest);
    assert.equal(overlongReplay.results[0].loop.loopId, overlong.results[0].loop.loopId);
    assert.equal(reads, 2);
    const amountRequest = { ...request, logicalOperationId: randomUUID(), selections: [{ ...request.selections[0], observedAt: '2026-09-20T00:03:00.000Z' }] };
    service.sourceService.notesRead = async input => {
      reads += 1;
      return { schemaVersion: 1, path: input.path, bytes: Buffer.from(`Invoice: INV-FICTIONAL-OVERLONG-AMOUNT\nAmount due: ${'x'.repeat(81)}\nPlease pay this invoice after review.`), revision: 'authoritative-malformed-v3', sourceReference: { referenceId: input.referenceId } };
    };
    const amountless = await service.openLoopsIngestSelected(amountRequest);
    assert.equal(amountless.results[0].loop.amount, undefined);
    assert.equal(amountless.results[0].loop.currency, undefined);
    assert.equal(gateway.jobs.size, 0);
    service.sourceService.notesRead = async () => { reads += 1; throw new Error('completed overlong-amount intake must not reread'); };
    const amountReplay = await service.openLoopsIngestSelected(amountRequest);
    assert.equal(amountReplay.results[0].loop.loopId, amountless.results[0].loop.loopId);
    assert.equal(reads, 3);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('selected-source root reconciles a committed child after process interruption without rereading content', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-document-recovery-'));
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-selected-recovery', paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'document:selected-recovery', topicId: 'topic-selected-recovery', sourceSystem: 'fictional-documents', sourceKind: 'document', externalSourceId: 'selected-recovery.txt', observedRevision: 'authoritative-recovery-v1' });
    seed.close();
    const host = fakePublishedApi(stateDir); plugin.register(host.api); service = host.services[0]; await service.start();
    const input = { schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:selected-recovery' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-selected-recovery', path: 'selected-recovery.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] };
    let metadata = service.getTopicMaintenanceOwners().metadata;
    const prepared = metadata.prepareSelectedSourceBatch({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, authorization: { ...input.authorization, scopeId: 'fictional-operator' }, baselineThrough: input.baselineThrough, window: { cursor: `selected:${input.logicalOperationId}`, nextCursor: `complete:${input.logicalOperationId}`, hasMore: false }, selections: [{ version: 'authoritative-recovery-v1', occurredAt: input.selections[0].occurredAt, observedAt: input.selections[0].observedAt, availability: 'available', content: 'Invoice: INV-RECOVERY-1\nPayee: Fictional Recovery Supplier\nPurpose: recovery proof\nAmount due: AUD 77.00', topicId: 'topic-selected-recovery' }] });
    const rootIntent = { schemaVersion: 1, operatorId: 'fictional-operator', authorization: input.authorization, baselineThrough: input.baselineThrough, selections: input.selections };
    const pending = metadata.recordOperation({ logicalOperationId: input.logicalOperationId, transportRequestId: input.logicalOperationId, intentDigest: operationDigest(rootIntent), operationKind: 'selected-source-intake-root', state: 'pending', resultStatus: 'pending', resultIdentity: JSON.stringify({ schemaVersion: 1, status: 'prepared', prepared }), observedRevision: 'authoritative-recovery-v1', createdAt: input.selections[0].observedAt, updatedAt: input.selections[0].observedAt });
    assert.equal(pending.resultIdentity.includes('Amount due'), false, 'recoverable intent must not persist raw source content');
    metadata.applyPreparedSelectedSourceBatch(prepared);
    await service.stop(); service = undefined;
    removePersistedSourceReference(stateDir, 'document:selected-recovery');
    const restartedHost = fakePublishedApi(stateDir); plugin.register(restartedHost.api); service = restartedHost.services[0]; await service.start(); metadata = service.getTopicMaintenanceOwners().metadata;
    let reads = 0; service.sourceService.notesRead = async () => { reads += 1; throw new Error('prepared recovery must not reread'); };
    const recovered = await service.openLoopsIngestSelected(input);
    assert.equal(reads, 0);
    assert.equal(recovered.results[0].loop.amount, 7700);
    assert.equal(metadata.getOperation(input.logicalOperationId).state, 'applied');
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('selected-source plugin route composes the descriptor-backed document owner through restart', { skip: process.platform === 'win32' ? 'Linux descriptor-backed source owner required' : false }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-document-owner-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'command-center-selected-document-vault-'));
  const gateway = fictionalSchedulerGateway(); const fileAccess = createHostFileAccessFixture();
  let service; let seed;
  try {
    seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, scheduler: true } });
    seed.createTopic({ topicId: 'topic-real-selected-document', paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'folder:real-selected-document', topicId: 'topic-real-selected-document', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: vault, observedRevision: null });
    const releaseEnrollmentAccess = installHostFileAccessFixture();
    try { await enrollFixtureFolder(seed, 'folder:real-selected-document', vault); }
    finally { releaseEnrollmentAccess(); }
    seed.close(); seed = undefined;
    const firstHost = fakePublishedApi(stateDir, { gateway, fileAccess }); plugin.register(firstHost.api); service = firstHost.services[0]; await service.start();
    const documentText = 'Invoice: INV-REAL-OWNER-1\nPayee: Fictional Tiler\nPurpose: laundry floor preparation\nAmount due: AUD 910.00\nDue: 2026-10-08T03:00:00.000Z';
    const created = await service.sourceService.notesCreate({ schemaVersion: 1, topicId: 'topic-real-selected-document', path: 'fictional-invoice.txt', content: Buffer.from(documentText, 'utf8'), sourceKind: 'document', logicalOperationId: randomUUID() });
    const reference = created.value.note.sourceReference;
    const input = { schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { sourceSystem: reference.sourceSystem, sourceKind: 'document', resourceId: reference.referenceId }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-real-selected-document', path: 'fictional-invoice.txt', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] };
    const ingested = await service.openLoopsIngestSelected(input);
    assert.equal(ingested.results[0].loop.amount, 91000); assert.equal(gateway.jobs.size, 1);
    const loopId = ingested.results[0].loop.loopId; await service.stop(); service = undefined;
    const restartedHost = fakePublishedApi(stateDir, { gateway, fileAccess }); plugin.register(restartedHost.api); service = restartedHost.services[0]; await service.start();
    assert.equal(service.openLoopsGet({ loopId }).loop.amount, 91000);
    await rm(path.join(vault, 'fictional-invoice.txt'));
    const unavailable = await service.openLoopsIngestSelected({ ...input, logicalOperationId: randomUUID(), selections: [{ ...input.selections[0], observedAt: '2026-09-21T00:01:00.000Z' }] });
    assert.equal(unavailable.freshness.status, 'unavailable'); assert.equal(service.openLoopsGet({ loopId }).loop.state, 'confirmed'); assert.equal(gateway.jobs.size, 1);
  } finally {
    seed?.close(); await service?.stop();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('historical selected invoices remain quiet and never create an overdue native Reminder', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-historical-selected-document-'));
  const gateway = fictionalSchedulerGateway();
  let service;
  try {
    const seed = openCommandCenterMetadataService({ stateDir });
    seed.createTopic({ topicId: 'topic-historical-document', paraCategory: 'project', lifecycle: 'active' });
    seed.createSourceReference({ version: 1, referenceId: 'document:historical-invoice', topicId: 'topic-historical-document', sourceSystem: 'fictional-documents', sourceKind: 'document', externalSourceId: 'historical-invoice.txt', observedRevision: 'historical-v1' });
    seed.close();
    const host = fakePublishedApi(stateDir, { gateway }); plugin.register(host.api); service = host.services[0]; await service.start();
    service.sourceService.notesRead = async input => ({ schemaVersion: 1, path: input.path, bytes: Buffer.from('Invoice: INV-HISTORICAL-1\nPayee: Fictional Historical Supplier\nPurpose: completed old work\nAmount due: AUD 125.00\nDue: 2026-08-15T00:00:00.000Z'), revision: 'historical-v1', sourceReference: { referenceId: input.referenceId } });
    const result = await service.openLoopsIngestSelected({ schemaVersion: 1, logicalOperationId: randomUUID(), authenticatedOperatorId: 'fictional-operator', authorization: { sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:historical-invoice' }, baselineThrough: '2026-09-01T00:00:00.000Z', selections: [{ topicId: 'topic-historical-document', path: 'historical-invoice.txt', occurredAt: '2026-08-01T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z' }] });
    assert.equal(result.results[0].historicalBaseline, true);
    assert.equal(gateway.jobs.size, 0);
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
    const corrected = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 1, decision: 'correct-date', dueDate: '2026-10-05', dueTimeZone: 'Australia/Brisbane', rationale: 'The fictional invoice states a local calendar date without a time.' });
    assert.equal(corrected.loop.dueDate, '2026-10-05'); assert.equal(corrected.loop.dueAt, undefined);
    assert.equal(corrected.reminder.action, 'create'); assert.equal(gateway.jobs.size, 1); assert.equal([...gateway.jobs.values()][0].schedule.at, '2026-10-04T23:00:00.000Z');
    const externallyChanged = [...gateway.jobs.values()][0]; externallyChanged.configRevision = 'revision-external-change';
    const deferred = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 2, decision: 'defer', reviewAt: '2026-10-02T09:00:00.000Z', rationale: 'Review after the fictional pay cycle.' });
    assert.equal(deferred.reminder.action, 'reschedule'); assert.equal([...gateway.jobs.values()][0].schedule.at, '2026-10-02T09:00:00.000Z', 'authoritative Cron revision wins over the stale Source Reference revision');
    const paid = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.payment-status', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: created.loop.loopId, expectedRevision: 3, paymentState: 'paid', rationale: 'The fictional settlement was verified.' });
    assert.equal(paid.reminder.action, 'cancel'); assert.equal([...gateway.jobs.values()][0].enabled, false);
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test('registered renovation bridge preserves exact purchase relationships and separate replacement obligations', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-renovation-bridge-'));
  const gateway = fictionalSchedulerGateway();
  let service;
  const at = '2026-09-20T02:00:00.000Z';
  const source = (externalId) => ({ system: 'fictional-renovation-source', kind: 'operator-evidence', externalId, version: 'v1' });
  const ref = (kind, id) => ({ kind, namespace: 'fictional-home-project', id });
  try {
    const seed = openCommandCenterMetadataService({ stateDir }); seed.createTopic({ topicId: 'topic-renovation-follow-through', paraCategory: 'project', lifecycle: 'active' }); seed.close();
    const host = fakePublishedApi(stateDir, { gateway });
    plugin.register(host.api);
    service = host.services[0];
    await service.start();
    const requirement = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-requirement', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 0, requirement: { schemaVersion: 1, source: source('required-mixer'), requirement: ref('purchase', 'buy-mixer'), occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Buy fictional sink mixer' } });
    assert.equal(requirement.loop.state, 'waiting');
    const purchased = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-purchase', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 1, reconciliation: { schemaVersion: 1, source: source('receipt-mixer'), requirement: ref('purchase', 'buy-mixer'), purchase: ref('purchase', 'purchased-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false } });
    assert.equal(purchased.loop.state, 'resolved');
    const correctedPurchase = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-purchase-correction', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 2, correction: { schemaVersion: 1, source: source('receipt-mixer-correction'), requirement: ref('purchase', 'buy-mixer'), purchase: ref('purchase', 'purchased-mixer-001'), occurredAt: at, observedAt: at, rationale: 'The fictional receipt line was linked to the wrong requirement.' } });
    assert.equal(correctedPurchase.loop.state, 'waiting');
    const replacement = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-replacement', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 0, replacement: { schemaVersion: 1, source: source('replacement-mixer'), replacementPurchase: ref('purchase', 'replacement-mixer-002'), replacedItem: ref('renovation-item', 'faulty-mixer-001'), obligation: ref('return', 'return-faulty-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Return fictional faulty mixer', dueAt: '2026-09-27T00:00:00.000Z' } });
    assert.equal(replacement.loop.state, 'confirmed');
    assert.equal(replacement.loop.expectedEvent, 'return completion');
    assert.notEqual(replacement.loop.loopId, purchased.loop.loopId);
    const refund = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-replacement', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 0, replacement: { schemaVersion: 1, source: source('replacement-mixer-refund'), replacementPurchase: ref('purchase', 'replacement-mixer-002'), replacedItem: ref('renovation-item', 'faulty-mixer-001'), obligation: ref('refund', 'refund-faulty-mixer-001'), occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Await fictional mixer refund', dueAt: '2026-10-04T00:00:00.000Z' } });
    const returned = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: replacement.loop.loopId, expectedRevision: 1, decision: 'resolve', rationale: 'The fictional carrier receipt confirms the old mixer was returned.' });
    assert.equal(returned.loop.state, 'resolved'); assert.equal(service.openLoopsGet({ loopId: refund.loop.loopId }).loop.state, 'confirmed');
    const order = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-requirement', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 0, requirement: { schemaVersion: 1, source: source('tap-order-required'), requirement: ref('purchase', 'tap-order-17'), topicId: 'topic-renovation-follow-through', occurredAt: at, observedAt: at, historicalBaseline: false, title: 'Await fictional tap order' } });
    const partial = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.renovation-fulfilment', { schemaVersion: 1, logicalOperationId: randomUUID(), expectedRevision: 1, fulfilment: { schemaVersion: 1, source: source('tap-order-partial'), requirement: ref('purchase', 'tap-order-17'), fulfilmentKind: 'delivered', installationRequired: false, fulfilledItemIds: ['tap-body', 'tap-hose'], outstandingItemIds: ['tap-handle'], expectedAt: '2026-09-25T00:00:00.000Z', note: 'Two of three fictional items arrived.', topicId: 'topic-renovation-follow-through', occurredAt: at, observedAt: at, historicalBaseline: false } });
    assert.equal(partial.loop.state, 'monitoring'); assert.equal(partial.loop.expectedEvent, 'delivery of tap-handle'); assert.equal(partial.loop.loopId, order.loop.loopId);
    const review = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: randomUUID(), loopId: partial.loop.loopId, expectedRevision: 2, decision: 'defer', reviewAt: '2026-09-25T09:00:00.000Z', rationale: 'Review Friday if the fictional handle remains outstanding.' });
    assert.equal(review.loop.reviewAt, '2026-09-25T09:00:00.000Z'); assert.equal(review.reminder.action, 'reschedule');
    const detail = await qualifyRegisteredOpenLoop(host, 'command-center.v1.open-loops.get', { schemaVersion: 1, loopId: partial.loop.loopId });
    assert.deepEqual(detail.evidence.find(item => item.eventKind === 'delivered').outstandingItemIds, ['tap-handle']);
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
