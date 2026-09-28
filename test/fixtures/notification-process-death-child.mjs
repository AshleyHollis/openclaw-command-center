import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createNotificationService } from '../../src/notifications/service.mjs';
import { fictionalEpisodes, openFictionalProvider, RELEASE_MS, START_MS } from './notification-process-death-provider.mjs';

const stateDir = process.argv[2];
if (!stateDir || !process.send || typeof global.gc !== 'function') throw new Error('Isolated IPC and explicit GC are required.');
const metadata = openCommandCenterMetadataService({ stateDir });
const provider = openFictionalProvider(stateDir);
const episodes = fictionalEpisodes();
const attention = { allEpisodes: () => episodes, list: () => ({}) };
let clock = START_MS;
const emitter = {
  async emit(candidate) {
    if (provider.record(candidate) !== 'new') throw new Error('Unexpected fictional provider replay before process death.');
    // The separate provider commit is complete. Root the unresolved host call in
    // IPC so it cannot be GC'd; a reply would release CC to write its receipt.
    await new Promise(resolve => {
      process.once('message', resolve);
      setImmediate(() => {
        global.gc();
        process.send({ phase: 'provider-committed', gcForced: true, logicalOperationId: candidate.logicalOperationId, emissionId: candidate.emissionId });
      });
    });
    return { status: 'sent' };
  },
  async clear() { throw new Error('No clear should start before this child is killed.'); }
};
const service = createNotificationService({ metadata, attentionService: attention, emitter, now: () => clock });
try {
  service.updateSettings({ schemaVersion: 1, logicalOperationId: '81111111-4444-4444-8444-444444444444', expectedRevision: 1, settings: { quietHoursEnd: '23:00', timeZone: 'UTC' } });
  await service.reconcile();
  if (provider.delivered().length !== 0) throw new Error('The quiet cohort was delivered before release.');
  clock = RELEASE_MS;
  await service.reconcile();
  throw new Error('The child must be killed before the host call returns.');
} finally {
  await service.stop();
  provider.close();
  metadata.close();
}
