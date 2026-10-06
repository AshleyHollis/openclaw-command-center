import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planCommitmentCapture } from '../src/open-loops/commitment-capture.mjs';
import { recordIntakeSourcePlan, recordIntakeOutcome } from '../src/open-loops/intake-accounting.mjs';
import { createBillActionAdapter } from '../src/open-loops/bill-actions.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'bill-owner-fictional-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  t.after(() => { metadata.close(); rmSync(stateDir, { recursive: true, force: true }); });
  metadata.createTopic({ topicId: 'fictional-home', name: 'Fictional home', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'fictional-note', topicId: 'fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/Bills/101.md', observedRevision: 'v1' });
  const obligation = { obligationId: 'BILL-101', title: 'Review fictional BILL-101', classification: 'obligation', obligationKind: 'payment', provenance: 'explicit', correlationNamespace: 'fictional-mailbox', correlationId: 'BILL-101' };
  const instant = '2026-10-05T22:00:00.000Z';
  const { classification, ...captureObligation } = obligation;
  const capture = planCommitmentCapture({ ...captureObligation, schemaVersion: 1, logicalOperationId: id(1), sourceKind: 'email', sourceExternalId: 'namespaced:fictional-mail-101', sourceVersion: 'v1', sourceReferenceId: 'fictional-note', sourcePath: 'Bills/101.md', sourceReferenceVersion: 'v1', topicId: 'fictional-home', occurredAt: instant, observedAt: instant });
  const loop = metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: id(1), operationKind: 'commitment.capture.v1', intent: capture.value, expectedRevision: 0, observation: capture.observation, loop: capture.loop, evidenceRoles: { [capture.observation.observationId]: 'origin' }, updatedAt: instant }).loop;
  recordIntakeSourcePlan(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'namespaced:fictional-mail-101', sourceVersion: 'v1', checkpoint: 'fictional-page-1', observedAt: instant, processorVersion: 'fictional-v1', acceptedExtraction: { schemaVersion: 1, proposedTopic: 'Fictional home', notePath: 'Bills/101.md', knowledgeMarkdown: '# Fictional bill', obligations: [obligation] }, outcomes: [{ outcomeId: 'BILL-101', kind: 'obligation' }] });
  recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'namespaced:fictional-mail-101', sourceVersion: 'v1', outcomeId: 'BILL-101', kind: 'obligation', status: 'applied', summary: obligation.title, loopId: loop.loopId, recordedAt: instant });
  let card, revoked = false, loseResponse = false, loseBefore = false, available = true, actor = 'fictional-operator', clock = '2026-10-05T22:00:00.000Z', beforeEffect = () => {}, beforeRead = () => {}, calls = 0;
  const adapter = () => createBillActionAdapter({ metadata, now: () => clock, authorize: ({ observation }) => { if (observation && !available) throw Object.assign(new Error('source revoked'), { code: 'unavailable' }); if (revoked) throw Object.assign(new Error('revoked'), { code: 'unauthenticated' }); return { principalId: actor }; }, readEvidence: async ({ loop }) => ({ available, topicId: loop.topicId, source: { kind: 'note', topicId: loop.topicId, referenceId: 'fictional-note', path: 'Bills/101.md', revision: 'v1' } }), nativeRequest: async (method, params, options) => {
    calls++;
    if (method === 'workboard.cards.create') { card ??= { id: 'fictional-card', title: params.title, status: 'todo', updatedAt: 100, metadata: { automation: { tenant: params.tenant, boardId: params.boardId, idempotencyKey: params.idempotencyKey } } }; return { card }; }
    if (method === 'workboard.cards.list') { beforeRead(); return { cards: card ? [card] : [] }; }
    if (method === 'workboard.cards.update') { beforeEffect(); options?.assertCurrent(); if (loseBefore) throw Object.assign(new Error('before acceptance'), { code: 'timeout' }); assert.equal(params.expectedUpdatedAt, 100); assert.deepEqual(params.patch, { status: 'done' }); card = { ...card, status: 'done', updatedAt: 101 }; if (loseResponse) throw Object.assign(new Error('lost'), { code: 'timeout' }); return { card }; }
    throw new Error('unexpected native method');
  } });
  const reminder = ({ version, dueAt }) => {
    const changed = { ...obligation, ...(dueAt ? { dueAt } : {}) }, current = metadata.getOpenLoop(loop.loopId);
    const { classification: ignored, ...captureValue } = changed;
    const observedAt = '2026-10-05T22:30:00.000Z';
    const planned = planCommitmentCapture({ ...captureValue, schemaVersion: 1, logicalOperationId: id(100), sourceKind: 'email', sourceExternalId: 'namespaced:fictional-mail-101', sourceVersion: version, sourceReferenceId: 'fictional-note', sourcePath: 'Bills/101.md', sourceReferenceVersion: 'v1', topicId: 'fictional-home', occurredAt: observedAt, observedAt }, current);
    metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: id(100), operationKind: 'commitment.capture.v1', intent: planned.value, expectedRevision: current.revision, observation: planned.observation, loop: planned.loop, evidenceRoles: { [planned.observation.observationId]: 'update' }, updatedAt: observedAt });
    recordIntakeSourcePlan(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'namespaced:fictional-mail-101', sourceVersion: version, checkpoint: 'fictional-page-2', observedAt, processorVersion: 'fictional-v1', acceptedExtraction: { schemaVersion: 1, proposedTopic: 'Fictional home', notePath: 'Bills/101.md', knowledgeMarkdown: '# Fictional bill update', obligations: [changed] }, outcomes: [{ outcomeId: 'BILL-101', kind: 'obligation' }] });
    recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'namespaced:fictional-mail-101', sourceVersion: version, outcomeId: 'BILL-101', kind: 'obligation', status: 'applied', summary: changed.title, loopId: loop.loopId, recordedAt: observedAt });
  };
  return { stateDir, reminder, clock: value => { clock = value; }, beforeEffect: hook => { beforeEffect = hook; }, get metadata() { return metadata; }, adapter, loopId: loop.loopId, get card() { return card; }, get calls() { return calls; }, revoke: () => { revoked = true; }, lose: () => { loseResponse = true; }, loseBefore: value => { loseBefore = value; }, removeEvidence: () => { available = false; }, actor: value => { actor = value; }, beforeRead: hook => { beforeRead = hook; }, done: () => { card = { ...card, status: 'done', updatedAt: 101 }; }, reopen: () => { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } }); } };
}
const admit = f => f.adapter().admit({ schemaVersion: 1, loopId: f.loopId, tenantId: 'fictional-tenant', boardId: 'fictional-board', logicalOperationId: id(2) });

