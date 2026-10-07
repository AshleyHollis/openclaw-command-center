const string = { type: 'string' }, number = { type: 'number' };
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const array = items => ({ type: 'array', items });
const source = object({ topicId: string, referenceId: string, sessionId: string, sessionKey: string, membershipRevision: number, messageId: string, messageDigest: string });
const input = object({ family: string, logicalOperationId: string, source, destination: object({ tenantId: string, boardId: string }), snapshot: object({ outcome: string, steps: array(string), completionCriteria: array(string) }) });
const row = object({ family: string, availability: string, outcome: string, reason: string, input, card: object({ id: string, status: string, updatedAt: number, sessionKey: string, runId: string }), progress: object({ availability: string, status: string }), attention: object({ eligible: { type: 'boolean' }, availability: string, reason: string, requests: array(object({ id: string, kind: string, createdAtMs: number, expiresAtMs: number })) }) });
export function conversationPlanResultSchema(method) {
  if (!method.startsWith('command-center.v1.conversation-plans.')) return null;
  if (method.endsWith('.messages')) return object({ messages: array(object({ source, text: string })) });
  if (method.endsWith('.list')) return object({ rows: array(row), coverage: string, unavailableCount: number });
  return row;
}
