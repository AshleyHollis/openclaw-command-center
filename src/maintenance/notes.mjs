import { randomUUID } from 'node:crypto';
import { sourceError, nonBlank } from '../sources/errors.mjs';
import { normalizeNotePath } from '../sources/note-path.mjs';

export class NoteMaintenanceService {
  constructor({ sourceService, notes, metadata, coordinator, now } = {}) {
    this.sourceService = sourceService;
    this.notes = notes;
    this.metadata = metadata;
    this.coordinator = coordinator;
    this.now = now ?? (() => new Date().toISOString());
  }

  async run(input = {}) {
    const logicalOperationId = input.logicalOperationId ?? randomUUID();
    const requestId = input.requestId ?? logicalOperationId;
    let result;
    let outcome = 'applied';
    let observedRevision = null;
    try {
      await this.assertExactNoteOwnership(input, logicalOperationId);
      const execute = () => this.sourceService
        ? this.sourceService.notesEdit({ ...input, logicalOperationId, requestId })
        : this.notes.edit({ ...input, logicalOperationId, requestId });
      result = this.sourceService
        ? await execute()
        : this.coordinator
        ? await this.coordinator.mutate({
          operationKind: 'notes.maintenance',
          requestId,
          logicalOperationId,
          intent: { path: input.path ?? input.notePath, text: input.text ?? input.content, expectedRevision: input.expectedRevision },
          execute,
          reconcile: async () => {
            try {
              const current = await this.notes.read({ path: input.path ?? input.notePath });
              return current.text === (input.text ?? input.content) ? { matched: true, value: current } : { matched: false };
            } catch { return { matched: false }; }
          }
        })
        : await execute();
      outcome = result.status === 'reconciled' ? 'applied' : result.status ?? 'applied';
      observedRevision = result.value?.revision ?? result.note?.revision ?? null;
    } catch (error) {
      outcome = error?.code === 'conflict' ? 'conflict' : 'unknown';
      observedRevision = error?.currentRevision ?? null;
      result = { schemaVersion: 1, status: outcome, error: { code: error?.code ?? 'unknown', message: error?.message ?? String(error) } };
    }
    const activity = this.metadata?.recordActivity?.({
      activityId: `maintenance:${logicalOperationId}`,
      topicId: input.topicId,
      logicalOperationId,
      transportRequestId: requestId,
      operationKind: 'notes.maintenance',
      outcome,
      observedRevision,
      createdAt: this.now(),
      updatedAt: this.now()
    });
    return Object.freeze({ ...result, activity });
  }

  async assertExactNoteOwnership(input, logicalOperationId) {
    const topicId = nonBlank(input.topicId, 'topicId');
    const referenceId = nonBlank(input.referenceId ?? input.noteReferenceId, 'noteReferenceId');
    const notePath = normalizeNotePath(input.path ?? input.notePath);
    const expectedRevision = nonBlank(input.expectedRevision, 'expectedRevision');
    const reference = this.metadata?.getSourceReference?.(referenceId);
    if (!reference || reference.topicId !== topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note') {
      throw sourceError('source-recovery', 'Maintenance requires an exact Topic-owned Obsidian Note Source Reference.');
    }
    const replayApplied = this.metadata?.getOperation?.(logicalOperationId)?.state === 'applied';
    if (reference.observedRevision !== expectedRevision && !replayApplied) throw sourceError('conflict', 'The maintenance Note Source Reference revision is stale.', { currentRevision: reference.observedRevision, expectedRevision });
    const current = this.sourceService?.notesRead
      ? await this.sourceService.notesRead({ topicId, referenceId, path: notePath })
      : await this.notes?.read?.({ path: notePath });
    if (!current || current.path !== notePath || (!replayApplied && current.revision !== expectedRevision) || current.sourceReference?.referenceId !== reference.referenceId || current.sourceReference?.externalSourceId !== reference.externalSourceId) {
      throw sourceError('conflict', 'The authoritative Note identity or revision changed before maintenance.', { currentRevision: current?.revision ?? null, expectedRevision });
    }
    return reference;
  }
}

export function createNoteMaintenanceService(options) {
  return new NoteMaintenanceService(options);
}
