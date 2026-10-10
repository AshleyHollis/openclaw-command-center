import { PLAN_KINDS, planDigest, planIdentity, validatePlan, nativePlanIntent } from '../conversation-plans/contract.mjs';

// Accepted snapshots and native correlation live in the existing operation journal.
// This owner stores no execution state, progress, scheduling or card lifecycle.
export function installConversationPlanMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = (code, message) => { throw new ErrorType(code, message); };
  const get = (db, id) => db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id=?').get(id);
  const decode = row => row ? JSON.parse(row.result_identity) : null;
  const key = source => `conversation-plan.binding:${planIdentity(source)}`;
  const fence = guard => { if (typeof guard !== 'function' || guard()?.then) fail('unauthenticated', 'Synchronous current plan authority is required.'); };
  const put = (db, id, kind, digest, value, state) => {
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO operation_journal (logical_operation_id,transport_request_id,intent_digest,operation_kind,state,result_status,result_identity,observed_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(logical_operation_id) DO UPDATE SET state=excluded.state,result_status=excluded.result_status,result_identity=excluded.result_identity,updated_at=excluded.updated_at`)
      .run(id, id, digest, kind, state, state, JSON.stringify(value), String(value.input.source.membershipRevision), at, at);
    return value;
  };
  service.getConversationPlan = source => inspect(db => decode(get(db, key(source))));
  service.listConversationPlans = () => inspect(db => db.prepare('SELECT * FROM operation_journal WHERE operation_kind=? ORDER BY logical_operation_id').all(PLAN_KINDS[0]).map(decode));
  service.reserveConversationPlan = (request, principalId, guard) => mutate(null, db => {
    const input = validatePlan(request); fence(guard);
    if (typeof principalId !== 'string' || !principalId.trim()) fail('unauthenticated', 'An exact operator is required.');
    const intent = { input, principalId }, digest = planDigest(intent), prior = get(db, input.logicalOperationId), binding = get(db, key(input.source));
    if (prior && (prior.operation_kind !== PLAN_KINDS[1] || prior.intent_digest !== digest)) fail('intent-mismatch', 'The operation ID has another accepted intent.');
    if (binding) {
      if (binding.operation_kind !== PLAN_KINDS[0]) fail('conflict', 'The reserved source key has another owner.');
      const value = decode(binding);
      // A second click with another transport operation still names the same acceptance.
      const { logicalOperationId: ignored, ...meaning } = input;
      const { logicalOperationId: original, ...accepted } = value.input;
      if (planDigest(meaning) !== planDigest(accepted) || principalId !== value.principalId) fail('intent-mismatch', 'The source already owns another immutable accepted plan.');
      if (!prior) put(db, input.logicalOperationId, PLAN_KINDS[1], digest, { ...value, input }, value.cardId ? 'applied' : 'unknown');
      return value;
    }
    if (get(db, key(input.source))) fail('conflict', 'Another plan owns this source.');
    const value = { ...intent, createIntent: nativePlanIntent(input), cardId: null };
    put(db, input.logicalOperationId, PLAN_KINDS[1], digest, value, 'unknown');
    return put(db, key(input.source), PLAN_KINDS[0], digest, value, 'unknown');
  });
  service.bindConversationPlan = (source, cardId, guard) => mutate(null, db => {
    fence(guard);
    const row = get(db, key(source)), value = decode(row);
    if (!value || typeof cardId !== 'string' || !cardId.trim()) fail('unavailable', 'Reserved plan or native card is unavailable.');
    if (value.cardId && value.cardId !== cardId) fail('conflict', 'The plan cannot acquire another native card.');
    const operation = get(db, value.input.logicalOperationId);
    if (operation?.operation_kind !== PLAN_KINDS[1] || operation.intent_digest !== row.intent_digest) fail('conflict', 'The original acceptance receipt is unavailable.');
    const next = { ...value, cardId };
    put(db, operation.logical_operation_id, PLAN_KINDS[1], row.intent_digest, next, 'applied');
    return put(db, key(source), PLAN_KINDS[0], row.intent_digest, next, 'applied');
  });
}
