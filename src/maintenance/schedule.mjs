import { createHash } from 'node:crypto';
import { sourceError, nonBlank } from '../sources/errors.mjs';

const KIND = 'notes.maintenance.schedule';
const TAG_PREFIX = 'command-center-note-maintenance-';
const CATCH_UP_DELAY_MS = 15 * 60 * 1000;

function stableId(...parts) { return createHash('sha256').update(parts.join('\0')).digest('hex'); }

/**
 * Sole owner for native maintenance-turn scheduling.  It has no timer and no
 * broad Cron API: the host owns timing; this owner only records one exact
 * Topic intent and asks the native workflow to run it on that Topic's exact
 * Primary Conversation. Native sidebar groups never establish ownership.
 */
export class TopicMaintenanceSchedule {
  constructor({ sourceService, metadata, scheduleSessionTurn, unscheduleSessionTurnsByTag, now = () => new Date().toISOString() } = {}) {
    if (!sourceService || !metadata || typeof scheduleSessionTurn !== 'function' || typeof unscheduleSessionTurnsByTag !== 'function') throw new TypeError('Topic maintenance scheduling requires native workflow, source and metadata owners.');
    this.sourceService = sourceService; this.metadata = metadata; this.scheduleSessionTurn = scheduleSessionTurn; this.unscheduleSessionTurnsByTag = unscheduleSessionTurnsByTag; this.now = now;
    this.inFlight = new Map();
  }

  async schedule({ sessionKey, reason }) {
    const key = nonBlank(sessionKey, 'sessionKey');
    const binding = await this.sourceService.sessionTopicContext({ sessionKey: key });
    if (binding.status !== 'bound') throw sourceError('source-recovery', 'Automatic Note maintenance requires an exact linked Conversation.');
    const running = this.inFlight.get(binding.topicId);
    if (running) return running;
    // Reserve the Topic, not an individual Conversation. A second meaningful
    // completion from any linked Conversation joins the one pending update.
    const work = this.#schedule({ binding, reason }).finally(() => this.inFlight.delete(binding.topicId));
    this.inFlight.set(binding.topicId, work);
    return work;
  }

