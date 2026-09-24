import { loadPendingClarificationContext } from './clarification-context.mjs';
import { runClarificationProposal } from './clarification-proposal.mjs';

const actionKeys = ['outcome', 'decision', 'paymentState', 'paidAmount', 'currency', 'reviewAt', 'dueAt', 'dueDate', 'dueTimeZone'];

export function createClarificationWorker({ metadata, complete, interpret, assertCurrent, notBefore, now = () => new Date().toISOString() }) {
  if (!metadata || typeof complete !== 'function' || typeof interpret !== 'function' || typeof assertCurrent !== 'function'
    || typeof notBefore !== 'string' || !Number.isFinite(Date.parse(notBefore))) throw new TypeError('The clarification worker requires active owners and an exact admission time.');

  async function processOne(item) {
    assertCurrent();
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
    if (accepted.proposal.outcome === 'ambiguous') return Object.freeze({ loopId: item.loopId, status: 'review-required' });
    const action = Object.fromEntries(actionKeys.filter(key => accepted.proposal[key] !== undefined).map(key => [key, accepted.proposal[key]]));
    assertCurrent();
    const result = await interpret({ loopId: context.loopId, expectedRevision: context.expectedRevision,
      clarificationObservationId: context.clarificationObservationId, processorVersion: context.processorVersion, ...action });
    return Object.freeze({ loopId: item.loopId, status: result?.disposition ?? result?.status ?? 'unknown' });
  }

  async function runPage({ cursor, limit = 5 } = {}) {
    assertCurrent();
    const page = metadata.listPendingOpenLoopClarificationsPage({ ...(cursor ? { cursor } : {}), limit });
    const results = [];
    for (const item of page.items) {
      try { results.push(await processOne(item)); }
      catch (error) {
        if (error?.code === 'capability-unavailable') throw error;
        results.push(Object.freeze({ loopId: item.loopId, status: 'failed', code: typeof error?.code === 'string' && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : 'clarification-worker-failed' }));
      }
    }
    return Object.freeze({ schemaVersion: 1, results, nextCursor: page.nextCursor });
  }

  return Object.freeze({ processOne, runPage });
}
