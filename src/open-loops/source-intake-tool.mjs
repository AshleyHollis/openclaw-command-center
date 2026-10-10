import { createHash } from 'node:crypto';
import { createCommitmentCaptureService, retainCommitmentCaptureTimestamps } from './commitment-capture.mjs';
import { findIntakeContinuation, recordIntakeReceipt } from './intake-receipt.mjs';
import { loadIntakeSourceAccount, recordIntakeOutcome, recordIntakeSourcePlan } from './intake-accounting.mjs';
import { sourceError } from '../sources/errors.mjs';
import { effectiveSourceLocator } from '../sources/reference.mjs';
import { requireAcceptedChatScope } from './accepted-chat-scope.mjs';
import { invokeAcceptedChatCommand } from '../bridge/chat-capture-contracts.mjs';

const paymentIdentitySchema = Object.freeze({ type: 'object', additionalProperties: false, properties: { schemaVersion: { type: 'integer', const: 1 }, amountMinorUnits: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, invoiceId: { type: 'string', minLength: 1, maxLength: 300 }, accountId: { type: 'string', minLength: 1, maxLength: 300 }, payeeId: { type: 'string', minLength: 1, maxLength: 300 }, purpose: { type: 'string', minLength: 1, maxLength: 300 }, predecessor: { type: 'object', additionalProperties: false, properties: { loopId: { type: 'string', minLength: 1, maxLength: 300 }, observationId: { type: 'string', minLength: 1, maxLength: 300 }, explanation: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['loopId', 'observationId', 'explanation'] } }, required: ['schemaVersion'], dependentRequired: { amountMinorUnits: ['currency'], currency: ['amountMinorUnits'] } });

const acceptedObligationSchema = Object.freeze({ type: 'object', additionalProperties: false, properties: {
  obligationId: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, classification: { type: 'string', enum: ['obligation', 'decision'] }, obligationKind: { type: 'string', enum: ['payment'] },
  provenance: { type: 'string', enum: ['explicit', 'inferred', 'idea', 'quoted'] }, correlationNamespace: { type: 'string', minLength: 1 }, correlationId: { type: 'string', minLength: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
  paymentIdentity: paymentIdentitySchema, dueAt: { type: 'string' }, reviewAt: { type: 'string' }, plannedAt: { type: 'string' }, importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'] }, importanceOrigin: { type: 'string', enum: ['source', 'processing'] },
  effortMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, contexts: { type: 'array', items: { type: 'string' }, maxItems: 8 }, dependencies: { type: 'array', items: { type: 'string' }, maxItems: 16 }
}, required: ['obligationId', 'title', 'provenance'] });

const acceptedExtractionSchema = Object.freeze({ type: 'object', additionalProperties: false, properties: {
  schemaVersion: { type: 'integer', const: 1 }, proposedTopic: { type: ['string', 'null'], minLength: 1, maxLength: 200 }, notePath: { type: 'string', maxLength: 1000 }, knowledgeMarkdown: { type: 'string', maxLength: 262144 },
  knowledgeOutcomeId: { type: 'string', minLength: 1 }, knowledgeSummary: { type: 'string', minLength: 1, maxLength: 300 }, obligations: { type: 'array', maxItems: 100, items: acceptedObligationSchema },
  noAction: { type: 'object', additionalProperties: false, properties: { outcomeId: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1, maxLength: 300 } }, required: ['outcomeId', 'summary'] }
}, required: ['schemaVersion', 'notePath', 'knowledgeMarkdown', 'obligations'] });

const chatActions = Object.freeze({ accept: 'Accept', load: 'Load', replay: 'Replay' });

function sourceCaptureOperationId(params) {
  const hex = createHash('sha256').update(['command-center.source-capture.v1', params.sourceKind, params.sourceExternalId, params.sourceVersion, params.obligationId].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sourceNoteOperationId(params) {
  const hex = createHash('sha256').update(['command-center.source-note.v1', params.topicId, params.sourceKind, params.sourceExternalId, params.sourceVersion].join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function resolveSourceTopic({ metadata, sourceService, topicName: requestedTopicName, notePath, expectedNoteRevision } = {}) {
  if (!metadata || typeof metadata.listTopics !== 'function' || typeof metadata.listSourceReferences !== 'function') throw sourceError('capability-unavailable', 'Source Topic ownership is not ready.');
  const topicName = requestedTopicName?.trim();
  if (!topicName || topicName !== requestedTopicName) throw sourceError('invalid-request', 'Source Topic resolution requires one exact canonical Topic name.');
  const candidates = metadata.listTopics().filter(topic => topic.name === topicName && topic.lifecycle === 'active');
  const matches = candidates.flatMap(topic => {
    const folders = metadata.listSourceReferences(topic.topicId).filter(reference => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    return folders.length === 1 ? [{ topicId: topic.topicId, noteFolderReferenceId: folders[0].referenceId, folder: folders[0] }] : [];
  });
  if (matches.length !== 1) return Object.freeze({ status: matches.length > 1 ? 'ambiguous' : 'unresolved' });
  const match = matches[0];
  let evidence;
  if (notePath !== undefined) {
    if (!sourceService || typeof sourceService.notesRead !== 'function') throw sourceError('capability-unavailable', 'Source Note resolution is not ready.');
    const root = effectiveSourceLocator(metadata, match.folder).replace(/[\\/]+$/u, '');
    const externalId = `${root}/${notePath.replace(/\\/gu, '/')}`;
    const references = metadata.listSourceReferences(match.topicId).filter(reference => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note' && effectiveSourceLocator(metadata, reference) === externalId);
    if (references.length === 1 && typeof references[0].observedRevision === 'string' && references[0].observedRevision.trim()) {
      try {
        const note = await sourceService.notesRead({ schemaVersion: 1, topicId: match.topicId, referenceId: references[0].referenceId, observedRevision: references[0].observedRevision, path: notePath });
        const reference = note?.sourceReference;
        if (expectedNoteRevision !== undefined && note.revision !== expectedNoteRevision) throw sourceError('conflict', 'The retained producer Note changed after verification.');
        if (reference?.referenceId === references[0].referenceId && reference.topicId === match.topicId && reference.sourceKind === 'note' && note.revision === references[0].observedRevision) evidence = Object.freeze({ sourceReferenceId: reference.referenceId, revision: note.revision, path: note.path });
      } catch (error) {
        // A producer can retain a verified replacement before Command Center
        // refreshes an older path observation. When the producer supplied the
        // exact retained revision, let the path-pinned read below distinguish
        // that safe refresh from an actual content change.
        const staleObservedRevision = error?.code === 'conflict' && expectedNoteRevision !== undefined;
        if (!staleObservedRevision && !['not-found', 'source-unavailable'].includes(error?.code)) throw error;
      }
    }
    // A maintained producer may have just written and verified the Note before
    // Command Center has observed it. Admit that exact Topic-relative path
    // through the authoritative Note reader, which records the retained Note
    // revision without conflating it with the upstream source revision.
    if (!evidence && references.length <= 1 && expectedNoteRevision !== undefined) {
      try {
        const note = await sourceService.notesRead({ schemaVersion: 1, topicId: match.topicId, path: notePath, observedRevision: expectedNoteRevision });
        const reference = note?.sourceReference;
        if (note.revision !== expectedNoteRevision) throw sourceError('conflict', 'The retained producer Note changed after verification.');
        if (reference?.referenceId && reference.topicId === match.topicId && reference.sourceKind === 'note' && note.revision === reference.observedRevision) evidence = Object.freeze({ sourceReferenceId: reference.referenceId, revision: note.revision, path: note.path });
      } catch (error) {
        if (!['not-found', 'source-unavailable'].includes(error?.code)) throw error;
      }
    }
  }
  return Object.freeze({ status: 'resolved', topicId: match.topicId, noteFolderReferenceId: match.noteFolderReferenceId, ...(evidence ? { evidence } : {}) });
}

export function sourceTopicResolverToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Source Topic resolution requires authoritative owners.');
  return () => ({
    name: 'command_center_resolve_source_topic',
    description: 'Resolve one exact existing active Topic name to its Note Folder reference for maintained intake. An optional Topic-relative Note path also resolves existing Note evidence without returning its content. Missing, unusable, or ambiguous matches stay unresolved. Private folder locators are never returned.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      topicName: { type: 'string', minLength: 1, maxLength: 200 }, notePath: { type: 'string', minLength: 1, maxLength: 1000 }, expectedNoteRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
    }, required: ['topicName'] }),
    async execute(_toolCallId, params) {
      const { metadata, sourceService } = getOwners() ?? {};
      const result = await resolveSourceTopic({ metadata, sourceService, topicName: params.topicName, notePath: params.notePath, expectedNoteRevision: params.expectedNoteRevision });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
    }
  });
}

export function sourceNoteCaptureToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Source Note capture requires authoritative owners.');
  return () => ({
    name: 'command_center_save_source_note',
    description: 'Save one new quiet Topic Note from a maintained email, Chat or Note producer and return its exact Note Source Reference. sourceKind identifies the upstream source, while the created reference remains a Note. This does not create an obligation or edit an existing Note.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      topicId: { type: 'string', minLength: 1 }, noteFolderReferenceId: { type: 'string', minLength: 1 }, sourceKind: { type: 'string', enum: ['email', 'chat', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, markdown: { type: 'string', minLength: 1 }
    }, required: ['topicId', 'noteFolderReferenceId', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'path', 'markdown'] }),
    async execute(_toolCallId, params) {
      const { sourceService } = getOwners() ?? {};
      if (params.sourceKind === 'chat') requireAcceptedChatScope(getOwners()?.metadata);
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
      topicId: { type: 'string', minLength: 1 }, sourceKind: { type: 'string', enum: ['email', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }, sourceReferenceId: { type: 'string', minLength: 1 }, sourcePath: { type: 'string', minLength: 1 }, sourceReferenceVersion: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 }, obligationId: { type: 'string', minLength: 1 }, obligationKind: { type: 'string', enum: ['payment'] }, correlationNamespace: { type: 'string', minLength: 1 }, correlationId: { type: 'string', minLength: 1 }, provenance: { type: 'string', enum: ['explicit', 'inferred', 'idea', 'quoted'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      paymentIdentity: paymentIdentitySchema, dueAt: { type: 'string' }, reviewAt: { type: 'string' }, plannedAt: { type: 'string' }, importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'] }, importanceOrigin: { type: 'string', enum: ['source', 'processing'] }, effortMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, contexts: { type: 'array', items: { type: 'string' }, maxItems: 8 }, dependencies: { type: 'array', items: { type: 'string' }, maxItems: 16 }
    }, required: ['topicId', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'sourceReferenceId', 'sourcePath', 'sourceReferenceVersion', 'title', 'obligationId', 'provenance'] }),
    async execute(_toolCallId, params) {
      const { sourceService, metadata } = getOwners() ?? {};
      if (!sourceService || !metadata) throw sourceError('capability-unavailable', 'Source capture ownership is not ready.');
      const capture = createCommitmentCaptureService({ metadata, sourceService });
      const observedAt = new Date().toISOString();
      const result = await capture.capture(retainCommitmentCaptureTimestamps(metadata, { schemaVersion: 1, logicalOperationId: sourceCaptureOperationId(params), ...params, occurredAt: observedAt, observedAt, historicalBaseline: false }));
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, loopId: result.loop?.loopId, state: result.loop?.state }) }], details: result });
    }
  });
}

