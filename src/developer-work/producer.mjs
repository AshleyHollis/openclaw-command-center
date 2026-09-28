import { readBoundedJson } from '../http/json-body.mjs';
import { developerEventRoute } from './http-route.mjs';

const MAX_RECEIPT_BYTES = 4096;

function opaque(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s|:\/\//u.test(value);
}

export function createDeveloperEventTransport({ baseUrl, tokenEnv, env = process.env, fetchImpl = fetch } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !/^\/[A-Za-z0-9/_-]*$/u.test(base.pathname)) throw new TypeError('Developer Work receiver must use a credential-free HTTPS base URL.');
  if (typeof tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{7,127}$/u.test(tokenEnv)) throw new TypeError('Developer Work credential reference is invalid.');
  const endpoint = new URL(`${base.pathname.replace(/\/$/u, '')}${developerEventRoute}`, base.origin);
  return Object.freeze({
    async send(event, { watermark } = {}) {
      if (!Number.isSafeInteger(watermark) || watermark < event.workRevision || watermark > event.workRevision + 500) throw Object.assign(new Error('Developer Work delivery watermark is invalid.'), { code: 'delivery-watermark-invalid' });
      const credential = env[tokenEnv];
      if (typeof credential !== 'string' || credential.length < 32 || credential.length > 512) throw Object.assign(new Error('Developer Work credential is unavailable.'), { code: 'credential-unavailable' });
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'x-developer-work-watermark': String(watermark) },
        body: JSON.stringify(event)
      });
      if (![200, 202].includes(response.status) || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) throw Object.assign(new Error('Developer Work receipt was not confirmed.'), { code: `receiver-http-${response.status}` });
      let envelope;
      try { envelope = (await readBoundedJson(response.body, MAX_RECEIPT_BYTES)).body; }
      catch { throw Object.assign(new Error('Developer Work receiver returned an invalid receipt.'), { code: 'receiver-receipt-invalid' }); }
      if (envelope?.schemaVersion !== 1 || envelope.status !== 'accepted' || !envelope.receipt) throw Object.assign(new Error('Developer Work receiver returned an invalid receipt.'), { code: 'receiver-receipt-invalid' });
      return envelope.receipt;
    }
  });
}

function deliveryFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : 'receiver-unavailable';
  const status = /^receiver-http-([0-9]{3})$/u.exec(code);
  const paused = ['credential-unavailable', 'receiver-receipt-invalid', 'developer-receipt-conflict'].includes(code)
    || status && Number(status[1]) >= 400 && Number(status[1]) < 500 && ![408, 429].includes(Number(status[1]));
  return { code, paused: Boolean(paused) };
}

