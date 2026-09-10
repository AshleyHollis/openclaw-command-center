import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionService as createAttentionServiceBase } from '../src/attention/service.mjs';
import { orderAttentionEpisodes } from '../src/attention/ordering.mjs';
import { resolveSnoozeUntil, SNOOZE_PRESETS } from '../src/attention/snooze.mjs';
import { assertTransition, canTransition } from '../src/attention/state-machine.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';

const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };
const createAttentionService = (options) => createAttentionServiceBase({ operatorId: 'operator-review', host: 'host-review', ...options });

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-attention-review-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  metadata.createTopic({ topicId: 'topic-review', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'source-review', topicId: 'topic-review', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-review' });
  try { return await run({ metadata, stateDir }); } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

function occurrence(sourceCapabilityId, overrides = {}) {
  return {
    schemaVersion: 1,
    sourceCapabilityId,
    stableSubjectId: 'subject-review',
    attentionReason: 'review-required',
    occurrenceId: `${sourceCapabilityId}-occurrence`,
    occurredAt: '2026-08-23T00:00:00.000Z',
    topicId: 'topic-review',
    sourceReferenceId: 'source-review',
    evidenceFacts: {},
    ...overrides
  };
}

function descriptor(overrides = {}) {
  return {
    actionId: 'monitor.apply',
    label: 'Apply Monitor Change',
    kind: 'mutation',
    targetResolver: () => ({ stableSubjectId: 'subject-review' }),
    parameterSchema: { type: 'object', properties: {}, additionalProperties: false },
    sideEffects: ['Changes the fictional monitor.'],
    approvalMode: 'required',
    idempotency: { idempotent: false, transientRetryable: false },
    executor: async () => ({ observedRevision: 'revision-2' }),
    authoritativeVerifier: async () => ({ outcome: 'applied', revision: 'revision-2' }),
    successTransition: async () => 'Resolved',
    ...overrides
  };
}

async function approvedAct(service, request) {
  const pending = await service.act(request);
  assert.equal(pending.status, 'approval-required');
  return service.act({
    schemaVersion: 1,
    logicalOperationId: randomUUID(),
    episodeId: request.episodeId,
    expectedEpisodeRevision: request.expectedEpisodeRevision,
    ...(request.expectedSourceRevision === undefined ? {} : { expectedSourceRevision: request.expectedSourceRevision }),
    topicId: request.topicId,
    sourceReferenceId: request.sourceReferenceId,
    actionId: 'approval.approve',
    approvalId: pending.approval.approvalId,
    input: {}
  });
}

test('state transitions include terminal source outcomes and reject terminal reopening', () => {
  for (const state of ['Active', 'Snoozed', 'Action running']) {
    assert.equal(canTransition(state, 'Resolved'), true);
    assert.equal(canTransition(state, 'Withdrawn'), true);
  }
  assert.equal(canTransition('Action running', 'Snoozed'), true);
  assert.throws(() => assertTransition('Resolved', 'Active'), /Illegal Attention transition/);
});

test('source capabilities cannot self-authorize mutations or lose a third semantic action', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    assert.throws(() => service.registerSourceCapability({ sourceCapabilityId: 'unsafe-monitor', actions: [descriptor({ approvalMode: 'never' })] }), /fresh approval/i);
    const navigation = (suffix) => descriptor({ actionId: `monitor.open-${suffix}`, label: `Open ${suffix}`, kind: 'navigation', approvalMode: 'never' });
    service.registerSourceCapability({ sourceCapabilityId: 'three-action-monitor', deriveEvidence: () => ({}), actions: [navigation('one'), navigation('two'), navigation('three')] });
    const created = await service.ingest(occurrence('three-action-monitor'));
    assert.deepEqual(service.get(created.episode.episodeId).episode.actions.map((action) => action.actionId), ['monitor.open-one', 'monitor.open-two', 'monitor.open-three']);
    service.close();
  });
});

test('attempt and Action-running state are committed before external dispatch', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'durable-monitor', deriveEvidence: () => ({}), actions: [descriptor({
      executor: async ({ attempt }) => {
        assert.deepEqual(service.list().inProgress.map((episode) => episode.episodeId), [attempt.episodeId]);
        assert.deepEqual(service.list().episodes, []);
        const inspection = new DatabaseSync(metadata.databasePath, { readOnly: true });
        try {
          assert.equal(inspection.prepare('SELECT state FROM attention_episodes WHERE episode_id = ?').get(attempt.episodeId).state, 'Action running');
          assert.equal(inspection.prepare('SELECT state FROM attention_attempts WHERE attempt_id = ?').get(attempt.attemptId).state, 'running');
        } finally { inspection.close(); }
        const sourceWrite = new DatabaseSync(metadata.databasePath);
        try { sourceWrite.exec('BEGIN IMMEDIATE; ROLLBACK;'); } finally { sourceWrite.close(); }
        return { observedRevision: 'revision-2' };
      }
    })] });
    const created = await service.ingest(occurrence('durable-monitor'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '61111111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(result.status, 'applied');
    service.close();
  });
});

test('the In progress projection applies the authenticated Attention result bound', async () => {
  await fixture(async ({ metadata }) => {
    const releases = [];
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'bounded-running-monitor', deriveEvidence: () => ({}), actions: [descriptor({ executor: async () => new Promise((resolve) => releases.push(resolve)) })] });
    const first = await service.ingest(occurrence('bounded-running-monitor', { occurrenceId: 'bounded-running-1', stableSubjectId: 'bounded-running-1' }));
    const second = await service.ingest(occurrence('bounded-running-monitor', { occurrenceId: 'bounded-running-2', stableSubjectId: 'bounded-running-2' }));
    const request = (episode, logicalOperationId) => approvedAct(service, { schemaVersion: 1, logicalOperationId, episodeId: episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const running = [request(first.episode, '61111111-1111-4111-8111-111111111112'), request(second.episode, '61111111-1111-4111-8111-111111111113')];
    while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.list({ schemaVersion: 1, limit: 1 }).inProgress.length, 1);
    for (const release of releases) release({ observedRevision: 'revision-2' });
    await Promise.all(running);
    service.close();
  });
});

test('Recovery-only metadata blocks Attention mutation while preserving reads', async () => {
  await fixture(async ({ metadata }) => {
    const recoveryMetadata = {
      databasePath: metadata.databasePath,
      getOperatingStatus: () => ({ mode: 'recovery-only' }),
      getTopic: metadata.getTopic.bind(metadata),
      getSourceReference: metadata.getSourceReference.bind(metadata),
      listActivity: metadata.listActivity.bind(metadata),
      getActivity: metadata.getActivity.bind(metadata)
    };
    const service = createAttentionService({ metadata: recoveryMetadata });
    service.registerSourceCapability({ sourceCapabilityId: 'recovery-monitor', deriveEvidence: () => ({}), actions: [] });
    await assert.rejects(() => service.ingest(occurrence('recovery-monitor')), (error) => error.code === 'recovery-only');
    assert.deepEqual(service.list({ schemaVersion: 1 }).episodes, []);
    service.close();
  });
});