  async #schedule({ binding: sourceBinding, reason }) {
    const pendingReason = nonBlank(reason, 'reason');
    const binding = await this.resolvePrimaryBinding(sourceBinding);
    const operationId = `notes.maintenance.schedule:${stableId(binding.topicId)}`;
    const tag = `${TAG_PREFIX}${stableId(binding.topicId).slice(0, 24)}`;
    const intent = { version: 1, topicId: binding.topicId, primaryReferenceId: binding.referenceId, primarySessionKey: binding.sessionKey, primarySessionId: binding.sessionId, tag };
    const prior = this.metadata.getTopicOperation?.(operationId);
    if (prior?.intent && JSON.stringify(prior.intent) !== JSON.stringify(intent)) throw sourceError('intent-mismatch', 'Maintenance scheduling identity changed.');
    const createdAt = prior?.createdAt ?? this.now();
    this.metadata.recordTopicOperation({ logicalOperationId: operationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'pending', currentStep: 'intent-recorded', result: prior?.result, createdAt, updatedAt: this.now() });
    const current = await this.sourceService.sessionTopicContext({ sessionKey: binding.sessionKey });
    if (current.status !== 'bound' || current.topicId !== binding.topicId || current.referenceId !== binding.referenceId || current.sessionId !== binding.sessionId) throw sourceError('source-recovery', 'The Conversation binding changed before maintenance scheduling.');
    // The host cleanup is the authoritative cross-restart reconciliation: a
    // lost scheduling acknowledgement is made safe by removing every prior
    // plugin-owned turn for this exact Conversation/tag before scheduling one
    // replacement.  Never schedule beside a cleanup failure.
    this.metadata.recordTopicOperation({ logicalOperationId: operationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'pending', currentStep: 'cancelling-prior-turn', result: prior?.result, createdAt, updatedAt: this.now() });
    let removed;
    try { removed = await this.unscheduleSessionTurnsByTag({ sessionKey: binding.sessionKey, tag }); }
    catch (error) {
      this.metadata.recordTopicOperation({ logicalOperationId: operationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'unknown', currentStep: 'prior-turn-cancel-unknown', result: { ...(prior?.result ?? {}), error: error?.code ?? 'cleanup-failed' }, createdAt, updatedAt: this.now() });
      throw sourceError('unknown', 'The prior maintenance turn could not be reconciled safely.');
    }
    if (!removed || removed.failed !== 0) {
      this.metadata.recordTopicOperation({ logicalOperationId: operationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'unknown', currentStep: 'prior-turn-cancel-failed', result: { ...(prior?.result ?? {}), cleanup: removed ?? null }, createdAt, updatedAt: this.now() });
      throw sourceError('unknown', 'The prior maintenance turn could not be removed safely.');
    }
    const beforeDispatch = await this.sourceService.sessionTopicContext({ sessionKey: binding.sessionKey });
    if (beforeDispatch.status !== 'bound' || beforeDispatch.topicId !== binding.topicId || beforeDispatch.referenceId !== binding.referenceId || beforeDispatch.sessionId !== binding.sessionId) throw sourceError('source-recovery', 'The Conversation binding changed before maintenance dispatch.');
    let handle;
    try {
      handle = await this.scheduleSessionTurn({ sessionKey: binding.sessionKey, agentId: 'main', delayMs: CATCH_UP_DELAY_MS, deleteAfterRun: true, deliveryMode: 'none', tag,
        name: 'Command Center Note maintenance', message: `Update the saved working Notes for this Topic after ${pendingReason}. Use only exact Topic-owned sources and preserve prior facts, corrections, and open questions. Do not send a user-facing message.` });
    } catch (error) {
      this.metadata.recordTopicOperation({ logicalOperationId: operationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'unknown', currentStep: 'native-turn-schedule-unknown', result: { ...(prior?.result ?? {}), cleanup: removed, error: error?.code ?? 'schedule-failed' }, createdAt, updatedAt: this.now() });
      throw error;
    }
    if (!handle || typeof handle.id !== 'string' || handle.id.trim() === '') throw sourceError('unavailable', 'The native workflow scheduler declined the maintenance turn.');
    // The host's scheduler gives its run a stable `cron:<job-id>:` prefix.
    // Persist that id with the exact primary binding.  The native completion
    // subscriber uses it to distinguish this plugin-owned catch-up turn from
    // an ordinary completed Conversation, without a timing heuristic.
    const result = { topicId: binding.topicId, referenceId: binding.referenceId, sessionId: binding.sessionId, tag, jobId: handle.id, reason: pendingReason };
    this.metadata.recordTopicOperation({ logicalOperationId: operationId, topicId: binding.topicId, operationKind: KIND, intent, state: 'applied', currentStep: 'native-turn-scheduled', result, createdAt, updatedAt: this.now() });
    return Object.freeze({ schemaVersion: 1, status: 'scheduled', logicalOperationId: operationId, ...result });
  }

  isScheduledMaintenanceRun({ topicId, runId }) {
    const id = `notes.maintenance.schedule:${stableId(nonBlank(topicId, 'topicId'))}`;
    const operation = this.metadata.getTopicOperation?.(id);
    const jobId = operation?.result?.jobId;
    return typeof jobId === 'string' && jobId.trim() !== '' && typeof runId === 'string' && runId.startsWith(`cron:${jobId}:`);
  }

  async resolvePrimaryBinding(sourceBinding) {
    const references = this.metadata.listSourceReferences?.(sourceBinding.topicId);
    // Lightweight test fixtures intentionally model one exact linked
    // Conversation only. Production metadata always supplies the durable
    // primary binding, which is the required target for Topic coalescing.
    if (references === undefined) return sourceBinding;
    const candidates = references.filter((reference) => reference.topicId === sourceBinding.topicId && reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session').filter((reference) => {
      const state = this.metadata.getSessionState?.(reference.referenceId);
      return state?.status === 'open' && state.isPrimary === true && typeof state.sessionId === 'string' && state.sessionId.trim() !== '' && typeof reference.externalSourceId === 'string' && reference.externalSourceId.trim() !== '';
    });
    if (candidates.length !== 1) throw sourceError('source-recovery', 'Automatic Note maintenance requires one exact open Primary Conversation.');
    const primary = candidates[0]; const state = this.metadata.getSessionState(primary.referenceId);
    const binding = await this.sourceService.sessionTopicContext({ sessionKey: primary.externalSourceId });
    if (binding.status !== 'bound' || binding.topicId !== sourceBinding.topicId || binding.referenceId !== primary.referenceId || binding.sessionKey !== primary.externalSourceId || binding.sessionId !== state.sessionId) {
      throw sourceError('source-recovery', 'The Topic Primary Conversation changed before maintenance scheduling.');
    }
    return binding;
  }
}

export function createTopicMaintenanceSchedule(options) { return new TopicMaintenanceSchedule(options); }
