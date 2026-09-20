import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapacityReviewService, capacityReviewCronDeclaration, CAPACITY_REVIEW_SCHEDULE_KEY } from '../src/open-loops/capacity-review.mjs';
import { normalizeLoop } from '../src/open-loops/contracts.mjs';

const config = Object.freeze({ enabled: true, topicId: 'topic-capacity-review', weekday: 7, localTime: '17:30', timeZone: 'Australia/Brisbane' });

function loop(state = 'confirmed', revision = 1) {
  return normalizeLoop({ schemaVersion: 1, loopId: 'open-loop:capacity-review', kind: 'general', stableSubjectId: 'capacity-review', title: 'Review older tasks when you have capacity', topicId: config.topicId, state, reviewAt: '2026-09-20T07:30:00.000Z', attention: { actions: ['Complete'], activated: false, currentEvidence: true, importance: 'low', importanceOrigin: 'processing', contexts: [], dependencies: [], someday: false }, evidenceObservationIds: ['observation:capacity-review'], revision });
}

test('weekly native declaration is quiet and permits only the capacity-review tool', () => {
  assert.deepEqual(capacityReviewCronDeclaration(config), {
    declarationKey: CAPACITY_REVIEW_SCHEDULE_KEY,
    name: 'Command Center weekly capacity review',
    description: 'Surface one quiet grouped review of older optional work.',
    enabled: true,
    schedule: { kind: 'cron', expr: '30 17 * * 7', tz: 'Australia/Brisbane', staggerMs: 0 },
    sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Call command_center_open_capacity_review exactly once. Do not send a message.', toolsAllow: ['command_center_open_capacity_review'] },
    delivery: { mode: 'none' }
  });
});

test('schedule reconciliation creates one owned declaration and reuses it after restart', async () => {
  const jobs = []; const methods = [];
  const gateway = { async request(method, params) {
    methods.push(method);
    if (method === 'cron.list') return { jobs: structuredClone(jobs) };
    if (method === 'cron.add') { const job = { ...structuredClone(params), id: 'capacity-review-job', configRevision: 'r1' }; jobs.push(job); return { created: true, job: structuredClone(job) }; }
    throw new Error(`Unexpected ${method}`);
  } };
  const service = createCapacityReviewService({ metadata: {}, gateway, config, captureService: {} });
  assert.equal((await service.reconcileSchedule()).job.id, 'capacity-review-job');
  assert.equal((await service.reconcileSchedule()).job.id, 'capacity-review-job');
  assert.deepEqual(methods, ['cron.list', 'cron.add', 'cron.list', 'cron.list']);
});

test('schedule reconciliation uses the plugin service Cron owner without privileged Gateway RPC', async () => {
  const jobs = []; const methods = [];
  const scheduler = {
    async list(options) { methods.push(['list', options]); return structuredClone(jobs); },
    async add(input) { methods.push(['add', input.declarationKey]); const job = { ...structuredClone(input), id: 'service-owned-capacity-review', configRevision: 'r1' }; jobs.push(job); return job; },
    async update() { throw new Error('An unchanged owned schedule must not be updated.'); }
  };
  const service = createCapacityReviewService({ metadata: {}, scheduler, config, captureService: {} });
  assert.equal((await service.reconcileSchedule()).job.id, 'service-owned-capacity-review');
  assert.equal((await service.reconcileSchedule()).job.id, 'service-owned-capacity-review');
  assert.deepEqual(methods.map(([method]) => method), ['list', 'add', 'list', 'list']);
});

test('plugin service Cron reconciliation does not invent an unpublished config revision', async () => {
  const job = { ...structuredClone(capacityReviewCronDeclaration(config)), id: 'service-owned-capacity-review' };
  const scheduler = { list: async () => [job], add: async () => assert.fail('Existing schedule was recreated.'), update: async () => assert.fail('Unchanged schedule was updated.') };
  assert.equal((await createCapacityReviewService({ metadata: {}, scheduler, config, captureService: {} }).reconcileSchedule()).job.id, job.id);
});

test('repeat wakes in one local week retain one operation and one outstanding review', async () => {
  const captures = new Map(); const calls = [];
  const captureService = { async capture(input) {
    calls.push(input);
    if (captures.has(input.logicalOperationId)) return { disposition: 'duplicate', loop: captures.get(input.logicalOperationId) };
    const created = loop(); captures.set(input.logicalOperationId, created); return { disposition: 'applied', loop: created };
  } };
  const metadata = { getTopic: id => id === config.topicId ? { topicId: id, lifecycle: 'active' } : null };
  const service = createCapacityReviewService({ metadata, gateway: { request: async () => ({ jobs: [] }) }, config, captureService, now: () => '2026-09-20T08:00:00.000Z' });
  const first = await service.wake(); const replay = await service.wake();
  assert.equal(first.loopId, replay.loopId);
  assert.equal(first.cycle, '2026-09-14');
  assert.equal(replay.outcome, 'already-open');
  assert.equal(captures.size, 1);
  assert.equal(calls[0].logicalOperationId, calls[1].logicalOperationId);
});

test('a later cycle reopens the same completed review instead of creating another item', async () => {
  const prior = loop('resolved', 4); let reconciled;
  const metadata = {
    getTopic: () => ({ topicId: config.topicId, lifecycle: 'active' }),
    reconcileOpenLoop(input) { reconciled = input; return { disposition: 'applied', loop: input.loop }; }
  };
  const service = createCapacityReviewService({ metadata, gateway: { request: async () => ({ jobs: [] }) }, config, captureService: { capture: async () => ({ disposition: 'applied', loop: prior }) }, now: () => '2026-09-27T08:00:00.000Z' });
  const result = await service.wake();
  assert.equal(result.loopId, prior.loopId);
  assert.equal(result.state, 'confirmed');
  assert.equal(reconciled.expectedRevision, 4);
  assert.equal(reconciled.loop.attention.lastConsideredAt, '2026-09-27T08:00:00.000Z');
});

test('an omitted or disabled live configuration never opens a review', async () => {
  let captures = 0;
  const service = createCapacityReviewService({ metadata: {}, gateway: { request: async () => ({ jobs: [] }) }, config: { ...config, enabled: false }, captureService: { capture: async () => { captures++; } } });
  assert.deepEqual(await service.wake(), { schemaVersion: 1, outcome: 'disabled' });
  assert.equal(captures, 0);
});