test('a live duplicate action awaits its in-process owner without reconciling or retrying', async () => {
  await fixture(async ({ metadata }) => {
    let release;
    let dispatches = 0;
    let applied = false;
    const pendingDispatch = new Promise((resolve) => { release = resolve; });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'live-monitor', deriveEvidence: () => ({}), actions: [descriptor({
      idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => { dispatches += 1; await pendingDispatch; applied = true; return { observedRevision: 'revision-2' }; },
      authoritativeVerifier: async () => ({ outcome: applied ? 'applied' : 'not-applied', transient: true })
    })] });
    const created = await service.ingest(occurrence('live-monitor'));
    const request = { schemaVersion: 1, logicalOperationId: '60111111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} };
    const pending = await service.act(request);
    const decision = { ...request, logicalOperationId: randomUUID(), actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    const first = service.act(decision);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = service.act(decision);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 1);
    release();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.equal(firstResult.activity.activityId, duplicateResult.activity.activityId);
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('restart reconciles a committed running attempt before considering the disclosed retry', async () => {
  await fixture(async ({ metadata }) => {
    let applied = false;
    let dispatches = 0;
    const action = descriptor({
      idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => { dispatches += 1; applied = true; first.close(); return { observedRevision: 'revision-2' }; },
      authoritativeVerifier: async () => ({ outcome: applied ? 'applied' : 'not-applied', revision: applied ? 'revision-2' : 'revision-1' })
    });
    const first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    first.registerSourceCapability({ sourceCapabilityId: 'restart-monitor', deriveEvidence: () => ({}), actions: [action] });
    const created = await first.ingest(occurrence('restart-monitor'));
    const request = { schemaVersion: 1, logicalOperationId: '61222222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} };
    const pending = await first.act(request);
    const decision = { ...request, logicalOperationId: randomUUID(), actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    await assert.rejects(() => first.act(decision), /closed/i);
    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z' });
    restarted.registerSourceCapability({ sourceCapabilityId: 'restart-monitor', deriveEvidence: () => ({}), actions: [{ ...action, executor: async () => { dispatches += 1; return { observedRevision: 'revision-3' }; } }] });
    const reconciled = await restarted.act(decision);
    assert.equal(reconciled.status, 'applied');
    assert.equal(reconciled.episode.state, 'Resolved');
    assert.equal(dispatches, 1);
    restarted.close();
  });
});

test('verified completion preserves source evidence ingested while the action is running', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'concurrent-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [descriptor({
      executor: async () => {
        await service.ingest(occurrence('concurrent-monitor', { occurrenceId: 'concurrent-update', evidenceFacts: { facts: ['degraded-service'] } }));
        return { observedRevision: 'revision-2' };
      }
    })] });
    const created = await service.ingest(occurrence('concurrent-monitor'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '61333333-3333-4333-8333-333333333333', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(result.status, 'applied');
    assert.equal(result.episode.state, 'Resolved');
    assert.equal(result.episode.severity, 'High');
    assert.equal(result.episode.revision, 4);
    service.close();
  });
});

test('verified terminal source evidence settles an in-flight attempt without reopening the episode', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'terminal-monitor', deriveEvidence: () => ({}), verifyTransition: async (value) => value.transitionEvidence?.state === 'resolved', actions: [descriptor({
      executor: async () => {
        await service.ingest(occurrence('terminal-monitor', { occurrenceId: 'terminal-transition', transitionEvidence: { state: 'resolved', version: 'transition-2' } }));
        return { observedRevision: 'revision-2' };
      }
    })] });
    const created = await service.ingest(occurrence('terminal-monitor'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '61444444-4444-4444-8444-444444444444', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(result.status, 'applied');
    assert.equal(result.episode.state, 'Resolved');
    assert.equal(result.attempt.state, 'applied');
    assert.equal(service.list().episodes.length, 0);
    service.close();
  });
});

test('verified terminal source evidence returns the exact durable Activity for authoritative readback', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({
      sourceCapabilityId: 'terminal-activity-monitor',
      deriveEvidence: () => ({}),
      verifyTransition: async (value) => value.transitionEvidence?.state === 'resolved' && value.transitionEvidence?.version === value.occurrenceVersion,
      actions: []
    });
    await service.ingest(occurrence('terminal-activity-monitor', { occurrenceId: 'terminal-activity-active', occurrenceVersion: 'revision-1' }));
    const transition = await service.ingest(occurrence('terminal-activity-monitor', {
      occurrenceId: 'terminal-activity-resolved',
      occurrenceVersion: 'revision-2',
      occurredAt: '2026-08-23T00:00:01.000Z',
      transitionEvidence: { state: 'resolved', version: 'revision-2' }
    }));
    assert.ok(transition.activity?.activityId);
    assert.deepEqual(service.getActivity(transition.activity.activityId), transition.activity);
    assert.deepEqual({
      topicId: transition.activity.topicId,
      sourceReferenceId: transition.activity.sourceReferenceId,
      outcome: transition.activity.outcome,
      verificationRevision: transition.activity.verificationRevision
    }, {
      topicId: 'topic-review',
      sourceReferenceId: 'source-review',
      outcome: 'resolved',
      verificationRevision: 'revision-2'
    });
    const replay = await service.ingest(occurrence('terminal-activity-monitor', {
      occurrenceId: 'terminal-activity-resolved',
      occurrenceVersion: 'revision-2',
      occurredAt: '2026-08-23T00:00:01.000Z',
      transitionEvidence: { state: 'resolved', version: 'revision-2' }
    }));
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.activity, transition.activity);
    service.close();
  });
});

test('severity requires explicit capability mapping and due Reminders appear once', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'raw-monitor', actions: [] });
    service.registerSourceCapability({ sourceCapabilityId: 'trusted-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    service.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const raw = await service.ingest(occurrence('raw-monitor', { evidenceFacts: { facts: ['active-security-exposure'] } }));
    assert.equal(raw.episode.severity, 'Routine');
    await service.ingest(occurrence('trusted-monitor', { stableSubjectId: 'subject-trusted', occurrenceId: 'trusted-occurrence', evidenceFacts: { facts: ['active-security-exposure'] } }));
    const reminder = await service.ingest(occurrence('reminders', { stableSubjectId: 'subject-reminder', occurrenceId: 'reminder-occurrence', attentionReason: 'reminder-due', evidenceFacts: { reminderDue: true } }));
    const listed = service.list();
    assert.equal(listed.buckets[2].some((episode) => episode.episodeId === reminder.episode.episodeId), true);
    assert.equal(listed.buckets[3].some((episode) => episode.episodeId === reminder.episode.episodeId), false);
    assert.equal(new Set(listed.episodes.map((episode) => episode.episodeId)).size, listed.episodes.length);
    service.close();
  });
});

