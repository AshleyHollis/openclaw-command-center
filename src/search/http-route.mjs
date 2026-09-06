import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { readBoundedJson } from '../http/json-body.mjs';

export const searchRebuildRoute = '/plugins/command-center/api/search/rebuild';
const fields = Object.freeze(['schemaVersion', 'topicId', 'logicalOperationId']);
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid-request' });

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

async function parse(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw invalid('JSON content type is required.');
  const { body } = await readBoundedJson(req, 2048);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) throw invalid('A closed Search rebuild request is required.');
  if (body.schemaVersion !== 1 || !isCanonicalUuid(body.topicId) || !isCanonicalUuid(body.logicalOperationId)) throw invalid('Schema version 1 and canonical Topic and operation IDs are required.');
  return body;
}

export function createSearchRebuildHttpHandler(service) {
  return async (req, res) => {
    if (req.method !== 'POST') { send(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed', message: 'Search rebuild is POST-only.' }); return true; }
    try {
      const body = await parse(req);
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