test('durable admission and restart preserve one native binding and literal loop identity', async t => {
  const f = fixture(t); await admit(f); await admit(f); f.reopen(); const row = await admit(f);
  assert.equal(row.loopId, f.loopId); assert.equal(row.binding.cardId, 'fictional-card'); assert.equal(f.metadata.listBillActionBindings().length, 1);
  await assert.rejects(f.adapter().admit({ schemaVersion: 1, loopId: f.loopId, tenantId: 'other', boardId: 'fictional-board', logicalOperationId: id(2) }), error => error.code === 'intent-mismatch');
});

test('original Handle CAS and lost response reconcile as observed Done, never paid', async t => {
  const f = fixture(t); await admit(f); f.lose();
  const intent = { schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(3), expectedUpdatedAt: 100 };
  const unknown = await f.adapter().handle(intent); assert.equal(unknown.outcome, 'unknown');
  f.reopen(); const observed = await f.adapter().reconcile({ schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(3) });
  assert.equal(observed.outcome, 'handled-observed'); assert.equal(f.metadata.getOpenLoop(f.loopId).paymentState, 'unpaid');
  await assert.rejects(f.adapter().handle({ ...intent, expectedUpdatedAt: 101 }), error => error.code === 'intent-mismatch');
});

test('Later commits eligibility with exact zone, survives restart and Done suppresses it', async t => {
  const f = fixture(t); await admit(f);
  const intent = { schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(4), expectedEligibilityRevision: 0, reviewAt: '2026-10-05T23:00:00.000Z', timeZone: 'Australia/Brisbane', offsetMinutes: 600 };
  const applied = await f.adapter().defer(intent); assert.equal(applied.outcome, 'applied'); assert.equal(f.card.status, 'todo');
  f.reopen(); f.clock('2026-10-05T23:00:00.000Z'); const row = await f.adapter().read({ loopId: f.loopId }); assert.equal(row.eligibility.revision, 1); assert.equal(row.eligibility.eligible, true);
  assert.equal((await f.adapter().defer(intent)).eligibilityRevision, 1);
  f.done(); assert.equal((await f.adapter().read({ loopId: f.loopId })).eligibility.eligible, false);
});

