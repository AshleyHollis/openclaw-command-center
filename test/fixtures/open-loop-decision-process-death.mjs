import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createOpenLoopReminderCoordinator } from '../../src/open-loops/reminder-coordinator.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [stateDir, mode] = process.argv.slice(2);
const operationId = '10000000-0000-4000-8000-000000000031';
const nativeFile = path.join(stateDir, 'fictional-native-cron.json');
let metadata;
try {
  metadata = openCommandCenterMetadataService({ stateDir, capabilities: { scheduler: true } });
  if (mode === 'commit') {
    metadata.createTopic({ topicId: 'fictional-process-renovation', paraCategory: 'project', lifecycle: 'active' });
    const created = metadata.ingestIncomingMessage({ schemaVersion: 1, logicalOperationId: 'fictional-process-bill', message: {
      schemaVersion: 1, channel: 'email', source: { system: 'fictional-mail', externalId: 'fictional-process-invoice', version: 'v1' },
      occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', historicalBaseline: false,
      topicId: 'fictional-process-renovation', disposition: 'confirmed-obligation', requestKind: 'payment', explicitRequest: true,
      summary: 'Pay fictional process invoice', payee: 'Fictional Builder', purpose: 'fictional work', amount: 10000,
      currency: 'AUD', dueAt: '2026-10-01T00:00:00.000Z', invoiceId: 'FICTIONAL-PROCESS-1',
      attachmentIds: ['fictional-attachment'], evidenceSelectors: ['attachment:1:invoice-number']
    } });
    metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: operationId, loopId: created.loop.loopId,
      expectedRevision: 1, decision: 'defer', reviewAt: '2026-10-02T00:00:00.000Z', actorId: 'fictional-operator',
      rationale: 'Wait for the fictional correction.', updatedAt: '2026-09-20T01:00:00.000Z' });
    process.send?.({ type: 'accepted', loopId: created.loop.loopId, operationId });
    setInterval(() => {}, 60_000);
  } else if (['resume', 'effect', 'recover', 'paid-recover'].includes(mode)) {
    const actions = metadata.listOpenLoopUserActionReceiptsPage({ limit: 10 });
    const action = actions.actions.find(item => item.logicalOperationId === operationId);
    if (!action || (mode !== 'paid-recover' && !action.current)) throw new Error('accepted decision missing after process death');
    const saved = mode === 'paid-recover'
      ? metadata.getCurrentOpenLoopUserActionReceipt(action.loop.loopId)
      : metadata.getOpenLoopUserActionReceipt(operationId);
    const jobs = new Map(existsSync(nativeFile) ? JSON.parse(readFileSync(nativeFile, 'utf8')).map(job => [job.id, job]) : []);
    let revision = 0;
    const gateway = { async request(method, params) {
      if (method === 'cron.list') return { jobs: [...jobs.values()].map(job => structuredClone(job)) };
      if (method === 'cron.get') return structuredClone(jobs.get(params.id));
      if (method === 'cron.add') {
        if (mode === 'recover' || mode === 'paid-recover') throw new Error('fresh process must not recreate an accepted native job');
        const job = { ...structuredClone(params), id: params.id ?? 'fictional-process-reminder', configRevision: `fictional-revision-${++revision}` };
        jobs.set(job.id, job);
        if (mode === 'effect') {
          writeFileSync(nativeFile, JSON.stringify([...jobs.values()]));
          process.send?.({ type: 'native-accepted', id: job.id });
          await new Promise(() => {});
        }
        return { created: true, job: structuredClone(job) };
      }
      if (method === 'cron.update') {
        const before = jobs.get(params.id);
        if (before.configRevision !== params.expectedConfigRevision) throw new Error('fictional Cron revision conflict');
        const after = { ...before, ...structuredClone(params.patch), configRevision: `fictional-revision-${++revision}` };
        jobs.set(after.id, after);
        if (mode === 'paid-recover') writeFileSync(nativeFile, JSON.stringify([...jobs.values()]));
        return structuredClone(after);
      }
      throw new Error(`unexpected Scheduler method ${method}`);
    } };
    const coordinator = createOpenLoopReminderCoordinator({ metadata, gateway });
    const completed = await coordinator.reconcileAccepted({ loop: saved.loop, followUpIntent: saved.followUpIntent });
    process.send?.({ type: 'completed', status: completed.status, jobCount: jobs.size,
      enabled: [...jobs.values()][0]?.enabled,
      scheduleAt: [...jobs.values()][0]?.schedule?.at, operationState: metadata.getOperation(saved.followUpIntent.logicalOperationId)?.state }, () => {
      metadata.close();
      process.exit(0);
    });
  } else throw new Error(`unsupported fixture mode ${mode}`);
} catch (error) {
  process.send?.({ type: 'failed', message: error?.stack ?? String(error) }, () => {
    metadata?.close();
    process.exit(1);
  });
}
