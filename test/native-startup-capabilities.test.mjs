import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMetadataService } from '../src/plugin-service.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

// The public transcript SDK is an external boundary, not the capability under
// test. Never read a host transcript or invoke a live Gateway in this fixture.
const transcriptFixture = 'data:text/javascript,' + encodeURIComponent('export async function readVisibleSessionTranscriptMessageEntries() { throw new Error("Transcript fixture is unavailable"); }');
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'openclaw/plugin-sdk/session-transcript-runtime'
    ? { url: transcriptFixture, shortCircuit: true } : nextResolve(specifier, context);
} });

const topicId = 'fictional-native-startup';
const referenceId = 'fictional-primary-reference';
const sessionKey = 'agent:main:fictional-primary';
const sessionId = 'fictional-primary-session';

async function withStartedService(run, { pluginConfig = {}, sessionStore = true, category = 'project', startContext = {} } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-startup-'));
  let service;
  const rows = new Map([[sessionKey, { sessionId, label: 'Primary', updatedAt: 1 }]]);
  try {
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    try {
      metadata.createTopic({ topicId, paraCategory: category, lifecycle: 'active' });
      metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
      metadata.setSessionState({ referenceId, sessionId, status: 'open', isPrimary: true, displayName: 'Primary', updatedAt: '2026-09-06T00:00:00.000Z' });
    } finally { metadata.close(); }
    const catalog = {
      listSessionEntries: () => [...rows].map(([key, entry]) => ({ sessionKey: key, entry: { ...entry } })),
      getSessionEntry: ({ sessionKey: key }) => rows.has(key) ? { ...rows.get(key) } : undefined
    };
    const api = { runtime: { state: { resolveStateDir: () => stateDir }, ...(sessionStore ? { agent: { session: typeof sessionStore === 'object' ? sessionStore : catalog } } : {}) }, pluginConfig, logger: { warn() {} } };
    service = createMetadataService(api);
    await service.start(startContext);
    await run({ service, rows });
  } finally { await service?.stop(); await rm(stateDir, { recursive: true, force: true }); }
}

test('native startup exposes the public Session catalog without a legacy Gateway', async () => {
  await withStartedService(async ({ service }) => {
    const status = service.sourceService.status();
    assert.equal(status.unavailableCapabilities.includes('sessions'), false);
    assert.equal(status.unavailableCapabilities.includes('scheduler'), true);
    const result = await service.sourceService.sessionsList({ topicId });
    assert.deepEqual(result.conversations.map((conversation) => ({ sessionId: conversation.sessionId, isPrimary: conversation.isPrimary })), [{ sessionId, isPrimary: true }]);
  });
});

test('native startup uses write authority only for the current Session request', async () => {
  await withStartedService(async ({ service, rows }) => {
    const input = () => ({ topicId, logicalOperationId: randomUUID(), label: 'New Conversation' });
    await assert.rejects(service.sourceService.sessionsCreate(input()), (error) => error.code === 'capability-unavailable');
    const createdKey = 'agent:main:fictional-created';
    let dispatches = 0;
    const created = await service.sourceService.sessionsCreate(input(), { gatewayRequest: async (method, params) => {
      assert.equal(method, 'sessions.create');
      dispatches += 1;
      rows.set(createdKey, { sessionId: 'fictional-created-session', label: params.label, updatedAt: 2 });
      return { key: createdKey, sessionId: 'fictional-created-session', revision: '2' };
    } });
    assert.equal(created.status, 'applied');
    assert.equal(created.value.sessionId, 'fictional-created-session');
    assert.equal((await service.sourceService.sessionsList({ topicId })).conversations.length, 2);
    await assert.rejects(service.sourceService.sessionsCreate(input()), (error) => error.code === 'capability-unavailable');
    assert.equal(dispatches, 1);
  });
});

test('explicit Session disablement still refuses native reads and authenticated writes', async () => {
  await withStartedService(async ({ service }) => {
    assert.equal(service.sourceService.status().unavailableCapabilities.includes('sessions'), true);
    await assert.rejects(service.sourceService.sessionsList({ topicId }), (error) => error.code === 'capability-unavailable');
    await assert.rejects(service.sourceService.sessionsCreate({ topicId, logicalOperationId: randomUUID(), label: 'Denied' }, { gatewayRequest: async () => { assert.fail('A disabled Session source dispatched a write.'); } }), (error) => error.code === 'capability-unavailable');
  }, { pluginConfig: { sourceCapabilities: { sessions: false } } });
});

test('Cron availability alone enables neither Sessions nor the general scheduler', async () => {
  const jobs = [];
  const cron = { async list() { return jobs; }, async add(declaration) { const job = { ...declaration, id: 'fictional-analysis-schedule', configRevision: '1' }; jobs.push(job); return job; } };
  await withStartedService(async ({ service }) => {
    assert.equal(jobs.length, 1);
    const status = service.sourceService.status();
    assert.equal(status.unavailableCapabilities.includes('sessions'), true);
    assert.equal(status.unavailableCapabilities.includes('scheduler'), true);
    await assert.rejects(service.sourceService.sessionsList({ topicId }), (error) => error.code === 'capability-unavailable');
  }, { sessionStore: false, startContext: { getCron: () => cron } });
});

test('a malformed Session catalog is not advertised as available', async () => {
  await withStartedService(async ({ service }) => {
    assert.equal(service.sourceService.status().unavailableCapabilities.includes('sessions'), true);
    await assert.rejects(service.sourceService.sessionsList({ topicId }), (error) => error.code === 'capability-unavailable');
  }, { sessionStore: { listSessionEntries: true } });
});

test('an Archived Topic retains native catalog reads but cannot acquire write authority', async () => {
  await withStartedService(async ({ service }) => {
    assert.equal((await service.sourceService.sessionsList({ topicId })).conversations[0].sessionId, sessionId);
    await assert.rejects(service.sourceService.sessionsCreate({ topicId, logicalOperationId: randomUUID(), label: 'Denied' }, { gatewayRequest: async () => { assert.fail('An Archived Topic dispatched a write.'); } }), (error) => error.code === 'read-only');
  }, { category: 'archive' });
});

test('native catalog availability does not adopt a missing or replaced linked Session', async () => {
  await withStartedService(async ({ service, rows }) => {
    rows.set(sessionKey, { sessionId: 'fictional-foreign-session', label: 'Foreign', updatedAt: 2 });
    await assert.rejects(service.sourceService.sessionsList({ topicId }), (error) => error.code === 'source-recovery');
    await assert.rejects(service.sourceService.sessionsCreate({ topicId, logicalOperationId: randomUUID(), label: 'Denied' }, { gatewayRequest: async () => { assert.fail('An unverified Primary Session dispatched a write.'); } }), (error) => error.code === 'source-recovery');
  });
});