test('Attention ordering compares parsed instants and assigns each episode to one bucket', () => {
  const base = { state: 'Active', severity: 'Routine', sourceKind: 'operational', due: false, snoozedUntil: null };
  const laterTextuallyFirst = { ...base, episodeId: 'episode-later', attentionSince: '2026-08-23T00:30:00+01:00' };
  const earlierTextuallyLast = { ...base, episodeId: 'episode-earlier', attentionSince: '2026-08-22T23:45:00.000Z' };
  const reminder = { ...base, episodeId: 'episode-reminder', attentionSince: '2026-08-22T23:00:00Z', sourceKind: 'reminder', due: true };
  const ordered = orderAttentionEpisodes([laterTextuallyFirst, earlierTextuallyLast, reminder], { now: '2026-08-24T00:00:00Z' });
  assert.deepEqual(ordered.buckets[2].map((episode) => episode.episodeId), ['episode-reminder']);
  assert.deepEqual(ordered.buckets[3].map((episode) => episode.episodeId), ['episode-later', 'episode-earlier']);
  assert.equal(new Set(ordered.episodes.map((episode) => episode.episodeId)).size, ordered.episodes.length);
});

test('a declined evidence mapping stays Routine and durable episode linkage cannot be rebound', async () => {
  await fixture(async ({ metadata }) => {
    metadata.createSourceReference({ version: 1, referenceId: 'source-review-other', topicId: 'topic-review', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-review-other' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'declined-evidence', deriveEvidence: () => null, actions: [] });
    const created = await service.ingest(occurrence('declined-evidence', { evidenceFacts: { facts: ['active-security-exposure'] } }));
    assert.equal(created.episode.severity, 'Routine');
    await assert.rejects(() => service.ingest(occurrence('declined-evidence', { occurrenceId: 'declined-evidence-2', sourceReferenceId: 'source-review-other' })), /rebound|linkage/i);
    service.close();
    const restarted = createAttentionService({ metadata });
    restarted.registerSourceCapability({ sourceCapabilityId: 'declined-evidence', deriveEvidence: () => null, actions: [] });
    assert.equal(restarted.get(created.episode.episodeId).episode.sourceReferenceId, 'source-review');
    restarted.close();
  });
});

test('matched false cannot resolve an episode', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'matched-monitor', deriveEvidence: () => ({}), actions: [descriptor({ authoritativeVerifier: async () => ({ matched: false }) })] });
    const created = await service.ingest(occurrence('matched-monitor'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '62222222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(result.status, 'failed');
    assert.equal(result.episode.state, 'Active');
    assert.equal(result.episode.severity, 'High');
    const database = new DatabaseSync(metadata.databasePath);
    try {
      assert.throws(() => database.prepare('UPDATE attention_activity_records SET outcome = ? WHERE activity_id = ?').run('applied', result.activity.activityId), /append-only/i);
      assert.throws(() => database.prepare('DELETE FROM attention_activity_records WHERE activity_id = ?').run(result.activity.activityId), /append-only/i);
    } finally { database.close(); }
    service.close();
  });
});

test('Reminder Complete uses the disclosed scheduler revision and authoritative read-back', async () => {
  await fixture(async ({ metadata }) => {
    const calls = [];
    const service = createAttentionService({
      metadata,
      now: () => '2026-08-23T00:01:00.000Z',
      sourceActions: {
        complete: async (input) => { calls.push(input); return { observedRevision: 'config-2' }; },
        verify: async () => ({ outcome: 'applied', revision: 'config-2' })
      }
    });
    service.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await service.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-1', evidenceFacts: { reminderDue: true } }));
    const complete = service.get(created.episode.episodeId).episode.actions.find((action) => action.actionId === 'reminder.complete');
    assert.deepEqual(complete.parameterSchema.required, ['expectedConfigRevision']);
    const result = await service.act({ schemaVersion: 1, logicalOperationId: '63333333-3333-4333-8333-333333333333', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-1' } });
    assert.equal(result.status, 'applied');
    assert.equal(result.episode.state, 'Resolved');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].parameters.expectedConfigRevision, 'config-1');
    service.close();
  });
});

test('approval decisions are public actions and stale preconditions block dispatch', async () => {
  await fixture(async ({ metadata }) => {
    let preconditionRevision = 'precondition-1';
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-monitor',
      sourceKind: 'approval',
      deriveEvidence: () => ({}),
      planRevision: 'plan-1',
      policyRevision: 'policy-1',
      preconditionReader: async () => ({ available: true, revision: preconditionRevision }),
      actions: [descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; return { observedRevision: 'revision-2' }; } })]
    });
    const created = await service.ingest(occurrence('approval-monitor'));
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '64444444-4444-4444-8444-444444444444', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(pending.status, 'approval-required');
    assert.deepEqual(service.get(created.episode.episodeId).episode.actions.map((action) => action.actionId), ['approval.approve', 'approval.reject', 'topic.open']);
    preconditionRevision = 'precondition-2';
    const replacement = await service.act({ schemaVersion: 1, logicalOperationId: '65555555-5555-4555-8555-555555555555', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(replacement.status, 'approval-required');
    assert.notEqual(replacement.approval.approvalId, pending.approval.approvalId);
    assert.equal(replacement.approval.preconditionRevision, 'precondition-2');
    assert.equal(dispatches, 0);
    service.close();
  });
});

test('an approved attempt remains publicly resumable after interruption before dispatch', async () => {
  await fixture(async ({ metadata }) => {
    let reads = 0;
    let dispatches = 0;
    const approvedAction = descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; return { observedRevision: 'revision-2' }; } });
    const first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    first.registerSourceCapability({
      sourceCapabilityId: 'approval-restart', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => { reads += 1; if (reads === 2) first.close(); return { available: true, revision: 'precondition-1' }; },
      actions: [approvedAction]
    });
    const created = await first.ingest(occurrence('approval-restart'));
    const pending = await first.act({ schemaVersion: 1, logicalOperationId: '66666666-6666-4666-8666-666666666666', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const decision = { schemaVersion: 1, logicalOperationId: '67777777-7777-4777-8777-777777777777', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    await assert.rejects(() => first.act(decision), /closed/i);
    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    restarted.registerSourceCapability({ sourceCapabilityId: 'approval-restart', sourceKind: 'approval', deriveEvidence: () => ({}), preconditionReader: async () => ({ available: true, revision: 'precondition-1' }), actions: [approvedAction] });
    assert.equal(restarted.get(created.episode.episodeId).episode.actions[0].actionId, 'approval.approve');
    const result = await restarted.act(decision);
    assert.equal(result.status, 'applied');
    assert.equal(result.episode.state, 'Resolved');
    assert.equal(dispatches, 1);
    restarted.close();
  });
});

