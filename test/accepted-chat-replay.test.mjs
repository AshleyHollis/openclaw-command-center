import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createAcceptedChatReplayService } from '../src/open-loops/accepted-chat-replay.mjs';
import { createCommitmentCaptureService, planCommitmentCapture } from '../src/open-loops/commitment-capture.mjs';
import { recordIntakeSourcePlan, recordIntakeOutcome } from '../src/open-loops/intake-accounting.mjs';
import { sourceNoteCaptureToolFactory } from '../src/open-loops/source-intake-tool.mjs';

export const acceptedPlan = () => ({ schemaVersion: 1, sessionKey: 'agent:main:fictional-chat', sessionId: 'fictional-session-v1', sourceKind: 'chat', sourceExternalId: 'fictional-accepted-input', sourceVersion: 'fictional-logical-revision-v1', checkpoint: 'fictional-checkpoint', observedAt: '2026-10-01T01:00:00.000Z', processorVersion: 'fictional-processor-v1', acceptedExtraction: { schemaVersion: 1, proposedTopic: 'Fictional Topic', notePath: '', knowledgeMarkdown: '', obligations: [{ obligationId: 'fictional-choice', title: 'Choose fictional delivery', provenance: 'inferred', classification: 'decision' }, { obligationId: 'fictional-reply', title: 'Reply with fictional reference', provenance: 'explicit', classification: 'obligation' }], noAction: { outcomeId: 'fictional-quiet', summary: 'No additional action required' } }, outcomes: [{ outcomeId: 'fictional-choice', kind: 'decision' }, { outcomeId: 'fictional-reply', kind: 'obligation' }, { outcomeId: 'fictional-quiet', kind: 'no-action' }] });

export async function fixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-accepted-chat-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } });
  metadata.createTopic({ topicId: 'topic-fictional', name: 'Fictional Topic', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId: 'conversation:fictional', topicId: 'topic-fictional', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-chat' });
  metadata.setSessionState({ referenceId: 'conversation:fictional', sessionId: 'fictional-session-v1', status: 'open', isPrimary: true, displayName: 'Fictional conversation', updatedAt: '2026-10-01T00:00:00.000Z' });
  let active = true, nativeSessionId = 'fictional-session-v1';
  const runtime = { principalId: 'fictional-operator', assertCurrent() { if (!active) throw Object.assign(new Error('revoked fictional authority'), { code: 'unauthenticated' }); } };
  function sources(store = metadata) {
    return { async sessionTopicContext() { return { status: 'bound', sessionKey: 'agent:main:fictional-chat', sessionId: nativeSessionId, referenceId: 'conversation:fictional', topicId: 'topic-fictional' }; },
      assertAcceptedChatBinding(binding) {
        runtime.assertCurrent();
        assert.equal(binding.sessionId, nativeSessionId, 'exact native incarnation');
        assert.deepEqual(binding.sessionReference, store.getSourceReference('conversation:fictional'));
        assert.deepEqual(binding.sessionState, store.getSessionState('conversation:fictional'));
        assert.deepEqual(binding.sessionLocator, store.getSourceLocator('conversation:fictional'));
        assert.equal(binding.topicRevision, store.getTopic('topic-fictional').revision);
      } };
  }
  return { stateDir, runtime, metadata: () => metadata, owner: () => createAcceptedChatReplayService({ metadata, sourceService: sources() }), sources,
    revoke() { active = false; }, replaceSession() { nativeSessionId = 'fictional-session-v2'; },
    reopen() { metadata.close(); metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true } }); },
    async cleanup() { metadata.close(); await rm(stateDir, { recursive: true, force: true }); } };
}

test('accepted Chat plan survives lost capture response, reopen, changed transport and preserves later user decision', async () => {
  const f = await fixture();
  try {
    const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
    const originalReceipt = f.metadata().getOperation(accepted.planId);
    let lost = false;
    const interrupted = { ...f.runtime, assertCurrent() {
      f.runtime.assertCurrent();
      if (!lost && f.metadata().listOpenLoops().length) { lost = true; throw new Error('fictional lost response after capture'); }
    } };
    await assert.rejects(() => f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, interrupted), /lost response/u);
    const loop = f.metadata().listOpenLoops()[0];
    assert.equal(loop.state, 'decision-needed');
    f.metadata().recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-user-complete', loopId: loop.loopId, expectedRevision: loop.revision, decision: 'resolve', actorId: f.runtime.principalId, rationale: 'Complete the fictional decision', updatedAt: '2026-10-02T00:00:00.000Z' });
    const decided = f.metadata().getOpenLoop(loop.loopId);
    f.reopen();
    const replay = await f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime);
    assert.equal(replay.account.resolved, true);
    assert.equal(replay.account.outcomes.find(item => item.kind === 'decision').status, 'clarified');
    assert.deepEqual(f.metadata().getOpenLoop(loop.loopId), decided);
    assert.deepEqual(f.metadata().getOperation(accepted.planId), originalReceipt);
    assert.equal(f.metadata().listOpenLoops().length, 2);
    const operations = f.metadata().listOperations();
    await f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, { ...f.runtime });
    assert.deepEqual(f.metadata().listOperations(), operations);
    assert.equal(replay.coverage, 'accepted-plan-only');
    assert.equal(replay.sourceCoverage, 'unknown');
  } finally { await f.cleanup(); }
});