export function createDeveloperWorkProducer({ metadata, sessionReader, authority, receiver, now = () => Date.now() } = {}) {
  if (!metadata?.submitDeveloperWork || !metadata?.reconcileDeveloperProducerEvent || !metadata?.listPendingDeveloperDeliveries || !metadata?.recordDeveloperDeliveryFailure || !metadata?.resumeDeveloperDelivery || !metadata?.getDeveloperProducerRequest || typeof sessionReader !== 'function' || !authority || typeof authority.producerId !== 'string') throw new TypeError('Developer Work producer requires metadata, session read, and fixed authority.');
  let closed = false;
  let flushing = null;
  const assertOpen = () => { if (closed) throw Object.assign(new Error('Developer Work producer is closed.'), { code: 'producer-closed' }); };

  function flush({ resumePaused = false } = {}) {
    assertOpen();
    const run = (flushing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const failedWork = new Set();
      let delivered = 0;
      let attempted = 0;
      let deferred = 0;
      let paused = 0;
      // Freeze each work's highest queued revision for this delivery pass.
      // Events submitted while sends are awaiting a reply belong to a later pass.
      const pending = metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId, limit: 500 });
      const watermarks = new Map();
      for (const item of pending) watermarks.set(item.workId, Math.max(item.workRevision, watermarks.get(item.workId) ?? 0));
      for (const item of pending) {
        if (failedWork.has(item.workId) || attempted >= 10) continue;
        const diagnostic = item.deliveryDiagnostic?.paused && resumePaused
          ? metadata.resumeDeveloperDelivery({ producerId: authority.producerId, eventId: item.eventId, observedAtMs: now() }).deliveryDiagnostic
          : item.deliveryDiagnostic;
        if (diagnostic?.paused || diagnostic?.nextAttemptAtMs > now()) {
          failedWork.add(item.workId);
          if (diagnostic?.paused) paused += 1;
          else deferred += 1;
          continue;
        }
        assertOpen();
        attempted += 1;
        try {
          const receipt = await receiver.send(item.event, { watermark: watermarks.get(item.workId) });
          assertOpen();
          metadata.markDeveloperDelivery({ producerId: authority.producerId, eventId: item.eventId, receiverReceipt: receipt });
          delivered += 1;
        } catch (error) {
          if (closed) assertOpen();
          const failure = deliveryFailure(error);
          metadata.recordDeveloperDeliveryFailure({ producerId: authority.producerId, eventId: item.eventId, ...failure, observedAtMs: now() });
          failedWork.add(item.workId);
          if (failure.paused) paused += 1;
          else deferred += 1;
        }
      }
      return Object.freeze({ delivered, attempted, deferred, paused, pending: metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId, limit: 500 }).length });
    });
    flushing = run;
    run.finally(() => { if (flushing === run) flushing = null; }).catch(() => {});
    return run;
  }

  // The owning synchronous SQLite commit is the only work allowed inside a
  // held host admission. Network delivery remains a separate async operation.
  function commit({ logicalOperationId, draft, assertSourceCurrent } = {}) {
    assertOpen();
    if (draft?.session && typeof assertSourceCurrent !== 'function') throw Object.assign(new Error('Bound work requires synchronous source admission.'), { code: 'source-admission-required' });
    return metadata.submitDeveloperWork({ authority, logicalOperationId, draft, assertSourceCurrent });
  }

  function reconcile({ logicalOperationId, draft } = {}) {
    assertOpen();
    return metadata.reconcileDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId, draft });
  }

  async function submit(input = {}) {
    const row = commit(input);
    if (receiver) await flush();
    return metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId: input.logicalOperationId }) ?? row;
  }

  async function resolve({ schemaVersion, workId, requestId } = {}) {
    assertOpen();
    if (schemaVersion !== 1 || !opaque(workId) || requestId !== undefined && !opaque(requestId)) throw Object.assign(new Error('Developer Work target is invalid.'), { code: 'invalid-request' });
    if (requestId === undefined) {
      const requests = metadata.listDeveloperProducerRequests({ producerId: authority.producerId, workId }).map(row => Object.freeze({ requestId: row.requestId, kind: row.kind, revision: row.revision, summary: row.event.request?.summary ?? 'Development request' }));
      return Object.freeze({ schemaVersion: 1, status: 'current-work', workId, requests });
    }
    const row = metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId, requestId });
    if (!row || row.state !== 'active' || !row.event.session) return Object.freeze({ schemaVersion: 1, status: 'stale', reason: !row ? 'request-missing' : row.state !== 'active' ? 'request-ended' : 'session-binding-missing', workId, requestId });
    const expected = row.event.session;
    const expired = event => event.request?.expiresAt !== undefined && !(Date.parse(event.request.expiresAt) > now());
    if (expired(row.event)) return Object.freeze({ schemaVersion: 1, status: 'stale', reason: 'request-expired', workId, requestId });
    let entry;
    try { entry = await sessionReader({ agentId: expected.agentId, sessionKey: expected.sessionKey, readConsistency: 'latest' }); }
    catch { return Object.freeze({ schemaVersion: 1, status: 'unavailable', reason: 'session-read-unavailable', workId, requestId }); }
    assertOpen();
    const current = metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId, requestId });
    if (!current || current.revision !== row.revision || current.lastEventId !== row.lastEventId || current.state !== 'active') return Object.freeze({ schemaVersion: 1, status: 'stale', reason: 'request-changed', workId, requestId });
    if (expired(current.event)) return Object.freeze({ schemaVersion: 1, status: 'stale', reason: 'request-expired', workId, requestId });
    // The plugin runtime reader is scoped by the exact agent/key but returns a
    // raw SessionEntry (no identity fields). Adapters that do return identity
    // must agree; the native Gateway reader separately verifies both fields.
    if (!entry || typeof entry !== 'object' ||
        'agentId' in entry && entry.agentId !== expected.agentId ||
        'sessionKey' in entry && entry.sessionKey !== expected.sessionKey ||
        !entry.lifecycleRevision || entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision) return Object.freeze({ schemaVersion: 1, status: 'stale', reason: 'session-replaced', workId, requestId });
    return Object.freeze({ schemaVersion: 1, status: 'ready', workId, requestId, requestRevision: row.revision, agentId: expected.agentId, sessionKey: expected.sessionKey, sessionId: expected.sessionId, lifecycleRevision: expected.lifecycleRevision, summary: row.event.request.summary ?? 'Development request' });
  }

  return Object.freeze({ commit, reconcile, submit, flush, resolve, close() { closed = true; } });
}
