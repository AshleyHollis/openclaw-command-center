import { sourceError } from './errors.mjs';

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('invalid-request', `${field} must be an object`);
  return value;
}

function closed(value, allowed, field) {
  object(value, field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw sourceError('invalid-request', `Unsupported ${field} field: ${key}`);
  return value;
}

function nonBlankString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw sourceError('invalid-request', `${field} must be a non-blank string`);
}

export function validateSchedule(value) {
  const schedule = object(value, 'schedule');
  if (schedule.kind === 'at') {
    closed(schedule, ['kind', 'at'], 'schedule');
    nonBlankString(schedule.at, 'schedule.at');
  } else if (schedule.kind === 'every') {
    closed(schedule, ['kind', 'everyMs', 'anchorMs'], 'schedule');
    if (!Number.isInteger(schedule.everyMs) || schedule.everyMs < 1) throw sourceError('invalid-request', 'schedule.everyMs must be a positive integer');
    if (schedule.anchorMs !== undefined && (!Number.isInteger(schedule.anchorMs) || schedule.anchorMs < 0)) throw sourceError('invalid-request', 'schedule.anchorMs must be a non-negative integer');
  } else if (schedule.kind === 'cron') {
    closed(schedule, ['kind', 'expr', 'tz', 'staggerMs'], 'schedule');
    nonBlankString(schedule.expr, 'schedule.expr');
    if (schedule.tz !== undefined && typeof schedule.tz !== 'string') throw sourceError('invalid-request', 'schedule.tz must be a string');
    if (schedule.staggerMs !== undefined && (!Number.isInteger(schedule.staggerMs) || schedule.staggerMs < 0)) throw sourceError('invalid-request', 'schedule.staggerMs must be a non-negative integer');
  } else {
    throw sourceError('invalid-request', 'Unsupported schedule kind');
  }
  return schedule;
}

export function validateSchedulePayload(value, { patch = false } = {}) {
  const payload = closed(value, ['kind', 'text'], 'payload');
  if (payload.kind !== 'systemEvent') throw sourceError('invalid-request', 'Only systemEvent scheduler payloads are supported');
  if (!patch || payload.text !== undefined) nonBlankString(payload.text, 'payload.text');
  return payload;
}

export function validateScheduleDeclaration(value) {
  const declaration = closed(value, ['name', 'description', 'enabled', 'deleteAfterRun', 'schedule', 'payload', 'sessionTarget', 'wakeMode'], 'schedule declaration');
  if (declaration.name !== undefined) nonBlankString(declaration.name, 'declaration.name');
  validateSchedule(declaration.schedule);
  validateSchedulePayload(declaration.payload);
  if (declaration.description !== undefined && typeof declaration.description !== 'string') throw sourceError('invalid-request', 'declaration.description must be a string');
  for (const key of ['enabled', 'deleteAfterRun']) if (declaration[key] !== undefined && typeof declaration[key] !== 'boolean') throw sourceError('invalid-request', `declaration.${key} must be a boolean`);
  if (declaration.sessionTarget !== undefined && !['main', 'isolated'].includes(declaration.sessionTarget)) throw sourceError('invalid-request', 'declaration.sessionTarget is unsupported');
  if (declaration.wakeMode !== undefined && !['now', 'next-heartbeat'].includes(declaration.wakeMode)) throw sourceError('invalid-request', 'declaration.wakeMode is unsupported');
  return declaration;
}

export function validateScheduleUpdatePatch(value) {
  const patch = closed(value, ['name', 'description', 'schedule', 'payload', 'enabled'], 'schedule patch');
  if (Object.keys(patch).length === 0) throw sourceError('invalid-request', 'schedule patch must not be empty');
  if (patch.name !== undefined) nonBlankString(patch.name, 'patch.name');
  if (patch.description !== undefined && typeof patch.description !== 'string') throw sourceError('invalid-request', 'patch.description must be a string');
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw sourceError('invalid-request', 'patch.enabled must be a boolean');
  if (patch.schedule !== undefined) validateSchedule(patch.schedule);
  if (patch.payload !== undefined) validateSchedulePayload(patch.payload, { patch: true });
  return patch;
}
