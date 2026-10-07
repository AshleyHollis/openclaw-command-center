import { sourceError } from '../sources/errors.mjs';
import { nativePlanSourceSelection } from './native-source.mjs';

// This adapter uses the host's authenticated dispatcher. Custody is minted and
// consumed by native code; neither the capability nor the guard is RPC JSON.
export function createNativePlanGatewayAdapter({ sdk, gateway, assertCurrent }) {
  const request = gateway?.request;
  const sync = guard => { const result = guard(); if (result?.then) { void Promise.resolve(result).catch(() => {}); throw sourceError('capability-unavailable', 'Source admission guards must be synchronous.'); } };
  const assertAvailable = () => {
    sync(assertCurrent);
    if (typeof request !== 'function' || gateway.request !== request || typeof sdk?.assertSessionTranscriptGatewaySourceAdmissionAvailable !== 'function' || sdk.SESSION_TRANSCRIPT_GATEWAY_SOURCE_ADMISSION_VERSION !== 1) throw sourceError('capability-unavailable', 'Native authenticated source admission is unavailable.');
    try { sdk.assertSessionTranscriptGatewaySourceAdmissionAvailable(gateway); }
    catch { throw sourceError('capability-unavailable', 'The actual Gateway host lacks source admission version 1.'); }
    sync(assertCurrent);
  };
  return Object.freeze({
    assertAvailable,
    async create(params, { source, assertCurrent: ownerGuard }) {
      assertAvailable();
      const selection = nativePlanSourceSelection(source);
      if (params.agentId !== selection.agentId || params.sessionKey !== selection.sessionKey || typeof ownerGuard !== 'function') throw sourceError('invalid-request', 'Plan creation must retain its exact source Session, agent and owner guard.');
      const guard = () => { assertAvailable(); sync(ownerGuard); assertAvailable(); };
      guard();
      let result;
      try { result = await request.call(gateway, 'workboard.cards.create', params, { timeoutMs: 45000, sessionTranscriptSource: Object.freeze({ selection, assertCurrent: guard }) }); }
      catch (error) {
        assertAvailable();
        // A sent local deadline is uncertainty, never proof of non-creation.
        if (error?.code === 'CLIENT_TIMEOUT' && error.method === 'workboard.cards.create' && error.requestSent === true) throw sourceError('timeout', 'Native plan creation did not return a confirmed receipt.');
        if (sdk.isGatewayClientRequestError?.(error)) {
          const code = String(error.gatewayCode).toLowerCase().replaceAll('_', '-');
          throw sourceError(['conflict', 'workboard-conflict'].includes(code) ? 'conflict' : ['invalid-request', 'not-found', 'unavailable'].includes(code) ? code : 'unavailable', 'The authenticated native plan request was refused.');
        }
        throw error;
      }
      guard();
      return result;
    }
  });
}
