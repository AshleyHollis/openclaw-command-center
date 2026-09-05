import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { allowOpaqueFrameRequest } from '../http/opaque-frame-cors.mjs';

const MAX_BODY = 64 * 1024;
function response(res, status, value) { const body = JSON.stringify(value); if (body.length > 256 * 1024) return response(res, 500, { status: 'error', code: 'bounded-response', message: 'Topic Analysis response exceeded its bound.' }); res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end(body); }
async function body(req) { let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { code: 'invalid-request' }); chunks.push(chunk); } if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Request body must be JSON.'), { code: 'invalid-request' }); } }
function closed(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw Object.assign(new Error('Request contains unsupported fields.'), { code: 'invalid-request' }); }
function failure(error) {
  const code = error?.code ?? 'invalid-request';
  const messages = { conflict: 'Topic Analysis request conflicts with newer state.', 'intent-mismatch': 'The logical operation identity was reused with different intent.', 'not-found': 'The requested Topic Review record was not found.', 'source-recovery': 'The requested Topic change requires source recovery.', 'invalid-request': 'Topic Analysis request was invalid.' };
  return { status: 'error', code, message: messages[code] ?? 'Topic Analysis request was refused.' };
}

export function createTopicAnalysisReadHttpHandler(service) {
  return async function topicAnalysisRead(req, res) {
    if (!allowOpaqueFrameRequest(req, res, { method: 'GET' })) return response(res, 403, { status: 'error', code: 'origin-not-allowed' });
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader?.('cache-control', 'no-store'); return res.end(); }
    if (req.method !== 'GET') return response(res, 405, { status: 'error', code: 'method-not-allowed' });
    try {
      const schedule = service.topicAnalysisSchedule?.peekSettings?.() ?? service.analysisSchedule?.peekSettings?.() ?? service.getTopicAnalysisSettings?.() ?? null;
      const runs = service.topicAnalysisRunner?.metadata?.listTopicAnalysisRuns?.() ?? service.listTopicAnalysisRuns?.() ?? [];
      const review = service.topicReview?.get?.() ?? service.review?.get?.() ?? service.getTopicReview?.() ?? null;
      return response(res, 200, { schemaVersion: 1, schedule, runs: runs.slice(-20), review });
    } catch (error) { return response(res, 503, failure(error)); }
  };
}

export function createTopicAnalysisActionsHttpHandler(service) {
  return async function topicAnalysisActions(req, res) {
    if (!allowOpaqueFrameRequest(req, res, { method: 'POST', headers: ['Content-Type'] })) return response(res, 403, { status: 'error', code: 'origin-not-allowed' });
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader?.('cache-control', 'no-store'); return res.end(); }
    if (req.method !== 'POST') return response(res, 405, { status: 'error', code: 'method-not-allowed' });
    try {
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers?.['content-type'] ?? ''))) throw Object.assign(new Error('JSON content type is required.'), { code: 'invalid-request' });
      const input = await body(req); closed(input, ['schemaVersion', 'action', 'logicalOperationId', 'expectedRevision', 'settings', 'trigger', 'proposalId', 'expectedProposalRevision', 'adjustment', 'reviewId', 'expectedReviewRevision', 'snoozedUntil', 'applicationId', 'planRevision', 'confirm', 'approvedProposalRevisions']);
      if (input.schemaVersion !== 1 || typeof input.action !== 'string' || !isCanonicalUuid(input.logicalOperationId)) throw Object.assign(new Error('Closed Topic Analysis action fields are required.'), { code: 'invalid-request' });
      let result;
      if (input.action === 'schedule.update') result = await (service.topicAnalysisSchedule ?? service.analysisSchedule).update(input);
      else if (input.action === 'analysis.run') result = await (service.topicAnalysisRun ? service.topicAnalysisRun({ ...input, trigger: input.trigger ?? 'manual' }) : (service.topicAnalysisRunner ?? service.analysisRunner).run({ ...input, trigger: input.trigger ?? 'manual' }));
      else if (['proposal.approve', 'proposal.adjust', 'proposal.keep-as-is'].includes(input.action)) { const { expectedProposalRevision: _expectedProposalRevision, ...decisionInput } = input; result = await (service.topicReview ?? service.review).decide({ ...decisionInput, action: input.action.slice('proposal.'.length), expectedRevision: input.expectedProposalRevision ?? input.expectedRevision }); }
      else if (input.action === 'review.snooze') { const { action: _action, expectedReviewRevision: _expectedReviewRevision, ...snoozeInput } = input; result = await (service.topicReview ?? service.review).snooze({ ...snoozeInput, expectedRevision: input.expectedReviewRevision ?? input.expectedRevision }); }
      else if (input.action === 'review.apply') result = input.confirm === true ? await (service.topicReview ?? service.review).apply(input) : await (service.topicReview ?? service.review).checkpoint(input);
      else throw Object.assign(new Error('Unknown Topic Analysis action.'), { code: 'invalid-request' });
      return response(res, 200, { status: 'ok', result });
    } catch (error) { return response(res, ['conflict', 'intent-mismatch'].includes(error?.code) ? 409 : error?.code === 'not-found' ? 404 : 400, failure(error)); }
  };
}

export const createTopicReviewReadHttpHandler = createTopicAnalysisReadHttpHandler;
export const createTopicReviewActionsHttpHandler = createTopicAnalysisActionsHttpHandler;
export const createAnalysisHttpHandler = createTopicAnalysisActionsHttpHandler;
