import { createAcceptedChatNoteFixture, mixedChatPlan } from '../support/accepted-chat-note-fixture.mjs';

const [parent, mode, boundary] = process.argv.slice(2);
const pause = async (metadata, planId) => {
  const choice = metadata.listOpenLoops().find(loop => loop.state === 'decision-needed');
  if (choice) metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'fictional-user-choice-after-effect', loopId: choice.loopId, expectedRevision: choice.revision, decision: 'resolve', actorId: 'fictional-operator', rationale: 'Preserve the completed fictional decision', updatedAt: '2026-10-02T00:00:00.000Z' });
  process.send?.({ type: 'boundary', boundary, planId });
  await new Promise(() => {});
};
let paused = false;
const f = await createAcceptedChatNoteFixture(parent, {
  async afterAtomicPublish() { if (mode === 'crash' && boundary === 'note' && !paused) { paused = true; await pause(f.metadata()); } },
  assertCurrent(metadata) {
    if (mode !== 'crash' || paused) return;
    const reached = boundary === 'capture' && metadata.listOpenLoops().length > 0 || boundary === 'outcome' && metadata.listOperations().some(item => item.operationKind === 'intake-outcome.chat.v1' && JSON.parse(item.resultIdentity).kind === 'decision');
    if (reached) { paused = true; throw new Error('fixture-death-boundary'); }
  }
});
try {
  let planId;
  if (mode === 'crash') {
    planId = (await f.owner().accept(mixedChatPlan(), f.runtime)).planId;
    if (boundary === 'accept') await pause(f.metadata(), planId);
  } else {
    const accepted = f.metadata().listOperations().filter(item => item.operationKind === 'intake-source.chat.v1');
    if (accepted.length !== 1) throw new Error('Restart needs exactly one existing accepted Chat plan');
    planId = accepted[0].logicalOperationId;
  }
  const result = await f.owner().replay({ schemaVersion: 1, planId }, f.runtime);
  process.send?.({ type: 'completed', account: result.account, loops: f.metadata().listOpenLoops().map(loop => ({ loopId: loop.loopId, state: loop.state, revision: loop.revision })), noteOperations: f.metadata().listOperations().filter(item => item.operationKind === 'notes.create').length });
  process.disconnect?.();
} catch (error) {
  if (error.message === 'fixture-death-boundary') await pause(f.metadata());
  process.send?.({ type: 'failed', message: error.stack ?? String(error) });
  process.disconnect?.(); process.exitCode = 1;
} finally { f.close(); }
