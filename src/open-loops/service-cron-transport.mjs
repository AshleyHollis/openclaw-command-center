import { sourceError } from '../sources/errors.mjs';

// The Reminder adapter still speaks the three exact-job Cron request shapes used by
// authenticated commands. This closed transport resolves the current service
// handle for every effect; it never borrows a Gateway request or its caller.
export function createReminderServiceCronTransport({ getCron, assertCurrent }) {
  const activeCron = () => {
    assertCurrent();
    const cron = getCron?.();
    if (!cron || typeof cron.getWithRevision !== 'function'
      || typeof cron.updateWithRevision !== 'function') {
      throw sourceError('capability-unavailable', 'Revision-aware service Cron is unavailable.');
    }
    return cron;
  };
  const assertSameCron = cron => {
    assertCurrent();
    if (getCron?.() !== cron) throw sourceError('capability-unavailable', 'The service Cron scheduler was replaced.');
  };
  return Object.freeze({
    async request(method, params) {
      const cron = activeCron();
      if (method === 'cron.get') {
        const job = await cron.getWithRevision(params.id);
        assertSameCron(cron);
        return job;
      }
      if (method === 'cron.add') {
        const created = await cron.add(params);
        const id = created?.job?.id ?? created?.id;
        if (typeof id !== 'string' || (params.id && id !== params.id)) {
          throw sourceError('source-recovery', 'Service Cron did not confirm the reserved Reminder identity.');
        }
        const current = await cron.getWithRevision(id);
        assertSameCron(cron);
        if (!current || current.id !== id) throw sourceError('source-recovery', 'Created Reminder cannot be read by its exact identity.');
        return current;
      }
      if (method === 'cron.update') {
        if (typeof params?.id !== 'string' || typeof params.expectedConfigRevision !== 'string') {
          throw sourceError('invalid-request', 'A conditional Reminder update requires its exact ID and revision.');
        }
        const updated = await cron.updateWithRevision(params.id, params.patch, params.expectedConfigRevision);
        assertSameCron(cron);
        return updated;
      }
      throw sourceError('capability-unavailable', 'This background Reminder transport does not expose the requested Cron operation.');
    }
  });
}
