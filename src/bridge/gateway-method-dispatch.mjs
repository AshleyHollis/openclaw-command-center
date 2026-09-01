import { dispatchGatewayMethod as hostDispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { sourceError } from '../sources/errors.mjs';

// A pinned sessions.create can include durable catalog publication. Keep its
// transport bound below the 240-second scenario budget while reserving time
// for exact sessions.list readback and cleanup.
const DISPATCH_TIMEOUT_MS = 45_000;

// Construct only inside an authenticated plugin Gateway handler. The pinned
// host binds dispatchGatewayMethod to that request scope and refuses detached
// plugin calls.
export function createRequestScopedGatewayRequest(dispatchGatewayMethod = hostDispatchGatewayMethod) {
  if (typeof dispatchGatewayMethod !== 'function') throw new TypeError('dispatchGatewayMethod is required');
  return async (method, params, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'requestId')) throw sourceError('invalid-request', 'Gateway request options are closed.');
    if (method === 'sessions.create') {
      const requestId = options.requestId;
      const idempotencyKey = params?.idempotencyKey;
      if (typeof requestId !== 'string' || requestId !== idempotencyKey) throw sourceError('invalid-request', 'sessions.create requires its logical operation ID as the exact request and idempotency identity.');
      if (typeof params?.agentId !== 'string' || params.agentId.trim() === '' || typeof params?.label !== 'string' || params.label.trim() === '' || Object.hasOwn(params, 'key') || Object.hasOwn(params, 'agentHarnessId')) throw sourceError('invalid-request', 'sessions.create requires agentId and label without a caller-selected Session owner or key.');
    }
    const response = await dispatchGatewayMethod(method, params, { expectFinal: true, timeoutMs: DISPATCH_TIMEOUT_MS });
    if (!response || response.ok !== true) {
      const code = typeof response?.error?.code === 'string' ? response.error.code : 'unavailable';
      throw sourceError(code, `The authenticated ${method} request was refused.`, {
        method,
        retryable: response?.error?.retryable === true
      });
    }
    if (!Object.hasOwn(response, 'payload')) throw sourceError('unavailable', `The authenticated ${method} response omitted its payload.`, { method, retryable: false });
    return response.payload;
  };
}
