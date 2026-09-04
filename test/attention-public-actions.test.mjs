import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionActionHandler } from '../src/attention/http-route.mjs';
import { createAttentionService } from '../src/attention/service.mjs';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createSourceCapabilityRegistry } from '../src/sources/capabilities.mjs';
import { createAuthoritativeSourceService } from '../src/sources/service.mjs';

const capabilities = { notes: true, sessions: true, scheduler: true, activity: true, analysis: true, attention: true, search: true };

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-attention-public-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities });
  metadata.createTopic({ topicId: 'topic-public', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'source-public', topicId: 'topic-public', sourceSystem: 'fictional', sourceKind: 'monitor', externalSourceId: 'subject-public' });
  try { return await run({ metadata }); } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

function occurrence(sourceCapabilityId, occurrenceId, overrides = {}) {
  return { schemaVersion: 1, sourceCapabilityId, stableSubjectId: 'subject-public', attentionReason: 'public-action', occurrenceId, occurredAt: '2026-08-23T00:00:00.000Z', topicId: 'topic-public', sourceReferenceId: 'source-public', evidenceFacts: { reminderDue: true }, ...overrides };
}

function responseRecorder() {
  return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } };
}

function authenticatedAction(attention) {
  const registrations = [];
  registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, { attentionAct: (input) => attention.act(input) });
  const handler = registrations.find(([method]) => method === 'command-center.v1.attention.act')[1];
  return (params) => new Promise((resolve) => handler({ req: { id: params.logicalOperationId }, params, client: { authenticatedOperatorId: 'gateway-operator' }, context: { authenticated: true }, respond: (...args) => resolve(args) }));
}

