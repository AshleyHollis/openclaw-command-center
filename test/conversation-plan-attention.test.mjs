import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAttentionService } from '../src/attention/service.mjs';
import { PLAN_REQUEST_CAPABILITY, PLAN_REQUEST_REASON } from '../src/attention/source-policy.mjs';
import { createPlanRequestEpisodeOwner } from '../src/conversation-plans/request-episodes.mjs';
import { verifyPlanHumanRequest, readPlanHumanRequests } from '../src/conversation-plans/human-requests.mjs';
import { PLAN_FAMILY, planDigest } from '../src/conversation-plans/contract.mjs';

function fixture(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fictional-plan-attention-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, attention: true } });
  const services = []; t.after(() => { services.forEach(service => service.close()); metadata.close(); rmSync(stateDir, { recursive: true, force: true }); });
  const input = { family: PLAN_FAMILY, logicalOperationId: '00000000-0000-4000-8000-000000000001', source: { topicId: 'garden', referenceId: 'conversation', sessionId: 'session', sessionKey: 'agent:main:garden', membershipRevision: 1, messageId: 'message', messageDigest: planDigest('A fictional garden plan') }, destination: { tenantId: 'fictional', boardId: 'default' }, snapshot: { outcome: 'Review the garden plan', steps: ['Draft a plan', 'Compare costs'], completionCriteria: ['Review the complete plan'] } };
  metadata.createTopic({ topicId: 'garden', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'conversation', topicId: 'garden', sourceSystem: 'fictional', sourceKind: 'conversation', externalSourceId: 'session' });
  metadata.reserveConversationPlan(input, 'operator', () => {}); metadata.bindConversationPlan(input.source, 'card', () => {});
  let clock = 100000, revoked = false, state = 'pending', hook = () => {};
  const card = { id: 'card', status: 'review', sessionKey: 'agent:main:garden', runId: 'run', metadata: { automation: { tenant: 'fictional', boardId: 'default' }, attempts: [] } };
  const request = { id: 'human-1', kind: 'question', createdAtMs: 1000, expiresAtMs: 10000000, requestRevision: 'native-revision-1' };
  const guard = () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'unauthenticated' }); };
  const attention = () => { const service = createAttentionService({ metadata, operatorId: 'operator', host: 'fictional', now: () => new Date(clock).toISOString() }); services.push(service); return service; };
  const owner = service => createPlanRequestEpisodeOwner({ metadata, attention: service, now: () => clock, verifyRequest: async ({ request, assertCurrent }) => { await hook(); assertCurrent(); return state === 'unknown' ? { availability: 'unavailable' } : { availability: 'available', request: { ...request, requestRevision: 'native-revision-1' }, state, observedAtMs: clock }; } });
  const project = (adapter, requests = [request]) => adapter.project({ input, card, principalId: 'operator', observation: { availability: 'available', requests }, assertCurrent: guard });
  return { metadata, input, card, request, guard, attention, owner, project, setState: value => { state = value; }, advance: () => { clock += 3600000; }, revoke: () => { revoked = true; }, hook: value => { hook = value; } };
}

test('one explicit request is durable, idempotent and private across restart; no generic action or notification projection', async t => {
  const f = fixture(t), a = f.attention(), owner = f.owner(a);
  const first = await f.project(owner), replay = await f.project(owner);
  assert.equal(first.requests.length, 1); assert.equal(replay.requests[0].episodeId, first.requests[0].episodeId); assert.equal(replay.requests[0].episodeRevision, 1);
  const id = first.requests[0].episodeId;
  const other = f.owner(a);
  const concurrent = await Promise.all([f.project(owner), f.project(other)]);
  assert.ok(concurrent.every(row => row.requests[0].episodeId === id && row.requests[0].episodeRevision === 1));
  const restarted = f.attention();
  assert.deepEqual(restarted.list().episodes, []); assert.equal(restarted.get(id), null); assert.deepEqual(restarted.allEpisodes(), []);
  await assert.rejects(restarted.act({ episodeId: id }), error => error.code === 'capability-unavailable');
  assert.equal((await f.project(f.owner(restarted))).requests[0].episodeId, id);
});

