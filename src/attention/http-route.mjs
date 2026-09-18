import { readBoundedJson } from '../http/json-body.mjs';
import { validateBridgeRequest } from '../bridge/contracts.mjs';
import { allowOpaqueFrameRequest } from '../http/opaque-frame-cors.mjs';

async function readJsonBody(req) { return (await readBoundedJson(req, 32768)).body; }

export function createAttentionActionHandler() {
  return async (req, res) => {
    if (!allowOpaqueFrameRequest(req, res, { method: 'POST', headers: ['Content-Type'] })) { res.statusCode = 403; res.setHeader?.('content-type', 'application/json'); res.end?.(JSON.stringify({ schemaVersion: 1, status: 'unavailable', code: 'origin-not-allowed' })); return; }
    if (req?.method === 'OPTIONS') { res.statusCode = 204; res.setHeader?.('cache-control', 'no-store'); res.end?.(); return; }
    if (req?.method !== 'POST') { res.statusCode = 405; res.end?.(); return; }
    try {
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw new Error('JSON content type is required');
      const body = await readJsonBody(req);
      validateBridgeRequest('command-center.v1.attention.act', body);
      if (typeof body.sourceCapabilityId !== 'string' || body.sourceCapabilityId.trim() === '' || typeof body.stableSubjectId !== 'string' || body.stableSubjectId.trim() === '') throw new Error('exact source identity is required');
      if (['approval.approve', 'approval.reject'].includes(body.actionId) && (typeof body.approvalId !== 'string' || body.approvalId.trim() === '')) throw new Error('approvalId is required for approval decisions');
      // HTTP frame authorization cannot supply an authenticated operator or core Gateway scope.
      res.statusCode = 403;
      res.setHeader?.('content-type', 'application/json');
      res.end?.(JSON.stringify({ schemaVersion: 1, status: 'unavailable', code: 'authenticated-bridge-required' }));
    } catch {
      res.statusCode = 400; res.setHeader?.('content-type', 'application/json'); res.end?.(JSON.stringify({ schemaVersion: 1, status: 'unavailable' }));
    }
  };
}
