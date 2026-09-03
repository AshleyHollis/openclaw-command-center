import { sanitizeBridgeResult, validateBridgeRequest } from '../bridge/contracts.mjs';
import { allowOpaqueFrameRequest } from '../http/opaque-frame-cors.mjs';

async function readJsonBody(req) {
  if (req?.body && typeof req.body === 'object') { if (JSON.stringify(req.body).length > 32768) throw new Error('request body is too large'); return req.body; }
  if (typeof req?.body === 'string') { if (req.body.length > 32768) throw new Error('request body is too large'); return JSON.parse(req.body); }
  if (typeof req?.readBody === 'function') { const body = await req.readBody(); if (body.length > 32768) throw new Error('request body is too large'); return JSON.parse(body); }
  if (req && typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.setEncoding?.('utf8');
      req.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 32768) { reject(new Error('request body is too large')); req.destroy?.(); return; }
        body += chunk;
      });
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } });
      req.on('error', reject);
    });
  }
  return {};
}

export function createAttentionActionHandler(service) {
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
      const current = await service.attentionGet({ schemaVersion: 1, episodeId: body.episodeId });
      if (!current?.episode || current.episode.sourceCapabilityId !== body.sourceCapabilityId || current.episode.stableSubjectId !== body.stableSubjectId) throw new Error('source identity does not match the episode');
      const { sourceCapabilityId: _sourceCapabilityId, stableSubjectId: _stableSubjectId, ...action } = body;
      const result = await service.attentionAct(action);
      await service.notificationReconcile?.();
      const bounded = sanitizeBridgeResult('command-center.v1.attention.act', result);
      const payload = JSON.stringify({ schemaVersion: 1, status: result?.status ?? 'applied', result: bounded });
      if (payload.length > 32768) throw new Error('response is too large');
      res.statusCode = 200; res.setHeader?.('content-type', 'application/json'); res.end?.(payload);
    } catch {
      res.statusCode = 400; res.setHeader?.('content-type', 'application/json'); res.end?.(JSON.stringify({ schemaVersion: 1, status: 'unavailable' }));
    }
  };
}
