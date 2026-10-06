const string = { type: 'string' };
const integer = { type: 'integer' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const source = object({ kind: { enum: ['outlook', 'note'] }, url: string, topicId: string, referenceId: string, path: string, revision: string, observedRevision: string });
const events = { type: 'array', items: object({ id: string, kind: string, at: number, fromStatus: string, toStatus: string }) };
const row = object({
  schemaVersion: { const: 1 }, loopId: string, actionId: string, title: string, topicId: string,
  availability: string, outcome: string, reason: string, canWrite: boolean,
  deadline: object({ known: boolean, instant: string, provenance: string }), source,
  sourceIdentity: object({ externalId: string, version: string, outcomeId: string, observationId: string }),
  binding: object({ tenantId: string, boardId: string, cardId: string, idempotencyKey: string }),
  native: object({ status: string, updatedAt: number, completedAt: number, events }),
  eligibility: object({ revision: integer, reviewAt: { type: ['string', 'null'] }, timeZone: { type: ['string', 'null'] }, offsetMinutes: { type: ['number', 'null'] }, eligible: boolean }),
  pendingOperation: object({ logicalOperationId: string, kind: string, intent: object({ schemaVersion: { const: 1 }, loopId: string, logicalOperationId: string, expectedUpdatedAt: number, expectedEligibilityRevision: integer, reviewAt: string, timeZone: string, offsetMinutes: number }) }),
  history: events
});
const operation = object({ schemaVersion: { const: 1 }, loopId: string, logicalOperationId: string, outcome: string, state: string,
  availability: string, reason: string, eligibility: row.properties.eligibility, action: { enum: ['handle', 'defer'] } });

export function billActionResultSchema(method) {
  if (!method.startsWith('command-center.v1.bill-actions.')) return null;
  if (method.endsWith('.list')) return object({ schemaVersion: { const: 1 }, rows: { type: 'array', items: row }, total: integer,
    offset: integer, limit: integer, coverage: string, unavailableCount: integer, observedAt: string, userTimeZone: string });
  return method.endsWith('.read') || method.endsWith('.admit') ? row : operation;
}