test('Attention action route admits only exact opaque-frame JSON preflights', async () => {
  let calls = 0;
  const handler = createAttentionActionHandler({ attentionGet() { calls += 1; }, attentionAct() { calls += 1; } });
  const accepted = responseRecorder();
  await handler({ method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true' } }, accepted);
  assert.equal(accepted.statusCode, 204);
  assert.equal(accepted.body, '');
  assert.equal(accepted.headers['Access-Control-Allow-Origin'], 'null');
  assert.equal(accepted.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(accepted.headers['Access-Control-Allow-Headers'], 'Content-Type');
  assert.equal(accepted.headers['Access-Control-Allow-Private-Network'], 'true');
  assert.equal(accepted.headers['Access-Control-Allow-Credentials'], undefined);
  for (const headers of [
    { origin: 'https://example.invalid', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' },
    { origin: 'null', 'access-control-request-method': 'POST' },
    { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' }
  ]) {
    const rejected = responseRecorder();
    await handler({ method: 'OPTIONS', headers }, rejected);
    assert.equal(rejected.statusCode, 403);
  }
  const nonJson = responseRecorder();
  await handler({ method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: {} }, nonJson);
  assert.equal(nonJson.statusCode, 400);
  const nonNullOrigin = responseRecorder();
  await handler({ method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: {} }, nonNullOrigin);
  assert.equal(nonNullOrigin.statusCode, 403);
  assert.equal(calls, 0);
});

test('registered source ingestion and authenticated bridge complete a Reminder with authoritative verification', async () => {
  await fixture(async ({ metadata }) => {
    const calls = [];
    const attention = createAttentionService({
      metadata,
      now: () => '2026-08-23T00:01:00.000Z',
      sourceActions: {
        complete: async (input) => { calls.push(input); return { observedRevision: 'config-2' }; },
        verify: async () => ({ outcome: 'applied', revision: 'config-2' })
      }
    });
    const sources = createSourceCapabilityRegistry({ attention });
    sources.register({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await sources.ingest(occurrence('reminders', 'reminder-public-1', { occurrenceVersion: 'config-1' }));
    const invoke = authenticatedAction(attention);
    const body = { schemaVersion: 1, logicalOperationId: '71111111-1111-4111-8111-111111111111', sourceCapabilityId: 'reminders', stableSubjectId: 'subject-public', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1', topicId: 'topic-public', sourceReferenceId: 'source-public', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-1' } };
    for (const wrongIdentity of [{ sourceCapabilityId: 'other-capability' }, { stableSubjectId: 'other-subject' }]) {
      const rejected = await invoke({ ...body, ...wrongIdentity });
      assert.equal(rejected[0], false);
      assert.equal(calls.length, 0);
    }
    const response = await invoke(body);
    assert.equal(response[0], true, JSON.stringify(response));
    assert.equal(response[1].result.episode.state, 'Resolved');
    assert.equal(calls[0].parameters.expectedConfigRevision, 'config-1');
    const replay = await invoke(body);
    assert.equal(replay[0], true);
    assert.equal(replay[1].result.activity.activityId, response[1].result.activity.activityId);
    assert.equal(calls.length, 1);
    const openBody = await invoke({ ...body, logicalOperationId: '72222222-2222-4222-8222-222222222222', credential: 'forbidden' });
    assert.equal(openBody[0], false);
    attention.close();
  });
});

test('the plugin POST route cannot fabricate an operator for approval-required mutations', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const attention = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', host: 'host-public' });
    attention.registerSourceCapability({
      sourceCapabilityId: 'approval-route', deriveEvidence: () => ({}),
      preconditionReader: async () => ({ available: true, revision: 'precondition-1' }),
      actions: [{
        actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-public' }),
        parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes a fictional monitor.'], approvalMode: 'required',
        idempotency: { idempotent: true, transientRetryable: true }, executor: async () => { dispatches += 1; return {}; }, authoritativeVerifier: async () => ({ outcome: 'applied' }), successTransition: async () => 'Resolved'
      }]
    });
    const created = await attention.ingest(occurrence('approval-route', 'approval-route-1'));
    const handler = createAttentionActionHandler({ attentionAct: (input) => attention.act(input), attentionGet: (input) => attention.get(input.episodeId) });
    const response = responseRecorder();
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { schemaVersion: 1, logicalOperationId: '70111111-1111-4111-8111-111111111111', sourceCapabilityId: 'approval-route', stableSubjectId: 'subject-public', episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'unversioned', topicId: 'topic-public', sourceReferenceId: 'source-public', actionId: 'monitor.change', input: {} } }, response);
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, 'authenticated-bridge-required');
    assert.equal(dispatches, 0);
    assert.equal(attention.get(created.episode.episodeId).episode.state, 'Active');
    attention.close();
  });
});

test('production Reminder listing ingests due scheduler evidence into Attention', async () => {
  await fixture(async ({ metadata }) => {
    metadata.createSourceReference({ version: 1, referenceId: 'reminder-production', topicId: 'topic-public', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'job-production', observedRevision: 'config-1' });
    metadata.createSourceReference({ version: 1, referenceId: 'reminder-recurring', topicId: 'topic-public', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'job-recurring', observedRevision: 'config-recurring-1' });
    const attention = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z' });
    attention.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, verifyTransition: (value) => value.transitionEvidence?.verifiedSource === 'scheduler-readback' && value.transitionEvidence?.version === value.occurrenceVersion, actions: [] });
    let present = true;
    let recurring = false;
    const sourceService = createAuthoritativeSourceService({
      metadata,
      capabilities,
      attentionService: attention,
      gateway: { request: async (method) => {
        assert.equal(method, 'cron.list');
        return { jobs: [...(present ? [{ id: 'job-production', enabled: true, configRevision: 'config-1', schedule: { kind: 'at', at: '2026-08-22T00:00:00.000Z' } }] : []), ...(recurring ? [{ id: 'job-recurring', enabled: true, configRevision: 'config-recurring-1', schedule: { kind: 'every', everyMs: 60_000 }, state: { nextRunAtMs: Date.parse('2026-08-22T00:00:00.000Z') } }] : [])] };
      } }
    });
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    const episodes = attention.list({ schemaVersion: 1 }).episodes;
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].sourceReferenceId, 'reminder-production');
    assert.deepEqual(episodes[0].actions.map((action) => action.actionId), ['reminder.complete', 'reminder.snooze', 'topic.open']);
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    assert.equal(attention.get(episodes[0].episodeId).revision, episodes[0].revision);
    present = false;
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    assert.equal(attention.list({ schemaVersion: 1 }).episodes.length, 0);
    assert.equal(attention.listActivity({ schemaVersion: 1, topicId: 'topic-public' }).records.some((record) => record.outcome === 'withdrawn'), true);
    present = true;
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    const returned = attention.list({ schemaVersion: 1 }).episodes;
    assert.equal(returned.length, 1);
    assert.equal(returned[0].generation, 2);
    assert.notEqual(returned[0].episodeId, episodes[0].episodeId);
    recurring = true;
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    assert.equal(attention.list({ schemaVersion: 1 }).episodes.some((episode) => episode.sourceReferenceId === 'reminder-recurring'), true);
    sourceService.close();
    attention.close();
  });
});

