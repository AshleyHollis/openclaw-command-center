import { planDigest } from './contract.mjs';

// Workboard owns schema 1 snapshots and durable terminal receipts. CC performs
// scoped reads only; neither this adapter nor Attention resolves or starts work.
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && !!value.trim();
export function nativeResultReviewScope(card) {
  const automation = card?.metadata?.automation;
  if (!text(card?.id) || !text(automation?.tenant)) return null;
  const boardId = automation.boardId ?? 'default';
  if (!text(boardId)) return null;
  return { tenant: automation.tenant, boardId, cardId: card.id };
}
function valid(native, scope) {
  const fields = ['schemaVersion', 'id', 'requestRevision', 'resultDigest', 'completionIntent', 'revision', 'status', 'tenant', 'boardId', 'cardId', 'sessionKey', 'runId', 'createdAt', 'expiresAt', 'resolvedAt', 'result'];
  if (!native || Object.keys(native).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(native, key)) || native.schemaVersion !== 1 || !text(native.id) || !digest(native.requestRevision) || !digest(native.resultDigest) || !digest(native.completionIntent) || !integer(native.revision) || native.revision < 1 || !integer(native.createdAt) || native.expiresAt !== null || !['pending', 'reviewed', 'withdrawn'].includes(native.status) || !text(native.sessionKey) || !text(native.runId)) return false;
  if (Object.keys(scope).some(key => native[key] !== scope[key]) || (native.status === 'pending' ? native.resolvedAt !== null : !integer(native.resolvedAt) || native.resolvedAt < native.createdAt)) return false;
  const result = native.result;
  if (!result || Object.keys(result).some(key => !['summary', 'proof', 'artifacts'].includes(key)) || !text(result.summary) || !Array.isArray(result.proof) || !Array.isArray(result.artifacts) || Buffer.byteLength(JSON.stringify(native)) > 128 * 1024 || planDigest(result) !== native.resultDigest) return false;
  const identity = { tenant: native.tenant, boardId: native.boardId, cardId: native.cardId, sessionKey: native.sessionKey, runId: native.runId, id: native.id, completionIntent: native.completionIntent };
  return planDigest({ ...identity, resultDigest: native.resultDigest }) === native.requestRevision;
}
const locator = native => ({ id: native.id, kind: 'requested-result-review', createdAtMs: native.createdAt, expiresAtMs: null, requestRevision: native.requestRevision });
export async function readNativeResultReviews({ card, nativeRequest, assertCurrent }) {
  assertCurrent();
  const scope = nativeResultReviewScope(card);
  if (!scope) return { availability: 'unavailable', requests: [] };
  try {
    const response = await nativeRequest('workboard.resultReviews.list', scope); assertCurrent();
    if (!Array.isArray(response?.requests) || response.requests.some(request => !valid(request, scope))) return { availability: 'unavailable', requests: [] };
    const requests = response.requests.filter(request => request.status === 'pending' && card.status === 'review' && request.sessionKey === card.sessionKey && request.runId === card.runId).map(locator);
    return { availability: 'available', requests };
  } catch { assertCurrent(); return { availability: 'unavailable', requests: [] }; }
}
export async function verifyNativeResultReview({ card, request, requestLink, nativeRequest, assertCurrent, now = Date.now }) {
  assertCurrent();
  const scope = nativeResultReviewScope(card), unknown = { availability: 'unavailable' };
  if (!scope) return unknown;
  try {
    const response = await nativeRequest('workboard.resultReviews.get', { ...scope, requestId: request.id }); assertCurrent();
    const native = response?.request;
    if (!valid(native, scope) || native.id !== request.id) return unknown;
    const link = requestLink ?? { sessionKey: card.sessionKey, runId: card.runId };
    if (native.sessionKey !== link.sessionKey || native.runId !== link.runId || native.status === 'pending' && (card.status !== 'review' || native.sessionKey !== card.sessionKey || native.runId !== card.runId)) return unknown;
    return { availability: 'available', state: native.status === 'reviewed' ? 'resolved' : native.status === 'withdrawn' ? 'withdrawn' : 'pending', request: locator(native), observedAtMs: now() };
  } catch { assertCurrent(); return unknown; }
}