test('Drop after lost capture response survives missing outcome reconciliation and later replay', async () => {
  const f = await fixture();
  try {
    const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
    let lost = false;
    await assert.rejects(() => f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, { ...f.runtime, assertCurrent() {
      f.runtime.assertCurrent();
      if (!lost && f.metadata().listOpenLoops().length) { lost = true; throw new Error('fictional capture response lost'); }
    } }), /response lost/u);
    const loop = f.metadata().listOpenLoops()[0];
    f.metadata().recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-user-drop', loopId: loop.loopId, expectedRevision: loop.revision, decision: 'dismiss', actorId: f.runtime.principalId, rationale: 'Drop the fictional decision', updatedAt: '2026-10-02T00:00:00.000Z' });
    const dropped = f.metadata().getOpenLoop(loop.loopId);
    assert.equal(dropped.state, 'cancelled');
    f.reopen();
    const request = { schemaVersion: 1, planId: accepted.planId };
    const replay = await f.owner().replay(request, f.runtime);
    assert.equal(replay.account.outcomes[0].status, 'clarified');
    await f.owner().replay(request, f.runtime);
    assert.deepEqual(f.metadata().getOpenLoop(loop.loopId), dropped);
  } finally { await f.cleanup(); }
});

test('explicit accepted decision stays pending with its original provenance', async () => {
  const f = await fixture();
  try {
    const plan = acceptedPlan(); plan.acceptedExtraction.obligations[0].provenance = 'explicit';
    const accepted = await f.owner().accept(plan, f.runtime);
    const replay = await f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime);
    assert.equal(replay.account.outcomes[0].status, 'pending-decision');
    const decision = f.metadata().getOpenLoop(replay.account.outcomes[0].loopId);
    assert.equal(decision.state, 'decision-needed');
    assert.equal(decision.attention.provenance, 'explicit');
  } finally { await f.cleanup(); }
});

test('same native key and incarnation with advanced Session locator generation refuses missing effects', async () => {
  const f = await fixture();
  try {
    const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
    f.metadata().setSourceLocator({ referenceId: 'conversation:fictional', locator: 'agent:main:fictional-chat', ownership: 'external', observedRevision: 'fictional-session-v1' });
    await assert.rejects(() => f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime));
    assert.equal(f.metadata().listOpenLoops().length, 0);
  } finally { await f.cleanup(); }
});

test('competing real SQLite connections converge on one accepted receipt and one effect per outcome', async () => {
  const f = await fixture();
  let second;
  try {
    const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
    second = openCommandCenterMetadataService({ stateDir: f.stateDir, capabilities: { notes: true, sessions: true } });
    const owner2 = createAcceptedChatReplayService({ metadata: second, sourceService: f.sources(second) });
    const replies = await Promise.all([f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime), owner2.replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime)]);
    assert.ok(replies.every(item => item.account.accounted));
    assert.equal(f.metadata().listOpenLoops().length, 2);
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'intake-outcome.chat.v1').length, 3);
  } finally { second?.close(); await f.cleanup(); }
});

test('changed extraction, processor or source acceptance intent conflicts; later clock returns original receipt', async () => {
  const f = await fixture();
  try {
    const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
    const later = await f.owner().accept({ ...acceptedPlan(), observedAt: '2026-10-05T00:00:00.000Z' }, f.runtime);
    assert.equal(later.plan.observedAt, accepted.plan.observedAt);
    await assert.rejects(() => f.owner().accept({ ...acceptedPlan(), processorVersion: 'fictional-processor-v2' }, f.runtime), { code: 'intent-mismatch' });
    const changed = acceptedPlan(); changed.acceptedExtraction.obligations[0].title = 'Different fictional intent';
    await assert.rejects(() => f.owner().accept(changed, f.runtime), { code: 'intent-mismatch' });
    assert.equal(f.metadata().listOperations().length, 1);
  } finally { await f.cleanup(); }
});