test('authenticated Gateway actions expose and consume approval decisions through the same service', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    let preconditionRevision = 'precondition-1';
    const attention = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', operatorId: 'operator-public', host: 'host-public' });
    const sources = createSourceCapabilityRegistry({ attention });
    sources.register({
      sourceCapabilityId: 'approval-public',
      sourceKind: 'approval',
      deriveEvidence: () => ({}),
      preconditionReader: async () => ({ available: true, revision: preconditionRevision }),
      actions: [{
        actionId: 'monitor.change', label: 'Change Monitor', kind: 'mutation', targetResolver: () => ({ stableSubjectId: 'subject-public' }),
        parameterSchema: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: ['Changes the fictional monitor.'], approvalMode: 'required',
        idempotency: { idempotent: true, transientRetryable: true }, executor: async () => { dispatches += 1; return { observedRevision: 'revision-2' }; },
        authoritativeVerifier: async () => ({ outcome: 'applied', revision: 'revision-2' }), successTransition: async () => 'Resolved'
      }]
    });
    const created = await sources.ingest(occurrence('approval-public', 'approval-public-1'));
    const registrations = [];
    registerBridgeMethods({ registerGatewayMethod: (...args) => registrations.push(args) }, {
      attentionAct: (input) => attention.act(input), attentionList: (input) => attention.list(input), attentionGet: (input) => attention.get(input.episodeId),
      activityList: (input) => attention.listActivity(input), activityGet: (input) => ({ schemaVersion: 1, record: attention.getActivity(input.activityId) })
    });
    const handler = registrations.find(([method]) => method === 'command-center.v1.attention.act')[1];
    const invoke = (params, authenticated = true, authenticatedOperatorId = 'gateway-operator') => new Promise((resolve) => handler({ req: { id: params.logicalOperationId }, params, client: { authenticatedOperatorId }, context: { authenticated }, respond: (...args) => resolve(args) }));
    const common = { schemaVersion: 1, episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'unversioned', topicId: 'topic-public', sourceReferenceId: 'source-public', input: {} };
    const pending = await invoke({ ...common, sourceCapabilityId: created.episode.sourceCapabilityId, stableSubjectId: created.episode.stableSubjectId, logicalOperationId: '73333333-3333-4333-8333-333333333333', actionId: 'monitor.change' });
    assert.equal(pending[0], true, JSON.stringify(pending));
    assert.equal(pending[1].result.approval.operatorId, 'gateway-operator');
    assert.equal(pending[1].result.approval.actionId, 'monitor.change');
    const projectedApproval = attention.get(created.episode.episodeId).episode.actions.find((action) => action.actionId === 'approval.approve');
    assert.equal(projectedApproval.target.approvalId, pending[1].result.approval.approvalId);
    assert.deepEqual(projectedApproval.target.disclosure.sideEffects, ['Changes the fictional monitor.']);
    assert.deepEqual(attention.get(created.episode.episodeId).episode.actions.map((action) => action.actionId), ['approval.approve', 'approval.reject', 'topic.open']);
    const unauthenticated = await invoke({ ...common, logicalOperationId: '74444444-4444-4444-8444-444444444444', actionId: 'approval.approve', approvalId: pending[1].result.approval.approvalId }, false);
    assert.equal(unauthenticated[0], false);
    const approved = await invoke({ ...common, logicalOperationId: '75555555-5555-4555-8555-555555555555', actionId: 'approval.approve', approvalId: pending[1].result.approval.approvalId });
    assert.equal(approved[0], true, JSON.stringify(approved));
    assert.equal(approved[1].result.episode.state, 'Resolved');
    assert.equal(dispatches, 1);
    const approvedReplay = await invoke({ ...common, logicalOperationId: '75555555-5555-4555-8555-555555555555', actionId: 'approval.approve', approvalId: pending[1].result.approval.approvalId });
    assert.equal(approvedReplay[0], true);
    assert.equal(approvedReplay[1].result.activity.activityId, approved[1].result.activity.activityId);
    assert.equal(dispatches, 1);
    const rejectable = await sources.ingest(occurrence('approval-public', 'approval-public-2', { stableSubjectId: 'subject-public-reject' }));
    const rejectCommon = { ...common, episodeId: rejectable.episode.episodeId };
    const rejectionPending = await invoke({ ...rejectCommon, logicalOperationId: '76666666-6666-4666-8666-666666666666', actionId: 'monitor.change' }); assert.equal(rejectionPending[0], true);
    const rejected = await invoke({ ...rejectCommon, logicalOperationId: '77777777-7777-4777-8777-777777777777', actionId: 'approval.reject', approvalId: rejectionPending[1].result.approval.approvalId });
    assert.equal(rejected[0], true, JSON.stringify(rejected));
    assert.equal(rejected[1].result.activity.actionId, 'approval.reject');
    assert.equal(rejected[1].result.activity.outcome, 'withdrawn');
    assert.equal((await invoke({ ...rejectCommon, logicalOperationId: '77777777-7777-4777-8777-777777777777', actionId: 'approval.reject', approvalId: rejectionPending[1].result.approval.approvalId }))[0], true);
    assert.equal(attention.get(rejectable.episode.episodeId).episode.state, 'Withdrawn');
    assert.equal(dispatches, 1);

    const replaceable = await sources.ingest(occurrence('approval-public', 'approval-public-3', { stableSubjectId: 'subject-public-replacement' }));
    const replacementCommon = { ...common, episodeId: replaceable.episode.episodeId };
    const stale = await invoke({ ...replacementCommon, logicalOperationId: '78888888-8888-4888-8888-888888888888', actionId: 'monitor.change' });
    assert.equal(stale[0], true, JSON.stringify(stale));
    preconditionRevision = 'precondition-2';
    const replacement = await invoke({ ...replacementCommon, logicalOperationId: '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actionId: 'monitor.change' });
    assert.equal(replacement[0], true, JSON.stringify(replacement));
    assert.equal(replacement[1].result.status, 'approval-required');
    assert.notEqual(replacement[1].result.approval.approvalId, stale[1].result.approval.approvalId);
    assert.equal(replacement[1].result.approval.preconditionRevision, 'precondition-2');
    assert.equal(replacement[1].result.approval.state, 'pending');
    assert.equal(dispatches, 1);

    const revised = await sources.ingest(occurrence('approval-public', 'approval-public-4', { stableSubjectId: 'subject-public-replacement', occurredAt: '2026-08-23T00:02:00.000Z' }));
    assert.equal(revised.episode.revision, 2);
    assert.deepEqual(attention.get(replaceable.episode.episodeId).episode.actions.map((action) => action.actionId), ['monitor.change']);
    const evidenceReplacement = await invoke({ ...replacementCommon, expectedEpisodeRevision: 2, logicalOperationId: '7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actionId: 'monitor.change' });
    assert.equal(evidenceReplacement[0], true, JSON.stringify(evidenceReplacement));
    assert.equal(evidenceReplacement[1].result.status, 'approval-required');
    assert.notEqual(evidenceReplacement[1].result.approval.approvalId, replacement[1].result.approval.approvalId);
    assert.equal(evidenceReplacement[1].result.approval.episodeRevision, 2);

    const operatorDrift = await sources.ingest(occurrence('approval-public', 'approval-public-5', { stableSubjectId: 'subject-public-operator-drift' }));
    const operatorCommon = { ...common, episodeId: operatorDrift.episode.episodeId };
    const firstOperator = await invoke({ ...operatorCommon, logicalOperationId: '7ccccccc-cccc-4ccc-8ccc-cccccccccccc', actionId: 'monitor.change' });
    assert.equal(firstOperator[1].result.approval.operatorId, 'gateway-operator');
    const secondOperator = await invoke({ ...operatorCommon, logicalOperationId: '7ddddddd-dddd-4ddd-8ddd-dddddddddddd', actionId: 'monitor.change' }, true, 'gateway-operator-2');
    assert.equal(secondOperator[0], true, JSON.stringify(secondOperator));
    assert.notEqual(secondOperator[1].result.approval.approvalId, firstOperator[1].result.approval.approvalId);
    assert.equal(secondOperator[1].result.approval.operatorId, 'gateway-operator-2');
    attention.close();
  });
});

test('an enabled future Reminder remains Snoozed during authoritative monitoring', async () => {
  await fixture(async ({ metadata }) => {
    metadata.createSourceReference({ version: 1, referenceId: 'reminder-snoozed', topicId: 'topic-public', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'job-snoozed', observedRevision: 'config-1' });
    let job = { id: 'job-snoozed', enabled: true, configRevision: 'config-1', schedule: { kind: 'at', at: '2026-08-22T00:00:00.000Z' } };
    let sourceService;
    const attention = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', sourceActions: {
      snooze: async ({ parameters }) => { job = { ...job, configRevision: 'config-2', schedule: { kind: 'at', at: parameters.until } }; return { observedRevision: 'config-2' }; },
      verify: async () => ({ outcome: 'applied', revision: 'config-2' })
    } });
    attention.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, verifyTransition: (value) => value.transitionEvidence?.verifiedSource === 'scheduler-readback' && value.transitionEvidence?.version === value.occurrenceVersion, actions: [] });
    sourceService = createAuthoritativeSourceService({ metadata, capabilities, attentionService: attention, gateway: { request: async () => ({ jobs: [job] }) } });
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    const created = attention.list({ schemaVersion: 1 }).episodes[0];
    const snoozed = await attention.act({ schemaVersion: 1, logicalOperationId: '78888888-8888-4888-8888-888888888888', episodeId: created.episodeId, expectedEpisodeRevision: created.revision, expectedSourceRevision: 'config-1', topicId: 'topic-public', sourceReferenceId: 'reminder-snoozed', actionId: 'reminder.snooze', input: { until: '2099-08-23T00:00:00.000Z', expectedConfigRevision: 'config-1' } });
    assert.equal(snoozed.episode.state, 'Snoozed');
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    const monitored = attention.get(created.episodeId).episode;
    assert.equal(monitored.state, 'Snoozed');
    assert.equal(attention.listActivity({ schemaVersion: 1, topicId: 'topic-public' }).records.some((record) => record.outcome === 'withdrawn'), false);
    sourceService.close();
    attention.close();
  });
});