test('terminal-before-pending and late higher-severity responses cannot revive after restart or delivery window', async t => {
  const f = fixture(t), a = f.attention(); f.setState('withdrawn');
  assert.equal((await f.project(f.owner(a))).eligible, false);
  f.advance(); f.setState('pending'); const restarted = f.attention(), owner = f.owner(restarted);
  assert.equal((await f.project(owner)).eligible, false);
  const records = restarted.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard); assert.equal(records.length, 1); assert.equal(records[0].state, 'Withdrawn');
  restarted.registerSourceCapability({ sourceCapabilityId: PLAN_REQUEST_CAPABILITY, sourceKind: 'operational', monitoring: false, actions: [], verifyTransition: () => false, deriveEvidence: () => ({ facts: ['active-data-loss'] }) });
  const staleCritical = await restarted.ingest({ schemaVersion: 1, sourceCapabilityId: PLAN_REQUEST_CAPABILITY, stableSubjectId: records[0].stableSubjectId, attentionReason: PLAN_REQUEST_REASON, occurrenceId: 'late-critical', occurredAt: new Date(5000000).toISOString(), topicId: 'garden', sourceReferenceId: 'conversation', evidenceFacts: {} }, { assertCurrent: f.guard });
  assert.equal(staleCritical.ignored, true); assert.equal(staleCritical.episode.state, 'Withdrawn');
  await assert.rejects(restarted.ingest({ schemaVersion: 1, sourceCapabilityId: PLAN_REQUEST_CAPABILITY, stableSubjectId: records[0].stableSubjectId, attentionReason: 'different-reason', occurrenceId: 'late', occurredAt: new Date().toISOString(), evidenceFacts: {} }, { assertCurrent: f.guard }), error => error.code === 'invalid-request');
});

test('absence is unknown, explicit resolved proof clears, and concurrent owners preserve terminal identity', async t => {
  const f = fixture(t), a = f.attention(), b = f.attention(), owner = f.owner(a);
  await f.project(owner); f.setState('unknown'); const unknown = await f.project(owner, []);
  assert.equal(unknown.eligible, false); assert.equal(unknown.availability, 'partial'); assert.equal(a.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard)[0].state, 'Active');
  f.setState('resolved'); await Promise.all([f.project(owner), f.project(f.owner(b))]);
  assert.equal(a.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard)[0].state, 'Resolved');
  assert.deepEqual(a.listActivity({ episodeId: a.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard)[0].episodeId }).records, []);
  f.setState('pending'); assert.equal((await f.project(owner)).eligible, false);
});

test('permission loss across native verification leaves no published episode', async t => {
  const f = fixture(t), a = f.attention(); f.hook(() => f.revoke());
  await assert.rejects(f.project(f.owner(a)), error => error.code === 'unauthenticated');
  assert.deepEqual(a.ownerEpisodes(PLAN_REQUEST_CAPABILITY, () => {}), []);
});

test('commit guard revocation rolls back episode and occurrence atomically', async t => {
  const f = fixture(t), a = f.attention(); let calls = 0;
  a.registerSourceCapability({ sourceCapabilityId: PLAN_REQUEST_CAPABILITY, sourceKind: 'operational', monitoring: false, actions: [], verifyTransition: () => false, deriveEvidence: () => ({}) });
  await assert.rejects(a.ingest({ schemaVersion: 1, sourceCapabilityId: PLAN_REQUEST_CAPABILITY, stableSubjectId: 'subject', attentionReason: PLAN_REQUEST_REASON, occurrenceId: 'request', occurredAt: new Date(1000).toISOString(), topicId: 'garden', sourceReferenceId: 'conversation', evidenceFacts: {} }, { assertCurrent: () => { if (++calls === 5) throw new Error('revoked at commit'); } }), /revoked at commit/);
  assert.deepEqual(a.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard), []);
});

test('explicit requested result review uses injected owner proof; generic review and blocked status remain quiet', async t => {
  const f = fixture(t), a = f.attention(), owner = f.owner(a);
  assert.equal((await f.project(owner, [])).eligible, false);
  f.card.status = 'blocked'; assert.equal((await f.project(owner, [])).eligible, false);
  f.request.kind = 'requested-result-review'; f.card.status = 'review';
  assert.equal((await f.project(owner)).requests[0].kind, 'requested-result-review');
  f.setState('resolved'); assert.equal((await f.project(owner)).eligible, false);
});