test('revoked operator, replaced Conversation and wrong original principal refuse replay without effects', async () => {
  for (const change of ['principal', 'session', 'revoke']) {
    const f = await fixture();
    try {
      const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
      if (change === 'session') f.replaceSession();
      if (change === 'revoke') f.revoke();
      await assert.rejects(() => f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, change === 'principal' ? { ...f.runtime, principalId: 'fictional-other-operator' } : f.runtime));
      assert.equal(f.metadata().listOpenLoops().length, 0);
      assert.equal(f.metadata().listOperations().length, 1);
    } finally { await f.cleanup(); }
  }
});

test('omitted accepted plan refuses direct Chat plan, accounting, capture, metadata apply and derived Note tool', async () => {
  const f = await fixture();
  try {
    const { sessionKey, sessionId, ...plan } = acceptedPlan();
    assert.throws(() => recordIntakeSourcePlan(f.metadata(), plan), { code: 'source-recovery' });
    const input = { schemaVersion: 1, logicalOperationId: 'fictional-unadmitted', sourceKind: 'chat', sourceExternalId: plan.sourceExternalId, sourceVersion: plan.sourceVersion, topicId: 'topic-fictional', obligationId: 'fictional-unadmitted', title: 'Fictional refused capture', provenance: 'explicit', occurredAt: plan.observedAt, observedAt: plan.observedAt, historicalBaseline: false };
    await assert.rejects(() => createCommitmentCaptureService({ metadata: f.metadata() }).capture(input), { code: 'source-recovery' });
    const planned = planCommitmentCapture(input);
    assert.throws(() => f.metadata().applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: input.logicalOperationId, operationKind: 'commitment.capture.v1', intent: input, expectedRevision: 0, observation: planned.observation, loop: planned.loop, updatedAt: input.observedAt }), { code: 'source-recovery' });
    assert.throws(() => recordIntakeOutcome(f.metadata(), { schemaVersion: 1, sourceKind: 'chat', sourceExternalId: plan.sourceExternalId, sourceVersion: plan.sourceVersion, outcomeId: 'fictional-quiet', kind: 'no-action', status: 'no-action', summary: 'No action', recordedAt: plan.observedAt }), { code: 'source-recovery' });
    let writes = 0;
    const tool = sourceNoteCaptureToolFactory({ getOwners: () => ({ metadata: f.metadata(), sourceService: { async notesCreate() { writes++; } } }) })();
    await assert.rejects(() => tool.execute('fictional-call', { sourceKind: 'chat' }), { code: 'source-recovery' });
    assert.equal(writes, 0);
    assert.equal(f.metadata().listOpenLoops().length, 0);
    assert.equal(f.metadata().listOperations().length, 0);
  } finally { await f.cleanup(); }
});

test('email and Note plans retain their existing accounting behavior', async () => {
  const f = await fixture();
  try {
    for (const sourceKind of ['email', 'note']) {
      const { sessionKey, sessionId, ...plan } = acceptedPlan();
      plan.sourceKind = sourceKind;
      assert.equal(recordIntakeSourcePlan(f.metadata(), plan).disposition, 'recorded');
      assert.equal(recordIntakeOutcome(f.metadata(), { schemaVersion: 1, sourceKind, sourceExternalId: plan.sourceExternalId, sourceVersion: plan.sourceVersion, outcomeId: 'fictional-quiet', kind: 'no-action', status: 'no-action', summary: 'No additional action required', recordedAt: plan.observedAt }).disposition, 'recorded');
    }
  } finally { await f.cleanup(); }
});

test('legacy Chat plan stays byte-for-byte unchanged and is not adopted by the current caller', async () => {
  const f = await fixture();
  try {
    const accepted = await f.owner().accept(acceptedPlan(), f.runtime);
    const { acceptedChat, ...legacy } = accepted.plan;
    const db = new DatabaseSync(f.metadata().databasePath);
    try { db.prepare('UPDATE operation_journal SET result_identity = ?, intent_digest = ? WHERE logical_operation_id = ?').run(JSON.stringify(legacy), 'sha256:fictional-legacy-intent', accepted.planId); }
    finally { db.close(); }
    const receipt = f.metadata().getOperation(accepted.planId);
    await assert.rejects(() => f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime), { code: 'source-recovery' });
    await assert.rejects(() => f.owner().accept(acceptedPlan(), f.runtime), { code: 'intent-mismatch' });
    assert.deepEqual(f.metadata().getOperation(accepted.planId), receipt);
    assert.equal(f.metadata().listOpenLoops().length, 0);
  } finally { await f.cleanup(); }
});