test('revoked awaited read exposes no action and commits no Handle receipt', async t => {
  const f = fixture(t); await admit(f); f.beforeRead(() => f.revoke());
  await assert.rejects(f.adapter().handle({ schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(5), expectedUpdatedAt: 100 }), error => error.code === 'unauthenticated');
  assert.equal(f.card.status, 'todo'); assert.equal(f.metadata.getBillActionOperation(id(5)).state, 'pending');
});

test('concurrent Done refuses Later and generic journal cannot overwrite adapter evidence', async t => {
  const f = fixture(t); await admit(f); f.beforeRead(() => f.done());
  const result = await f.adapter().defer({ schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(6), expectedEligibilityRevision: 0, reviewAt: '2026-10-05T23:00:00.000Z', timeZone: 'Australia/Brisbane', offsetMinutes: 600 });
  assert.equal(result.outcome, 'handled-observed'); assert.equal(f.metadata.getBillActionBinding(f.loopId).eligibilityRevision, 0);
  assert.throws(() => f.metadata.recordOperation({ logicalOperationId: id(6), transportRequestId: id(6), intentDigest: 'altered', operationKind: 'other', state: 'applied' }), error => error.code === 'bill-action-owner-required');
});

test('unknown before acceptance survives restart, blocks competing choices and retains original retry', async t => {
  const f = fixture(t); await admit(f); f.loseBefore(true);
  const intent = { schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(7), expectedUpdatedAt: 100 };
  assert.equal((await f.adapter().handle(intent)).outcome, 'unknown'); f.reopen();
  const row = await f.adapter().read({ loopId: f.loopId }); assert.equal(row.outcome, 'unknown'); assert.deepEqual(row.pendingOperation.intent, intent); assert.equal(row.eligibility.eligible, false);
  await assert.rejects(f.adapter().handle({ ...intent, logicalOperationId: id(8) }), error => error.code === 'conflict');
  f.actor('another-operator'); await assert.rejects(f.adapter().reconcile({ schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(7) }), error => error.code === 'unavailable');
  f.actor('fictional-operator'); f.loseBefore(false); assert.equal((await f.adapter().handle(intent)).outcome, 'handled-observed');
});

test('stale native CAS and foreign scope refuse writes; source loss does not leak cached rows', async t => {
  const f = fixture(t); await admit(f); f.card.updatedAt = 200;
  assert.equal((await f.adapter().handle({ schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(9), expectedUpdatedAt: 100 })).outcome, 'conflict'); assert.equal(f.card.status, 'todo');
  f.card.metadata.automation.tenant = 'foreign'; await assert.rejects(f.adapter().read({ loopId: f.loopId }), error => error.code === 'conflict');
  f.card.metadata.automation.tenant = 'fictional-tenant'; f.removeEvidence(); const page = await f.adapter().list(); assert.deepEqual(page.rows, []); assert.equal(page.coverage, 'partial'); assert.equal(page.unavailableCount, 1);
});

