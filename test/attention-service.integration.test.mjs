import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAttentionService as createAttentionServiceBase } from '../src/attention/service.mjs';

const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };
const fixtureServices = new WeakMap();
const createAttentionService = (options) => {
  const service = createAttentionServiceBase({ operatorId: 'operator-1', host: 'host-1', ...options });
  fixtureServices.get(options.metadata)?.add(service);
  return service;
};

async function withService(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-attention-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const services = new Set();
  fixtureServices.set(metadata, services);
  try { return await run({ stateDir, metadata }); } finally {
    for (const service of services) service.close();
    metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function occurrence(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceCapabilityId: 'fictional-monitor',
    stableSubjectId: 'subject-1',
    attentionReason: 'blocked-work',
    occurrenceId: 'occurrence-1',
    occurredAt: '2026-08-23T00:00:00.000Z',
    topicId: 'topic-1',
    sourceReferenceId: 'source-1',
    evidenceFacts: { facts: ['blocked-work'] },
    ...overrides
  };
}

async function approvedAct(service, request) {
  const pending = await service.act(request);
  assert.equal(pending.status, 'approval-required');
  return service.act({ ...request, logicalOperationId: randomUUID(), actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
}

test('normalized source occurrences create one durable episode and exact replay is idempotent', async () => {
  await withService(async ({ stateDir, metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'fictional-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const first = await service.ingest(occurrence());
    const replay = await service.ingest(occurrence());
    assert.equal(first.episode.episodeId, replay.episode.episodeId);
    assert.equal(replay.duplicate, true);
    assert.equal(first.episode.severity, 'High');
    assert.equal(service.list().episodes.length, 1);
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir, capabilities });
    const afterRestart = createAttentionService({ metadata: reopened, now: () => '2026-08-23T00:01:00.000Z' });
    assert.equal(afterRestart.list().episodes.length, 1);
    assert.equal(afterRestart.get(first.episode.episodeId).episode.revision, 1);
    afterRestart.close();
    reopened.close();
  });
});

test('unrelated capabilities may reuse the same source-local occurrence identity', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'fictional-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    service.registerSourceCapability({ sourceCapabilityId: 'independent-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const first = await service.ingest(occurrence({ occurrenceId: 'shared-local-occurrence' }));
    const second = await service.ingest(occurrence({ sourceCapabilityId: 'independent-monitor', occurrenceId: 'shared-local-occurrence' }));
    assert.notEqual(first.episode.episodeId, second.episode.episodeId);
    assert.deepEqual(service.list().episodes.map((episode) => episode.sourceCapabilityId).sort(), ['fictional-monitor', 'independent-monitor']);
    service.close();
  });
});

test('critical evidence breaks snooze and a verified action failure returns the same episode', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    let clock = '2026-08-23T00:00:00.000Z';
    const service = createAttentionService({ metadata, now: () => clock });
    service.registerSourceCapability({ sourceCapabilityId: 'fictional-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [{
      actionId: 'monitor.retry', label: 'Retry Monitor', kind: 'mutation',
      targetResolver: () => ({ stableSubjectId: 'subject-1' }), parameterSchema: { type: 'object', properties: {}, additionalProperties: false },
      sideEffects: ['Retries the fictional monitor operation.'], approvalMode: 'required', idempotency: { idempotent: false, transientRetryable: false },
      executor: async () => { const error = new Error('ambiguous'); error.ambiguous = true; throw error; },
      authoritativeVerifier: async () => false, successTransition: async () => 'Active'
    }] });
    const created = await service.ingest(occurrence({ occurrenceId: 'occurrence-a', evidenceFacts: { facts: [] }, attentionReason: 'monitoring' }));
    const snoozed = await service.act({ schemaVersion: 1, logicalOperationId: '11111111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'attention.snooze', input: { preset: 'PT72H' } });
    assert.equal(snoozed.episode.state, 'Snoozed');
    const critical = await service.ingest(occurrence({ occurrenceId: 'occurrence-b', attentionReason: 'monitoring', evidenceFacts: { facts: ['active-security-exposure'] } }));
    assert.equal(critical.episode.severity, 'Critical');
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '22222222-2222-4222-8222-222222222222', episodeId: critical.episode.episodeId, expectedEpisodeRevision: critical.episode.revision, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'monitor.retry', input: {} });
    assert.equal(result.status, 'unknown');
    assert.equal(result.episode.episodeId, critical.episode.episodeId);
    assert.equal(result.episode.severity, 'Critical');
    assert.equal(service.listActivity({ limit: 50 }).records.length, 2);
    clock = '2026-08-23T02:00:00.000Z';
    assert.equal(service.list().episodes.length, 1);
  });
});

