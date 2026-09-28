import { createDeveloperWorkProducer } from './producer.mjs';

// Caller supplies an authenticated Gateway connection. No plugin or credentials here.
export function createNativeDeveloperSessionReader({ request } = {}) {
  if (typeof request !== 'function') throw new TypeError('An authenticated Gateway request function is required.');
  return async ({ agentId, sessionKey, readConsistency } = {}) => {
    if (readConsistency !== 'latest' || typeof agentId !== 'string' || !agentId || agentId.includes(':') ||
        typeof sessionKey !== 'string' || !sessionKey.startsWith(`agent:${agentId}:`) ||
        sessionKey === `agent:${agentId}:`) throw new TypeError('An exact DEV session is required.');
    const result = await request('sessions.describe', { key: sessionKey, agentId });
    // A null or legacy response without a lifecycle read is not a usable proof.
    if (result?.session?.key !== sessionKey || typeof result.session.agentId !== 'string' ||
        !result.session.agentId.trim() || result.session.agentId !== agentId ||
        typeof result.session.sessionId !== 'string' || !result.session.sessionId.trim() ||
        typeof result.lifecycleRevision !== 'string' ||
        !result.lifecycleRevision.trim()) return null;
    return Object.freeze({ agentId: result.session.agentId, sessionKey, sessionId: result.session.sessionId, lifecycleRevision: result.lifecycleRevision });
  };
}

function nativeChatUrl(baseUrl, sessionKey) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      !new RegExp('^/[A-Za-z0-9/_-]*$').test(base.pathname)) throw new TypeError('Native Chat base must be a credential-free HTTPS path.');
  const target = new URL(`${(base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname)}/chat`, base.origin);
  target.searchParams.set('session', sessionKey);
  return target.href;
}

// Core only: embedding still must qualify invocation, authentication and
// commit-time session checks before using the existing producer submit owner.
export function createNativeDeveloperWorkCompanion({ metadata, authority, gatewayRequest, chatBaseUrl, now } = {}) {
  const sessionReader = createNativeDeveloperSessionReader({ request: gatewayRequest });
  nativeChatUrl(chatBaseUrl, 'agent:sample:main');
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader, now });
  return Object.freeze({
    async check(input) { return producer.resolve(input); },
    async chatTarget({ schemaVersion, workId, requestId } = {}) {
      if (requestId === undefined) throw new TypeError('An exact request is required.');
      const result = await producer.resolve({ schemaVersion, workId, requestId });
      if (result.status !== 'ready') return result;
      return Object.freeze({ ...result, url: nativeChatUrl(chatBaseUrl, result.sessionKey) });
    },
    close() { producer.close(); }
  });
}