test('a partial approval decision remains exact and truthful across restart replay', async () => {
  await fixture(async ({ metadata }) => {
    let first;
    const action = descriptor({
      approvalMode: 'required',
      idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => { first.close(); return {}; },
      authoritativeVerifier: async () => ({ outcome: 'partial' })
    });
    first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    first.registerSourceCapability({ sourceCapabilityId: 'approval-partial-restart', sourceKind: 'approval', deriveEvidence: () => ({}), actions: [action] });
    const created = await first.ingest(occurrence('approval-partial-restart'));
    const pending = await first.act({ schemaVersion: 1, logicalOperationId: '67711111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const decision = { schemaVersion: 1, logicalOperationId: '67722222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    await assert.rejects(() => first.act(decision), /closed/i);

    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    restarted.registerSourceCapability({ sourceCapabilityId: 'approval-partial-restart', sourceKind: 'approval', deriveEvidence: () => ({}), actions: [descriptor({ approvalMode: 'required', idempotency: { idempotent: true, transientRetryable: true }, authoritativeVerifier: async () => ({ outcome: 'partial' }) })] });
    const reconciled = await restarted.act(decision);
    assert.equal(reconciled.status, 'partial');
    assert.equal(reconciled.attempt.state, 'partial');
    assert.equal(reconciled.activity.outcome, 'partial');
    restarted.close();

    const replayed = createAttentionService({ metadata, now: () => '2026-08-23T00:03:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    replayed.registerSourceCapability({ sourceCapabilityId: 'approval-partial-restart', sourceKind: 'approval', deriveEvidence: () => ({}), actions: [action] });
    const replay = await replayed.act(decision);
    assert.equal(replay.status, 'partial');
    assert.equal(replay.attempt.attemptId, reconciled.attempt.attemptId);
    assert.equal(replay.activity.activityId, reconciled.activity.activityId);
    await assert.rejects(() => replayed.act({ ...decision, approvalId: 'approval:different' }), (error) => error?.code === 'intent-mismatch');
    replayed.close();
  });
});

test('approved retries recheck the bound source precondition before a second dispatch', async () => {
  await fixture(async ({ metadata }) => {
    let preconditionRevision = 'precondition-1';
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-retry', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => ({ available: true, revision: preconditionRevision }),
      actions: [descriptor({
        approvalMode: 'required',
        idempotency: { idempotent: true, transientRetryable: true },
        executor: async () => { dispatches += 1; preconditionRevision = 'precondition-2'; return {}; },
        authoritativeVerifier: async () => ({ outcome: 'not-applied', transient: true })
      })]
    });
    const created = await service.ingest(occurrence('approval-retry'));
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '67811111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const result = await service.act({ schemaVersion: 1, logicalOperationId: '67822222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
    assert.equal(result.status, 'partial');
    assert.equal(result.episode.severity, 'Critical');
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('a live approval replay cannot cross the bound operator identity', async () => {
  await fixture(async ({ metadata }) => {
    let release;
    let dispatches = 0;
    const pendingDispatch = new Promise((resolve) => { release = resolve; });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-live-operator', sourceKind: 'approval', deriveEvidence: () => ({}),
      actions: [descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; await pendingDispatch; return {}; } })]
    });
    const created = await service.ingest(occurrence('approval-live-operator'));
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '67831111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const decision = { schemaVersion: 1, logicalOperationId: '67832222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    const owner = service.act(decision);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => service.act({ ...decision, authenticatedOperatorId: 'operator-intruder' }), /operator/i);
    assert.equal(dispatches, 1);
    release();
    assert.equal((await owner).status, 'applied');
    service.close();
  });
});

test('approval context drift after reservation prevents the first external dispatch', { timeout: 2_000 }, async () => {
  await fixture(async ({ metadata }) => {
    let preconditionRevision = 'precondition-1';
    let episodeId;
    let releaseRead;
    let signalRead;
    let dispatches = 0;
    const readStarted = new Promise((resolve) => { signalRead = resolve; });
    const readReleased = new Promise((resolve) => { releaseRead = resolve; });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-first-dispatch-drift', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => {
        if (episodeId && service.get(episodeId).episode.state === 'Action running') {
          signalRead();
          await readReleased;
        }
        return { available: true, revision: preconditionRevision };
      },
      actions: [descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; return {}; } })]
    });
    const created = await service.ingest(occurrence('approval-first-dispatch-drift'));
    episodeId = created.episode.episodeId;
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '67835111-1111-4111-8111-111111111111', episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const decision = service.act({ schemaVersion: 1, logicalOperationId: '67835222-2222-4222-8222-222222222222', episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
    await readStarted;
    preconditionRevision = 'precondition-2';
    releaseRead();
    const result = await decision;
    assert.equal(result.status, 'failed');
    assert.equal(dispatches, 0);
    assert.equal(result.episode.state, 'Active');
    assert.equal(service.get(episodeId).episode.actions.some((action) => action.actionId === 'monitor.apply'), true);
    const replacement = await service.act({ schemaVersion: 1, logicalOperationId: '67835555-5555-4555-8555-555555555555', episodeId, expectedEpisodeRevision: result.episode.revision, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(replacement.status, 'approval-required');
    assert.notEqual(replacement.approval.approvalId, pending.approval.approvalId);
    service.close();
  });
});

test('approval expiry while the reserved context is being re-read prevents dispatch', { timeout: 2_000 }, async () => {
  await fixture(async ({ metadata }) => {
    let clock = '2026-08-23T00:00:00.000Z';
    let episodeId;
    let releaseRead;
    let signalRead;
    let dispatches = 0;
    const readStarted = new Promise((resolve) => { signalRead = resolve; });
    const readReleased = new Promise((resolve) => { releaseRead = resolve; });
    const service = createAttentionService({ metadata, now: () => clock, operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-first-dispatch-expiry', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => {
        if (episodeId && service.get(episodeId).episode.state === 'Action running') {
          signalRead();
          await readReleased;
        }
        return { available: true, revision: 'precondition-1' };
      },
      actions: [descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; return {}; } })]
    });
    const created = await service.ingest(occurrence('approval-first-dispatch-expiry'));
    episodeId = created.episode.episodeId;
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '67835333-3333-4333-8333-333333333333', episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const decision = service.act({ schemaVersion: 1, logicalOperationId: '67835444-4444-4444-8444-444444444444', episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
    await readStarted;
    clock = pending.approval.expiresAt;
    releaseRead();
    const result = await decision;
    assert.equal(result.status, 'failed');
    assert.equal(dispatches, 0);
    assert.equal(result.episode.state, 'Active');
    service.close();
  });
});

