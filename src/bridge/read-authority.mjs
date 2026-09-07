import { SourceServiceError } from '../sources/errors.mjs';

// The native host supplies these connection facts, never request params. Keep
// its captured respond path, which independently fences host auth generations.
export function captureHistoryReadAuthority({ client, context, signal }) {
  const refused = () => { throw new SourceServiceError('unauthenticated', 'The authenticated history read is no longer current.'); };
  if (!client || typeof client.connId !== 'string' || !client.connId || !client.connect || !context) refused();
  const connect = client.connect;
  const connectionSignal = client.connectionSignal;
  const connId = client.connId;
  const identity = () => JSON.stringify([client.authenticatedUserProfile?.profileId ?? null, client.authenticatedUserId ?? null,
    client.authenticatedOperatorId ?? null, client.pairedClientId ?? null, connect.role, connect.scopes]);
  const original = identity();
  const assertCurrent = () => {
    if (client.connect !== connect || client.connId !== connId || client.connectionSignal !== connectionSignal || identity() !== original ||
        client.invalidated === true || signal?.aborted || connectionSignal?.aborted || context.authenticated === false || context.isConnectionActive?.(connId) === false ||
        connect.role !== 'operator' || !Array.isArray(connect.scopes) || !connect.scopes.some(scope => ['operator.read', 'operator.write', 'operator.admin'].includes(scope)) ||
        (client.authenticatedUserProfile !== undefined && (typeof client.authenticatedUserProfile?.profileId !== 'string' || !client.authenticatedUserProfile.profileId.trim()))) refused();
  };
  assertCurrent();
  return assertCurrent;
}