export function intakeReceiptToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Intake receipts require authoritative owners.');
  return () => ({
    name: 'command_center_record_intake_receipt',
    description: 'Record a content-free maintained email, Chat or Note processing checkpoint for Command Center intake health. A separately marked admitted retry does not claim a new source scan. Chat is on demand and may omit nextExpectedAt.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      sourceKind: { type: 'string', enum: ['email', 'chat', 'note'] }, runId: { type: 'string', minLength: 1 }, purpose: { type: 'string', enum: ['producer', 'admitted-retry'] }, retryOfRunId: { type: 'string', minLength: 1 }, planDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, unadmittedSourceCount: { type: 'integer', minimum: 0 }, checkpoint: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['healthy-empty', 'healthy-processed', 'incomplete', 'pending', 'failed', 'never-connected'] }, observedAt: { type: 'string' }, lastSuccessfulAt: { type: 'string' }, nextExpectedAt: { type: 'string' }, processedCount: { type: 'integer', minimum: 0 }, actionableCount: { type: 'integer', minimum: 0 }, noteCount: { type: 'integer', minimum: 0 }, continuation: { type: 'object', additionalProperties: false, properties: { scopeId: { type: 'string', minLength: 1 }, cursor: { type: 'string', minLength: 1 }, remainingCount: { type: 'integer', minimum: 0 }, failedReadCount: { type: 'integer', minimum: 0 }, scanCapReached: { type: 'boolean' } }, required: ['scopeId', 'cursor', 'remainingCount', 'failedReadCount', 'scanCapReached'] },
      scope: { type: 'object', additionalProperties: false, properties: { accountBinding: { type: 'string', minLength: 1 }, folders: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1 } }, sinceUtc: { type: 'string' }, beforeUtc: { type: 'string' }, maxMessages: { type: 'integer', minimum: 1, maximum: 50 }, batchKind: { type: 'string', enum: ['canary', 'bounded'] } }, required: ['accountBinding', 'folders', 'sinceUtc', 'beforeUtc', 'maxMessages', 'batchKind'] },
      enumeration: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['complete', 'bounded', 'partial'] }, scannedCount: { type: 'integer', minimum: 0 }, remainingCount: { type: 'integer', minimum: 0 }, failedReadCount: { type: 'integer', minimum: 0 }, scanCapReached: { type: 'boolean' } }, required: ['scope', 'scannedCount', 'remainingCount', 'failedReadCount', 'scanCapReached'] }
    }, required: ['sourceKind', 'runId', 'checkpoint', 'status', 'observedAt', 'processedCount', 'actionableCount', 'noteCount'] }),
    async execute(_toolCallId, params) {
      const { metadata } = getOwners() ?? {};
      if (!metadata) throw sourceError('capability-unavailable', 'Intake receipt ownership is not ready.');
      const resumeFrom = params.status === 'pending' ? findIntakeContinuation(metadata, params.sourceKind) : null;
      const result = recordIntakeReceipt(metadata, { schemaVersion: 1, ...params });
      const details = Object.freeze({ ...result, ...(resumeFrom ? { resumeFrom } : {}) });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, sourceKind: result.receipt.sourceKind, checkpoint: result.receipt.checkpoint, ...(resumeFrom ? { resumeFrom } : {}) }) }], details });
    }
  });
}

