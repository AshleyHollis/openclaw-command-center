import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createHistoricalBackfill } from '../../src/open-loops/historical-backfill.mjs';
import { createHistoricalBackfillStore } from '../../src/open-loops/historical-backfill-store.mjs';

const [stateDir] = process.argv.slice(2);
const effectPath = path.join(stateDir, 'fictional-effect.json');
const plan = { schemaVersion: 1, backfillId: 'process-death-fixture', sourceKind: 'email', scope: { topicIds: [], topicNames: [], maxRecords: 1 } };
const metadata = openCommandCenterMetadataService({ stateDir });
try {
  const store = createHistoricalBackfillStore({ metadata });
  const service = createHistoricalBackfill({
    ...store,
    now: () => '2026-09-21T07:00:00.000Z',
    async readPage() { return { records: [{ schemaVersion: 1, sourceExternalId: 'fictional', sourceVersion: '1', checkpoint: '001' }], next: '001', done: true }; },
    async classify() { return { schemaVersion: 1, disposition: 'actionable', obligationId: 'fictional:work', title: 'Review fictional work' }; },
    async applyRecord() {
      if (existsSync(effectPath)) throw new Error('effect-dispatched-twice');
      writeFileSync(effectPath, '{"revision":1}\n', { flag: 'wx' });
      process.exit(23);
    },
    async reconcileRecord() { return existsSync(effectPath) ? { status: 'applied', result: { disposition: 'created', effectId: 'loop:fictional', revision: 1 } } : { status: 'not-applied' }; },
    async recordReceipt() {}
  });
  const result = await service.run({ mode: 'apply', plan });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { metadata.close(); }