test('reserved approval invalidation rolls back with failure finalization and remains restart-recoverable', { timeout: 4_000 }, async () => {
  await fixture(async ({ metadata }) => {
    let preconditionRevision = 'precondition-1';
    let episodeId;
    let releaseRead;
    let signalRead;
    let dispatches = 0;
    const readStarted = new Promise((resolve) => { signalRead = resolve; });
    const readReleased = new Promise((resolve) => { releaseRead = resolve; });
    const action = descriptor({
      approvalMode: 'required',
      idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => { dispatches += 1; return {}; },
      authoritativeVerifier: async () => ({ outcome: 'not-applied', transient: true })
    });
    const first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    first.registerSourceCapability({
      sourceCapabilityId: 'approval-atomic-invalidation', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => {
        if (episodeId && first.get(episodeId).episode.state === 'Action running') {
          signalRead();
          await readReleased;
        }
        return { available: true, revision: preconditionRevision };
      },
      actions: [action]
    });
    const created = await first.ingest(occurrence('approval-atomic-invalidation'));
    episodeId = created.episode.episodeId;
    const pending = await first.act({ schemaVersion: 1, logicalOperationId: '67835666-6666-4666-8666-666666666666', episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const decisionRequest = { schemaVersion: 1, logicalOperationId: '67835777-7777-4777-8777-777777777777', episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    const decision = first.act(decisionRequest);
    await readStarted;
    const fault = new DatabaseSync(metadata.databasePath);
    try { fault.exec("CREATE TRIGGER attention_failure_fault BEFORE INSERT ON attention_activity_records BEGIN SELECT RAISE(ABORT, 'fictional failure-finalization fault'); END;"); } finally { fault.close(); }
    preconditionRevision = 'precondition-2';
    releaseRead();
    await assert.rejects(() => decision, /fictional failure-finalization fault/i);
    assert.equal(dispatches, 0);
    assert.equal(first.get(episodeId).episode.state, 'Action running');
    const inspection = new DatabaseSync(metadata.databasePath, { readOnly: true });
    try {
      assert.equal(inspection.prepare('SELECT state FROM attention_approvals WHERE approval_id = ?').get(pending.approval.approvalId).state, 'consumed');
      assert.equal(inspection.prepare('SELECT state FROM attention_attempts WHERE attempt_id = ?').get(pending.approval.attemptId).state, 'running');
    } finally { inspection.close(); }
    first.close();
    const repair = new DatabaseSync(metadata.databasePath);
    try { repair.exec('DROP TRIGGER attention_failure_fault;'); } finally { repair.close(); }

    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z' });
    restarted.registerSourceCapability({
      sourceCapabilityId: 'approval-atomic-invalidation', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => ({ available: true, revision: preconditionRevision }),
      actions: [action]
    });
    const recovered = await restarted.act(decisionRequest);
    assert.equal(recovered.status, 'partial');
    assert.equal(recovered.episode.state, 'Active');
    assert.equal(dispatches, 0);
    const recoveredInspection = new DatabaseSync(metadata.databasePath, { readOnly: true });
    try { assert.equal(recoveredInspection.prepare('SELECT state FROM attention_approvals WHERE approval_id = ?').get(pending.approval.approvalId).state, 'superseded'); } finally { recoveredInspection.close(); }
    restarted.close();
  });
});

test('approved retries reject evidence ingested while the first dispatch is running', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    let service;
    service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-evidence-drift', sourceKind: 'approval', deriveEvidence: () => ({}),
      actions: [descriptor({
        approvalMode: 'required',
        idempotency: { idempotent: true, transientRetryable: true },
        executor: async () => {
          dispatches += 1;
          await service.ingest(occurrence('approval-evidence-drift', { occurrenceId: 'approval-evidence-drift-occurrence-2', occurredAt: '2026-08-23T00:00:30.000Z' }));
          return {};
        },
        authoritativeVerifier: async () => ({ outcome: 'not-applied', transient: true })
      })]
    });
    const created = await service.ingest(occurrence('approval-evidence-drift'));
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '67841111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const result = await service.act({ schemaVersion: 1, logicalOperationId: '67842222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} });
    assert.equal(result.status, 'partial');
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('restart recovery rechecks an approved retry precondition before dispatch', async () => {
  await fixture(async ({ metadata }) => {
    let preconditionRevision = 'precondition-1';
    let dispatches = 0;
    let first;
    const approvedAction = descriptor({
      approvalMode: 'required',
      idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => { dispatches += 1; preconditionRevision = 'precondition-2'; first.close(); return {}; },
      authoritativeVerifier: async () => ({ outcome: 'not-applied', transient: true })
    });
    first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    first.registerSourceCapability({ sourceCapabilityId: 'approval-retry-restart', sourceKind: 'approval', deriveEvidence: () => ({}), preconditionReader: async () => ({ available: true, revision: preconditionRevision }), actions: [approvedAction] });
    const created = await first.ingest(occurrence('approval-retry-restart'));
    const original = { schemaVersion: 1, logicalOperationId: '67911111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} };
    const pending = await first.act(original);
    const decision = { schemaVersion: 1, logicalOperationId: '67922222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    await assert.rejects(() => first.act(decision), /closed/i);
    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    restarted.registerSourceCapability({ sourceCapabilityId: 'approval-retry-restart', sourceKind: 'approval', deriveEvidence: () => ({}), preconditionReader: async () => ({ available: true, revision: preconditionRevision }), actions: [approvedAction] });
    const result = await restarted.act(original);
    assert.equal(result.status, 'partial');
    assert.equal(dispatches, 1);
    restarted.close();
  });
});

test('concurrent Approve decisions reserve one attempt and dispatch exactly once', async () => {
  await fixture(async ({ metadata }) => {
    let reads = 0;
    let waiting;
    let release;
    let dispatches = 0;
    const barrier = () => {
      if (!waiting) waiting = new Promise((resolve) => { release = resolve; });
      return waiting;
    };
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-review', host: 'host-review' });
    service.registerSourceCapability({
      sourceCapabilityId: 'approval-race', sourceKind: 'approval', deriveEvidence: () => ({}),
      preconditionReader: async () => { reads += 1; if (reads === 2) await barrier(); else if (reads === 3) release(); return { available: true, revision: 'precondition-1' }; },
      actions: [descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; return { observedRevision: 'revision-2' }; } })]
    });
    const created = await service.ingest(occurrence('approval-race'));
    const pending = await service.act({ schemaVersion: 1, logicalOperationId: '68111111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    const base = { schemaVersion: 1, episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'approval.approve', approvalId: pending.approval.approvalId, input: {} };
    const results = await Promise.allSettled([
      service.act({ ...base, logicalOperationId: '68222222-2222-4222-8222-222222222222' }),
      service.act({ ...base, logicalOperationId: '68333333-3333-4333-8333-333333333333' })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('preset Reminder snooze restores the persisted absolute instant during restart reconciliation', async () => {
  await fixture(async ({ metadata }) => {
    let applied = false;
    let dispatches = 0;
    const first = createAttentionService({
      metadata, now: () => '2026-08-23T00:01:00.000Z',
      sourceActions: {
        snooze: async () => { dispatches += 1; applied = true; first.close(); return { observedRevision: 'config-2' }; },
        verify: async () => ({ outcome: applied ? 'applied' : 'not-applied', revision: applied ? 'config-2' : 'config-1' })
      }
    });
    first.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await first.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-1', evidenceFacts: { reminderDue: true } }));
    const request = { schemaVersion: 1, logicalOperationId: '68888888-8888-4888-8888-888888888888', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.snooze', input: { preset: 'PT72H', expectedConfigRevision: 'config-1' } };
    await assert.rejects(() => first.act(request), /closed/i);
    const restarted = createAttentionService({
      metadata, now: () => '2026-08-23T00:02:00.000Z',
      sourceActions: { snooze: async () => { dispatches += 1; return {}; }, verify: async () => ({ outcome: 'applied', revision: 'config-2' }) }
    });
    restarted.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const result = await restarted.act(request);
    assert.equal(result.status, 'applied');
    assert.equal(result.episode.state, 'Snoozed');
    assert.equal(result.episode.snoozedUntil, '2026-08-26T00:01:00.000Z');
    assert.equal(dispatches, 1);
    restarted.close();
  });
});

test('approval-required actions fail closed without explicit host and operator identities across restart', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const action = descriptor({ approvalMode: 'required', executor: async () => { dispatches += 1; return {}; } });
    const first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: null, host: null });
    first.registerSourceCapability({ sourceCapabilityId: 'identity-required', deriveEvidence: () => ({}), actions: [action] });
    const created = await first.ingest(occurrence('identity-required'));
    const request = { schemaVersion: 1, logicalOperationId: '69777777-7777-4777-8777-777777777777', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: action.actionId, input: {} };
    await assert.rejects(() => first.act(request), (error) => error?.code === 'identity-unavailable');
    first.close();
    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z', operatorId: null, host: null });
    restarted.registerSourceCapability({ sourceCapabilityId: 'identity-required', deriveEvidence: () => ({}), actions: [action] });
    await assert.rejects(() => restarted.act({ ...request, logicalOperationId: '69777777-7777-4777-8777-777777777778', authenticatedOperatorId: 'operator-review' }), (error) => error?.code === 'identity-unavailable');
    assert.equal(dispatches, 0);
    restarted.close();
  });
});

test('an exact completed Reminder preauthorization replays one verified Activity record', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', sourceActions: { complete: async () => { dispatches += 1; return { observedRevision: 'config-2' }; }, verify: async () => ({ outcome: 'applied', revision: 'config-2' }) } });
    service.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await service.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-1', evidenceFacts: { reminderDue: true } }));
    const request = { schemaVersion: 1, logicalOperationId: '69999999-9999-4999-8999-999999999999', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-1' } };
    const first = await service.act(request);
    const replay = await service.act(request);
    assert.equal(first.status, 'applied');
    assert.equal(first.activity.actorMode, 'manual');
    assert.equal(replay.activity.activityId, first.activity.activityId);
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('preauthorization registration rejects every non-Reminder source action', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata });
    const action = descriptor({ actionId: 'monitor.wildcard', approvalMode: 'preauthorized' });
    assert.throws(() => service.registerSourceCapability({ sourceCapabilityId: 'wildcard-monitor', actions: [action], preauthorizations: [{ actionId: 'monitor.wildcard', version: 'authorization-1', parameters: {}, planRevision: 'plan-v1', policyRevision: 'policy-1', preconditionRevision: 'precondition-v1' }] }), /fresh approval|built-in Reminder/i);
    service.close();
  });
});

