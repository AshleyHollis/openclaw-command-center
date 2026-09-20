import { createHash } from 'node:crypto';
import { createCommitmentCaptureService } from './commitment-capture.mjs';
import { recordIntakeReceipt } from './intake-receipt.mjs';
import { sourceError } from '../sources/errors.mjs';

function sourceCaptureOperationId(params) {
  const hex = createHash('sha256').update(['command-center.source-capture.v1', params.sourceKind, params.sourceExternalId, params.sourceVersion, params.obligationId].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sourceNoteOperationId(params) {
  const hex = createHash('sha256').update(['command-center.source-note.v1', params.topicId, params.sourceKind, params.sourceExternalId, params.sourceVersion].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sourceNoteCaptureToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Source Note capture requires authoritative owners.');
  return () => ({
    name: 'command_center_save_source_note',
    description: 'Save one new quiet Topic Note from a maintained email or Note producer and return its exact Source Reference. This does not create an obligation or edit an existing Note.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      topicId: { type: 'string', minLength: 1 }, noteFolderReferenceId: { type: 'string', minLength: 1 }, sourceKind: { type: 'string', enum: ['email', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, markdown: { type: 'string', minLength: 1 }
    }, required: ['topicId', 'noteFolderReferenceId', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'path', 'markdown'] }),
    async execute(_toolCallId, params) {
      const { sourceService } = getOwners() ?? {};
      if (!sourceService) throw sourceError('capability-unavailable', 'Source Note ownership is not ready.');
      const logicalOperationId = sourceNoteOperationId(params);
      const result = await sourceService.notesCreate({ schemaVersion: 1, topicId: params.topicId, referenceId: params.noteFolderReferenceId, path: params.path, text: params.markdown, sourceKind: 'note', logicalOperationId, requestId: logicalOperationId });
      const note = result?.value?.note ?? result?.note;
      const sourceReference = note?.sourceReference;
      if (!sourceReference || sourceReference.topicId !== params.topicId || sourceReference.sourceKind !== 'note') throw sourceError('unknown', 'The saved Source Note did not return its exact Topic-owned Source Reference.');
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.status, sourceReferenceId: sourceReference.referenceId, revision: note.revision, path: note.path }) }], details: Object.freeze({ logicalOperationId, result, note, sourceReference }) });
    }
  });
}

export function sourceCommitmentCaptureToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Source commitment capture requires authoritative owners.');
  return () => ({
    name: 'command_center_capture_source_commitment',
    description: 'Capture one obligation or bounded suggestion from a maintained email or Note producer after it has created an exact Topic Note reference. Do not call for informational knowledge with no unresolved action.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      topicId: { type: 'string', minLength: 1 }, sourceKind: { type: 'string', enum: ['email', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }, sourceReferenceId: { type: 'string', minLength: 1 }, sourcePath: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 }, obligationId: { type: 'string', minLength: 1 }, provenance: { type: 'string', enum: ['explicit', 'inferred', 'idea', 'quoted'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      dueAt: { type: 'string' }, reviewAt: { type: 'string' }, plannedAt: { type: 'string' }, importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'] }, importanceOrigin: { type: 'string', enum: ['source', 'processing'] }, effortMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, contexts: { type: 'array', items: { type: 'string' }, maxItems: 8 }, dependencies: { type: 'array', items: { type: 'string' }, maxItems: 16 }
    }, required: ['topicId', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'sourceReferenceId', 'sourcePath', 'title', 'obligationId', 'provenance'] }),
    async execute(_toolCallId, params) {
      const { sourceService, metadata } = getOwners() ?? {};
      if (!sourceService || !metadata) throw sourceError('capability-unavailable', 'Source capture ownership is not ready.');
      const capture = createCommitmentCaptureService({ metadata, sourceService });
      const observedAt = new Date().toISOString();
      const result = await capture.capture({ schemaVersion: 1, logicalOperationId: sourceCaptureOperationId(params), ...params, occurredAt: observedAt, observedAt, historicalBaseline: false });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, loopId: result.loop?.loopId, state: result.loop?.state }) }], details: result });
    }
  });
}

export function intakeReceiptToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Intake receipts require authoritative owners.');
  return () => ({
    name: 'command_center_record_intake_receipt',
    description: 'Record a content-free maintained email or Note processing checkpoint for Command Center intake health.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      sourceKind: { type: 'string', enum: ['email', 'note'] }, runId: { type: 'string', minLength: 1 }, checkpoint: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['healthy-empty', 'healthy-processed', 'pending', 'failed', 'never-connected'] }, observedAt: { type: 'string' }, lastSuccessfulAt: { type: 'string' }, nextExpectedAt: { type: 'string' }, processedCount: { type: 'integer', minimum: 0 }, actionableCount: { type: 'integer', minimum: 0 }, noteCount: { type: 'integer', minimum: 0 }
    }, required: ['sourceKind', 'runId', 'checkpoint', 'status', 'observedAt', 'processedCount', 'actionableCount', 'noteCount'] }),
    async execute(_toolCallId, params) {
      const { metadata } = getOwners() ?? {};
      if (!metadata) throw sourceError('capability-unavailable', 'Intake receipt ownership is not ready.');
      const result = recordIntakeReceipt(metadata, { schemaVersion: 1, ...params });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, sourceKind: result.receipt.sourceKind, checkpoint: result.receipt.checkpoint }) }], details: result });
    }
  });
}
