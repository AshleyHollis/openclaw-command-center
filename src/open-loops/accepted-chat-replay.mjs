import { processAcceptedChatPlan } from './producer-intake.mjs';
import { sourceError } from '../sources/errors.mjs';
import { normalizeIntakeSourcePlan, recordIntakeSourcePlan, loadIntakeSourceAccount } from './intake-accounting.mjs';
import { withAcceptedChatScope } from './accepted-chat-scope.mjs';

const fail = (code, message) => { throw sourceError(code, message); };
const copy = value => JSON.parse(JSON.stringify(value));
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
function principal(runtime) {
  if (!text(runtime?.principalId) || typeof runtime.assertCurrent !== 'function' || runtime.assertCurrent()?.then) fail('unauthenticated', 'Accepted Chat processing requires current authenticated operator authority.');
  return runtime.principalId;
}
function checkOutcomes(plan) {
  const extraction = plan.acceptedExtraction;
  const expected = extraction.obligations.map(item => ({ outcomeId: item.obligationId, kind: item.classification }));
  if (extraction.knowledgeMarkdown.trim()) {
    if (!text(extraction.knowledgeOutcomeId) || !text(extraction.notePath)) fail('invalid-request', 'Accepted Chat information requires its exact outcome and Note destination.');
    expected.push({ outcomeId: extraction.knowledgeOutcomeId, kind: 'information' });
  }
  if (extraction.noAction) expected.push({ outcomeId: extraction.noAction.outcomeId, kind: 'no-action' });
  if (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(plan.outcomes)) fail('invalid-request', 'Accepted Chat outcomes must exactly match the frozen extraction.');
}

/** Existing accepted-plan replay only. This does not attest native original-message custody. */
export function createAcceptedChatReplayService({ metadata, sourceService } = {}) {
  if (!metadata?.commitIntakeAccountingOperation || !sourceService?.assertAcceptedChatBinding) throw new TypeError('Accepted Chat replay requires existing accounting and exact source owners.');
  function fence(plan, runtime) {
    const operatorId = principal(runtime);
    if (plan.acceptedChat?.principalId !== operatorId) fail('unauthenticated', 'The original accepted Chat operator is required.');
    sourceService.assertAcceptedChatBinding(plan.acceptedChat);
  }
  function read(input, runtime) {
    principal(runtime);
    if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !['schemaVersion', 'planId'].includes(key)) || !text(input.planId)) fail('invalid-request', 'Accepted Chat load requires its exact plan receipt.');
    const operation = metadata.getOperation(input.planId);
    if (operation?.operationKind !== 'intake-source.chat.v1' || operation.state !== 'applied' || operation.resultStatus !== 'planned') fail('source-recovery', 'The accepted Chat plan receipt is unavailable.');
    let plan;
    try { plan = normalizeIntakeSourcePlan(JSON.parse(operation.resultIdentity)); } catch { fail('source-recovery', 'The accepted Chat plan receipt is invalid.'); }
    if (!plan.acceptedChat) fail('source-recovery', 'Legacy Chat plans require explicit reconciliation before accepted replay.');
    checkOutcomes(plan); fence(plan, runtime);
    const result = loadIntakeSourceAccount(metadata, plan);
    if (result?.logicalOperationId !== input.planId) fail('conflict', 'The Chat receipt does not identify this accepted source.');
    return result;
  }
  const result = durable => Object.freeze({ schemaVersion: 1, planId: durable.logicalOperationId, plan: durable.plan, account: durable.account, status: durable.account?.resolved ? 'accounted' : 'pending', coverage: 'accepted-plan-only', sourceCoverage: 'unknown' });
  return Object.freeze({
    async accept(input, runtime) {
      const operatorId = principal(runtime);
      if (!input || !text(input.sessionKey) || !text(input.sessionId) || input.sourceKind !== 'chat' || input.acceptedChat !== undefined) fail('invalid-request', 'Chat acceptance requires an exact current Conversation and logical source revision.');
      const { sessionKey, sessionId, ...submitted } = input;
      const binding = await sourceService.sessionTopicContext({ sessionKey });
      principal(runtime);
      if (binding.status !== 'bound' || binding.sessionId !== sessionId) fail('source-recovery', 'The current Conversation is not exactly linked to a Topic.');
      const topic = metadata.getTopic(binding.topicId);
      const needsNote = submitted.acceptedExtraction?.knowledgeMarkdown?.trim();
      const folders = needsNote ? metadata.listSourceReferences(binding.topicId).filter(item => item.sourceSystem === 'obsidian' && item.sourceKind === 'note_folder') : [];
      if (needsNote && folders.length !== 1) fail('source-recovery', 'Accepted Chat information requires one exact Topic Note Folder.');
      const acceptedChat = copy({ version: 1, principalId: operatorId, sessionKey, sessionId, referenceId: binding.referenceId, topicId: binding.topicId, topicRevision: topic.revision,
        sessionReference: metadata.getSourceReference(binding.referenceId), sessionState: metadata.getSessionState(binding.referenceId), sessionLocator: metadata.getSourceLocator(binding.referenceId),
        ...(needsNote ? { noteFolderReferenceId: folders[0].referenceId, noteFolderReference: folders[0], noteFolderLocator: metadata.getSourceLocator(folders[0].referenceId) } : {}) });
      const plan = normalizeIntakeSourcePlan({ ...submitted, acceptedChat });
      if (plan.acceptedExtraction.proposedTopic !== topic.name) fail('conflict', 'The accepted extraction must name the exact current Conversation Topic.');
      checkOutcomes(plan);
      if (plan.acceptedChat.noteFolderReferenceId) {
        if (typeof sourceService.verifyAcceptedChatBinding !== 'function') fail('capability-unavailable', 'The current physical Note Folder owner is required.');
        await sourceService.verifyAcceptedChatBinding(plan.acceptedChat);
      }
      const assertCurrent = () => fence(plan, runtime);
      const durable = withAcceptedChatScope(metadata, plan, assertCurrent, () => recordIntakeSourcePlan(metadata, plan), { accepting: true });
      return result(durable);
    },
    load(input, runtime) { return result(read(input, runtime)); },
    async replay(input, runtime) {
      const durable = read(input, runtime);
      const plan = durable.plan;
      if (plan.acceptedChat.noteFolderReferenceId) {
        if (typeof sourceService.verifyAcceptedChatBinding !== 'function') fail('capability-unavailable', 'The current physical Note Folder owner is required.');
        await sourceService.verifyAcceptedChatBinding(plan.acceptedChat);
        fence(plan, runtime);
      }
      const assertCurrent = () => {
        fence(plan, runtime);
        const operation = metadata.getOperation(input.planId);
        if (operation?.operationKind !== 'intake-source.chat.v1' || operation.resultIdentity !== JSON.stringify(plan)) fail('conflict', 'The accepted Chat receipt changed.');
      };
      return withAcceptedChatScope(metadata, plan, assertCurrent, async () => {
        return result(await processAcceptedChatPlan({ metadata, sourceService, plan, assertCurrent }));
      });
    }
  });
}
