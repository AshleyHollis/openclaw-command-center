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
    async send(event) {
      const credential = env[tokenEnv];
      if (typeof credential !== 'string' || credential.length < 32 || credential.length > 512) throw Object.assign(new Error('Developer Work credential is unavailable.'), { code: 'credential-unavailable' });
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(event)
      });
      if (![200, 202].includes(response.status) || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) throw Object.assign(new Error('Developer Work receipt was not confirmed.'), { code: `receiver-http-${response.status}` });
      const envelope = (await readBoundedJson(response.body, MAX_RECEIPT_BYTES)).body;
      if (envelope?.schemaVersion !== 1 || envelope.status !== 'accepted' || !envelope.receipt) throw Object.assign(new Error('Developer Work receiver returned an invalid receipt.'), { code: 'receiver-receipt-invalid' });
      return envelope.receipt;
    }
  });
}

export function createDeveloperWorkProducer({ metadata, sessionReader, authority, receiver } = {}) {
  if (!metadata?.submitDeveloperWork || !metadata?.listPendingDeveloperDeliveries || !metadata?.getDeveloperProducerRequest || typeof sessionReader !== 'function' || !authority || typeof authority.producerId !== 'string') throw new TypeError('Developer Work producer requires metadata, session read, and fixed authority.');
  let closed = false;
  let flushing = null;
  const assertOpen = () => { if (closed) throw Object.assign(new Error('Developer Work producer is closed.'), { code: 'producer-closed' }); };

  function flush() {
    assertOpen();
    const run = (flushing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const failedWork = new Set();
      let delivered = 0;
      let attempted = 0;
      for (;;) {
        assertOpen();
        const pending = metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId, limit: 100 });
        if (!pending.length) return Object.freeze({ delivered, attempted, pending: 0 });
        let madeProgress = false;
        for (const item of pending) {
          if (failedWork.has(item.workId)) continue;
          if (attempted >= 10) return Object.freeze({ delivered, attempted, pending: metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId, limit: 500 }).length });
          assertOpen();
          attempted += 1;
          try {
            const receipt = await receiver.send(item.event);
            assertOpen();
            metadata.markDeveloperDelivery({ producerId: authority.producerId, eventId: item.eventId, receiverReceipt: receipt });
            delivered += 1;
            madeProgress = true;
          } catch { if (closed) assertOpen(); failedWork.add(item.workId); }
        }
        if (!madeProgress || failedWork.size && pending.every(item => failedWork.has(item.workId))) return Object.freeze({ delivered, attempted, pending: metadata.listPendingDeveloperDeliveries({ producerId: authority.producerId, limit: 500 }).length });
      }
    });
    flushing = run;
    run.finally(() => { if (flushing === run) flushing = null; }).catch(() => {});
    return run;
  }

  async function submit({ logicalOperationId, draft, assertSourceCurrent } = {}) {
    assertOpen();
    const row = metadata.submitDeveloperWork({ authority, logicalOperationId, draft, assertSourceCurrent });
    if (receiver) await flush();
    return metadata.getDeveloperProducerEvent({ producerId: authority.producerId, logicalOperationId }) ?? row;
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
    let entry;
    try { entry = await sessionReader({ agentId: expected.agentId, sessionKey: expected.sessionKey, readConsistency: 'latest' }); }
    catch { return Object.freeze({ schemaVersion: 1, status: 'unavailable', reason: 'session-read-unavailable', workId, requestId }); }
    assertOpen();
    const current = metadata.getDeveloperProducerRequest({ producerId: authority.producerId, workId, requestId });
    if (!current || current.revision !== row.revision || current.lastEventId !== row.lastEventId || current.state !== 'active') return Object.freeze({ schemaVersion: 1, status: 'stale', reason: 'request-changed', workId, requestId });
    if (!entry || entry.sessionId !== expected.sessionId || entry.lifecycleRevision !== expected.lifecycleRevision) return Object.freeze({ schemaVersion: 1, status: 'stale', reason: 'session-replaced', workId, requestId });
    return Object.freeze({ schemaVersion: 1, status: 'ready', workId, requestId, requestRevision: row.revision, agentId: expected.agentId, sessionKey: expected.sessionKey, sessionId: expected.sessionId, lifecycleRevision: expected.lifecycleRevision, summary: row.event.request.summary ?? 'Development request' });
  }

  return Object.freeze({ submit, flush, resolve, close() { closed = true; } });
}