test('a snoozed Reminder refreshes its authoritative revision before the next public action', async () => {
  await fixture(async ({ metadata }) => {
    metadata.createSourceReference({ version: 1, referenceId: 'reminder-recurrence', topicId: 'topic-public', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'job-recurrence', observedRevision: 'config-1' });
    let clock = '2026-08-23T00:01:00.000Z';
    let job = { id: 'job-recurrence', enabled: true, configRevision: 'config-1', schedule: { kind: 'at', at: '2026-08-23T00:00:00.000Z' } };
    const attention = createAttentionService({
      metadata,
      now: () => clock,
      sourceActions: {
        snooze: async ({ parameters }) => { job = { ...job, configRevision: 'config-2', schedule: { kind: 'at', at: parameters.until } }; return { observedRevision: 'config-2' }; },
        complete: async () => { job = { ...job, enabled: false, configRevision: 'config-3' }; return { observedRevision: 'config-3' }; },
        verify: async () => ({ outcome: 'applied', revision: job.configRevision })
      }
    });
    attention.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, verifyTransition: (value) => value.transitionEvidence?.verifiedSource === 'scheduler-readback' && value.transitionEvidence?.version === value.occurrenceVersion, actions: [] });
    const sourceService = createAuthoritativeSourceService({ metadata, capabilities, attentionService: attention, now: () => clock, gateway: { request: async () => ({ jobs: [job] }) } });
    const invoke = authenticatedAction(attention);

    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    const created = attention.list({ schemaVersion: 1 }).episodes[0];
    const common = { schemaVersion: 1, sourceCapabilityId: 'reminders', stableSubjectId: 'job-recurrence', episodeId: created.episodeId, topicId: 'topic-public', sourceReferenceId: 'reminder-recurrence' };
    const snoozeResponse = await invoke({ ...common, logicalOperationId: '78911111-1111-4111-8111-111111111111', expectedEpisodeRevision: created.revision, expectedSourceRevision: 'config-1', actionId: 'reminder.snooze', input: { until: '2026-08-23T00:02:00.000Z', expectedConfigRevision: 'config-1' } });
    assert.equal(snoozeResponse[0], true, JSON.stringify(snoozeResponse));

    clock = '2026-08-23T00:03:00.000Z';
    await sourceService.remindersList({ schemaVersion: 1, topicId: 'topic-public' });
    const ready = attention.list({ schemaVersion: 1 }).episodes[0];
    assert.equal(ready.episodeId, created.episodeId);
    assert.equal(ready.sourceRevision, 'config-2');
    const completeResponse = await invoke({ ...common, logicalOperationId: '78922222-2222-4222-8222-222222222222', expectedEpisodeRevision: ready.revision, expectedSourceRevision: 'config-2', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-2' } });
    assert.equal(completeResponse[0], true, JSON.stringify(completeResponse));
    assert.equal(completeResponse[1].result.episode.state, 'Resolved');
    assert.equal(job.configRevision, 'config-3');
    sourceService.close();
    attention.close();
  });
});

