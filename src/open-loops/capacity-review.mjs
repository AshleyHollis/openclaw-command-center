import { createHash } from 'node:crypto';
import { createCommitmentCaptureService } from './commitment-capture.mjs';
import { planOrganizationChange } from './capacity-workspace.mjs';
import { sourceError } from '../sources/errors.mjs';

export const CAPACITY_REVIEW_SCHEDULE_KEY = 'command-center:capacity-review:weekly';
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const terminal = new Set(['resolved', 'cancelled']);

function stableUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function assertTimeZone(value) {
  try { new Intl.DateTimeFormat('en-AU', { timeZone: value }).format(); }
  catch { throw sourceError('invalid-request', 'Capacity review timeZone must be a valid IANA timezone.'); }
  return value;
}

export function normalizeCapacityReviewConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('invalid-request', 'Capacity review configuration is invalid.');
  const allowed = ['enabled', 'topicId', 'weekday', 'localTime', 'timeZone'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.enabled !== 'boolean' ||
      typeof value.topicId !== 'string' || !value.topicId.trim() || value.topicId.length > 300 ||
      !Number.isInteger(value.weekday) || value.weekday < 1 || value.weekday > 7 ||
      typeof value.localTime !== 'string' || !TIME.test(value.localTime)) throw sourceError('invalid-request', 'Capacity review configuration is invalid.');
  return Object.freeze({ enabled: value.enabled, topicId: value.topicId.trim(), weekday: value.weekday, localTime: value.localTime, timeZone: assertTimeZone(value.timeZone) });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}
function canonical(value) { return JSON.stringify(canonicalValue(value)); }

function jobFrom(value) { return value?.job ?? value?.result?.job ?? value?.result ?? value; }
function jobsFrom(value) { return value?.jobs ?? value?.result?.jobs ?? value?.result ?? value ?? []; }

export function capacityReviewCronDeclaration(config) {
  const value = normalizeCapacityReviewConfig(config);
  const [hour, minute] = value.localTime.split(':').map(Number);
  return Object.freeze({
    declarationKey: CAPACITY_REVIEW_SCHEDULE_KEY,
    name: 'Command Center weekly capacity review',
    description: 'Surface one quiet grouped review of older optional work.',
    enabled: value.enabled,
    schedule: { kind: 'cron', expr: `${minute} ${hour} * * ${value.weekday}`, tz: value.timeZone, staggerMs: 0 },
    sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Call command_center_open_capacity_review exactly once. Do not send a message.', toolsAllow: ['command_center_open_capacity_review'] },
    delivery: { mode: 'none' }
  });
}

function localWeekKey(now, timeZone) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const weekday = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 })[fields.weekday];
  const local = new Date(Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day)) - weekday * 86_400_000);
  return local.toISOString().slice(0, 10);
}

function schedulerOwner({ scheduler, gateway }) {
  if (scheduler?.list && scheduler?.add && scheduler?.update) return scheduler;
  if (gateway?.request) return Object.freeze({
    list: (options) => gateway.request('cron.list', options),
    add: (input) => gateway.request('cron.add', input, { requestId: stableUuid(`${CAPACITY_REVIEW_SCHEDULE_KEY}:create`) }),
    update: (id, patch, expectedConfigRevision) => gateway.request('cron.update', { id, expectedConfigRevision, patch }, { requestId: stableUuid(`${CAPACITY_REVIEW_SCHEDULE_KEY}:update:${expectedConfigRevision}`) })
  });
  throw new TypeError('Capacity review requires metadata and native Scheduler ownership.');
}

