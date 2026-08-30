import { isCanonicalUuid } from '../sources/operation-journal.mjs';

export const searchRebuildRoute = '/plugins/command-center/api/search/rebuild';
const fields = Object.freeze(['schemaVersion', 'topicId', 'logicalOperationId']);
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid-request' });

function allowOpaqueFrame(req, res) {
  const origin = req.headers?.origin;
  const requestedMethod = String(req.headers?.['access-control-request-method'] ?? '').toUpperCase();
  const requestedHeaders = String(req.headers?.['access-control-request-headers'] ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const validPreflight = req.method !== 'OPTIONS' || (requestedMethod === 'POST' && requestedHeaders.length === 1 && requestedHeaders[0] === 'content-type');
  if ((origin !== undefined && origin !== 'null') || !validPreflight) return false;
  res.setHeader?.('Access-Control-Allow-Origin', 'null');
  res.setHeader?.('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader?.('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader?.('Vary', 'Origin');
  return true;
}

function send(res, statusCode, value) {
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 4096) {
    statusCode = 507;
    body = JSON.stringify({ schemaVersion: 1, status: 'error', code: 'response-too-large', message: 'Search rebuild evidence exceeded its bounded limit.' });
  }
  res.statusCode = statusCode;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end(body);
}

function parse(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw invalid('JSON content type is required.');
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) throw invalid('A closed Search rebuild request is required.');
  if (body.schemaVersion !== 1 || !isCanonicalUuid(body.topicId) || !isCanonicalUuid(body.logicalOperationId)) throw invalid('Schema version 1 and canonical Topic and operation IDs are required.');
  return body;
}

export function createSearchRebuildHttpHandler(service) {
  return async (req, res) => {
    if (!allowOpaqueFrame(req, res)) { send(res, 403, { schemaVersion: 1, status: 'error', code: 'origin-not-allowed', message: 'Search rebuild origin is not allowed.' }); return true; }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
    if (req.method !== 'POST') { send(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed', message: 'Search rebuild is POST-only.' }); return true; }
    try {
      const body = parse(req);
      if (Buffer.byteLength(JSON.stringify(body)) > 2048) throw invalid('Search rebuild request is too large.');
      const result = await service.searchRebuild(body);
      const projections = [result?.notes?.projectionId, result?.conversations?.projectionId].filter((value) => typeof value === 'string').sort();
      send(res, 200, { schemaVersion: 1, status: 'applied', logicalOperationId: body.logicalOperationId, result: { topicId: body.topicId, topicIds: result?.topicIds ?? [body.topicId], projections } });
    } catch (error) {
      const code = String(error?.code ?? 'invalid-request');
      send(res, code === 'invalid-request' ? 400 : code === 'intent-mismatch' || code === 'conflict' ? 409 : 422, { schemaVersion: 1, status: 'error', code, message: 'Search rebuild was not applied.' });
    }
    return true;
  };
}