test('the public Reminder preauthorization binds the exact scheduler revision', async () => {
  await fixture(async ({ metadata }) => {
    let dispatches = 0;
    const attention = createAttentionService({ metadata, now: () => '2026-08-23T00:01:00.000Z', sourceActions: { complete: async () => { dispatches += 1; return {}; }, verify: async () => ({ outcome: 'applied' }) } });
    attention.registerSourceCapability({ sourceCapabilityId: 'reminders', sourceKind: 'reminder', deriveEvidence: (value) => value.evidenceFacts, actions: [] });
    const created = await attention.ingest(occurrence('reminders', 'preauthorized-public-1', { occurrenceVersion: 'config-1', attentionReason: 'reminder-due', evidenceFacts: { reminderDue: true } }));
    await assert.rejects(attention.act({
      schemaVersion: 1, logicalOperationId: '79999999-9999-4999-8999-999999999999',
      episodeId: created.episode.episodeId, expectedEpisodeRevision: 1, expectedSourceRevision: 'config-1',
      topicId: 'topic-public', sourceReferenceId: 'source-public', actionId: 'reminder.complete', input: { expectedConfigRevision: 'config-2' }
    }), (error) => error?.code === 'conflict');
    assert.equal(dispatches, 0);
    attention.close();
  });
});