test('abrupt child termination after durable reservation keeps unknown immutable intent', async t => {
  const f = fixture(t); await admit(f);
  const binding = f.metadata.getBillActionBinding(f.loopId);
  const intent = { schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(10), actorId: 'fictional-operator', action: 'handle', actionId: binding.actionId, cardId: binding.cardId, boardId: binding.boardId, tenantId: binding.tenantId, patch: { status: 'done' }, expectedUpdatedAt: 100 };
  const module = pathToFileURL(path.resolve('src/metadata/service.mjs')).href;
  const script = `const {openCommandCenterMetadataService}=await import(${JSON.stringify(module)}); const metadata=openCommandCenterMetadataService({stateDir:${JSON.stringify(f.stateDir)},capabilities:{notes:true}}); metadata.beginBillActionOperation(${JSON.stringify(intent)},()=>{}); process.exit(23);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 23, child.stderr); f.reopen();
  const row = await f.adapter().read({ loopId: f.loopId }); assert.equal(row.outcome, 'unknown'); assert.equal(row.pendingOperation.intent.expectedUpdatedAt, 100);
});

test('source revocation at native queued admission refuses the effect', async t => {
  const f = fixture(t); await admit(f); f.beforeEffect(() => f.removeEvidence());
  await assert.rejects(f.adapter().handle({ schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(11), expectedUpdatedAt: 100 }), error => error.code === 'unavailable');
  assert.equal(f.card.status, 'todo'); assert.equal(f.metadata.getBillActionOperation(id(11)).state, 'pending');
});

test('Later rejects past/equal, missing zone, non-UTC strings and changed retry intent', async t => {
  const f = fixture(t); await admit(f);
  const intent = { schemaVersion: 1, loopId: f.loopId, logicalOperationId: id(12), expectedEligibilityRevision: 0, reviewAt: '2026-10-05T23:00:00.000Z', timeZone: 'Australia/Brisbane', offsetMinutes: 600 };
  for (const patch of [{ reviewAt: '2026-10-05T22:00:00.000Z' }, { reviewAt: '2020-01-01T00:00:00.000Z' }, { reviewAt: '2027-02-30T00:00:00.000Z' }, { timeZone: undefined }, { reviewAt: '2026-10-06 09:00' }, { offsetMinutes: 0 }]) await assert.rejects(f.adapter().defer({ ...intent, ...patch }), error => error.code === 'invalid-request');
  await f.adapter().defer(intent); await assert.rejects(f.adapter().defer({ ...intent, reviewAt: '2026-10-06T00:00:00.000Z' }), error => error.code === 'intent-mismatch');
});

test('simultaneous admission settles one native card and one durable binding', async t => {
  const f = fixture(t); const rows = await Promise.all([admit(f), admit(f)]);
  assert.equal(rows[0].binding.cardId, rows[1].binding.cardId); assert.equal(f.metadata.listBillActionBindings().length, 1);
  const binding = f.metadata.getBillActionBinding(f.loopId);
  assert.throws(() => f.metadata.reserveBillActionBinding({ schemaVersion: binding.schemaVersion, actionId: binding.actionId, semanticKey: binding.semanticKey, meaningDigest: binding.meaningDigest, tenantId: binding.tenantId, boardId: binding.boardId, logicalOperationId: binding.logicalOperationId, actorId: binding.actorId, createIntent: { ...binding.createIntent, title: 'Different intent' }, source: binding.source }, () => {}), error => error.code === 'intent-mismatch');
});

test('routine new source version preserves Done and binding; changed accepted deadline conflicts', async t => {
  const f = fixture(t); await admit(f); f.done(); f.reminder({ version: 'v2' });
  const row = await f.adapter().read({ loopId: f.loopId }); assert.equal(row.outcome, 'handled-observed'); assert.equal(row.sourceIdentity.version, 'v2'); assert.equal(f.metadata.listBillActionBindings().length, 1);
  const other = fixture(t); await admit(other); other.reminder({ version: 'v2', dueAt: '2026-10-07T00:00:00.000Z' });
  await assert.rejects(other.adapter().read({ loopId: other.loopId }), error => error.code === 'conflict'); assert.equal(other.metadata.listBillActionBindings().length, 1); assert.equal(other.card.status, 'todo');
});

test('source revision changes during read cannot publish the earlier authorized evidence', async t => {
  const f = fixture(t); await admit(f); let changed = false;
  f.beforeRead(() => { if (!changed) { changed = true; f.reminder({ version: 'v2' }); } });
  await assert.rejects(f.adapter().read({ loopId: f.loopId }), error => error.code === 'conflict');
});
