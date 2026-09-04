import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { normalizeNotificationSettings } from '../notifications/settings.mjs';
import { allowOpaqueFrameRequest } from '../http/opaque-frame-cors.mjs';
import { createRequestScopedGatewayRequest } from '../bridge/gateway-method-dispatch.mjs';

const MAX_BODY = 32_768;
function send(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = Buffer.byteLength(body) > MAX_BODY ? 507 : status;
  res.setHeader?.('content-type', 'application/json; charset=utf-8');
  res.setHeader?.('cache-control', 'no-store');
  res.end?.(res.statusCode === 507 ? JSON.stringify({ schemaVersion: 1, status: 'error', code: 'response-too-large' }) : body);
}
async function readBody(req) {
  if (req?.body && typeof req.body === 'object') { if (JSON.stringify(req.body).length > MAX_BODY) throw new Error('request body is too large'); return req.body; }
  if (typeof req?.body === 'string') return JSON.parse(req.body);
  if (typeof req?.readBody === 'function') return JSON.parse(await req.readBody());
  let body = '';
  for await (const chunk of req ?? []) { body += chunk; if (Buffer.byteLength(body) > MAX_BODY) throw new Error('request body is too large'); }
  return JSON.parse(body || '{}');
}
export function createDashboardReadHttpHandler(service) {
  return async (req, res) => {
    if (!allowOpaqueFrameRequest(req, res, { method: 'GET' })) { send(res, 403, { schemaVersion: 1, status: 'error', code: 'origin-not-allowed' }); return true; }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader?.('cache-control', 'no-store'); res.end?.(); return true; }
    if (req.method !== 'GET') { send(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed' }); return true; }
    try {
      const url = new URL(req.url ?? '/', 'http://command-center.invalid');
      const allowed = new Set(['activityOffset', 'activityLimit']);
      if ([...url.searchParams.keys()].some((field) => !allowed.has(field) || field === 'now' || field === 'currentTime')) throw new Error('closed dashboard query required');
      const runtime = { gateway: Object.freeze({ request: createRequestScopedGatewayRequest() }) };
      const result = await service.dashboard.get({ schemaVersion: 1, activityOffset: Number(url.searchParams.get('activityOffset') ?? 0), activityLimit: Number(url.searchParams.get('activityLimit') ?? 50) }, runtime);
      send(res, 200, { schemaVersion: 1, status: 'applied', result });
    } catch { send(res, 400, { schemaVersion: 1, status: 'error', code: 'invalid-request', message: 'Dashboard read failed.' }); }
    return true;
  };
}

export function createDashboardActionsHttpHandler(service) {
  return async (req, res) => {
    if (!allowOpaqueFrameRequest(req, res, { method: 'POST', headers: ['Content-Type'] })) { send(res, 403, { schemaVersion: 1, status: 'error', code: 'origin-not-allowed' }); return true; }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader?.('cache-control', 'no-store'); res.end?.(); return true; }
    if (req.method !== 'POST') { send(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed' }); return true; }
    try {
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw new Error('JSON content type is required');
      const body = await readBody(req);
      const allowed = ['schemaVersion', 'action', 'logicalOperationId', 'expectedRevision', 'settings'];
      if (!body || Object.keys(body).some((key) => !allowed.includes(key)) || body.schemaVersion !== 1 || body.action !== 'settings.update' || !isCanonicalUuid(body.logicalOperationId) || !Number.isInteger(body.expectedRevision) || !body.settings) throw new Error('closed dashboard action required');
      const { action: _action, ...settingsInput } = body;
      const result = await service.dashboardUpdateSettings(settingsInput);
      send(res, 200, { schemaVersion: 1, status: 'applied', result });
    } catch (error) { send(res, error?.code === 'conflict' ? 409 : 400, { schemaVersion: 1, status: 'error', code: error?.code ?? 'invalid-request', message: 'Dashboard action failed.' }); }
    return true;
  };
}

export function validateDashboardSettingsPayload(value) { return normalizeNotificationSettings(value); }
