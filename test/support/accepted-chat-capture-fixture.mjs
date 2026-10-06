import assert from 'node:assert/strict';
import { createAcceptedChatReplayService } from '../../src/open-loops/accepted-chat-replay.mjs';

// Logical accepted-tool fixture only; the real native binding reader is tested separately.
export async function captureAcceptedChatFixture(metadata, input) {
  const referenceId = `conversation:${input.topicId}:fictional`;
  const sessionKey = `agent:main:${input.topicId}-fictional`;
  if (!metadata.getSourceReference(referenceId)) {
    metadata.createSourceReference({ version: 1, referenceId, topicId: input.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
    metadata.setSessionState({ referenceId, sessionId: 'fictional-session', status: 'open', isPrimary: true, displayName: 'Fictional Conversation', updatedAt: '2026-09-20T00:00:00Z' });
  }
  const sourceService = {
    async sessionTopicContext() { return { status: 'bound', sessionKey, sessionId: 'fictional-session', referenceId, topicId: input.topicId }; },
    assertAcceptedChatBinding(binding) { assert.deepEqual(binding.sessionReference, metadata.getSourceReference(referenceId)); assert.deepEqual(binding.sessionState, metadata.getSessionState(referenceId)); assert.deepEqual(binding.sessionLocator, metadata.getSourceLocator(referenceId)); assert.equal(binding.topicRevision, metadata.getTopic(input.topicId).revision); }
  };
  const owner = createAcceptedChatReplayService({ metadata, sourceService });
  const fields = ['title', 'obligationId', 'provenance', 'confidence', 'correlationNamespace', 'correlationId', 'dueAt', 'reviewAt', 'plannedAt', 'importance', 'importanceOrigin', 'effortMinutes', 'contexts', 'dependencies'];
  const obligation = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const runtime = { principalId: 'fictional-operator', assertCurrent() {} };
  const accepted = await owner.accept({ schemaVersion: 1, sessionKey, sessionId: 'fictional-session', sourceKind: 'chat', sourceExternalId: input.sourceExternalId, sourceVersion: input.sourceVersion, checkpoint: 'fictional-accepted-tool', observedAt: input.observedAt, processorVersion: 'fictional-accepted-tool-v1', acceptedExtraction: { schemaVersion: 1, proposedTopic: metadata.getTopic(input.topicId).name, notePath: '', knowledgeMarkdown: '', obligations: [{ ...obligation, classification: 'obligation' }] }, outcomes: [{ outcomeId: input.obligationId, kind: 'obligation' }] }, runtime);
  const replay = await owner.replay({ schemaVersion: 1, planId: accepted.planId }, runtime);
  return { disposition: 'created', loop: metadata.getOpenLoop(replay.account.outcomes[0].loopId) };
}
