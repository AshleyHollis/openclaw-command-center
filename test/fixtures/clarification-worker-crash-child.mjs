import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createClarificationWorker } from '../../src/open-loops/clarification-worker.mjs';

const metadata = openCommandCenterMetadataService({ stateDir: process.env.COMMAND_CENTER_FIXTURE_STATE_DIR, capabilities: { notes: true } });
const worker = createClarificationWorker({ metadata, notBefore: '2026-09-22T00:00:00.000Z', assertCurrent() {},
  now: () => '2026-09-22T01:03:00.000Z',
  complete: async () => ({ model: 'fictional/model', text: JSON.stringify({ outcome: 'clear', decision: 'confirm',
    evidenceQuote: 'Use the morning delivery window for this one.' }) }),
  interpret: async () => {
    process.send?.({ phase: 'proposal-persisted' });
    await new Promise(() => {});
  } });
await worker.runPage();