test('pinned native question/approval contracts: absent pending list is unknown, Done/expiry/exact stopped run withdraws relevance', async () => {
  const card = { id: 'card', status: 'review', sessionKey: 'session', runId: 'run', metadata: { attempts: [] } };
  const question = { id: 'q', sessionKey: 'session', runId: 'run', status: 'pending', createdAtMs: 1, expiresAtMs: 10000, questions: [{ id: 'choice', prompt: 'Fictional choice' }] };
  const verify = (request, options = {}) => verifyPlanHumanRequest({ card, request, known: false, nativeRequest: async method => method === 'question.get' ? { question } : [], assertCurrent() {}, now: () => 100, ...options });
  const proof = await verify({ id: 'q', kind: 'question' }); assert.equal(proof.state, 'pending');
  question.status = 'answered'; assert.equal((await verify(proof.request)).state, 'resolved');
  const approval = { id: 'a', kind: 'execution-approval', createdAtMs: 1, expiresAtMs: 10000, requestRevision: 'rev' };
  assert.equal((await verify(approval, { known: true })).availability, 'unavailable');
  card.status = 'done'; assert.equal((await verify(approval, { known: true })).state, 'withdrawn');
  card.status = 'review'; card.metadata.attempts = [{ sessionKey: 'session', runId: 'run', status: 'stopped' }];
  assert.equal((await verify(approval, { known: true, requestLink: { sessionKey: 'session', runId: 'run' } })).state, 'withdrawn');
  assert.equal((await verify({ ...approval, kind: 'requested-result-review' }, { known: true })).availability, 'unavailable');
  assert.equal((await readPlanHumanRequests({ card, nativeRequest: async method => method === 'question.list' ? { questions: [] } : [], assertCurrent() {} })).eligible, false);
});

test('routine card/run completion and review prose cannot manufacture requested result review', async () => {
  const calls = [];
  const nativeRequest = async method => {
    calls.push(method);
    if (method === 'question.list') return { questions: [] };
    if (method === 'exec.approval.list') return [];
    assert.fail(`Unexpected native dispatch: ${method}`);
  };
  for (const status of ['triage', 'backlog', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done']) {
    for (const runStatus of ['running', 'succeeded', 'failed', 'blocked', 'stopped']) {
      const card = { id: 'fictional-card', status, sessionKey: 'fictional-session', runId: 'fictional-run', notes: 'Please review this completed result', events: [{ id: 'fictional-move', kind: 'moved', at: 1, toStatus: 'review' }, { id: 'fictional-notification', kind: 'notification', at: 2 }], metadata: { attempts: [{ sessionKey: 'fictional-session', runId: 'fictional-run', status: runStatus }] } };
      const result = await readPlanHumanRequests({ card, nativeRequest, assertCurrent() {}, now: () => 100 });
      assert.equal(result.eligible, false); assert.deepEqual(result.requests, []);
    }
  }
  assert.ok(calls.every(method => ['question.list', 'exec.approval.list'].includes(method)));
});

test('an explicit review-worded native question keeps its question identity and exact run scope', async () => {
  const card = { id: 'fictional-card', status: 'review', sessionKey: 'fictional-session', runId: 'fictional-run', metadata: { attempts: [] } };
  const question = { id: 'fictional-review-question', status: 'pending', sessionKey: card.sessionKey, runId: card.runId, createdAtMs: 1, expiresAtMs: 10000, questions: [{ id: 'review-choice', prompt: 'Please review this result' }] };
  const nativeRequest = async method => method === 'question.list' ? { questions: [question, { ...question, id: 'unrelated-question', runId: 'another-run' }] } : method === 'question.get' ? { question } : [];
  const observation = await readPlanHumanRequests({ card, nativeRequest, assertCurrent() {}, now: () => 100 });
  assert.equal(observation.requests.length, 1); assert.equal(observation.requests[0].kind, 'question');
  const proof = await verifyPlanHumanRequest({ card, request: observation.requests[0], known: false, nativeRequest, assertCurrent() {}, now: () => 100 });
  assert.equal(proof.state, 'pending'); assert.equal(proof.request.kind, 'question');
  card.runId = 'another-run';
  assert.equal((await verifyPlanHumanRequest({ card, request: proof.request, known: true, nativeRequest, assertCurrent() {}, now: () => 100 })).availability, 'unavailable');
});

test('older native build refusing result-review get admits no Attention receipt', async t => {
  const f = fixture(t), a = f.attention();
  const calls = [];
  const owner = createPlanRequestEpisodeOwner({ metadata: f.metadata, attention: a, now: () => 100000,
    verifyRequest: args => verifyPlanHumanRequest({ ...args, nativeRequest: async method => { calls.push(method); throw new Error('Unknown native method on older build'); }, now: () => 100000 }) });
  f.request.kind = 'requested-result-review';
  const result = await f.project(owner);
  assert.equal(result.eligible, false); assert.equal(result.availability, 'partial');
  assert.equal(result.resultReviewAvailability, 'unqualified');
  assert.deepEqual(calls, ['workboard.resultReviews.get']); assert.deepEqual(a.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard), []);
});

