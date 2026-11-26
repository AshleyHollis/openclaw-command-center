// Content-free operator projection. This describes accepted work only;
// native Chat acknowledgement and unsubmitted-message coverage are unchanged.
export const CHAT_CAPTURE_METHODS = Object.freeze([
  'command-center.v1.chat-capture.accept',
  'command-center.v1.chat-capture.load',
  'command-center.v1.chat-capture.replay'
]);

export const acceptedChatResultSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, planId: { type: 'string' }, status: { type: 'string' },
    coverage: { const: 'accepted-plan-only' }, sourceCoverage: { const: 'unknown' },
    processorVersion: { type: 'string' }, acceptedAt: { type: 'string' },
    outcomes: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { outcomeId: { type: 'string' }, kind: { enum: ['obligation', 'decision', 'information', 'no-action'] }, status: { type: 'string' } },
      required: ['outcomeId', 'kind', 'status'] } }
  }, required: ['schemaVersion', 'planId', 'status', 'coverage', 'sourceCoverage', 'processorVersion', 'acceptedAt', 'outcomes']
});

export function projectAcceptedChatResult(result) {
  const plan = result.plan;
  return Object.freeze({ schemaVersion: 1, planId: result.planId ?? result.logicalOperationId,
    status: result.status ?? result.disposition ?? 'accepted', coverage: 'accepted-plan-only', sourceCoverage: 'unknown',
    processorVersion: plan.processorVersion, acceptedAt: plan.observedAt,
    outcomes: Object.freeze((result.account?.outcomes ?? plan.outcomes.map(outcome => ({ ...outcome, status: 'missing' })))
      .map(({ outcomeId, kind, status }) => Object.freeze({ outcomeId, kind, status }))) });
}

export async function invokeAcceptedChatCommand(service, action, input, runtime) {
  if (typeof runtime?.assertCurrent !== 'function' || typeof runtime.principalId !== 'string' || !runtime.principalId.trim()) throw new TypeError('Accepted capture requires current operator authority.');
  runtime.assertCurrent();
  const result = await service[`acceptedChatCapture${action}`](input, runtime);
  runtime.assertCurrent();
  return projectAcceptedChatResult(result);
}
