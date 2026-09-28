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

function localSourceGuard({ getSessionEntry, binding } = {}) {
  const prefix = binding && 'agent:' + binding.agentId + ':';
  if (typeof getSessionEntry !== 'function' || !binding ||
      typeof binding.agentId !== 'string' || !binding.agentId || binding.agentId.includes(':') ||
      typeof binding.sessionKey !== 'string' || !binding.sessionKey.startsWith(prefix) ||
      binding.sessionKey === prefix ||
      typeof binding.sessionId !== 'string' || !binding.sessionId.trim() ||
      typeof binding.lifecycleRevision !== 'string' || !binding.lifecycleRevision.trim()) {
    throw new TypeError('A fixed exact local DEV source binding is required.');
  }
  const expected = Object.freeze(Object.fromEntries(
    ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision'].map(key => [key, binding[key]])
  ));
  return { expected, assertCurrent(claimed) {
    if (!claimed || ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision'].some(key => claimed[key] !== expected[key])) {
      throw Object.assign(new Error('DEV source binding changed.'), { code: 'session-stale' });
    }
    // The installed-host SDK reads the same machine's canonical SQLite store
    // synchronously. Never pass a caller-supplied storePath or accept a Promise.
    const entry = getSessionEntry({ agentId: expected.agentId, sessionKey: expected.sessionKey, readConsistency: 'latest' });
    if (!entry || typeof entry.then === 'function' || entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision) {
      throw Object.assign(new Error('DEV session incarnation changed.'), { code: 'session-stale' });
    }
  } };
}

// Caller must separately qualify invocation, authentication and receiver transport.
// Local SDK reads require the same machine/state directory as the DEV Gateway.
export function createNativeDeveloperWorkCompanion({ metadata, authority, gatewayRequest, chatBaseUrl, localSource, now } = {}) {
  const sessionReader = createNativeDeveloperSessionReader({ request: gatewayRequest });
  nativeChatUrl(chatBaseUrl, 'agent:sample:main');
  const producer = createDeveloperWorkProducer({ metadata, authority, sessionReader, now });
  const guard = localSource === undefined ? null : localSourceGuard(localSource);
  return Object.freeze({
    ...(guard ? { async submit({ logicalOperationId, draft } = {}) {
      if (!draft?.session || ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision'].some(key => draft.session[key] !== guard.expected[key])) {
        throw Object.assign(new Error('DEV source binding changed.'), { code: 'session-stale' });
      }
      guard.assertCurrent(guard.expected);
      return producer.submit({ logicalOperationId, draft, assertSourceCurrent: guard.assertCurrent });
    } } : {}),
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