test('an unrelated terminal run cannot withdraw an original human request across episode-owner restart', async t => {
  const f = fixture(t), a = f.attention();
  const question = { id: f.request.id, status: 'pending', sessionKey: f.card.sessionKey, runId: f.card.runId, createdAtMs: 1000, expiresAtMs: 10000000, questions: [{ id: 'choice', prompt: 'Review the fictional plan?' }] };
  const owner = service => createPlanRequestEpisodeOwner({ metadata: f.metadata, attention: service, now: () => 100000,
    verifyRequest: args => verifyPlanHumanRequest({ ...args, nativeRequest: async method => { assert.equal(method, 'question.get'); return { question }; }, now: () => 100000 }) });
  const admitted = await f.project(owner(a));
  assert.equal(admitted.eligible, true); const episodeId = admitted.requests[0].episodeId;
  f.card.runId = 'unrelated-run';
  const restarted = f.attention();
  for (const status of ['succeeded', 'failed', 'stopped']) {
    f.card.metadata.attempts = [{ sessionKey: f.card.sessionKey, runId: f.card.runId, status }];
    const observed = await f.project(owner(restarted), []);
    assert.equal(observed.eligible, false); assert.equal(observed.availability, 'partial');
    const receipt = restarted.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard)[0];
    assert.equal(receipt.episodeId, episodeId); assert.equal(receipt.state, 'Active');
  }
  f.card.runId = question.runId;
  f.card.metadata.attempts = [{ sessionKey: question.sessionKey, runId: question.runId, status: 'stopped' }];
  assert.equal((await f.project(owner(restarted), [])).eligible, false);
  assert.equal(restarted.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard)[0].state, 'Withdrawn');
  f.card.metadata.attempts = [];
  assert.equal((await f.project(owner(f.attention()))).eligible, false);
});

function fictionalNativeReview(card, overrides = {}) {
  const result = { summary: 'The fictional planting plan and budget are ready.', proof: [], artifacts: [] };
  const identity = { id: 'result-review:fictional', tenant: card.metadata.automation.tenant, boardId: card.metadata.automation.boardId, cardId: card.id, sessionKey: card.sessionKey, runId: card.runId, completionIntent: planDigest('fictional immutable completion') };
  const resultDigest = planDigest(result);
  return { schemaVersion: 1, ...identity, requestRevision: planDigest({ ...identity, resultDigest }), resultDigest, revision: 1, status: 'pending', createdAt: 1000, expiresAt: null, resolvedAt: null, result, ...overrides };
}

