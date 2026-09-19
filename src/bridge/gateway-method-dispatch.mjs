import { sourceError } from '../sources/errors.mjs';

// A pinned sessions.create can include durable catalog publication. Keep its
// transport bound below the 240-second scenario budget while reserving time
// for exact sessions.list readback and cleanup.
const DISPATCH_TIMEOUT_MS = 45_000;

// Capture the host's admitted identity and request lifetime, never request JSON.
// The synchronous fence can run inside the owning metadata transaction after
// native readback. It is not an independent credential reauthentication service.
export async function createRequestScopedConversationRuntime({ getRequestScope, dispatchGatewayMethod, gatewayRequest, requiredGatewayMethods = [] } = {}) {
  const readScope = getRequestScope ?? (await import('openclaw/plugin-sdk/plugin-runtime')).getPluginRuntimeGatewayRequestScope;
  const refuse = () => { throw sourceError('unauthenticated', 'The original authenticated Conversation request is no longer available.'); };
  if (typeof readScope !== 'function') return refuse();
  const scope = readScope();
  const client = scope?.client;
  const profile = client?.authenticatedUserProfile;
  const principalId = profile?.profileId ?? client?.authenticatedUserId ?? client?.authenticatedOperatorId;
  const resolver = scope?.resolveGatewayContext;
  const directContext = scope?.context;
  const role = client?.connect?.role;
  const granted = client?.connect?.scopes;
  if (!Array.isArray(requiredGatewayMethods) || requiredGatewayMethods.some(method => typeof method !== 'string' || !method.trim())) throw new TypeError('requiredGatewayMethods must be an array of non-empty method names');
  const dispatchAllowlist = Array.isArray(scope?.gatewayMethodDispatchMethods) ? scope.gatewayMethodDispatchMethods : [];
  const dispatchPermitted = scope?.gatewayMethodDispatchAllowed === true
    || (requiredGatewayMethods.length > 0 && requiredGatewayMethods.every(method => dispatchAllowlist.includes(method)));
  if (scope?.pluginId !== 'command-center' || !dispatchPermitted || typeof principalId !== 'string' || !principalId.trim()
    || (typeof resolver !== 'function' && !directContext) || role !== 'operator' || !Array.isArray(granted)
    || !granted.every(value => typeof value === 'string') || !granted.some(value => value === 'operator.write' || value === 'operator.admin')) return refuse();
  const scopes = JSON.stringify([...granted].sort());
  const context = typeof resolver === 'function' ? resolver() : directContext;
  if (!context) return refuse();
  const assertCurrent = () => {
    const currentPrincipal = client?.authenticatedUserProfile?.profileId ?? client?.authenticatedUserId ?? client?.authenticatedOperatorId;
    if (readScope() !== scope || scope.client !== client || client.authenticatedUserProfile !== profile || currentPrincipal !== principalId
      || scope.pluginId !== 'command-center'
      || !(scope.gatewayMethodDispatchAllowed === true || (requiredGatewayMethods.length > 0 && requiredGatewayMethods.every(method => scope.gatewayMethodDispatchMethods?.includes(method))))
      || scope.resolveGatewayContext !== resolver
      || client.connect?.role !== role || !Array.isArray(client.connect?.scopes) || JSON.stringify([...client.connect.scopes].sort()) !== scopes
      || (typeof resolver === 'function' ? resolver() !== context : scope.context !== context)) refuse();
  };
  assertCurrent();
  if (gatewayRequest !== undefined && typeof gatewayRequest !== 'function') throw new TypeError('gatewayRequest must be a function');
  // The published runtime facade carries the active plugin owner into the
  // host's sessions.create boundary. Keep the local dispatcher as the
  // testable fallback, but do not replace a host-owned facade with a caller
  // supplied or synthetic Session result.
  const request = gatewayRequest ?? createRequestScopedGatewayRequest(dispatchGatewayMethod);
  return Object.freeze({
    creationAuthority: Object.freeze({ principalId, assertCurrent }),
    gatewayRequest: async (...args) => {
      assertCurrent();
      const [method, params, options] = args;
      const scopedParams = method === 'sessions.create' ? { ...params, catalogId: 'command-center' } : params;
      return request(method, scopedParams, options);
    }
  });
}

// Construct only inside an authenticated plugin HTTP handler. The pinned
// host binds dispatchGatewayMethod to that request scope and refuses detached
// plugin calls.
export function createRequestScopedGatewayRequest(dispatchGatewayMethod) {
  if (dispatchGatewayMethod !== undefined && typeof dispatchGatewayMethod !== 'function') throw new TypeError('dispatchGatewayMethod must be a function');
  return async (method, params, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'requestId')) throw sourceError('invalid-request', 'Gateway request options are closed.');
    if (method === 'sessions.create') {
      const requestId = options.requestId;
      const idempotencyKey = params?.idempotencyKey;
      if (typeof requestId !== 'string' || requestId !== idempotencyKey) throw sourceError('invalid-request', 'sessions.create requires its logical operation ID as the exact request and idempotency identity.');
      if (typeof params?.agentId !== 'string' || params.agentId.trim() === '' || typeof params?.label !== 'string' || params.label.trim() === '' || Object.hasOwn(params, 'key') || Object.hasOwn(params, 'agentHarnessId')) throw sourceError('invalid-request', 'sessions.create requires agentId and label without a caller-selected Session owner or key.');
      params = { ...params, catalogId: 'command-center' };
    }
    const dispatch = dispatchGatewayMethod ?? (await import('openclaw/plugin-sdk/gateway-method-runtime')).dispatchGatewayMethod;
    if (typeof dispatch !== 'function') throw sourceError('capability-unavailable', 'Authenticated Gateway dispatch is unavailable.');
    const response = await dispatch(method, params, { expectFinal: true, timeoutMs: DISPATCH_TIMEOUT_MS });
    if (!response || response.ok !== true) {
      const code = typeof response?.error?.code === 'string' ? response.error.code.toLowerCase().replaceAll('_', '-') : 'unavailable';
      throw sourceError(code, `The authenticated ${method} request was refused.`, {
        method,
        retryable: response?.error?.retryable === true
      });
    }
    if (!Object.hasOwn(response, 'payload')) throw sourceError('unavailable', `The authenticated ${method} response omitted its payload.`, { method, retryable: false });
    return response.payload;
  };
}