test('same-process Reminder Complete retry rejects evidence-revision drift before redispatch', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    let service;
    service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', sourceActions: { complete: async () => { dispatches += 1; await service.ingest(occurrence('reminders', { occurrenceId: 'reminder-drift-2', occurrenceVersion: 'config-2', occurredAt: '2026-08-23T00:00:30.000Z', attentionReason: 'reminder-due', evidenceFacts: { reminderDue: true } })); return {}; }, verify: async () => ({ outcome: 'not-applied', transient: true, revision: 'config-2' }) } });
    service.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await service.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-1', evidenceFacts: { reminderDue: true } }));
    const result = await service.act({ schemaVersion: 1, logicalOperationId: '69888888-8888-4888-8888-888888888888', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-1' } });
    assert.equal(result.status, 'partial');
    assert.equal(result.episode.severity, 'Critical');
    assert.equal(result.episode.evidenceFacts.actionOutcome, 'partial');
    assert.equal(result.activity.outcome, 'partial');
    assert.equal(result.activity.actorMode, 'manual');
    assert.deepEqual(service.list().buckets[0].map((episode) => episode.episodeId), [created.episode.episodeId]);
    assert.equal(service.list().buckets[2].length, 0);
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('a definite Reminder action failure enters the High operational lane', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({
      metadata,
      now: () => '2026-08-23T00:01:00.000Z',
      sourceActions: {
        complete: async () => ({}),
        verify: async () => ({ outcome: 'not-applied', transient: false })
      }
    });
    service.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await service.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-failure-1', evidenceFacts: { reminderDue: true } }));
    const result = await service.act({ schemaVersion: 1, logicalOperationId: '69899999-9999-4999-8999-999999999999', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-failure-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-failure-1' } });
    assert.equal(result.status, 'failed');
    assert.equal(result.episode.severity, 'High');
    assert.equal(result.episode.evidenceFacts.actionOutcome, 'failed');
    assert.equal(result.activity.outcome, 'failed');
    assert.deepEqual(service.list().buckets[1].map((episode) => episode.episodeId), [created.episode.episodeId]);
    assert.equal(service.list().buckets[2].length, 0);
    service.close();
  });
});

test('restart Reminder Snooze retry preserves identical intent and records verified Activity', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const first = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', sourceActions: { snooze: async () => { dispatches += 1; first.close(); return {}; }, verify: async () => ({ outcome: 'not-applied', transient: true, revision: 'config-1' }) } });
    first.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', monitoring: true, deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await first.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-1', evidenceFacts: { reminderDue: true } }));
    const request = { schemaVersion: 1, logicalOperationId: '69911111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.snooze', input: { preset: 'PT72H', expectedConfigRevision: 'config-1' } };
    await assert.rejects(() => first.act(request), /closed/i);
    let verificationCount = 0;
    const restarted = createAttentionService({ metadata, now: () => '2026-08-23T00:02:00.000Z', sourceActions: { snooze: async ({ parameters, logicalOperationId, retry }) => { dispatches += 1; assert.equal(parameters.until, '2026-08-26T00:01:00.000Z'); assert.equal(logicalOperationId, request.logicalOperationId); assert.equal(retry, true); return { observedRevision: 'config-2' }; }, verify: async () => (++verificationCount === 1 ? { outcome: 'not-applied', transient: true, revision: 'config-1' } : { outcome: 'applied', revision: 'config-2' }) } });
    restarted.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', monitoring: true, deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const result = await restarted.act(request);
    assert.equal(result.status, 'applied');
    assert.equal(result.attempt.retryCount, 1);
    assert.equal(result.activity.actorMode, 'manual');
    assert.equal(result.activity.outcome, 'applied');
    assert.equal(dispatches, 2);
    const replay = await restarted.act(request);
    assert.equal(replay.activity.activityId, result.activity.activityId);
    assert.equal(dispatches, 2);
    restarted.close();
  });
});

test('direct retryable actions reject evidence changes before a second dispatch', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    let service;
    const action = descriptor({
      actionId: 'monitor.direct-retry',
      idempotency: { idempotent: true, transientRetryable: true },
      executor: async () => {
        dispatches += 1;
        await service.ingest(occurrence('direct-retry-monitor', { occurrenceId: 'direct-retry-new-evidence', occurredAt: '2026-08-23T00:00:30.000Z' }));
        return {};
      },
      authoritativeVerifier: async () => ({ outcome: 'not-applied', transient: true })
    });
    service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'direct-retry-monitor', deriveEvidence: () => ({}), actions: [action] });
    const created = await service.ingest(occurrence('direct-retry-monitor'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '69877777-7777-4777-8777-777777777777', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: action.actionId, input: {} });
    assert.equal(result.status, 'partial');
    assert.equal(dispatches, 1);
    service.close();
  });
});

