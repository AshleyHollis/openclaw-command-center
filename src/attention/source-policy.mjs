// Reserved request identity keeps its privacy/lifecycle policy when the
// optional native adapter is unavailable or not registered after restart.
export const PLAN_REQUEST_CAPABILITY = 'conversation-plan-human-requests.v1';
export const PLAN_REQUEST_REASON = 'explicit-native-human-request';
export function attentionSourcePolicy(sourceCapabilityId) {
  return sourceCapabilityId === PLAN_REQUEST_CAPABILITY
    ? Object.freeze({ ownerScoped: true, terminalSubject: true, attentionReason: PLAN_REQUEST_REASON })
    : Object.freeze({ ownerScoped: false, terminalSubject: false });
}
