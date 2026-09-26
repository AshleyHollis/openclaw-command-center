import assert from 'node:assert/strict';
import test from 'node:test';
import { createClarificationWorker } from '../src/open-loops/clarification-worker.mjs';

test('recovering an earlier Reminder cannot mark its unknown Note as recovered', async () => {
  const interpretationId = 'fictional-interpretation';
  const clarificationId = 'fictional-clarification';
  const receipt = { logicalOperationId: interpretationId, current: false, recoverable: true,
    followUpIntent: { action: 'create', logicalOperationId: 'fictional-reminder' },
    loop: { loopId: 'fictional-loop', evidenceObservationIds: ['fictional-interpretation-observation'] } };
  let reminderApplied = false;
  let disposition;
  const metadata = {
    listOpenLoopUserActionReceiptsPage: () => ({ actions: [receipt], nextCursor: null }),
    getOpenLoopObservation: id => id === 'fictional-interpretation-observation'
      ? { source: { kind: 'processor-interpretation', externalId: interpretationId }, facts: { interpretationOf: clarificationId } }
      : id === clarificationId ? { observedAt: '2026-09-24T00:00:00.000Z' } : null,
    getClarificationProposal: () => ({ loopId: receipt.loop.loopId, proposal: { outcome: 'clear' } }),
    getOpenLoopUserActionReceipt: () => receipt,
    getOpenLoopSupportingNoteIntent: () => ({ current: false, target: { status: 'ready' },
      outcome: { status: 'unknown', reason: 'prior-note-publication-unverified' } }),
    getOperation: () => reminderApplied ? { state: 'applied' } : null,
    recordClarificationWorkerDisposition: value => { disposition = value; }
  };
  const worker = createClarificationWorker({ metadata, notBefore: '2026-09-22T00:00:00.000Z',
    assertCurrent() {}, complete: async () => { throw new Error('No model call is needed.'); },
    interpret: async () => { throw new Error('No new decision is needed.'); },
    followUp: async () => { reminderApplied = true; return { status: 'completed' }; } });
  const result = await worker.runFollowUpPage();
  assert.equal(reminderApplied, true);
  assert.equal(result.results[0].status, 'review-required');
  assert.equal(disposition.status, 'review-required');
  assert.equal(disposition.clarificationObservationId, clarificationId);
});
