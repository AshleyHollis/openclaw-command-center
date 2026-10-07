import { createHash } from 'node:crypto';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';
import { sourceError } from '../sources/errors.mjs';

export const PLAN_FAMILY = 'approved-conversation-plan.v1';
export const PLAN_KINDS = Object.freeze(['conversation-plan.binding.v1', 'conversation-plan.track.v1']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const planDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = message => { throw sourceError('invalid-request', message); };
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail('Plan fields must be complete and closed.');
}
function text(value, max = 2000) { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) fail('Plan text is invalid.'); }
export function validatePlan(input) {
  closed(input, ['family', 'logicalOperationId', 'source', 'destination', 'snapshot']);
  if (input.family !== PLAN_FAMILY) fail('Unsupported plan family.');
  assertLogicalOperationId(input.logicalOperationId);
  closed(input.source, ['topicId', 'referenceId', 'sessionId', 'sessionKey', 'membershipRevision', 'messageId', 'messageDigest', ...(Object.hasOwn(input.source ?? {}, 'nativeAdmission') ? ['nativeAdmission'] : [])]);
  for (const key of ['topicId', 'referenceId', 'sessionId', 'sessionKey', 'messageId']) text(input.source[key], 500);
  if (!Number.isSafeInteger(input.source.membershipRevision) || input.source.membershipRevision < 0 || !/^[a-f0-9]{64}$/u.test(input.source.messageDigest)) fail('Exact source revision and message digest are required.');
  if (input.source.nativeAdmission !== undefined) {
    closed(input.source.nativeAdmission, ['generation', 'digest']); text(input.source.nativeAdmission.generation, 4096);
    if (!/^sha256-public-message-v1:[a-f0-9]{64}$/u.test(input.source.nativeAdmission.digest)) fail('Unsupported native public-message digest.');
  }
  closed(input.destination, ['tenantId', 'boardId']);
  Object.values(input.destination).forEach(value => text(value, 80));
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(input.destination.boardId)) fail('An exact canonical native board is required.');
  closed(input.snapshot, ['outcome', 'steps', 'completionCriteria']);
  text(input.snapshot.outcome, 180);
  for (const key of ['steps', 'completionCriteria']) {
    if (!Array.isArray(input.snapshot[key]) || input.snapshot[key].length < (key === 'steps' ? 2 : 1) || input.snapshot[key].length > 30) fail('A concrete multi-step plan and completion criteria are required.');
    input.snapshot[key].forEach(value => text(value));
  }
  if (nativePlanIntent(input).notes.length > 4000) fail('The exact plan exceeds native card notes capacity; shorten it before accepting.');
  return structuredClone(input);
}
export const planIdentity = source => planDigest([PLAN_FAMILY, source.topicId, source.referenceId, source.sessionId, source.messageId]);
export function nativePlanIntent(input) {
  return { title: input.snapshot.outcome, notes: JSON.stringify({ family: PLAN_FAMILY, source: input.source, snapshot: input.snapshot }), status: 'todo', tenant: input.destination.tenantId, boardId: input.destination.boardId, idempotencyKey: `cc-plan:${planIdentity(input.source)}` };
}
