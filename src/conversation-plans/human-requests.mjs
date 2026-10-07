// Native transient requests are the only admission evidence. Workboard status,
// progress_card, notifications and prose never become human-action requests.
import { planDigest } from './contract.mjs';

// Pending-list absence is uncertainty, never proof of an answer or approval.
// Result review has no qualified native owner on the pinned fork; its optional
// verifier is an explicitly injected adapter seam, not a new native RPC.
export async function verifyPlanHumanRequest({ card, request, known, nativeRequest, assertCurrent, now = Date.now, verifyResultReview }) {
  assertCurrent();
  const unknown = { availability: 'unavailable' };
  const result = (state, identity) => ({ availability: 'available', state, request: identity, observedAtMs: now() });
  const attempt = (card.metadata?.attempts ?? []).findLast(item => item.sessionKey === card.sessionKey && item.runId === card.runId);
  if (known && request.requestRevision && (card.status === 'done' || request.expiresAtMs <= now() || request.kind !== 'requested-result-review' && ['failed', 'stopped', 'succeeded'].includes(attempt?.status))) return result('withdrawn', request);
  if (request.kind === 'requested-result-review') return typeof verifyResultReview === 'function' ? verifyResultReview({ card, request, known, assertCurrent }) : unknown;
  try {
    const response = request.kind === 'question' ? await nativeRequest('question.get', { id: request.id }) : await nativeRequest('exec.approval.list', {});
    assertCurrent();
    const native = request.kind === 'question' ? response?.question : Array.isArray(response) ? response.find(item => item.id === request.id && item.approvalKind === 'exec') : null;
    const link = request.kind === 'question' ? native : native?.request;
    if (!native || native.id !== request.id || !card.sessionKey || !card.runId || link?.sessionKey !== card.sessionKey || link?.runId !== card.runId || !Number.isSafeInteger(native.createdAtMs) || !Number.isSafeInteger(native.expiresAtMs)) return unknown;
    const immutable = request.kind === 'question' ? { id: native.id, sessionKey: native.sessionKey, runId: native.runId, createdAtMs: native.createdAtMs, expiresAtMs: native.expiresAtMs, questions: native.questions } : { id: native.id, request: native.request, createdAtMs: native.createdAtMs, expiresAtMs: native.expiresAtMs, approvalKind: native.approvalKind };
    const identity = { id: request.id, kind: request.kind, createdAtMs: native.createdAtMs, expiresAtMs: native.expiresAtMs, requestRevision: planDigest(immutable) };
    if (native.expiresAtMs <= now() || ['cancelled', 'expired'].includes(native.status)) return result('withdrawn', identity);
    if (request.kind === 'question' && native.status === 'answered') return result('resolved', identity);
    if (request.kind === 'question' && native.status !== 'pending') return unknown;
    return result('pending', identity);
  } catch { assertCurrent(); return unknown; }
}
export async function readPlanHumanRequests({ card, nativeRequest, assertCurrent, now = Date.now }) {
  assertCurrent();
  if (card.status === 'done' || !card.sessionKey?.trim() || !card.runId?.trim()) return { availability: 'available', eligible: false, requests: [] };
  const matches = request => request.sessionKey === card.sessionKey && request.runId === card.runId;
  const pending = request => typeof request.id === 'string' && Number.isFinite(request.createdAtMs) && Number.isFinite(request.expiresAtMs) && request.expiresAtMs > now();
  try {
    const questions = await nativeRequest('question.list', {}); assertCurrent();
    const approvals = await nativeRequest('exec.approval.list', {}); assertCurrent();
    if (!Array.isArray(questions?.questions) || !Array.isArray(approvals)) throw new Error('Native human requests unavailable');
    const requests = [];
    for (const request of questions.questions) if (request.status === 'pending' && matches(request) && pending(request)) requests.push({ id: request.id, kind: 'question', createdAtMs: request.createdAtMs, expiresAtMs: request.expiresAtMs });
    for (const request of approvals) if (request.approvalKind === 'exec' && matches(request.request ?? {}) && pending(request)) requests.push({ id: request.id, kind: 'execution-approval', createdAtMs: request.createdAtMs, expiresAtMs: request.expiresAtMs });
    return { availability: 'available', eligible: requests.length > 0, requests };
  } catch {
    assertCurrent(); return { availability: 'unavailable', eligible: false, requests: [] };
  }
}