test('required actions bind one immutable approval attempt and execute only after approval', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:00:00.000Z', operatorId: 'operator-1', host: 'host-1' });
    service.registerSourceCapability({ sourceCapabilityId: 'approval-monitor', actions: [{
      actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-1' }),
      parameterSchema: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false },
      sideEffects: ['Changes the fictional monitor mode.'], approvalMode: 'required', idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => ({ observedRevision: 'revision-2' }), authoritativeVerifier: async () => ({ outcome: 'applied', revision: 'revision-2' }), successTransition: async () => 'Resolved'
    }] });
    const created = await service.ingest({ schemaVersion: 1, sourceCapabilityId: 'approval-monitor', stableSubjectId: 'subject-1', attentionReason: 'approval', occurrenceId: 'approval-occurrence', occurredAt: '2026-08-23T00:00:00.000Z', topicId: 'topic-1', sourceReferenceId: 'source-1', evidenceFacts: {} });
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '33333333-3333-4333-8333-333333333333', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'monitor.change', input: { mode: 'safe' } });
    assert.equal(pending.status, 'approval-required');
    assert.equal(pending.approval.expiresAt, '2026-08-23T00:15:00.000Z');
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '34444444-4444-4444-8444-444444444444', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'approval.approve', input: {} }), /approvalId/i);
    const applied = await service.act({ schemaVersion: 1, logicalOperationId: '34444444-4444-4444-8444-444444444445', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.episode.state, 'Resolved');
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '35555555-5555-4555-8555-555555555555', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} }), /stale|conflict/i);
  });
});

test('expired approval decisions never dispatch at the exact expiry boundary or on reuse', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    let clock = '2026-08-23T00:00:00.000Z';
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => clock, operatorId: 'operator-1', host: 'host-1' });
    service.registerSourceCapability({ sourceCapabilityId: 'expiry-monitor', actions: [{
      actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-1' }),
      parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes the fictional monitor.'], approvalMode: 'required', idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => { dispatches += 1; return { observedRevision: 'revision-2' }; }, authoritativeVerifier: async () => ({ outcome: 'applied', revision: 'revision-2' }), successTransition: async () => 'Resolved'
    }] });
    const created = await service.ingest({ schemaVersion: 1, sourceCapabilityId: 'expiry-monitor', stableSubjectId: 'subject-1', attentionReason: 'approval', occurrenceId: 'expiry-occurrence', occurredAt: clock, topicId: 'topic-1', sourceReferenceId: 'source-1', evidenceFacts: {} });
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '36666666-6666-4666-8666-666666666666', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'monitor.change', input: {} });
    clock = pending.approval.expiresAt;
    const decision = { schemaVersion: 1, episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'approval.approve', input: {}, approvalId: pending.approval.approvalId };
    await assert.rejects(() => service.act({ ...decision, logicalOperationId: '37777777-7777-4777-8777-777777777777' }), (error) => error?.code === 'approval-expired');
    clock = '2026-08-23T00:15:01.000Z';
    await assert.rejects(() => service.act({ ...decision, logicalOperationId: '38888888-8888-4888-8888-888888888888' }), (error) => error?.code === 'approval-expired');
    assert.equal(dispatches, 0);
  });
});