test('scoped native result review with no deadline publishes once, survives restart and clears only native terminal receipt', async t => {
  const f = fixture(t), a = f.attention(); let native = fictionalNativeReview(f.card), calls = [];
  const nativeRequest = async (method, params) => {
    calls.push(method);
    if (method.startsWith('workboard.resultReviews.')) {
      assert.deepEqual({ tenant: params.tenant, boardId: params.boardId, cardId: params.cardId }, { tenant: 'fictional', boardId: 'default', cardId: 'card' });
      return method.endsWith('.list') ? { requests: [native] } : { request: native };
    }
    return method === 'question.list' ? { questions: [] } : [];
  };
  const owner = service => createPlanRequestEpisodeOwner({ metadata: f.metadata, attention: service, now: () => 100000,
    verifyRequest: args => verifyPlanHumanRequest({ ...args, nativeRequest, now: () => 100000 }) });
  const observation = await readPlanHumanRequests({ card: f.card, nativeRequest, assertCurrent: f.guard });
  assert.equal(observation.resultReviewAvailability, 'available'); assert.equal(observation.requests[0].expiresAtMs, null);
  const project = async service => owner(service).project({ input: f.input, card: f.card, principalId: 'operator', observation, assertCurrent: f.guard });
  const first = await project(a); assert.equal(first.requests.length, 1); assert.equal(first.requests[0].expiresAtMs, null);
  f.advance(); const restarted = f.attention(); assert.equal((await project(restarted)).requests[0].episodeId, first.requests[0].episodeId);
  native = { ...native, revision: 2, status: 'reviewed', resolvedAt: 200000 };
  f.card.status = 'done'; f.card.runId = 'another-run';
  assert.equal((await project(restarted)).eligible, false);
  assert.equal(restarted.ownerEpisodes(PLAN_REQUEST_CAPABILITY, f.guard)[0].state, 'Resolved');
  native = { ...native, revision: 1, status: 'pending', resolvedAt: null }; f.card.status = 'review'; f.card.runId = native.runId;
  assert.equal((await project(f.attention())).eligible, false);
  assert.ok(calls.every(method => ['workboard.resultReviews.list', 'workboard.resultReviews.get', 'question.list', 'exec.approval.list'].includes(method)));
});

test('result-review scope, producing run, snapshot digest and authority must remain exact; ordinary completion creates no review', async () => {
  const card = { id: 'card', status: 'review', sessionKey: 'session', runId: 'run', metadata: { automation: { tenant: 'fictional', boardId: 'default' }, attempts: [] } };
  const original = fictionalNativeReview(card);
  const verify = native => verifyPlanHumanRequest({ card, request: { id: original.id, kind: 'requested-result-review' }, nativeRequest: async () => ({ request: native }), assertCurrent() {}, now: () => 10000 });
  assert.equal((await verify(original)).state, 'pending');
  for (const native of [{ ...original, tenant: 'wrong' }, { ...original, boardId: 'wrong' }, { ...original, cardId: 'wrong' }, { ...original, runId: 'unrelated' }, { ...original, result: { ...original.result, summary: 'changed' } }, { ...original, expiresAt: 999999 }, { ...original, resolvedAt: 5000 }, { ...original, revision: 0 }, null]) assert.equal((await verify(native)).availability, 'unavailable');
  card.status = 'done'; assert.equal((await verify(original)).availability, 'unavailable');
  card.status = 'review'; let revoked = false;
  await assert.rejects(verifyPlanHumanRequest({ card, request: { id: original.id, kind: 'requested-result-review' }, nativeRequest: async () => { revoked = true; return { request: original }; }, assertCurrent() { if (revoked) throw new Error('revoked'); } }), /revoked/);
  const read = await readPlanHumanRequests({ card, nativeRequest: async method => method === 'question.list' ? { questions: [] } : method === 'exec.approval.list' ? [] : { requests: [] }, assertCurrent() {} });
  assert.equal(read.eligible, false); assert.equal(read.resultReviewAvailability, 'available');
});

test('unavailable result-review owner preserves an independently verified native question', async () => {
  const card = { id: 'card', status: 'running', sessionKey: 'session', runId: 'run', metadata: { automation: { tenant: 'fictional', boardId: 'default' } } };
  const question = { id: 'q', status: 'pending', sessionKey: 'session', runId: 'run', createdAtMs: 1, expiresAtMs: 10000 };
  const nativeRequest = async method => { if (method.startsWith('workboard.resultReviews.')) throw new Error('Unknown method'); return method === 'question.list' ? { questions: [question] } : []; };
  const observation = await readPlanHumanRequests({ card, nativeRequest, assertCurrent() {}, now: () => 100 });
  assert.equal(observation.eligible, true); assert.equal(observation.resultReviewAvailability, 'unavailable'); assert.equal(observation.requests[0].kind, 'question');
});
