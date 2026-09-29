import { createHash } from 'node:crypto';

export const DEVELOPER_WORK_RETRY_SCHEDULE_KEY = 'command-center:developer-work:outbox-retry';

function stableUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}`;
}

export function developerWorkRetryDeclaration() {
  return Object.freeze({
    declarationKey: DEVELOPER_WORK_RETRY_SCHEDULE_KEY,
    name: 'Command Center DEV work delivery retry',
    description: 'Retry bounded durable DEV work deliveries to the configured LIVE receiver.',
    enabled: true,
    schedule: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC', staggerMs: 0 },
    sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Call command_center_flush_developer_work exactly once. Do not send a message.', toolsAllow: ['command_center_flush_developer_work'] },
    delivery: { mode: 'none' }
  });
}

const jobsFrom = value => value?.jobs ?? value?.result?.jobs ?? value?.result ?? value ?? [];
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, Array.isArray(item) ? item : item && typeof item === 'object' ? JSON.parse(canonical(item)) : item]))
  : value);

function schedulerOwner({ scheduler, gateway }) {
  if (scheduler?.list && scheduler?.add && scheduler?.update) return Object.freeze({
    requiresRevision: false,
    list: scheduler.list.bind(scheduler), add: scheduler.add.bind(scheduler), update: scheduler.update.bind(scheduler)
  });
  if (gateway?.request) return Object.freeze({
    requiresRevision: true,
    list: options => gateway.request('cron.list', options),
    add: input => gateway.request('cron.add', input, { requestId: stableUuid(`${DEVELOPER_WORK_RETRY_SCHEDULE_KEY}:create`) }),
    update: (id, patch, expectedConfigRevision) => gateway.request('cron.update', { id, expectedConfigRevision, patch }, { requestId: stableUuid(`${DEVELOPER_WORK_RETRY_SCHEDULE_KEY}:update:${expectedConfigRevision}`) })
  });
  throw new TypeError('DEV Developer Work retry requires the native Cron service.');
}

export async function reconcileDeveloperWorkRetrySchedule({ scheduler, gateway } = {}) {
  const cron = schedulerOwner({ scheduler, gateway });
  const declaration = developerWorkRetryDeclaration();
  const listed = jobsFrom(await cron.list({ includeDisabled: true }));
  const owned = Array.isArray(listed) ? listed.filter(job => job?.declarationKey === DEVELOPER_WORK_RETRY_SCHEDULE_KEY) : [];
  if (owned.length > 1) throw Object.assign(new Error('Duplicate DEV work retry schedules were found.'), { code: 'conflict' });
  let job = owned[0];
  if (!job) {
    await cron.add(declaration);
    const verified = jobsFrom(await cron.list({ includeDisabled: true }));
    job = Array.isArray(verified) ? verified.find(candidate => candidate?.declarationKey === DEVELOPER_WORK_RETRY_SCHEDULE_KEY) : undefined;
  }
  if (!job?.id || job.declarationKey !== DEVELOPER_WORK_RETRY_SCHEDULE_KEY || cron.requiresRevision && !job.configRevision) throw Object.assign(new Error('DEV work retry schedule identity was not verified.'), { code: 'source-recovery' });
  const expected = Object.fromEntries(['name', 'description', 'enabled', 'schedule', 'sessionTarget', 'wakeMode', 'payload', 'delivery'].map(key => [key, declaration[key]]));
  const actual = Object.fromEntries(Object.keys(expected).map(key => [key, job[key]]));
  if (canonical(expected) !== canonical(actual)) {
    await cron.update(job.id, expected, job.configRevision);
    const verified = jobsFrom(await cron.list({ includeDisabled: true }));
    job = Array.isArray(verified) ? verified.find(candidate => candidate?.id === job.id && candidate.declarationKey === DEVELOPER_WORK_RETRY_SCHEDULE_KEY) : undefined;
  }
  const observed = Object.fromEntries(Object.keys(expected).map(key => [key, job?.[key]]));
  if (!job?.id || canonical(expected) !== canonical(observed)) throw Object.assign(new Error('DEV work retry schedule was not fully verified.'), { code: 'source-recovery' });
  return Object.freeze({ declaration, job });
}
