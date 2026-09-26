import { loadPendingClarificationContext } from './clarification-context.mjs';
import { runClarificationProposal } from './clarification-proposal.mjs';
import { clarificationInterpretationOperationId } from './clarification-context.mjs';

const actionKeys = ['outcome', 'decision', 'paymentState', 'paidAmount', 'currency', 'reviewAt', 'dueAt', 'dueDate', 'dueTimeZone'];

function followUpState(metadata, receipt) {
  if (!receipt?.current && !receipt?.recoverable) return 'superseded';
  const reminder = receipt.followUpIntent;
  const reminderReview = ['blocked', 'conflict'].includes(reminder?.action);
  const reminderPending = reminder && !['none', 'blocked', 'conflict'].includes(reminder.action)
    && metadata.getOperation(reminder.logicalOperationId)?.state !== 'applied';
  const note = metadata.getOpenLoopSupportingNoteIntent(receipt.logicalOperationId);
  const noteReview = (note?.current || receipt.recoverable)
    && (note?.target.status === 'conflict' || note?.outcome?.status === 'conflict'
      || receipt.recoverable && note?.outcome?.status === 'unknown');
  const notePending = note?.current && note.target.status === 'ready' && note.outcome?.status !== 'completed';
  if (reminderPending || notePending) return 'follow-up-pending';
  return reminderReview || noteReview ? 'review-required' : 'recovered';
}