export function intakeSourcePlanToolFactory({ getOwners, acceptedChatCommands, getAcceptedChatRuntime } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Intake source accounting requires authoritative owners.');
  return (context = {}) => ({
    name: 'command_center_plan_intake_source',
    description: 'Record email/Note plans as before. For Chat, accept a frozen extraction, then load or replay its returned planId through the closed owner. Recovery covers successfully submitted plans only; failure before acceptance leaves coverage unknown. Never apply separate Chat Note/accounting writes.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      chatCommand: { type: 'string', enum: ['accept', 'load', 'replay'] }, planId: { type: 'string', minLength: 1 },
      sourceKind: { type: 'string', enum: ['email', 'chat', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }, checkpoint: { type: 'string', minLength: 1 }, observedAt: { type: 'string' }, processorVersion: { type: 'string', minLength: 1, maxLength: 300 }, retainedNoteRevision: { type: 'string', minLength: 1, maxLength: 100 },
      acceptedExtraction: acceptedExtractionSchema,
      outcomes: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { outcomeId: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['obligation', 'decision', 'information', 'no-action'] } }, required: ['outcomeId', 'kind'] } },
      enumeration: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['complete', 'bounded', 'partial'] }, scannedCount: { type: 'integer', minimum: 0 }, remainingCount: { type: 'integer', minimum: 0 }, failedReadCount: { type: 'integer', minimum: 0 }, scanCapReached: { type: 'boolean' }, scopeId: { type: 'string', minLength: 1 }, resumeCursor: { type: 'string', minLength: 1 } }, required: ['scope', 'scannedCount', 'remainingCount', 'failedReadCount', 'scanCapReached'] }
    }, required: ['sourceKind'], oneOf: [
      { properties: { sourceKind: { enum: ['email', 'note'] } }, required: ['sourceExternalId', 'sourceVersion', 'checkpoint', 'observedAt', 'processorVersion', 'acceptedExtraction', 'outcomes', 'enumeration'], not: { anyOf: [{ required: ['chatCommand'] }, { required: ['planId'] }] } },
      { properties: { sourceKind: { const: 'chat' }, chatCommand: { const: 'accept' } }, required: ['chatCommand', 'sourceExternalId', 'sourceVersion', 'checkpoint', 'observedAt', 'processorVersion', 'acceptedExtraction', 'outcomes', 'enumeration'], not: { required: ['planId'] } },
      { properties: { sourceKind: { const: 'chat' }, chatCommand: { enum: ['load', 'replay'] }, planId: { type: 'string', minLength: 1 } }, required: ['chatCommand', 'planId'], additionalProperties: false }
    ] }),
    async execute(_toolCallId, params) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw sourceError('invalid-request', 'Intake source input must be an object.');
      if (params?.sourceKind === 'chat') {
        const action = Object.hasOwn(chatActions, params.chatCommand) ? chatActions[params.chatCommand] : undefined;
        if (!action || params.chatCommand === 'accept' && Object.hasOwn(params, 'planId') || params.chatCommand !== 'accept' && Object.keys(params).some(key => !['sourceKind', 'chatCommand', 'planId'].includes(key)))
          throw sourceError('invalid-request', 'Chat requires a closed accept/load/replay command; replay cannot replace extraction or authority.');
        if (typeof context.assertInvocationCurrent !== 'function') throw sourceError('unauthenticated', 'Chat submission requires Native V2 invocation authority. Coverage remains unknown before acceptance.');
        if (context.assertInvocationCurrent()?.then) throw sourceError('unauthenticated', 'Chat invocation authority must remain synchronous.');
        // A tool lifetime is not an operator profile. Only an existing trusted
        // caller adapter may supply the canonical binding; never derive it
        // from a device, generic sender, model argument or owner boolean.
        const original = getAcceptedChatRuntime?.(context);
        if (typeof original?.principalId !== 'string' || !original.principalId.trim() || typeof original.assertCurrent !== 'function')
          throw sourceError('unauthenticated', 'The canonical operator profile is unavailable before Chat submission. Coverage remains unknown.');
        const runtime = Object.freeze({ principalId: original.principalId, assertCurrent() {
          if (context.assertInvocationCurrent()?.then || original.assertCurrent()?.then) throw sourceError('unauthenticated', 'Chat authority must remain synchronous.');
        } });
        runtime.assertCurrent();
        if (!acceptedChatCommands) throw sourceError('capability-unavailable', 'Accepted Chat owner is unavailable.');
        let input;
        if (action === 'Accept') {
          if (typeof context.sessionKey !== 'string' || !context.sessionKey || typeof context.sessionId !== 'string' || !context.sessionId)
            throw sourceError('source-recovery', 'Chat submission requires the exact trusted native Conversation.');
          const { chatCommand, ...plan } = params;
          if (Object.keys(plan).some(key => !['sourceKind', 'sourceExternalId', 'sourceVersion', 'checkpoint', 'observedAt', 'processorVersion', 'retainedNoteRevision', 'acceptedExtraction', 'outcomes', 'enumeration'].includes(key)))
            throw sourceError('invalid-request', 'Chat plan cannot supply Conversation or authority fields.');
          input = { schemaVersion: 1, ...plan, sessionKey: context.sessionKey, sessionId: context.sessionId };
        } else input = { schemaVersion: 1, planId: params.planId };
        const result = await invokeAcceptedChatCommand(acceptedChatCommands, action, input, runtime);
        runtime.assertCurrent();
        return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
      }
      if (Object.hasOwn(params, 'chatCommand') || Object.hasOwn(params, 'planId')) throw sourceError('invalid-request', 'Chat commands cannot be used for email or Note intake.');
      const { metadata } = getOwners() ?? {};
      if (!metadata) throw sourceError('capability-unavailable', 'Intake source accounting is not ready.');
      const result = recordIntakeSourcePlan(metadata, { schemaVersion: 1, ...params });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, sourceKind: result.plan.sourceKind, checkpoint: result.plan.checkpoint, outcomeCount: result.plan.outcomes.length }) }], details: result });
    }
  });
}

