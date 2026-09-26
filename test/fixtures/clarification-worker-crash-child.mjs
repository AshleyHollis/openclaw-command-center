import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createClarificationWorker } from '../../src/open-loops/clarification-worker.mjs';
import { loadPendingClarificationContext, clarificationInterpretationOperationId } from '../../src/open-loops/clarification-context.mjs';

const metadata = openCommandCenterMetadataService({ stateDir: process.env.COMMAND_CENTER_FIXTURE_STATE_DIR, capabilities: { notes: true } });
if (process.env.COMMAND_CENTER_FIXTURE_PHASE === 'decision-committed') {
  const [item] = metadata.listPendingOpenLoopClarificationsPage().items;
  const context = loadPendingClarificationContext(metadata, item);
  metadata.recordOpenLoopDecision({ schemaVersion: 1,
    logicalOperationId: clarificationInterpretationOperationId(item.clarificationObservationId),
    loopId: item.loopId, expectedRevision: item.expectedRevision, decision: 'defer',
    reviewAt: '2026-09-26T09:00:00.000Z', actorId: 'operator-fixture',
    rationale: context.userWords, updatedAt: '2026-09-22T01:04:00.000Z',
    interpretationFence: { clarificationObservationId: item.clarificationObservationId,
      ...context.source, outcomeId: context.outcomeId, processorVersion: context.processorVersion } });
  process.send?.({ phase: 'decision-committed' });
  await new Promise(() => {});
}
const worker = createClarificationWorker({ metadata, notBefore: '2026-09-22T00:00:00.000Z', assertCurrent() {},
  now: () => '2026-09-22T01:03:00.000Z',
  complete: async () => ({ model: 'fictional/model', text: JSON.stringify({ outcome: 'clear', decision: 'confirm',
    evidenceQuote: 'Use the morning delivery window for this one.' }) }),
  interpret: async () => {
    process.send?.({ phase: 'proposal-persisted' });
    await new Promise(() => {});
  } });
await worker.runPage();