export function createClarificationWorker({ metadata, complete, interpret, followUp, assertCurrent, notBefore, now = () => new Date().toISOString() }) {
  if (!metadata || typeof complete !== 'function' || typeof interpret !== 'function' || typeof assertCurrent !== 'function'
    || typeof notBefore !== 'string' || !Number.isFinite(Date.parse(notBefore))) throw new TypeError('The clarification worker requires active owners and an exact admission time.');

  async function processOne(item) {
    assertCurrent();
    const current = metadata.getOpenLoop(item.loopId);
    if (current?.revision === item.expectedRevision
      && current.attention?.pendingClarificationId === item.clarificationObservationId
      && current.attention?.priorUserActionOperationId) {
      const priorNote = metadata.getOpenLoopSupportingNoteIntent(current.attention.priorUserActionOperationId);
      if (priorNote?.outcome?.status === 'unknown') {
        metadata.recordClarificationWorkerDisposition?.({ loopId: item.loopId,
          clarificationObservationId: item.clarificationObservationId, status: 'review-required',
          code: 'prior-note-publication-unknown', updatedAt: now() });
        return Object.freeze({ loopId: item.loopId, status: 'review-required', code: 'prior-note-publication-unknown' });
      }
    }
    if (metadata.getClarificationWorkerDisposition?.(item.clarificationObservationId)?.status === 'review-required')
      return Object.freeze({ loopId: item.loopId, status: 'review-required' });
    const context = loadPendingClarificationContext(metadata, item);
    if (context.status !== 'pending' || context.clarificationObservationId !== item.clarificationObservationId)
      return Object.freeze({ loopId: item.loopId, status: context.status === 'pending' ? 'superseded' : context.status });
    const observation = metadata.getOpenLoopObservation(context.clarificationObservationId);
    if (!observation || Date.parse(observation.observedAt) < Date.parse(notBefore))
      return Object.freeze({ loopId: item.loopId, status: 'outside-admission-window' });
    let accepted = metadata.getClarificationProposal(context.clarificationObservationId);
    if (!accepted) {
      let model;
      const proposal = await runClarificationProposal({ context, complete: async request => {
        assertCurrent();
        const response = await complete(request);
        model = response?.model;
        return response;
      } });
      assertCurrent();
      const recorded = metadata.recordClarificationProposal({ loopId: context.loopId, expectedRevision: context.expectedRevision,
        clarificationObservationId: context.clarificationObservationId, processorVersion: context.processorVersion,
        source: context.source, outcomeId: context.outcomeId, proposal, model, createdAt: now() });
      accepted = recorded.accepted;
    }
    if (accepted.loopId !== context.loopId || accepted.expectedRevision !== context.expectedRevision
      || accepted.processorVersion !== context.processorVersion || accepted.outcomeId !== context.outcomeId
      || JSON.stringify(accepted.source) !== JSON.stringify(context.source))
      return Object.freeze({ loopId: item.loopId, status: 'proposal-conflict' });
    if (accepted.proposal.outcome === 'ambiguous') {
      metadata.recordClarificationWorkerDisposition?.({ loopId: item.loopId,
        clarificationObservationId: item.clarificationObservationId, status: 'review-required',
        code: 'ambiguous-proposal', updatedAt: now() });
      return Object.freeze({ loopId: item.loopId, status: 'review-required' });
    }
    const action = Object.fromEntries(actionKeys.filter(key => accepted.proposal[key] !== undefined).map(key => [key, accepted.proposal[key]]));
    assertCurrent();
    const result = await interpret({ loopId: context.loopId, expectedRevision: context.expectedRevision,
      clarificationObservationId: context.clarificationObservationId, processorVersion: context.processorVersion, ...action });
    const receipt = metadata.getOpenLoopUserActionReceipt?.(clarificationInterpretationOperationId(item.clarificationObservationId));
    const followUpStatus = receipt ? followUpState(metadata, receipt) : null;
    if (receipt && ['recovered', 'review-required'].includes(followUpStatus)) metadata.recordClarificationWorkerDisposition?.({ loopId: item.loopId,
      clarificationObservationId: item.clarificationObservationId,
      status: followUpStatus, ...(followUpStatus === 'review-required' ? { code: 'follow-up-conflict' } : {}), updatedAt: now() });
    return Object.freeze({ loopId: item.loopId,
      status: followUpStatus === 'follow-up-pending' || followUpStatus === 'review-required'
        ? followUpStatus : result?.disposition ?? result?.status ?? 'unknown' });
  }

  async function runPage({ cursor, limit = 5 } = {}) {
    assertCurrent();
    const page = metadata.listPendingOpenLoopClarificationsPage({ ...(cursor ? { cursor } : {}), limit });
    const results = [];
    for (const item of page.items) {
      try { results.push(await processOne(item)); }
      catch (error) {
        if (error?.code === 'capability-unavailable') throw error;
        const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : 'clarification-worker-failed';
        const status = code === 'invalid-proposal' ? 'review-required' : 'failed';
        metadata.recordClarificationWorkerDisposition?.({ loopId: item.loopId,
          clarificationObservationId: item.clarificationObservationId, status, code, updatedAt: now() });
        results.push(Object.freeze({ loopId: item.loopId, status, code }));
      }
    }
    return Object.freeze({ schemaVersion: 1, results, nextCursor: page.nextCursor });
  }

  // The pending marker disappears at the decision commit. A separate bounded
  // pass over durable decision receipts recovers effects after that boundary.
  async function runFollowUpPage({ cursor, limit = 20 } = {}) {
    assertCurrent();
    if (typeof followUp !== 'function') return Object.freeze({ schemaVersion: 1, results: [], nextCursor: null });
    const page = metadata.listOpenLoopUserActionReceiptsPage({ ...(cursor ? { cursor } : {}), limit });
    const results = [];
    for (const item of page.actions) {
      assertCurrent();
      if (!item.current && !item.recoverable) continue;
      const interpretation = item.loop.evidenceObservationIds?.map(id => {
        const observation = metadata.getOpenLoopObservation(id);
        return observation?.source?.kind === 'processor-interpretation'
          && observation.source.externalId === item.logicalOperationId ? observation : null;
      }).find(Boolean);
      if (!interpretation) continue;
      const clarificationId = interpretation.facts?.interpretationOf;
      const clarification = clarificationId && metadata.getOpenLoopObservation(clarificationId);
      const proposal = clarificationId && metadata.getClarificationProposal(clarificationId);
      if (!clarification || Date.parse(clarification.observedAt) < Date.parse(notBefore)
        || proposal?.loopId !== item.loop.loopId || proposal.proposal?.outcome !== 'clear') continue;
      const receipt = metadata.getOpenLoopUserActionReceipt(item.logicalOperationId);
      const before = followUpState(metadata, receipt);
      if (before === 'recovered' || before === 'superseded') continue;
      if (before === 'review-required') {
        metadata.recordClarificationWorkerDisposition?.({ loopId: receipt.loop.loopId,
          clarificationObservationId: clarificationId, status: 'review-required', code: 'follow-up-conflict', updatedAt: now() });
        results.push(Object.freeze({ loopId: receipt.loop.loopId, status: 'review-required' }));
        continue;
      }
      try {
        const result = await followUp(receipt);
        const after = followUpState(metadata, metadata.getOpenLoopUserActionReceipt(item.logicalOperationId));
        if (['recovered', 'review-required'].includes(after)) metadata.recordClarificationWorkerDisposition?.({ loopId: receipt.loop.loopId,
          clarificationObservationId: clarificationId,
          status: after, ...(after === 'review-required' ? { code: 'follow-up-conflict' } : {}), updatedAt: now() });
        results.push(Object.freeze({ loopId: receipt.loop.loopId,
          status: after === 'follow-up-pending' || after === 'review-required'
            ? after : result?.disposition ?? result?.status ?? 'recovered' }));
      } catch (error) {
        if (error?.code === 'capability-unavailable') throw error;
        const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : 'clarification-follow-up-failed';
        metadata.recordClarificationWorkerDisposition?.({ loopId: receipt.loop.loopId,
          clarificationObservationId: clarificationId,
          status: 'failed', code, updatedAt: now() });
        results.push(Object.freeze({ loopId: receipt.loop.loopId, status: 'failed', code }));
      }
    }
    return Object.freeze({ schemaVersion: 1, results, nextCursor: page.nextCursor });
  }

  return Object.freeze({ processOne, runPage, runFollowUpPage });
}
