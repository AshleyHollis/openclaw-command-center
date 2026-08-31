import { dispatchGatewayMethod as hostDispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { sourceError } from '../sources/errors.mjs';

const DISPATCH_TIMEOUT_MS = 10_000;

// Reserved for authenticated host routes that explicitly opt into request-scoped
// Gateway dispatch. Ordinary Topic Session creation uses api.runtime.gateway,
// whose pinned plugin wrapper enforces Session ownership before dispatch.
export function createRequestScopedGatewayRequest(dispatchGatewayMethod = hostDispatchGatewayMethod) {
  if (typeof dispatchGatewayMethod !== 'function') throw new TypeError('dispatchGatewayMethod is required');
  return async (method, params) => {
    const response = await dispatchGatewayMethod(method, params, { expectFinal: true, timeoutMs: DISPATCH_TIMEOUT_MS });
    if (!response || response.ok !== true) {
      const code = typeof response?.error?.code === 'string' ? response.error.code : 'unavailable';
      throw sourceError(code, `The authenticated ${method} request was refused.`, {
        method,
        retryable: response?.error?.retryable === true
      });
    }
    return response.payload;
  };
}
