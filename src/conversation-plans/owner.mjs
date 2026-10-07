import { planDigest, validatePlan } from './contract.mjs';
import { sourceError } from '../sources/errors.mjs';

const fail = (code, message) => { throw sourceError(code, message); };
// readSource verifies the exact message; assertSourceCurrent reaches source
// membership/reset/permission admission synchronously. Missing owners fail closed.
export function createConversationPlanOwner({ metadata, nativeRequest, readSource, assertSourceCurrent, authorize, readHumanRequests }) {
  if (!metadata?.reserveConversationPlan || ![nativeRequest, readSource, assertSourceCurrent, authorize].every(value => typeof value === 'function')) throw new TypeError('Plan tracking requires durable metadata and exact authenticated source owners.');
  function fence(input, principalId, write = false) {
    const auth = authorize({ source: input.source, destination: input.destination, write });
    if (auth?.then || !auth?.principalId || principalId !== undefined && principalId !== auth.principalId) fail('unauthenticated', 'Original plan authority is unavailable.');
    if (assertSourceCurrent(input.source)?.then) fail('unauthenticated', 'Source admission must be synchronous.');
    return auth.principalId;
  }
  async function source(input, principalId, write) {
    fence(input, principalId, write);
    const result = await readSource(input.source);
    fence(input, principalId, write);
    if (!result?.available || planDigest(result.source) !== planDigest(input.source)) fail('unavailable', 'Exact reviewed Conversation source is unavailable.');
  }
  function exact(card, binding) {
    const automation = card?.metadata?.automation, intent = binding.createIntent;
    if (!card?.id || automation?.tenant !== intent.tenant || (automation.boardId ?? 'default') !== intent.boardId || automation.idempotencyKey !== intent.idempotencyKey || !Number.isFinite(card.updatedAt)) fail('conflict', 'Native card identity, scope or revision differs.');
    return card;
  }
  async function observe(binding, principalId) {
    const input = binding.input;
    await source(input, principalId, false);
    const response = await nativeRequest('workboard.cards.list', { boardId: input.destination.boardId });
    await source(input, principalId, false);
    if (!Array.isArray(response?.cards)) fail('unavailable', 'Authoritative Workboard read is unavailable.');
    const candidates = response.cards.filter(card => binding.cardId ? card.id === binding.cardId : card.metadata?.automation?.idempotencyKey === binding.createIntent.idempotencyKey);
    if (candidates.length > 1) fail('conflict', 'Ambiguous native plan identity.');
    if (!candidates.length) return { family: input.family, input, availability: 'unavailable', outcome: 'unknown', reason: 'No exact native card was observed.' };
    const card = exact(candidates[0], binding);
    if (!binding.cardId) {
      if (card.title !== binding.createIntent.title || card.notes !== binding.createIntent.notes) fail('conflict', 'Native admission does not match the accepted plan.');
      metadata.bindConversationPlan(input.source, card.id, () => fence(input, principalId));
    }
    let attention = { availability: 'unavailable', eligible: false, reason: 'Explicit human-request owner is not qualified.' };
    if (readHumanRequests) {
      attention = await readHumanRequests(card, () => fence(input, principalId));
      await source(input, principalId, false);
      const current = await nativeRequest('workboard.cards.list', { boardId: input.destination.boardId });
      await source(input, principalId, false);
      const cards = current?.cards?.filter(item => item.id === card.id);
      if (!Array.isArray(cards) || cards.length !== 1 || planDigest(exact(cards[0], binding)) !== planDigest(card)) fail('unavailable', 'Native card changed while reading linked human requests.');
      // Expiry can occur during source/card awaits. Native controls revalidate
      // pending request resolution before any user response; CC only navigates.
      const requests = (attention.requests ?? []).filter(request => request.expiresAtMs > Date.now());
      attention = { ...attention, requests, eligible: attention.eligible === true && requests.length > 0 };
    }
    const attempts = card.metadata?.attempts ?? [];
    const linked = typeof card.sessionKey === 'string' && card.sessionKey.trim() && typeof card.runId === 'string' && card.runId.trim();
    const attempt = linked ? attempts.filter(item => item.sessionKey === card.sessionKey && item.runId === card.runId && ['running', 'succeeded', 'failed', 'blocked', 'stopped'].includes(item.status)).at(-1) : undefined;
    return { family: input.family, availability: 'available', outcome: 'tracked-observed', input, card: { id: card.id, status: card.status, updatedAt: card.updatedAt, ...(card.sessionKey ? { sessionKey: card.sessionKey } : {}), ...(card.runId ? { runId: card.runId } : {}) }, progress: { availability: attempt ? 'available' : 'unavailable', ...(attempt ? { status: attempt.status } : {}) }, attention };
  }
  async function track(request) {
    const input = validatePlan(request), principalId = fence(input, undefined, true);
    await source(input, principalId, true);
    const binding = metadata.reserveConversationPlan(input, principalId, () => fence(input, principalId, true));
    if (binding.cardId) return observe(binding, principalId);
    try {
      const response = await nativeRequest('workboard.cards.create', binding.createIntent, { assertCurrent: () => fence(binding.input, principalId, true) });
      await source(binding.input, principalId, true);
      const card = exact(response?.card, binding);
      if (card.title !== binding.createIntent.title || card.notes !== binding.createIntent.notes) fail('conflict', 'Created card differs from the frozen plan.');
      metadata.bindConversationPlan(binding.input.source, card.id, () => fence(binding.input, principalId, true));
    } catch (error) {
      if (!['timeout', 'delivery-unknown', 'unavailable'].includes(error.code)) throw error;
      // Recovery reads only; uncertainty never dispatches another execution.
    }
    return observe(metadata.getConversationPlan(binding.input.source), principalId);
  }
  async function reconcile(request) {
    const input = validatePlan(request), principalId = fence(input);
    const binding = metadata.getConversationPlan(input.source);
    const operation = metadata.getOperation(input.logicalOperationId);
    const accepted = operation?.operationKind === 'conversation-plan.track.v1' ? JSON.parse(operation.resultIdentity) : null;
    if (!binding || !accepted || planDigest(input) !== planDigest(accepted.input) || binding.principalId !== principalId || accepted.principalId !== principalId) fail('intent-mismatch', 'Reconciliation requires the exact original accepted intent.');
    return observe(binding, principalId);
  }
  return Object.freeze({ track, reconcile });
}