export function createCapacityReviewService({ metadata, sourceService, scheduler, gateway, config, now = () => new Date().toISOString(), captureService } = {}) {
  if (!metadata) throw new TypeError('Capacity review requires metadata and native Scheduler ownership.');
  const cron = schedulerOwner({ scheduler, gateway });
  const settings = normalizeCapacityReviewConfig(config);
  const capture = captureService ?? createCommitmentCaptureService({ metadata, sourceService });

  async function reconcileSchedule() {
    const declaration = capacityReviewCronDeclaration(settings);
    const listed = jobsFrom(await cron.list({ includeDisabled: true }));
    const owned = Array.isArray(listed) ? listed.filter(job => job?.declarationKey === CAPACITY_REVIEW_SCHEDULE_KEY) : [];
    if (owned.length > 1) throw sourceError('conflict', 'Duplicate Command Center capacity review schedules were found.');
    let job = owned[0];
    if (!job) {
      const created = jobFrom(await cron.add(declaration));
      const verified = jobsFrom(await cron.list({ includeDisabled: true }));
      job = Array.isArray(verified) ? verified.find(candidate => candidate?.declarationKey === CAPACITY_REVIEW_SCHEDULE_KEY || created?.id && candidate?.id === created.id) : undefined;
    }
    if (!job?.id || job.declarationKey !== CAPACITY_REVIEW_SCHEDULE_KEY || typeof job.configRevision !== 'string' || !job.configRevision.trim()) throw sourceError('source-recovery', 'Capacity review schedule identity was not verified.');
    const expected = { name: declaration.name, description: declaration.description, enabled: declaration.enabled, schedule: declaration.schedule, sessionTarget: declaration.sessionTarget, wakeMode: declaration.wakeMode, payload: declaration.payload, delivery: declaration.delivery };
    const actual = Object.fromEntries(Object.keys(expected).map(key => [key, job[key]]));
    if (canonical(expected) !== canonical(actual)) {
      await cron.update(job.id, expected, job.configRevision);
      const verified = jobsFrom(await cron.list({ includeDisabled: true }));
      job = Array.isArray(verified) ? verified.find(candidate => candidate?.id === job.id) : undefined;
    }
    const observed = Object.fromEntries(Object.keys(expected).map(key => [key, job?.[key]]));
    if (!job?.id || job.declarationKey !== CAPACITY_REVIEW_SCHEDULE_KEY || canonical(expected) !== canonical(observed)) throw sourceError('source-recovery', 'Capacity review schedule was not fully verified after reconciliation.');
    return Object.freeze({ declaration, job });
  }

  async function wake() {
    if (!settings.enabled) return Object.freeze({ schemaVersion: 1, outcome: 'disabled' });
    const topic = metadata.getTopic?.(settings.topicId);
    if (!topic || topic.lifecycle !== 'active') throw sourceError('source-recovery', 'Capacity review requires its exact active Topic.');
    const observedAt = new Date(now()).toISOString();
    const cycle = localWeekKey(observedAt, settings.timeZone);
    const logicalOperationId = stableUuid(`${CAPACITY_REVIEW_SCHEDULE_KEY}:capture:${settings.topicId}:${cycle}`);
    let result = await capture.capture({
      schemaVersion: 1, logicalOperationId, sourceKind: 'manual',
      sourceExternalId: CAPACITY_REVIEW_SCHEDULE_KEY, sourceVersion: `week:${cycle}`,
      topicId: settings.topicId, title: 'Review older tasks when you have capacity', obligationId: 'capacity-backlog-review',
      provenance: 'explicit', occurredAt: observedAt, observedAt, historicalBaseline: false, reviewAt: observedAt,
      importance: 'low', importanceOrigin: 'processing', contexts: [], dependencies: []
    });
    if (terminal.has(result.loop?.state)) {
      const reopened = planOrganizationChange(result.loop, { schemaVersion: 1, action: 'reopen', updatedAt: observedAt });
      result = metadata.reconcileOpenLoop({ schemaVersion: 1, logicalOperationId: stableUuid(`${CAPACITY_REVIEW_SCHEDULE_KEY}:reopen:${settings.topicId}:${cycle}`), expectedRevision: result.loop.revision, loop: reopened, evidenceRoles: {}, updatedAt: observedAt });
    }
    return Object.freeze({ schemaVersion: 1, outcome: result.disposition === 'duplicate' ? 'already-open' : 'opened', cycle, loopId: result.loop.loopId, state: result.loop.state });
  }

  return Object.freeze({ settings, reconcileSchedule, wake });
}