test('an unchanged approval remains executable through minute fourteen', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    let clock = '2026-08-23T00:00:00.000Z';
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => clock, operatorId: 'operator-1', host: 'host-1' });
    service.registerSourceCapability({ sourceCapabilityId: 'validity-monitor', actions: [{ actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-1' }), parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes the fictional monitor.'], approvalMode: 'required', idempotency: { idempotent: false, transientRetryable: false }, executor: async () => { dispatches += 1; return {}; }, authoritativeVerifier: async () => ({ outcome: 'applied' }), successTransition: async () => 'Resolved' }] });
    const created = await service.ingest({ ...occurrence(), sourceCapabilityId: 'validity-monitor', occurrenceId: 'validity-occurrence' });
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '38999999-9999-4999-8999-999999999991', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'monitor.change', input: {} });
    clock = '2026-08-23T00:14:59.999Z';
    const result = await service.act({ schemaVersion: 1, logicalOperationId: '38999999-9999-4999-8999-999999999992', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
    assert.equal(result.status, 'applied');
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('approval execution expires if an asynchronous precondition read crosses its deadline', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    let clock = '2026-08-23T00:00:00.000Z';
    let preconditionReads = 0;
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => clock, operatorId: 'operator-1', host: 'host-1' });
    service.registerSourceCapability({
      sourceCapabilityId: 'deadline-monitor',
      preconditionReader: async () => {
        preconditionReads += 1;
        if (preconditionReads === 2) clock = '2026-08-23T00:15:00.000Z';
        return { available: true, revision: 'precondition-1' };
      },
      actions: [{
        actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-1' }),
        parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes a fictional monitor.'], approvalMode: 'required',
        idempotency: { idempotent: false, transientRetryable: false }, executor: async () => { dispatches += 1; return {}; }, authoritativeVerifier: async () => ({ outcome: 'applied' }), successTransition: async () => 'Resolved'
      }]
    });
    const created = await service.ingest({ ...occurrence(), sourceCapabilityId: 'deadline-monitor', occurrenceId: 'deadline-occurrence' });
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '39999999-9999-4999-8999-999999999991', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'monitor.change', input: {} });
    const decision = { schemaVersion: 1, logicalOperationId: '39999999-9999-4999-8999-999999999992', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    await assert.rejects(() => service.act(decision), (error) => error?.code === 'approval-expired');
    assert.equal(dispatches, 0);
    await assert.rejects(() => service.act({ ...decision, logicalOperationId: '39999999-9999-4999-8999-999999999993' }), (error) => error?.code === 'approval-expired');
    service.close();
  });
});

test('monitorable approval evidence exposes and performs presentation snooze', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:00:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'monitorable-approval', sourceKind: 'approval', monitoring: true, actions: [] });
    const created = await service.ingest({ schemaVersion: 1, sourceCapabilityId: 'monitorable-approval', stableSubjectId: 'subject-1', attentionReason: 'approval-monitor', occurrenceId: 'approval-snooze', occurredAt: '2026-08-23T00:00:00.000Z', topicId: 'topic-1', sourceReferenceId: 'source-1', evidenceFacts: {} });
    assert.deepEqual(service.get(created.episode.episodeId).episode.eligibleSnoozeChoices, ['NEXT_0700', 'PT72H', 'PT168H', 'custom']);
    const snoozed = await service.act({ schemaVersion: 1, logicalOperationId: '39999999-9999-4999-8999-999999999999', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'attention.snooze', input: { preset: 'PT72H' } });
    assert.equal(snoozed.episode.state, 'Snoozed');
  });
});

test('unverified action outcomes do not resolve episodes or expose Reminder mutations to operational sources', async () => {
  await withService(async ({ metadata }) => {
    metadata.createTopic({ topicId: 'topic-1', paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'source-1', topicId: 'topic-1', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-1' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:00:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'fictional-monitor', actions: [{
      actionId: 'monitor.verify', label: 'Verify Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-1' }),
      parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes nothing in the fictional monitor.'], approvalMode: 'required', idempotency: { idempotent: false, transientRetryable: false },
      executor: async () => ({}), authoritativeVerifier: async () => false, successTransition: async () => 'Resolved'
    }] });
    const created = await service.ingest(occurrence({ occurrenceId: 'verification-occurrence', attentionReason: 'monitoring', evidenceFacts: {} }));
    const failed = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '44444444-4444-4444-8444-444444444444', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'monitor.verify', input: {} });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.episode.state, 'Active');
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '55555555-5555-4555-8555-555555555555', episodeId: created.episode.episodeId, expectedEpisodeRevision: failed.episode.revision, topicId: 'topic-1', sourceReferenceId: 'source-1', actionId: 'reminder.complete', input: { expectedConfigRevision: 'revision-1' } }), /not registered|invalid action/i);
  });
});