export function intakeSourceAccountToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Intake source accounting requires authoritative owners.');
  return () => ({
    name: 'command_center_get_intake_source_account',
    description: 'Load the durable accepted extraction, processor version, outcome identities and current accounting states for one exact source revision before retrying effects.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      sourceKind: { type: 'string', enum: ['email', 'chat', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }
    }, required: ['sourceKind', 'sourceExternalId', 'sourceVersion'] }),
    async execute(_toolCallId, params) {
      const { metadata } = getOwners() ?? {};
      if (!metadata) throw sourceError('capability-unavailable', 'Intake source accounting is not ready.');
      const result = loadIntakeSourceAccount(metadata, params);
      const projection = result ? Object.freeze({
        status: 'found', sourceKind: result.plan.sourceKind, sourceExternalId: result.plan.sourceExternalId, sourceVersion: result.plan.sourceVersion,
        processorVersion: result.plan.processorVersion, acceptedExtraction: result.plan.acceptedExtraction,
        outcomes: result.account?.outcomes ?? result.plan.outcomes.map(outcome => Object.freeze({ ...outcome, status: 'missing' }))
      }) : Object.freeze({ status: 'not-found', sourceKind: params.sourceKind });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify(projection) }], details: result });
    }
  });
}

export function intakeOutcomeToolFactory({ getOwners } = {}) {
  if (typeof getOwners !== 'function') throw new TypeError('Intake outcome accounting requires authoritative owners.');
  return () => ({
    name: 'command_center_record_intake_outcome',
    description: 'Record one exact outcome from a previously planned maintained source revision after its effect is known. Retries must preserve the same outcome identity and result.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: {
      sourceKind: { type: 'string', enum: ['email', 'chat', 'note'] }, sourceExternalId: { type: 'string', minLength: 1 }, sourceVersion: { type: 'string', minLength: 1 }, outcomeId: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['obligation', 'decision', 'information', 'no-action'] }, status: { type: 'string', enum: ['applied', 'pending-decision', 'quiet', 'no-action', 'unresolved-topic', 'failed', 'unknown'] }, summary: { type: 'string', minLength: 1, maxLength: 300 }, loopId: { type: 'string', minLength: 1 }, topicId: { type: 'string', minLength: 1 }, sourceReferenceId: { type: 'string', minLength: 1 }, sourcePath: { type: 'string', minLength: 1 }, sourceReferenceVersion: { type: 'string', minLength: 1 }, recordedAt: { type: 'string' }, errorCode: { type: 'string', minLength: 1, maxLength: 100 }
    }, required: ['sourceKind', 'sourceExternalId', 'sourceVersion', 'outcomeId', 'kind', 'status', 'summary', 'recordedAt'] }),
    async execute(_toolCallId, params) {
      const { metadata } = getOwners() ?? {};
      if (!metadata) throw sourceError('capability-unavailable', 'Intake outcome accounting is not ready.');
      const result = recordIntakeOutcome(metadata, { schemaVersion: 1, ...params });
      return Object.freeze({ content: [{ type: 'text', text: JSON.stringify({ status: result.disposition, outcomeId: result.outcome.outcomeId, outcomeStatus: result.outcome.status }) }], details: result });
    }
  });
}
