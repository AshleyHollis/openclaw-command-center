import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';
import { effectiveSourceLocator } from '../sources/reference.mjs';

const scopes = new AsyncLocalStorage();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const refuse = () => { throw sourceError('source-recovery', 'Chat effects require an exact accepted plan and current authenticated authority.'); };
function operationId(parts) {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(Number.parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function assertStoredPlan(frame) {
  if (frame.accepting) return;
  const found = (frame.metadata.listOperations?.() ?? []).filter(operation => operation.operationKind === 'intake-source.chat.v1' && operation.state === 'applied' && operation.resultStatus === 'planned').filter(operation => {
    try { return same(JSON.parse(operation.resultIdentity), frame.plan); } catch { return false; }
  });
  if (found.length !== 1) refuse();
}

// A live owning-command frame, never a receipt copied into model parameters.
export function withAcceptedChatScope(metadata, plan, assertCurrent, action, { accepting = false } = {}) {
  if (!plan?.acceptedChat || typeof assertCurrent !== 'function') refuse();
  const frame = { metadata, plan, assertCurrent, accepting };
  assertCurrent();
  return scopes.run(frame, action);
}

export function assertAcceptedChatEffect(metadata, input, kind) {
  const frame = scopes.getStore();
  if (!frame || frame.metadata !== metadata) refuse();
  if (frame.assertCurrent()?.then) refuse();
  assertStoredPlan(frame);
  const plan = frame.plan;
  if (input.sourceKind !== 'chat' || input.sourceExternalId !== plan.sourceExternalId || input.sourceVersion !== plan.sourceVersion) refuse();
  if (kind === 'plan') {
    if (!frame.accepting || !same(input, plan)) refuse();
    return;
  }
  if (frame.accepting) refuse();
  if (kind === 'capture') {
    const expected = plan.acceptedExtraction.obligations.find(item => item.obligationId === input.obligationId);
    if (!expected || input.topicId !== plan.acceptedChat.topicId || input.occurredAt !== plan.observedAt || input.observedAt !== plan.observedAt || input.historicalBaseline !== false) refuse();
    for (const field of ['title', 'provenance', 'confidence', 'obligationKind', 'correlationNamespace', 'correlationId', 'dueAt', 'reviewAt', 'plannedAt', 'importance', 'importanceOrigin', 'effortMinutes', 'contexts', 'dependencies']) {
      if (!same(input[field] ?? (['contexts', 'dependencies'].includes(field) ? [] : undefined), expected[field] ?? (['contexts', 'dependencies'].includes(field) ? [] : undefined))) refuse();
    }
    if (input.paymentIdentity !== undefined) refuse();
    if (input.classification !== (expected.classification === 'decision' ? 'decision' : undefined)) refuse();
    if (input.logicalOperationId !== operationId(['command-center.source-capture.v1', 'chat', plan.sourceExternalId, plan.sourceVersion, input.obligationId])) refuse();
    if (plan.acceptedExtraction.knowledgeMarkdown.trim()) {
      const noteId = operationId(['command-center.source-note.v1', plan.acceptedChat.topicId, 'chat', plan.sourceExternalId, plan.sourceVersion]);
      const noteOperation = metadata.getOperation(noteId);
      const reference = metadata.getSourceReference(input.sourceReferenceId ?? '');
      if (noteOperation?.operationKind !== 'notes.create' || noteOperation.state !== 'applied' || noteOperation.observedRevision !== input.sourceReferenceVersion || reference?.sourceKind !== 'note' || reference.topicId !== plan.acceptedChat.topicId || input.sourcePath !== plan.acceptedExtraction.notePath || reference.observedRevision !== input.sourceReferenceVersion || effectiveSourceLocator(metadata, reference) !== noteOperation.resultIdentity) refuse();
    } else if (input.sourceReferenceId !== undefined || input.sourcePath !== undefined || input.sourceReferenceVersion !== undefined) refuse();
  } else if (kind === 'outcome') {
    const expected = plan.outcomes.find(item => item.outcomeId === input.outcomeId);
    if (!expected || expected.kind !== input.kind) refuse();
    const status = { obligation: 'applied', decision: 'pending-decision', information: 'quiet', 'no-action': 'no-action' }[expected.kind];
    if (input.status !== status) refuse();
    const obligation = plan.acceptedExtraction.obligations.find(item => item.obligationId === input.outcomeId);
    const summary = obligation?.title ?? (input.kind === 'information' ? plan.acceptedExtraction.knowledgeSummary ?? 'Information retained in the Topic Note' : plan.acceptedExtraction.noAction?.summary ?? 'No action required');
    if (input.summary !== summary || input.recordedAt !== plan.observedAt || input.topicId !== undefined && input.topicId !== plan.acceptedChat.topicId) refuse();
  } else refuse();
}

export function assertAcceptedChatNote(metadata, input) {
  const frame = scopes.getStore();
  if (!frame) {
    // Generic Note calls cannot impersonate an accepted Chat effect by copying its ID.
    if (input.logicalOperationId && (metadata.listOperations?.() ?? []).some(operation => {
      if (operation.operationKind !== 'intake-source.chat.v1') return false;
      try {
        const plan = JSON.parse(operation.resultIdentity);
        return plan.acceptedChat && input.logicalOperationId === operationId(['command-center.source-note.v1', plan.acceptedChat.topicId, 'chat', plan.sourceExternalId, plan.sourceVersion]);
      } catch { return false; }
    })) refuse();
    return false; // Ordinary email/Note writes retain their existing owners.
  }
  if (frame.metadata !== metadata || frame.accepting || frame.assertCurrent()?.then) refuse();
  assertStoredPlan(frame);
  const { plan } = frame;
  if (input.topicId !== undefined && input.topicId !== plan.acceptedChat.topicId || input.referenceId !== undefined && input.referenceId !== plan.acceptedChat.noteFolderReferenceId || input.path !== plan.acceptedExtraction.notePath || input.text !== plan.acceptedExtraction.knowledgeMarkdown || input.sourceKind !== 'note' || !input.text?.trim()) refuse();
  if (input.logicalOperationId !== operationId(['command-center.source-note.v1', plan.acceptedChat.topicId, 'chat', plan.sourceExternalId, plan.sourceVersion]) || input.requestId !== undefined && input.requestId !== input.logicalOperationId) refuse();
  return true;
}

export function requireAcceptedChatScope(metadata) {
  const frame = scopes.getStore();
  if (!frame || frame.metadata !== metadata || frame.accepting || frame.assertCurrent()?.then) refuse();
  assertStoredPlan(frame);
}