test('global Activity pages include legacy verified records alongside Attention history', async () => {
  await fixture(async ({ metadata }) => {
    metadata.recordActivity({ activityId: 'activity:legacy-review', topicId: 'topic-review', logicalOperationId: 'legacy-operation-review', transportRequestId: 'legacy-request-review', operationKind: 'scheduler.run', outcome: 'applied', observedRevision: 'legacy-revision-1', createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z' });
    metadata.recordActivity({ activityId: 'activity:legacy-review-newer', topicId: 'topic-review', logicalOperationId: 'legacy-operation-review-newer', transportRequestId: 'legacy-request-review-newer', operationKind: 'scheduler.run', outcome: 'applied', observedRevision: 'legacy-revision-2', createdAt: '2026-08-23T00:00:01.000Z', updatedAt: '2026-08-23T00:00:01.000Z' });
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    const first = service.listActivity({ schemaVersion: 1, topicId: 'topic-review', limit: 1 });
    assert.deepEqual(first.records.map((record) => record.activityId), ['activity:legacy-review-newer']);
    assert.equal(first.nextOffset, 1); assert.equal(first.hasMore, true);
    const page = service.listActivity({ schemaVersion: 1, topicId: 'topic-review', offset: first.nextOffset, limit: 1 });
    assert.deepEqual(page.records.map((record) => record.activityId), ['activity:legacy-review']);
    assert.deepEqual({ nextOffset: page.nextOffset, hasMore: page.hasMore }, { nextOffset: null, hasMore: false });
    assert.throws(() => service.listActivity({ schemaVersion: 1, offset: -1 }), /offset/i);
    assert.throws(() => service.listActivity({ schemaVersion: 1, offset: 0.5 }), /offset/i);
    assert.throws(() => service.listActivity({ schemaVersion: 1, cursor: 'forbidden' }), /unsupported/i);
    assert.doesNotThrow(() => service.listActivity({ schemaVersion: 1, limit: 100 }));
    assert.throws(() => service.listActivity({ schemaVersion: 1, limit: 101 }), /limit/i);
    assert.equal(service.getActivity('activity:legacy-review').verificationRevision, 'legacy-revision-1');
    service.close();
  });
});

test('the delayed-delivery window excludes the exact ten-minute boundary and requires an active transition', async () => {
  await fixture(async ({ metadata }) => {
    let clock = '2026-08-23T00:00:00.000Z';
    const service = createAttentionService({ metadata, now: () => clock });
    service.registerSourceCapability({ sourceCapabilityId: 'boundary-monitor', deriveEvidence: () => ({}), verifyTransition: async (value) => value.transitionEvidence?.verified === true, actions: [] });
    const created = await service.ingest(occurrence('boundary-monitor'));
    await service.ingest(occurrence('boundary-monitor', { occurrenceId: 'boundary-terminal', transitionEvidence: { state: 'resolved', verified: true } }));
    const exactActiveReplay = await service.ingest(occurrence('boundary-monitor', { transitionEvidence: { state: 'active', verified: true } }));
    assert.equal(exactActiveReplay.duplicate, true);
    assert.equal(exactActiveReplay.episode.generation, created.episode.generation);
    const revisedExactReplay = await service.ingest(occurrence('boundary-monitor', { occurrenceVersion: 'revision-2' }));
    assert.equal(revisedExactReplay.duplicate, true, 'an occurrence ID remains exact across observed revisions');
    const unverifiedRevision = await service.ingest(occurrence('boundary-monitor', { occurrenceId: 'boundary-unverified-revision', occurrenceVersion: 'revision-3' }));
    assert.equal(unverifiedRevision.ignored, true, 'a changed revision is not capability-verified transition proof');
    clock = '2026-08-23T00:09:59.999Z';
    const delayed = await service.ingest(occurrence('boundary-monitor', { occurrenceId: 'boundary-delayed' }));
    assert.equal(delayed.ignored, true);
    clock = '2026-08-23T00:10:00.000Z';
    const boundary = await service.ingest(occurrence('boundary-monitor', { occurrenceId: 'boundary-exact' }));
    assert.equal(boundary.ignored, false);
    assert.equal(boundary.episode.generation, 2);
    await service.ingest(occurrence('boundary-monitor', { occurrenceId: 'boundary-terminal-2', transitionEvidence: { state: 'resolved', verified: true } }));
    clock = '2026-08-23T00:10:01.000Z';
    const unchangedTerminal = await service.ingest(occurrence('boundary-monitor', { occurrenceId: 'boundary-unchanged-terminal', transitionEvidence: { state: 'resolved', verified: true } }));
    assert.equal(unchangedTerminal.ignored, true);
    service.close();
  });
});

test('accepted snooze presets use fixed durations and timezone-aware next 07:00', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'snooze-preset-monitor', sourceKind: 'reminder', deriveEvidence: () => ({}), actions: [] });
    const created = await service.ingest(occurrence('snooze-preset-monitor', { occurrenceVersion: 'config-1' }));
    assert.deepEqual(service.get(created.episode.episodeId).episode.eligibleSnoozeChoices, ['NEXT_0700', 'PT72H', 'PT168H', 'custom']);
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '69922222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.snooze', input: { preset: 'PT24H', expectedConfigRevision: 'config-1' } }), /preset|snooze/i);
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '69933333-3333-4333-8333-333333333333', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.snooze', input: { preset: 'PT72H', until: '2026-08-24T00:00:00.000Z', expectedConfigRevision: 'config-1' } }), /exactly one/i);
    service.close();
  });
  assert.deepEqual(SNOOZE_PRESETS, ['NEXT_0700', 'PT72H', 'PT168H']);
  assert.equal(resolveSnoozeUntil('PT72H', '2026-08-23T00:00:00.000Z', 'UTC'), '2026-08-26T00:00:00.000Z');
  assert.equal(resolveSnoozeUntil('PT168H', '2026-08-23T00:00:00.000Z', 'UTC'), '2026-08-30T00:00:00.000Z');
  assert.equal(resolveSnoozeUntil('NEXT_0700', '2026-03-08T05:30:00.000Z', 'America/New_York'), '2026-03-09T11:00:00.000Z');
  assert.equal(resolveSnoozeUntil('NEXT_0700', '2026-11-01T04:30:00.000Z', 'America/New_York'), '2026-11-02T12:00:00.000Z');
  assert.equal(resolveSnoozeUntil('NEXT_0700', '2026-08-27T05:30:00.000Z', 'UTC'), '2026-08-28T07:00:00.000Z');
});

