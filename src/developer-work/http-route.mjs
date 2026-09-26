import { createHash, timingSafeEqual } from 'node:crypto';
import { readBoundedJson } from '../http/json-body.mjs';
import { DEVELOPER_EVENT_MAX_BYTES } from './contract.mjs';

export const developerEventRoute = '/plugins/command-center/api/v1/developer-events';

const eventFamilies = Object.freeze({
  human_input_required: 'human-request',
  product_decision_required: 'human-request',
  approval_required: 'human-request',
  feature_ready_for_review: 'human-request',
  request_resolved: 'request-terminal',
  request_withdrawn: 'request-terminal',
  feature_completed: 'work-outcome',
  validation_completed: 'work-outcome',
  production_deployment_failed: 'deployment-control',
  production_rollback: 'deployment-control',
  production_recovered: 'deployment-control',
  deployment_succeeded: 'deployment-outcome'
});

function reply(res, statusCode, payload, headers = {}) {
  res.statusCode = statusCode;
  res.setHeader?.('content-type', 'application/json; charset=utf-8');
  res.setHeader?.('cache-control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader?.(name, value);
  res.end?.(JSON.stringify(payload));
  return true;
}

function secureTransport(req, trustedProxyPeers) {
  if (req.socket?.encrypted === true || req.connection?.encrypted === true) return true;
  const peer = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  return typeof peer === 'string' && trustedProxyPeers.includes(peer) && req.headers?.['x-forwarded-proto'] === 'https';
}

function principalFor(header, principals, env) {
  if (typeof header !== 'string' || !/^Bearer \S{32,512}$/u.test(header)) return null;
  const candidate = createHash('sha256').update(header.slice(7)).digest();
  let match = null;
  for (const principal of principals) {
    const credential = env[principal.tokenEnv];
    if (typeof credential !== 'string' || credential.length < 32 || credential.length > 512) continue;
    if (timingSafeEqual(candidate, createHash('sha256').update(credential).digest())) {
      if (match) return null;
      match = principal;
    }
  }
  return match;
}

export function createDeveloperEventHandler({ service, principals = [], trustedProxyPeers = [], env = process.env, now = () => Date.now(), limitPerMinute = 60 } = {}) {
  if (typeof service?.accept !== 'function') throw new TypeError('Developer Work ingress requires a receipt owner.');
  const windows = new Map();
  return async (req, res) => {
    if (req.method !== 'POST') return reply(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed' });
    if (!secureTransport(req, trustedProxyPeers)) return reply(res, 403, { schemaVersion: 1, status: 'error', code: 'secure-transport-required' });
    if (req.headers?.origin || req.headers?.cookie) return reply(res, 403, { schemaVersion: 1, status: 'error', code: 'machine-only' });
    const principal = principalFor(req.headers?.authorization, principals, env);
    if (!principal) return reply(res, 401, { schemaVersion: 1, status: 'error', code: 'unauthorized' });
    const authority = JSON.stringify({ tokenEnv: principal.tokenEnv, producerId: principal.producerId, role: principal.role, allowedProjects: principal.allowedProjects, families: principal.families });
    const assertAuthorityCurrent = () => {
      const current = principalFor(req.headers?.authorization, principals, env);
      if (current !== principal || JSON.stringify({ tokenEnv: current.tokenEnv, producerId: current.producerId, role: current.role, allowedProjects: current.allowedProjects, families: current.families }) !== authority) {
        throw Object.assign(new Error('Developer Work principal was revoked or changed.'), { code: 'unauthorized' });
      }
    };
    const current = now();
    const window = windows.get(principal.producerId);
    const active = window && current - window.startedAt < 60_000 ? window : { startedAt: current, count: 0 };
    active.count += 1;
    windows.set(principal.producerId, active);
    if (active.count > limitPerMinute) return reply(res, 429, { schemaVersion: 1, status: 'error', code: 'rate-limited' }, { 'retry-after': String(Math.max(1, Math.ceil((active.startedAt + 60_000 - current) / 1000))) });
    if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) return reply(res, 415, { schemaVersion: 1, status: 'error', code: 'json-required' });
    try {
      const { body } = await readBoundedJson(req, DEVELOPER_EVENT_MAX_BYTES, { oversizeCode: 'body-too-large' });
      if (!principal.families?.includes(eventFamilies[body?.eventType])) return reply(res, 403, { schemaVersion: 1, status: 'error', code: 'event-family-denied' });
      const watermarkHeader = req.headers?.['x-developer-work-watermark'];
      if (watermarkHeader !== undefined && (typeof watermarkHeader !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(watermarkHeader) || !Number.isSafeInteger(Number(watermarkHeader)))) throw Object.assign(new Error('Invalid delivery watermark.'), { code: 'delivery-watermark-invalid' });
      const receipt = await service.accept({ producerId: principal.producerId, role: principal.role, allowedProjects: principal.allowedProjects, event: body, assertAuthorityCurrent,
        ...(watermarkHeader !== undefined ? { watermark: Number(watermarkHeader) } : {}) });
      return reply(res, receipt.projectionState === 'projected' ? 200 : 202, { schemaVersion: 1, status: 'accepted', receipt });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'invalid-request';
      const status = code === 'unauthorized' ? 401 : code === 'body-too-large' ? 413 : code === 'developer-event-backpressure' ? 429 : code === 'capability-unavailable' || code === 'recovery-only' ? 503 : /(?:stale|gap|conflict|terminal|order|missing)$/u.test(code) ? 409 : 400;
      return reply(res, status, { schemaVersion: 1, status: 'error', code }, status === 429 ? { 'retry-after': '60' } : {});
    }
  };
}
