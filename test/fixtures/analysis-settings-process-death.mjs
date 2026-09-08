import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { createTopicAnalysisScheduleService } from '../../src/topics/analysis-schedule.mjs';

// The external Cron boundary is fictional; its durable bytes survive the
// actual child SIGKILL. Product Settings, journal and reconciliation are real.
export function durableFictionalCron(stateDir, { beforeEffect, afterEffect } = {}) {
  const file = path.join(stateDir, 'fictional-cron.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  async function save(input) {
    await beforeEffect?.();
    const previous = read();
    const job = { ...input, id: 'fictional-weekly-cron', configRevision: `fictional-${Number(previous?.configRevision.split('-').at(-1) ?? 0) + 1}` };
    writeFileSync(`${file}.writing`, JSON.stringify(job), { mode: 0o600 });
    renameSync(`${file}.writing`, file);
    await afterEffect?.();
    return structuredClone(job);
  }
  return {
    async list() { const job = read(); return job ? [job] : []; },
    async add(input) { if (read()) throw new Error('Duplicate fictional declaration'); return save(input); },
    async update(id, patch, { expectedConfigRevision }) {
      const job = read();
      if (!job || job.id !== id || job.configRevision !== expectedConfigRevision) throw Object.assign(new Error('Fictional Cron revision conflict'), { code: 'conflict' });
      return save({ ...job, ...patch });
    }
  };
}

export const interruptedSettingsInput = Object.freeze({ schemaVersion: 1, logicalOperationId: '71111111-1111-4111-8111-111111111111', expectedRevision: 1, settings: { weekday: 3, localTime: '08:15' } });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateDir, phase] = process.argv.slice(2);
  if (!stateDir || !['before-effect', 'after-effect'].includes(phase)) throw new Error('An isolated fixture and exact kill phase are required.');
  if (typeof global.gc !== 'function') throw new Error('The kill-boundary fixture requires explicit GC support.');
  // Root the pending operation in a real external completion source. A forever
  // unresolved, unreferenced Promise can be collected together with its SQLite
  // handle even while an unrelated IPC listener keeps the process alive.
  const pause = async () => {
    await new Promise(resolve => {
      process.once('message', resolve);
      setImmediate(() => { global.gc(); process.send({ phase, gcForced: true }); });
    });
  };
  const cron = durableFictionalCron(stateDir, phase === 'before-effect' ? { beforeEffect: pause } : { afterEffect: pause });
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    await createTopicAnalysisScheduleService({ metadata, getCron: () => cron, now: () => Date.parse('2026-08-23T06:59:00Z') }).update(interruptedSettingsInput);
    throw new Error('The fixture must be killed at its external Cron boundary.');
  } finally { metadata.close(); }
}