test('occurrence identity is condition-scoped while out-of-order evidence fails closed and severity remains monotonic', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:03:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'ordered-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    await assert.rejects(() => service.ingest({ ...occurrence('ordered-monitor'), occurrenceId: undefined }), /occurrenceId/i);
    const explicitlyUnversioned = await service.ingest({ ...occurrence('ordered-monitor'), stableSubjectId: 'explicitly-unversioned', occurrenceId: undefined, unversioned: true });
    const unversionedReplay = await service.ingest({ ...occurrence('ordered-monitor'), stableSubjectId: 'explicitly-unversioned', occurrenceId: undefined, unversioned: true });
    assert.equal(unversionedReplay.duplicate, true);
    assert.equal(unversionedReplay.episode.episodeId, explicitlyUnversioned.episode.episodeId);
    const created = await service.ingest(occurrence('ordered-monitor', { occurrenceId: 'shared-occurrence', occurredAt: '2026-08-23T00:02:00.000Z', evidenceFacts: { facts: ['blocked-work'] } }));
    assert.equal(created.episode.severity, 'High');
    const unrelated = await service.ingest(occurrence('ordered-monitor', { stableSubjectId: 'different-subject', occurrenceId: 'shared-occurrence', occurredAt: '2026-08-23T00:02:30.000Z' }));
    assert.notEqual(unrelated.episode.episodeId, created.episode.episodeId);
    const stale = await service.ingest(occurrence('ordered-monitor', { occurrenceId: 'older-occurrence', occurredAt: '2026-08-23T00:01:00.000Z' }));
    assert.equal(stale.ignored, true);
    assert.equal(service.get(created.episode.episodeId).episode.severity, 'High');
    await service.ingest(occurrence('ordered-monitor', { occurrenceId: 'newer-occurrence', occurredAt: '2026-08-23T00:03:00.000Z', evidenceFacts: {} }));
    assert.equal(service.get(created.episode.episodeId).episode.severity, 'High');
    assert.deepEqual(service.get(created.episode.episodeId).episode.evidenceFacts.facts, ['blocked-work']);
    await service.ingest(occurrence('ordered-monitor', { occurrenceId: 'versioned-current', occurrenceVersion: 'revision-2', occurredAt: '2026-08-23T00:04:00.000Z' }));
    await assert.rejects(() => service.ingest(occurrence('ordered-monitor', { occurrenceId: 'versioned-stale', occurrenceVersion: 'revision-1', occurredAt: '2026-08-23T00:04:00.000Z' })), /equal-time|revision/i);
    await assert.rejects(() => service.ingest(occurrence('ordered-monitor', { occurrenceId: 'unversioned-stale', occurredAt: '2026-08-23T00:04:00.000Z' })), /equal-time|revision/i);
    service.close();
  });
});

test('versioned mutations require the exact source revision and due Reminders sort by first-seen time', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:03:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'versioned-monitor', deriveEvidence: (value) => value.evidenceFacts, actions: [descriptor()] });
    const created = await service.ingest(occurrence('versioned-monitor', { occurrenceVersion: 'source-7' }));
    const action = { schemaVersion: 1, logicalOperationId: '69944444-4444-4444-8444-444444444444', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} };
    await assert.rejects(() => service.act(action), /source revision/i);
    const appliedAction = { ...action, logicalOperationId: '69955555-5555-4555-8555-555555555555', expectedSourceRevision: 'source-7' };
    assert.equal((await approvedAct(service, appliedAction)).status, 'applied');
    await assert.rejects(() => service.act({ ...appliedAction, expectedSourceRevision: 'source-8' }), /intent/i);
    service.registerSourceCapability({ sourceCapabilityId: 'due-order', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    await service.ingest(occurrence('due-order', { stableSubjectId: 'first-seen', occurrenceId: 'due-first', occurredAt: '2026-08-23T00:00:00.000Z', evidenceFacts: { reminderDue: true, dueAt: '2026-08-23T00:02:00.000Z' } }));
    await service.ingest(occurrence('due-order', { stableSubjectId: 'later-seen', occurrenceId: 'due-later', occurredAt: '2026-08-23T00:01:00.000Z', evidenceFacts: { reminderDue: true, dueAt: '2026-08-23T00:00:30.000Z' } }));
    assert.deepEqual(service.list({ schemaVersion: 1 }).buckets[2].map((episode) => episode.stableSubjectId), ['first-seen', 'later-seen']);
    service.close();
  });
});

test('unresolved ambiguity remains Critical across repeated Routine evidence updates', async () => {
  await fixture(async ({ metadata }) => {
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'durable-ambiguity', deriveEvidence: (value) => value.evidenceFacts, actions: [descriptor({
      executor: async () => { throw new Error('fictional transport loss'); },
      authoritativeVerifier: async () => ({ outcome: 'unknown' })
    })] });
    const created = await service.ingest(occurrence('durable-ambiguity'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '69111111-1111-4111-8111-111111111111', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(result.status, 'unknown');
    assert.equal(result.episode.severity, 'Critical');
    await service.ingest(occurrence('durable-ambiguity', { occurrenceId: 'durable-ambiguity-2', occurredAt: '2026-08-23T00:00:30.000Z' }));
    await service.ingest(occurrence('durable-ambiguity', { occurrenceId: 'durable-ambiguity-3', occurredAt: '2026-08-23T00:00:40.000Z' }));
    const episode = service.get(created.episode.episodeId).episode;
    assert.equal(episode.severity, 'Critical');
    assert.equal(episode.evidenceFacts.actionOutcome, 'ambiguous');
    service.close();
  });
});

test('Reminder mutations bind expectedConfigRevision to the trusted episode source revision', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', sourceActions: {
      complete: async () => { dispatches += 1; return {}; }, verify: async () => ({ outcome: 'applied' })
    } });
    service.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await service.ingest(occurrence('reminders', { attentionReason: 'reminder-due', occurrenceVersion: 'config-1', evidenceFacts: { reminderDue: true } }));
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '69222222-2222-4222-8222-222222222222', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-2' } }), /config|revision/i);
    const unversioned = await service.ingest(occurrence('reminders', { stableSubjectId: 'unversioned-reminder', occurrenceId: 'unversioned-reminder-occurrence', attentionReason: 'reminder-due', evidenceFacts: { reminderDue: true } }));
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '69233333-3333-4333-8333-333333333333', episodeId: unversioned.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'reminder.complete', input: { expectedConfigRevision: 'invented-config' } }), /authoritative|revision/i);
    assert.equal(dispatches, 0);
    service.close();
  });
});

test('post-verification transition failures preserve applied history and enter Critical recovery', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const service = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    service.registerSourceCapability({ sourceCapabilityId: 'projection-failure', deriveEvidence: () => ({}), actions: [descriptor({
      executor: async () => { dispatches += 1; return { observedRevision: 'source-2' }; },
      authoritativeVerifier: async () => ({ outcome: 'applied', revision: 'source-2' }),
      successTransition: async () => { throw new Error('fictional projection failure'); }
    })] });
    const created = await service.ingest(occurrence('projection-failure'));
    const result = await approvedAct(service, { schemaVersion: 1, logicalOperationId: '69333333-3333-4333-8333-333333333333', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} });
    assert.equal(result.status, 'recovery-required');
    assert.equal(result.attempt.state, 'applied');
    assert.equal(result.activity.outcome, 'applied');
    assert.equal(result.episode.state, 'Active');
    assert.equal(result.episode.severity, 'Critical');
    assert.equal(result.episode.evidenceFacts.actionOutcome, 'projection-failure');
    assert.equal(dispatches, 1);
    assert.equal(service.get(created.episode.episodeId).episode.actions.some((action) => action.actionId === 'monitor.apply'), false);
    await assert.rejects(() => service.act({ schemaVersion: 1, logicalOperationId: '69344444-4444-4444-8444-444444444444', episodeId: created.episode.episodeId, expectedEpisodeRevision: result.episode.revision, topicId: 'topic-review', sourceReferenceId: 'source-review', actionId: 'monitor.apply', input: {} }), /registered|invalid.action/i);
    assert.equal(dispatches, 1);
    service.close();
  });
});
