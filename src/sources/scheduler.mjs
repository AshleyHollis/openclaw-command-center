import { sourceError, assertNoUnexpectedKeys, nonBlank } from './errors.mjs';
import { createSourceReference, intentDigest } from './reference.mjs';
import { assertLogicalOperationId } from './operation-journal.mjs';
import { createMutationCoordinator } from './mutation-coordinator.mjs';
import { validateScheduleDeclaration, validateScheduleUpdatePatch } from './scheduler-input.mjs';

function jobFrom(value) {
  return value?.job ?? value?.payload?.job ?? value;
}

function jobsFrom(value) {
  return Array.isArray(value) ? value : value?.jobs ?? value?.items ?? [];
}

function runsFrom(value) {
  return Array.isArray(value) ? value : value?.entries ?? value?.runs ?? value?.items ?? [];
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function closedSchedulePatch(value, operationKind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw sourceError('invalid-request', `${operationKind} patch must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'schedule') throw sourceError('invalid-request', `${operationKind} supports only the schedule patch field`);
  if (!value.schedule || typeof value.schedule !== 'object' || Array.isArray(value.schedule)) throw sourceError('invalid-request', 'schedule must be an object');
  return { schedule: value.schedule };
}

const creationLocks = new WeakMap();

async function withCreationLock(owner, referenceId, run) {
  let locks = creationLocks.get(owner);
  if (!locks) {
    locks = new Map();
    creationLocks.set(owner, locks);
  }
  const previous = locks.get(referenceId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(referenceId, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(referenceId) === tail) locks.delete(referenceId);
  }
}

export class SchedulerAdapter {
  constructor({ api, gateway, metadata, topicId, coordinator, now } = {}) {
    this.gateway = gateway ?? api?.runtime?.gateway;
    if (!this.gateway?.request) throw sourceError('capability-unavailable', 'The scheduler gateway capability is unavailable.', { capability: 'scheduler' });
    this.metadata = metadata;
    this.topicId = nonBlank(topicId, 'topicId');
    this.coordinator = coordinator ?? createMutationCoordinator();
    this.now = now ?? (() => new Date().toISOString());
  }

  references() {
    return (this.metadata?.listSourceReferences?.(this.topicId) ?? []).filter((reference) => reference.sourceSystem === 'scheduler' && ['schedule', 'reminder_schedule'].includes(reference.sourceKind));
  }

  allReferences() {
    return (this.metadata?.listSourceReferences?.() ?? []).filter((reference) => reference.sourceSystem === 'scheduler' && ['schedule', 'reminder_schedule'].includes(reference.sourceKind));
  }

  resolveReference(input) {
    const referenceId = typeof input === 'string' ? input : input?.referenceId ?? input?.scheduleReferenceId;
    nonBlank(referenceId, 'scheduleReferenceId');
    const matches = this.references().filter((reference) => reference.referenceId === referenceId);
    if (matches.length !== 1) throw sourceError('source-recovery', 'The exact linked scheduler Source Reference was not found in this Topic.');
    return matches[0];
  }

  async request(method, params, options) {
    return this.gateway.request(method, params, options);
  }

  async read(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'scheduleReferenceId', 'requestId'], 'Schedule read request');
    const reference = this.resolveReference(input);
    const result = jobFrom(await this.request('cron.get', { id: reference.externalSourceId }));
    if (!result || result.id !== reference.externalSourceId) throw sourceError('source-recovery', 'The exact scheduler job was not found.');
    const observed = result.configRevision ?? reference.observedRevision;
    if (observed === null) throw sourceError('source-recovery', 'The scheduler omitted its authoritative configuration revision.');
    if (this.metadata?.observeSourceReference) this.metadata.observeSourceReference({ referenceId: reference.referenceId, observedRevision: observed, updatedAt: this.now() });
    return Object.freeze({ schemaVersion: 1, sourceReference: { ...reference, observedRevision: observed }, job: { ...result, configRevision: observed } });
  }

  async list(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'requestId'], 'Schedule list request');
    const rows = jobsFrom(await this.request('cron.list', { includeDisabled: true }));
    const references = new Map(this.references().map((reference) => [reference.externalSourceId, reference]));
    const owned = [];
    for (const job of rows) {
      const reference = references.get(job?.id);
      if (!reference) continue;
      const observedRevision = job.configRevision ?? reference.observedRevision;
      if (observedRevision === null) throw sourceError('source-recovery', 'The scheduler omitted its authoritative configuration revision.');
      const sourceReference = this.metadata?.observeSourceReference
        ? this.metadata.observeSourceReference({ referenceId: reference.referenceId, observedRevision, updatedAt: this.now() })
        : { ...reference, observedRevision };
      owned.push(Object.freeze({ schemaVersion: 1, sourceReference, job }));
    }
    return Object.freeze(owned);
  }

  async create(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'requestId', 'referenceId', 'logicalOperationId', 'declaration'], 'Schedule create request');
    return this.createDeclared(input, 'schedule', 'schedules.create');
  }

  async createReminder(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'requestId', 'logicalOperationId', 'declaration'], 'Reminder create request');
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    validateScheduleDeclaration(input.declaration);
    const declarationKey = `command-center:reminder:${logicalOperationId}`;
    const declaration = { ...input.declaration, declarationKey };
    const execute = async ({ requestId }) => {
      const result = jobFrom(await this.request('cron.add', declaration, { requestId }));
      if (!result?.id) throw sourceError('unavailable', 'cron.add returned no scheduler job id.');
      const reference = await this.persistReference(result.id, result.configRevision ?? null, 'reminder_schedule');
      return { job: result, sourceReference: reference };
    };
    const reconcile = async () => {
      const rows = jobsFrom(await this.request('cron.list', { includeDisabled: true }));
      const matches = rows.filter((job) => job.declarationKey === declarationKey);
      if (matches.length !== 1) return { matched: false };
      const reference = await this.persistReference(matches[0].id, matches[0].configRevision ?? null, 'reminder_schedule');
      return { matched: true, value: { job: matches[0], sourceReference: reference } };
    };
    if (this.coordinator) return this.coordinator.mutate({ operationKind: 'reminders.create', requestId: input.requestId ?? logicalOperationId, logicalOperationId, intent: { declarationKey, declaration }, idempotent: true, execute, reconcile });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: await execute({ requestId: input.requestId ?? logicalOperationId }) };
  }

  async createDeclared(input, sourceKind, operationKind) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const referenceId = nonBlank(input.referenceId, 'referenceId');
    validateScheduleDeclaration(input.declaration);
    const declarationKey = `command-center:${sourceKind}:${logicalOperationId}`;
    const requestedEnabled = input.declaration.enabled ?? true;
    const declaration = { ...input.declaration, enabled: false, declarationKey };
    const execute = async ({ requestId }) => {
      if (this.metadata?.getSourceReference?.(referenceId) || this.references().some((reference) => reference.referenceId === referenceId)) throw sourceError('conflict', 'The requested scheduler Source Reference identity is already bound.');
      const existingDeclarations = jobsFrom(await this.request('cron.list', { includeDisabled: true })).filter((job) => job.declarationKey === declarationKey);
      if (existingDeclarations.length !== 0) throw sourceError('conflict', 'The scheduled-operation declaration identity is already bound.');
      const addResult = await this.request('cron.add', declaration, { requestId });
      const result = jobFrom(addResult);
      const createdByRequest = addResult?.created === true;
      if (!result?.id) throw sourceError('unavailable', 'cron.add returned no scheduler job id.');
      if (result.declarationKey !== declarationKey) throw sourceError('source-recovery', 'cron.add returned an unexpected declaration identity.');
      if (result.enabled !== false) throw sourceError('source-recovery', 'cron.add did not create the scheduled operation disabled.');
      if (this.allReferences().some((reference) => reference.externalSourceId === result.id)) throw sourceError('conflict', 'cron.add returned a scheduler identity that is already owned.');
      let sourceReference;
      try {
        sourceReference = await this.persistReference(result.id, result.configRevision ?? null, sourceKind, referenceId);
      } catch (bindingError) {
        if (!createdByRequest) throw bindingError;
        let currentOwners;
        try {
          if (typeof this.metadata?.listSourceReferences !== 'function') throw new Error('global scheduler ownership is unavailable');
          currentOwners = this.allReferences();
        } catch (ownershipError) {
          throw sourceError('unknown', 'Scheduler ownership could not be revalidated before rollback.', { cause: ownershipError });
        }
        if (currentOwners.some((reference) => reference.externalSourceId === result.id)) throw bindingError;
        try {
          const removal = await this.request('cron.remove', { id: result.id }, { requestId });
          if (removal?.removed === false) throw new Error('scheduler declined rollback');
        } catch (cleanupError) {
          throw sourceError('unknown', 'The disabled scheduled operation could not be rolled back after metadata binding failed.', { cause: cleanupError });
        }
        throw bindingError;
      }
      return this.enableBoundSchedule({ job: result, sourceReference, requestedEnabled, requestId });
    };
    const reconcile = async ({ requestId, applied = false } = {}) => {
      const matches = jobsFrom(await this.request('cron.list', { includeDisabled: true })).filter((job) => job.declarationKey === declarationKey);
      if (matches.length !== 1) return { outcome: matches.length === 0 ? 'not-applied' : 'conflict' };
      const job = matches[0];
      const existingBinding = this.metadata?.getSourceReference?.(referenceId)
        ?? this.references().find((reference) => reference.referenceId === referenceId)
        ?? null;
      const externalBinding = this.allReferences().find((reference) => reference.externalSourceId === job.id) ?? null;
      const exactBinding = existingBinding?.topicId === this.topicId
        && existingBinding?.sourceSystem === 'scheduler'
        && existingBinding?.sourceKind === sourceKind
        && existingBinding?.externalSourceId === job.id;
      if ((existingBinding && !exactBinding) || (externalBinding && externalBinding.referenceId !== referenceId)) return { outcome: 'conflict' };
      if (applied && !exactBinding) return { outcome: 'conflict' };
      if (job.enabled === true && (!requestedEnabled || !existingBinding || existingBinding.externalSourceId !== job.id || existingBinding.sourceKind !== sourceKind)) return { outcome: 'conflict' };
      if (job.enabled !== false && job.enabled !== true) return { outcome: 'conflict' };
      const sourceReference = await this.persistReference(job.id, job.configRevision ?? null, sourceKind, referenceId);
      if (applied) return { outcome: 'applied', value: { job, sourceReference } };
      return { outcome: 'applied', value: await this.enableBoundSchedule({ job, sourceReference, requestedEnabled, requestId }) };
    };
    const owner = this.metadata && (typeof this.metadata === 'object' || typeof this.metadata === 'function') ? this.metadata : this;
    return withCreationLock(owner, referenceId, () => this.coordinator.mutate({ operationKind, requestId: input.requestId ?? logicalOperationId, logicalOperationId, topicId: this.topicId, referenceId, intent: { declarationKey, declaration, requestedEnabled }, execute, reconcile }));
  }

  async enableBoundSchedule({ job, sourceReference, requestedEnabled, requestId }) {
    if (!requestedEnabled || job.enabled === true) return { job, sourceReference };
    if (job.enabled !== false) throw sourceError('source-recovery', 'The scheduled operation enabled state is unavailable.');
    const response = jobFrom(await this.request('cron.update', {
      id: job.id,
      expectedConfigRevision: nonBlank(job.configRevision, 'configRevision'),
      patch: { enabled: true }
    }, { requestId }));
    if (!response || response.id !== job.id || response.enabled !== true) throw sourceError('source-recovery', 'cron.update did not enable the exact bound scheduled operation.');
    const observedRevision = nonBlank(response.configRevision, 'configRevision');
    const observedReference = this.metadata?.observeSourceReference
      ? this.metadata.observeSourceReference({ referenceId: sourceReference.referenceId, observedRevision, updatedAt: this.now() })
      : { ...sourceReference, observedRevision };
    return { job: response, sourceReference: observedReference };
  }

  async snooze(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId', 'expectedConfigRevision', 'patch'], 'reminders.snooze request');
    return this.update({ ...input, patch: closedSchedulePatch(input.patch, 'reminders.snooze') }, 'reminders.snooze', 'reminder_schedule');
  }

  async complete(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId', 'expectedConfigRevision'], 'reminders.complete request');
    return this.update({ ...input, patch: { enabled: false } }, 'reminders.complete', 'reminder_schedule');
  }

  async reschedule(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId', 'expectedConfigRevision', 'patch'], 'schedules.reschedule request');
    return this.update({ ...input, patch: closedSchedulePatch(input.patch, 'schedules.reschedule') }, 'schedules.reschedule', 'schedule');
  }

  async updateSchedule(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId', 'expectedConfigRevision', 'patch'], 'schedules.update request');
    validateScheduleUpdatePatch(input.patch);
    return this.update(input, 'schedules.update', 'schedule');
  }

  async setEnabled(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId', 'expectedConfigRevision', 'enabled'], 'schedules.set-enabled request');
    if (typeof input.enabled !== 'boolean') throw sourceError('invalid-request', 'enabled must be a boolean');
    return this.update({ ...input, patch: { enabled: input.enabled } }, 'schedules.set-enabled', 'schedule');
  }

  async run(input = {}) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'topicId', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId'], 'schedules.run request');
    const reference = this.resolveReference(input);
    if (reference.sourceKind !== 'schedule') throw sourceError('invalid-request', 'schedules.run requires an exact schedule Source Reference');
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const execute = async ({ requestId }) => {
      await this.read({ referenceId: reference.referenceId });
      const beforeRunIds = new Set(runsFrom(await this.request('cron.runs', { id: reference.externalSourceId, limit: 50 })).map((entry) => entry?.runId).filter(Boolean));
      const result = await this.request('cron.run', { id: reference.externalSourceId, mode: 'force' }, { requestId });
      if (typeof result?.runId !== 'string' || result.runId.trim() === '') {
        if (result?.ran !== true) return result;
        const newRuns = runsFrom(await this.request('cron.runs', { id: reference.externalSourceId, limit: 50 }))
          .filter((entry) => entry?.jobId === reference.externalSourceId && typeof entry?.runId === 'string' && !beforeRunIds.has(entry.runId));
        if (newRuns.length === 1) return { ...result, runId: newRuns[0].runId };
      }
      return result;
    };
    const reconcile = async ({ resultIdentity } = {}) => {
      if (typeof resultIdentity !== 'string' || resultIdentity.trim() === '') return { outcome: 'unknown' };
      const matches = runsFrom(await this.request('cron.runs', { id: reference.externalSourceId, limit: 50 }))
        .filter((entry) => entry?.jobId === reference.externalSourceId && entry?.runId === resultIdentity);
      return matches.length === 1
        ? { outcome: 'applied', value: { ok: true, ran: true, runId: resultIdentity, status: matches[0].status ?? null } }
        : { outcome: matches.length > 1 ? 'conflict' : 'unknown' };
    };
    return this.coordinator.mutate({ operationKind: 'schedules.run', requestId: input.requestId ?? logicalOperationId, logicalOperationId, intent: { jobId: reference.externalSourceId }, execute, reconcile });
  }

  async update(input, operationKind, expectedSourceKind) {
    assertNoUnexpectedKeys(input, ['schemaVersion', 'referenceId', 'scheduleReferenceId', 'requestId', 'logicalOperationId', 'expectedConfigRevision', 'patch', 'enabled'], `${operationKind} request`);
    const reference = this.resolveReference(input);
    if (reference.sourceKind !== expectedSourceKind) throw sourceError('invalid-request', `${operationKind} requires an exact ${expectedSourceKind} Source Reference`);
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    validateScheduleUpdatePatch(input.patch);
    const current = await this.read({ referenceId: reference.referenceId });
    const expectedConfigRevision = nonBlank(input.expectedConfigRevision ?? current.job.configRevision, 'expectedConfigRevision');
    if (current.job.configRevision !== expectedConfigRevision) throw sourceError('conflict', 'The scheduler configuration revision is stale.', { currentRevision: current.job.configRevision, expectedRevision: expectedConfigRevision });
    const requestParams = { id: reference.externalSourceId, expectedConfigRevision, patch: input.patch };
    const execute = async ({ requestId }) => {
      let response;
      try { response = await this.request('cron.update', requestParams, { requestId }); } catch (error) {
        if (error?.code === 'CRON_JOB_CHANGED' || error?.details?.code === 'CRON_JOB_CHANGED') throw sourceError('conflict', 'The scheduler configuration revision is stale.', { currentRevision: error?.actualConfigRevision ?? error?.details?.actualConfigRevision ?? null, expectedRevision });
        throw error;
      }
      const result = jobFrom(response);
      if (!result || result.id !== reference.externalSourceId) throw sourceError('unavailable', 'cron.update returned an unexpected scheduler job.');
      const observedRevision = typeof result.configRevision === 'string' && result.configRevision.trim() !== '' ? result.configRevision : null;
      if (observedRevision === null) throw sourceError('source-recovery', 'cron.update omitted its authoritative configuration revision.');
      const sourceReference = this.metadata?.observeSourceReference
        ? this.metadata.observeSourceReference({ referenceId: reference.referenceId, observedRevision: observedRevision, updatedAt: this.now() })
        : { ...reference, observedRevision: observedRevision };
      return { job: result, sourceReference };
    };
    const reconcile = async () => {
      const after = await this.read({ referenceId: reference.referenceId });
      const expected = { ...current.job, ...input.patch };
      const matched = Object.entries(input.patch).every(([key, value]) => stable(after.job[key]) === stable(value));
      return matched ? { matched: true, value: after } : { matched: false, expected, actual: after.job };
    };
    if (this.coordinator) return this.coordinator.mutate({ operationKind, requestId: input.requestId ?? logicalOperationId, logicalOperationId, intent: { jobId: reference.externalSourceId, expectedConfigRevision, patch: input.patch }, reconcile, execute });
    return { schemaVersion: 1, status: 'applied', logicalOperationId, value: await execute({ requestId: input.requestId ?? logicalOperationId }) };
  }

  async persistReference(jobId, revision, sourceKind, requestedReferenceId = null) {
    nonBlank(revision, 'configRevision');
    let reference = this.references().find((item) => item.externalSourceId === jobId);
    if (reference && (reference.topicId !== this.topicId || reference.sourceKind !== sourceKind || requestedReferenceId && reference.referenceId !== requestedReferenceId)) {
      throw sourceError('conflict', 'The authoritative scheduler job is already bound to a different Source Reference.');
    }
    if (!reference) {
      reference = createSourceReference({ referenceId: requestedReferenceId ?? `scheduler:${this.topicId}:${jobId}`, topicId: this.topicId, sourceSystem: 'scheduler', sourceKind, externalSourceId: jobId, observedRevision: revision });
      this.metadata?.createSourceReference?.(reference);
    } else if (this.metadata?.observeSourceReference) {
      reference = this.metadata.observeSourceReference({ referenceId: reference.referenceId, observedRevision: revision, updatedAt: this.now() });
    }
    return reference;
  }
}

export function createSchedulerAdapter(options) {
  return new SchedulerAdapter(options);
}
