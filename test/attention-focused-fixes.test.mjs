import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateActionDescriptor, validateActionInput } from '../src/attention/contracts.mjs';
import { createAttentionService } from '../src/attention/service.mjs';
import { resolveSnoozeUntil } from '../src/attention/snooze.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };
const nestedSchema = { type: 'object', additionalProperties: false, required: ['options'], properties: {
  options: { type: 'object', additionalProperties: false, required: ['mode', 'targets'], properties: {
    mode: { type: 'string', enum: ['safe', 'fast'], minLength: 4 },
    targets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer' }, enabled: { type: 'boolean' } } } }
  } }
} };

function descriptor(parameterSchema = nestedSchema, overrides = {}) {
  return { actionId: 'monitor.apply', label: 'Apply', kind: 'mutation', targetResolver: () => ({ subjectId: 'fictional-subject' }), parameterSchema,
    sideEffects: ['Changes a fictional monitor.'], approvalMode: 'required', idempotency: { idempotent: false, transientRetryable: false },
    executor: async () => ({}), authoritativeVerifier: async () => ({ outcome: 'applied' }), successTransition: async () => 'Resolved', ...overrides };
}

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-attention-focused-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  const services = [];
  metadata.createTopic({ topicId: 'fictional-topic', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'fictional-source', topicId: 'fictional-topic', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'fictional-subject' });
  try { await run(metadata, (service) => { services.push(service); return service; }); } finally { for (const service of services) service.close(); metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

function occurrence(sourceCapabilityId, evidenceFacts = {}) {
  return { schemaVersion: 1, sourceCapabilityId, stableSubjectId: 'fictional-subject', attentionReason: 'review-required', occurrenceId: randomUUID(), occurredAt: '2026-08-23T00:00:00.000Z', topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', evidenceFacts };
}

function request(episode, actionId, input = {}, extra = {}) {
  return { schemaVersion: 1, logicalOperationId: randomUUID(), episodeId: episode.episodeId, expectedEpisodeRevision: episode.revision,
    topicId: 'fictional-topic', sourceReferenceId: 'fictional-source', actionId, input, ...extra };
}

function approvalRow(metadata, approvalId) {
  const database = new DatabaseSync(metadata.databasePath, { readOnly: true });
  try { return database.prepare('SELECT state, expires_at AS expiresAt FROM attention_approvals WHERE approval_id = ?').get(approvalId); }
  finally { database.close(); }
}

function attemptCount(metadata, episodeId) {
  const database = new DatabaseSync(metadata.databasePath, { readOnly: true });
  try { return database.prepare('SELECT COUNT(*) AS count FROM attention_attempts WHERE episode_id = ?').get(episodeId).count; }
  finally { database.close(); }
}

test('nested action inputs validate every declared level and remain canonical', () => {
  const action = validateActionDescriptor(descriptor());
  const valid = { options: { targets: [{ enabled: true, id: 3 }], mode: 'safe' } };
  assert.deepEqual(validateActionInput(action, valid), { options: { mode: 'safe', targets: [{ enabled: true, id: 3 }] } });
  assert.throws(() => validateActionInput(action, { options: { ...valid.options, surprise: true } }), /action input.options contains unsupported field surprise/);
  assert.throws(() => validateActionInput(action, { options: { targets: [] } }), /action input.options is missing mode/);
  assert.throws(() => validateActionInput(action, { options: { mode: 'safe', targets: [{ id: '3' }] } }), /action input.options.targets\[0\].id has an invalid type/);
  assert.throws(() => validateActionInput(action, { options: { mode: 'other', targets: [] } }), /action input.options.mode has an invalid value/);
  assert.throws(() => validateActionInput(action, { options: { mode: 5, targets: [] } }), /action input.options.mode has an invalid type/);
  assert.throws(() => validateActionInput(action, { options: { mode: 'fast', targets: [{ id: 1, enabled: 'yes' }] } }), /action input.options.targets\[0\].enabled has an invalid type/);
  assert.throws(() => validateActionDescriptor(descriptor({ type: 'object', additionalProperties: false, properties: { x: { type: 'string', pattern: 'x' } } })), /unsupported field pattern/);
  const flat = validateActionDescriptor(descriptor({ type: 'object', additionalProperties: false, required: ['expectedConfigRevision'], properties: { expectedConfigRevision: { type: 'string', minLength: 1 } } }));
  assert.deepEqual(validateActionInput(flat, { expectedConfigRevision: 'config-1' }), { expectedConfigRevision: 'config-1' });
});

test('approval presentation presets resolve to one hour and one day', () => {
  assert.equal(resolveSnoozeUntil('PT1H', '2026-08-23T00:01:00.000Z'), '2026-08-23T01:01:00.000Z');
  assert.equal(resolveSnoozeUntil('P1D', '2026-08-23T00:01:00.000Z'), '2026-08-24T00:01:00.000Z');
});

test('invalid nested input stops before target resolution, attempt persistence, and dispatch', async () => {
  await fixture(async (metadata, track) => {
    let targets = 0;
    let dispatches = 0;
    const service = track(createAttentionService({ metadata, host: 'fictional-host', operatorId: 'fictional-operator', now: () => '2026-08-23T00:01:00.000Z' }));
    service.registerSourceCapability({ sourceCapabilityId: 'nested-input', monitoring: true, deriveEvidence: (value) => value.evidenceFacts,
      actions: [descriptor(nestedSchema, { targetResolver: () => { targets += 1; return { subjectId: 'fictional-subject' }; }, executor: async () => { dispatches += 1; return {}; } })] });
    const created = await service.ingest(occurrence('nested-input'));
    targets = 0;
    await assert.rejects(() => service.act(request(created.episode, 'monitor.apply', { options: { mode: 'safe', targets: [{ id: 'bad' }] } })), /targets\[0\].id/);
    assert.equal(targets, 0);
    assert.equal(dispatches, 0);
    assert.equal(service.get(created.episode.episodeId).episode.revision, 1);
    assert.equal(service.listActivity({ episodeId: created.episode.episodeId }).records.length, 0);
    assert.equal(attemptCount(metadata, created.episode.episodeId), 0);
    service.close();
  });
});

test('eligible approval snooze preserves the exact approval and wakes with three deterministic actions', async () => {
  await fixture(async (metadata, track) => {
    let clock = '2026-08-23T00:01:00.000Z';
    let dispatches = 0;
    const service = track(createAttentionService({ metadata, host: 'fictional-host', operatorId: 'fictional-operator', now: () => clock }));
    service.registerSourceCapability({ sourceCapabilityId: 'approval-snooze', sourceKind: 'approval', monitoring: true,
      deriveEvidence: (value) => value.evidenceFacts, planRevision: 'plan-1', policyRevision: 'policy-1', preconditionReader: async () => ({ available: true, revision: 'precondition-1' }),
      actions: [descriptor({ type: 'object', properties: {}, additionalProperties: false }, { executor: async () => { dispatches += 1; return {}; } })] });
    const created = await service.ingest(occurrence('approval-snooze', { facts: ['blocked-work'] }));
    const pending = await service.act(request(created.episode, 'monitor.apply'));
    const approvalId = pending.approval.approvalId;
    const expiry = pending.approval.expiresAt;
    let shown = service.get(created.episode.episodeId).episode;
    assert.equal(shown.severity, 'High');
    assert.deepEqual(shown.eligibleSnoozeChoices, ['PT1H', 'P1D', 'NEXT_0700', 'PT72H', 'PT168H', 'custom']);
    assert.deepEqual(shown.actions.map((action) => action.actionId), ['approval.approve', 'approval.reject', 'attention.snooze']);
    const snoozeRequest = request(shown, 'attention.snooze', { until: '2026-08-23T00:03:00.000Z' });
    const snoozed = await service.act(snoozeRequest);
    assert.equal(snoozed.status, 'applied');
    assert.equal(snoozed.episode.state, 'Snoozed');
    assert.equal(approvalRow(metadata, approvalId).state, 'pending');
    assert.equal(approvalRow(metadata, approvalId).expiresAt, expiry);
    assert.equal(service.list().episodes.length, 0);
    assert.equal(dispatches, 0);
    assert.equal((await service.act(snoozeRequest)).status, 'applied');
    assert.equal(attemptCount(metadata, created.episode.episodeId), 2, 'the exact snooze retry does not add an attempt');
    await assert.rejects(() => service.act(request(created.episode, 'approval.approve', {}, { approvalId })), /revision is stale/);
    clock = '2026-08-23T00:03:00.000Z';
    shown = service.list().episodes[0];
    assert.equal(shown.state, 'Active');
    assert.deepEqual(shown.actions.map((action) => action.actionId), ['approval.approve', 'approval.reject', 'attention.snooze']);
    assert.equal(approvalRow(metadata, approvalId).state, 'pending');
    assert.equal(approvalRow(metadata, approvalId).expiresAt, expiry);
    const approved = await service.act(request(shown, 'approval.approve', {}, { approvalId }));
    assert.equal(approved.status, 'applied');
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('presentation snooze does not postpone approval expiry and source evidence still invalidates it', async () => {
  await fixture(async (metadata, track) => {
    let clock = '2026-08-23T00:01:00.000Z';
    const service = track(createAttentionService({ metadata, host: 'fictional-host', operatorId: 'fictional-operator', now: () => clock }));
    service.registerSourceCapability({ sourceCapabilityId: 'approval-expiry', sourceKind: 'approval', monitoring: true, deriveEvidence: (value) => value.evidenceFacts,
      actions: [descriptor({ type: 'object', properties: {}, additionalProperties: false })] });
    const created = await service.ingest(occurrence('approval-expiry'));
    const pending = await service.act(request(created.episode, 'monitor.apply'));
    const approvalId = pending.approval.approvalId;
    await service.act(request(created.episode, 'attention.snooze', { preset: 'PT1H' }));
    clock = pending.approval.expiresAt;
    assert.equal(service.get(created.episode.episodeId).episode.state, 'Snoozed');
    assert.equal(approvalRow(metadata, approvalId).state, 'expired');
    clock = resolveSnoozeUntil('PT1H', '2026-08-23T00:01:00.000Z');
    const reappeared = service.list().episodes[0];
    assert.equal(reappeared.state, 'Active');
    assert.equal(reappeared.actions.some((action) => action.actionId === 'approval.approve'), false);
    assert.equal(approvalRow(metadata, approvalId).expiresAt, pending.approval.expiresAt);
    const later = await service.ingest({ ...occurrence('approval-expiry', { facts: ['degraded-service'] }), occurredAt: '2026-08-23T01:01:01.000Z' });
    assert.equal(later.episode.revision > reappeared.revision, true);
  });
});

test('Critical source evidence breaks an approval presentation snooze', async () => {
  await fixture(async (metadata, track) => {
    let clock = '2026-08-23T00:01:00.000Z';
    const service = track(createAttentionService({ metadata, host: 'fictional-host', operatorId: 'fictional-operator', now: () => clock }));
    service.registerSourceCapability({ sourceCapabilityId: 'approval-escalation', sourceKind: 'approval', monitoring: true, deriveEvidence: (value) => value.evidenceFacts,
      actions: [descriptor({ type: 'object', properties: {}, additionalProperties: false })] });
    const created = await service.ingest(occurrence('approval-escalation'));
    const pending = await service.act(request(created.episode, 'monitor.apply'));
    await service.act(request(created.episode, 'attention.snooze', { preset: 'PT1H' }));
    clock = '2026-08-23T00:02:00.000Z';
    await service.ingest({ ...occurrence('approval-escalation', { facts: ['active-data-loss'] }), occurredAt: clock });
    const shown = service.list().episodes[0];
    assert.equal(shown.state, 'Active');
    assert.equal(shown.severity, 'Critical');
    assert.deepEqual(shown.eligibleSnoozeChoices, []);
    assert.equal(shown.actions.some((action) => action.actionId === 'attention.snooze'), false);
    assert.equal(approvalRow(metadata, pending.approval.approvalId).state, 'superseded');
  });
});

test('Critical and unmonitored approvals omit snooze; rejection remains actionable', async () => {
  await fixture(async (metadata, track) => {
    const service = track(createAttentionService({ metadata, host: 'fictional-host', operatorId: 'fictional-operator', now: () => '2026-08-23T00:01:00.000Z' }));
    for (const [kind, monitoring, facts] of [['critical', true, ['active-data-loss']], ['unmonitored', false, []], ['routine', true, []]]) {
      const sourceCapabilityId = `approval-${kind}`;
      service.registerSourceCapability({ sourceCapabilityId, sourceKind: 'approval', monitoring, deriveEvidence: (value) => value.evidenceFacts,
        actions: [descriptor({ type: 'object', properties: {}, additionalProperties: false }, { actionId: `monitor.${kind}` })] });
      const created = await service.ingest(occurrence(sourceCapabilityId, { facts }));
      const pending = await service.act(request(created.episode, `monitor.${kind}`));
      const shown = service.get(created.episode.episodeId).episode;
      assert.deepEqual(shown.actions.map((action) => action.actionId), kind === 'routine'
        ? ['approval.approve', 'approval.reject', 'attention.snooze'] : ['approval.approve', 'approval.reject', 'topic.open']);
      if (kind !== 'routine') await assert.rejects(() => service.act(request(shown, 'attention.snooze', { preset: 'PT1H' })), /not registered/);
      const rejected = await service.act(request(shown, 'approval.reject', {}, { approvalId: pending.approval.approvalId }));
      assert.equal(rejected.status, 'applied');
      assert.equal(approvalRow(metadata, pending.approval.approvalId).state, 'rejected');
    }
    service.close();
  });
});
