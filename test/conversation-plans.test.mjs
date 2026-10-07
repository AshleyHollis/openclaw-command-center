import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createConversationPlanOwner } from '../src/conversation-plans/owner.mjs';
import { PLAN_FAMILY, planDigest } from '../src/conversation-plans/contract.mjs';
import { validatePlan } from '../src/conversation-plans/contract.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const fictionalPlan = () => ({ family: PLAN_FAMILY, logicalOperationId: uuid(1), source: { topicId: 'fictional-garden', referenceId: 'fictional-conversation', sessionId: 'fictional-session', sessionKey: 'agent:main:fictional-plan', membershipRevision: 1, messageId: 'fictional-message-7', messageDigest: planDigest('Draft the planting plan, then review the budget.') }, destination: { tenantId: 'fictional-tenant', boardId: 'fictional-board' }, snapshot: { outcome: 'Prepare a reviewed planting plan', steps: ['Draft a planting plan', 'Compare the fictional budget', 'Present the plan for review'], completionCriteria: ['A planting plan and cost comparison are ready for review'] } });
test('native card capacity and canonical dotted board names are validated without truncation', () => {
  const input = fictionalPlan(); input.destination.boardId = 'fictional.planning'; assert.equal(validatePlan(input).destination.boardId, 'fictional.planning');
  input.snapshot.outcome = 'x'.repeat(181); assert.throws(() => validatePlan(input), error => error.code === 'invalid-request');
  input.snapshot.outcome = 'Fictional'; input.snapshot.steps = ['x'.repeat(2000), 'y'.repeat(2000)]; assert.throws(() => validatePlan(input), error => error.code === 'invalid-request');
});
function fixture(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fictional-plan-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  t.after(() => { metadata.close(); rmSync(stateDir, { recursive: true, force: true }); });
  const input = fictionalPlan(); let card, revoked = false, sourceChanged = false, wrongScope = false, lost = false, before = false, unavailable = false, writes = 0, reads = 0, hook = () => {};
  const owner = () => createConversationPlanOwner({ metadata,
    authorize: () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'unauthenticated' }); return { principalId: 'fictional-operator' }; },
    assertSourceCurrent: () => { if (sourceChanged) throw Object.assign(new Error('source changed'), { code: 'unavailable' }); },
    readSource: async source => ({ available: !sourceChanged, source }),
    nativeRequest: async (method, params, options) => {
      if (method === 'workboard.cards.create') {
        hook(); options.assertCurrent(); writes++;
        if (before) throw Object.assign(new Error('lost before acceptance'), { code: 'timeout' });
        card ??= { id: 'fictional-native-card', title: params.title, notes: params.notes, execution: params.execution, status: 'todo', updatedAt: 100, metadata: { automation: { tenant: params.tenant, boardId: params.boardId, idempotencyKey: params.idempotencyKey } } };
        if (lost) throw Object.assign(new Error('lost response'), { code: 'timeout' });
        return { card };
      }
      assert.equal(method, 'workboard.cards.list'); reads++; hook();
      if (unavailable) throw Object.assign(new Error('disconnected'), { code: 'unavailable' });
      return { cards: card ? [{ ...card, metadata: { ...card.metadata, automation: { ...card.metadata.automation, ...(wrongScope ? { tenant: 'wrong-tenant' } : {}) } } }] : [] };
    } });
  return { input, stateDir, owner, get metadata() { return metadata; }, get card() { return card; }, get writes() { return writes; }, get reads() { return reads; }, revoke: () => { revoked = true; }, sourceChanged: () => { sourceChanged = true; }, wrongScope: () => { wrongScope = true; }, lose: () => { lost = true; }, before: value => { before = value; }, unavailable: value => { unavailable = value; }, hook: value => { hook = value; }, reopen: () => { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } }); } };
}
test('concurrent/double-click admission and restart preserve exactly one card and snapshot', async t => {
  const f = fixture(t); const rows = await Promise.all([f.owner().track(f.input), f.owner().track(f.input)]);
  assert.equal(rows[0].card.id, rows[1].card.id); assert.equal(f.metadata.listConversationPlans().length, 1);
  f.reopen(); await f.owner().track(f.input); assert.equal(f.writes, 2);
  assert.equal(f.card.status, 'todo'); assert.equal(f.card.execution, undefined);
});
test('response loss resolves by exact readback; reconcile never creates or starts', async t => {
  const f = fixture(t); f.lose(); const row = await f.owner().track(f.input); assert.equal(row.card.id, 'fictional-native-card');
  f.reopen(); await f.owner().reconcile(f.input); assert.equal(f.writes, 1);
});
test('another click reserves its operation ID; it cannot be reused for another source', async t => {
  const f = fixture(t); await f.owner().track(f.input);
  const second = { ...f.input, logicalOperationId: uuid(2) }; await f.owner().track(second);
  assert.equal((await f.owner().reconcile(second)).card.id, 'fictional-native-card');
  const changed = structuredClone(second); changed.source.messageId = 'different-message';
  await assert.rejects(f.owner().track(changed), error => error.code === 'intent-mismatch'); assert.equal(f.writes, 1);
});
test('unknown before acceptance survives restart and unchanged explicit retry', async t => {
  const f = fixture(t); f.before(true); assert.equal((await f.owner().track(f.input)).outcome, 'unknown');
  f.reopen(); assert.equal((await f.owner().reconcile(f.input)).outcome, 'unknown'); assert.equal(f.writes, 1);
  f.before(false); assert.equal((await f.owner().track(f.input)).outcome, 'tracked-observed'); assert.equal(f.metadata.listConversationPlans().length, 1);
});
test('snapshot, destination, message revision and reused operation identity are immutable', async t => {
  const f = fixture(t); await f.owner().track(f.input);
  for (const mutate of [x => { x.snapshot.steps[0] = 'Changed'; }, x => { x.destination.boardId = 'other'; }, x => { x.source.membershipRevision++; }, x => { x.source.messageDigest = planDigest('changed'); }, x => { x.source.messageId = 'another'; }]) {
    const changed = structuredClone(f.input); mutate(changed);
    await assert.rejects(f.owner().track(changed), error => error.code === 'intent-mismatch');
  }
  assert.equal(f.writes, 1);
});
test('queued authority loss and source reset/reassignment fail before native effect', async t => {
  for (const change of ['revoke', 'sourceChanged']) {
    const f = fixture(t); f.hook(() => f[change]());
    await assert.rejects(f.owner().track(f.input), error => ['unauthenticated', 'unavailable'].includes(error.code));
    assert.equal(f.writes, 0); assert.equal(f.metadata.listConversationPlans()[0].cardId, null);
  }
});
test('wrong tenant and unavailable read never publish copied native truth', async t => {
  const f = fixture(t); await f.owner().track(f.input); f.wrongScope();
  await assert.rejects(f.owner().reconcile(f.input), error => error.code === 'conflict');
  const g = fixture(t); await g.owner().track(g.input); g.unavailable(true);
  await assert.rejects(g.owner().reconcile(g.input), error => error.code === 'unavailable');
});
test('Done, generic blocked/review, stopped and failed are quiet and honest', async t => {
  const f = fixture(t); await f.owner().track(f.input);
  f.card.metadata.attempts = [{ id: 'old-unlinked-attempt', startedAt: 1, status: 'succeeded' }];
  for (const status of ['done', 'blocked', 'review', 'running']) {
    f.card.status = status; const row = await f.owner().reconcile(f.input);
    assert.equal(row.card.status, status); assert.equal(row.attention.eligible, false); assert.equal(row.progress.availability, 'unavailable');
  }
  f.card.sessionKey = 'fictional-run-session'; f.card.runId = 'fictional-run';
  for (const status of ['stopped', 'failed']) {
    f.card.metadata.attempts = [{ sessionKey: 'unrelated-turn', runId: 'other', status: 'succeeded' }, { sessionKey: f.card.sessionKey, runId: f.card.runId, status }];
    assert.equal((await f.owner().reconcile(f.input)).progress.status, status);
  }
});
test('process death after journal reservation preserves acceptance; generic owner cannot overwrite it', async t => {
  const f = fixture(t); const module = pathToFileURL(path.resolve('src/metadata/service.mjs')).href;
  const script = `const {openCommandCenterMetadataService}=await import(${JSON.stringify(module)}); const metadata=openCommandCenterMetadataService({stateDir:${JSON.stringify(f.stateDir)},capabilities:{notes:true}}); metadata.reserveConversationPlan(${JSON.stringify(f.input)},'fictional-operator',()=>{}); process.exit(23);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 }); assert.equal(child.status, 23, child.stderr);
  f.reopen(); assert.equal(f.metadata.getConversationPlan(f.input.source).cardId, null);
  assert.throws(() => f.metadata.recordOperation({ logicalOperationId: f.input.logicalOperationId, transportRequestId: f.input.logicalOperationId, operationKind: 'other', intentDigest: 'changed', state: 'applied' }), error => error.code === 'conversation-plan-owner-required');
  assert.equal((await f.owner().track(f.input)).card.id, 'fictional-native-card');
});
