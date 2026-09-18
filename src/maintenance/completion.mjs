import { createHash } from 'node:crypto';
import { sourceError, nonBlank } from '../sources/errors.mjs';

const KIND = 'notes.maintenance.completion';
const RUN_CONTEXT = 'command-center-topic-note-maintenance';
const WORKING_NOTE_TOOL = 'command_center_update_working_note';

function stableId(...parts) { return createHash('sha256').update(parts.join('\0')).digest('hex'); }

function isSettledCompletion(event) {
  return event?.stream === 'lifecycle'
    && event?.data?.phase === 'end'
    && event?.data?.executionSettled === true
    && event?.data?.aborted !== true
    && typeof event?.runId === 'string' && event.runId.trim() !== ''
    && typeof event?.sessionKey === 'string' && event.sessionKey.trim() !== ''
    && typeof event?.sessionId === 'string' && event.sessionId.trim() !== '';
}

function verifiedWorkingNoteResult(event) {
  if (event?.data?.isError !== false) return false;
  const result = event?.data?.result;
  const details = result?.details ?? result?.value ?? result;
  return details?.status === 'applied' || details?.status === 'reconciled';
}

/**
 * Owns the durable conversion of an exact native Conversation completion into
 * one Topic-level catch-up request.  It deliberately does not inspect message
 * text, names, sidebar groups, or timing.  The host's cron run id is the only
 * provenance used to suppress the catch-up turn that Command Center created.
 */
export class TopicMaintenanceCompletion {
  constructor({ sourceService, metadata, maintenanceSchedule, now = () => new Date().toISOString() } = {}) {
    if (!sourceService || !metadata || !maintenanceSchedule) throw new TypeError('Native completion maintenance requires source, metadata and scheduling owners.');
    this.sourceService = sourceService; this.metadata = metadata; this.maintenanceSchedule = maintenanceSchedule; this.now = now;
  }

  async handle(event, { workingNoteApplied = false } = {}) {
    if (!isSettledCompletion(event)) return Object.freeze({ status: 'ignored', reason: 'not-an-exact-settled-completion' });
    const binding = await this.sourceService.sessionTopicContext({ sessionKey: event.sessionKey });
    if (binding.status !== 'bound' || binding.sessionKey !== event.sessionKey || binding.sessionId !== event.sessionId) {
      return Object.freeze({ status: 'ignored', reason: 'conversation-binding-not-exact' });
    }
    const logicalOperationId = `notes.maintenance.completion:${stableId(binding.topicId, binding.referenceId, binding.sessionId, event.runId)}`;
    const intent = Object.freeze({ version: 1, topicId: binding.topicId, referenceId: binding.referenceId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, runId: event.runId });
    const prior = this.metadata.getTopicOperation?.(logicalOperationId);
    if (prior?.intent && JSON.stringify(prior.intent) !== JSON.stringify(intent)) throw sourceError('intent-mismatch', 'Native completion identity changed.');
    if (prior?.state === 'applied') return Object.freeze({ schemaVersion: 1, status: 'replayed', logicalOperationId, result: prior.result ?? null });
    const createdAt = prior?.createdAt ?? this.now();
    this.metadata.recordTopicOperation({ logicalOperationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'pending', currentStep: 'completion-recorded', result: prior?.result, createdAt, updatedAt: this.now() });
    if (this.maintenanceSchedule.isScheduledMaintenanceRun({ topicId: binding.topicId, runId: event.runId })) {
      const result = Object.freeze({ disposition: 'maintenance-turn', topicId: binding.topicId, referenceId: binding.referenceId, sessionId: binding.sessionId });
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'applied', currentStep: 'maintenance-turn-ignored', result, createdAt, updatedAt: this.now() });
      return Object.freeze({ schemaVersion: 1, status: 'ignored-maintenance-turn', logicalOperationId, result });
    }
    if (workingNoteApplied) {
      const result = Object.freeze({ disposition: 'working-note-maintained', topicId: binding.topicId, referenceId: binding.referenceId, sessionId: binding.sessionId });
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'applied', currentStep: 'working-note-maintenance-observed', result, createdAt, updatedAt: this.now() });
      return Object.freeze({ schemaVersion: 1, status: 'ignored-working-note-maintained', logicalOperationId, result });
    }
    const scheduled = await this.maintenanceSchedule.schedule({ sessionKey: binding.sessionKey, reason: 'a completed native Conversation turn' });
    const result = Object.freeze({ disposition: 'scheduled', topicId: binding.topicId, referenceId: binding.referenceId, sessionId: binding.sessionId, schedule: scheduled });
    this.metadata.recordTopicOperation({ logicalOperationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'applied', currentStep: 'catch-up-scheduled', result, createdAt, updatedAt: this.now() });
    return Object.freeze({ schemaVersion: 1, status: 'scheduled', logicalOperationId, result });
  }
}

export function createTopicMaintenanceCompletion(options) { return new TopicMaintenanceCompletion(options); }

export function createTopicMaintenanceCompletionSubscription({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Native completion maintenance requires authoritative source owners.');
  return Object.freeze({
    id: 'command-center-topic-note-maintenance-completion',
    description: 'Schedules one exact Topic Note catch-up after a settled native Conversation completion.',
    streams: Object.freeze(['lifecycle', 'tool']),
    async handle(event, ctx = {}) {
      if (event?.stream === 'tool') {
        // A transport-level non-error is not a saved Note. The owner exposes
        // conflicts/unknown outcomes as ordinary tool results, so only its
        // verified durable outcome may suppress the terminal catch-up.
        if (event?.data?.phase === 'result'
          && event?.data?.name === WORKING_NOTE_TOOL
          && verifiedWorkingNoteResult(event)
          && typeof ctx.setRunContext === 'function') {
          ctx.setRunContext(RUN_CONTEXT, { workingNoteApplied: true });
        }
        return;
      }
      const { sourceService, metadata, maintenanceSchedule } = getOwners() ?? {};
      if (!sourceService || !metadata || !maintenanceSchedule) return;
      const runContext = typeof ctx.getRunContext === 'function' ? ctx.getRunContext(RUN_CONTEXT) : undefined;
      await createTopicMaintenanceCompletion({ sourceService, metadata, maintenanceSchedule }).handle(event, {
        workingNoteApplied: runContext?.workingNoteApplied === true
      });
    }
  });
}
