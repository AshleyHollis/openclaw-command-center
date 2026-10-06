import { createHash } from 'node:crypto';

export const BILL_ACTION_KINDS = Object.freeze(['bill-action.binding.v1', 'bill-action.handle.v1', 'bill-action.defer.v1', 'bill-action.admit.v1']);
export const billActionDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const bindingId = actionId => `bill-action.binding:${billActionDigest(actionId)}`;

// Correlation and transport recovery only. Native Workboard owns status/history.
export function installBillActionMetadata(service, { mutate, inspect, ErrorType }) {
  const fail = (code, message) => { throw new ErrorType(code, message); };
  const validate = (input, fields) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail('invalid-value', 'Bill metadata command has unsupported fields.');
    for (const key of ['actionId', 'logicalOperationId', 'loopId', 'cardId', 'tenantId', 'boardId', 'semanticKey', 'actorId']) if (fields.includes(key) && (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2000)) fail('invalid-value', `Bill metadata ${key} is invalid.`);
  };
  const decode = row => row ? Object.freeze({ ...JSON.parse(row.result_identity), state: row.state }) : null;
  const row = (db, id) => db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(id);
  const fence = assertCurrent => { if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('unauthenticated', 'Current synchronous bill-action authority is required.'); };
  const put = (db, id, kind, digest, value, state, revision) => {
    const instant = new Date().toISOString();
    db.prepare(`INSERT INTO operation_journal (logical_operation_id,transport_request_id,intent_digest,operation_kind,state,result_status,result_identity,observed_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(logical_operation_id) DO UPDATE SET state=excluded.state,result_status=excluded.result_status,result_identity=excluded.result_identity,observed_revision=excluded.observed_revision,updated_at=excluded.updated_at`)
      .run(id, id, digest, kind, state, value.outcome ?? state, JSON.stringify(value), String(revision), instant, instant);
    return decode(row(db, id));
  };
  service.getBillActionBinding = actionId => inspect(db => decode(row(db, bindingId(actionId))));
  service.listBillActionBindings = () => inspect(db => db.prepare('SELECT * FROM operation_journal WHERE operation_kind=? ORDER BY logical_operation_id').all(BILL_ACTION_KINDS[0]).map(decode));
  service.getBillActionOperation = id => inspect(db => {
    const found = row(db, id);
    return found && BILL_ACTION_KINDS.slice(1, 3).includes(found.operation_kind) ? decode(found) : null;
  });
  service.reserveBillActionBinding = (input, assertCurrent) => mutate(null, db => {
    fence(assertCurrent);
    validate(input, ['schemaVersion', 'actionId', 'semanticKey', 'meaningDigest', 'tenantId', 'boardId', 'logicalOperationId', 'createIntent', 'source', 'actorId']);
    if (input.schemaVersion !== 1 || input.createIntent?.status !== 'todo' || input.createIntent?.tenant !== input.tenantId || input.createIntent?.boardId !== input.boardId || typeof input.createIntent?.idempotencyKey !== 'string') fail('invalid-value', 'Bill admission requires a non-executing immutable create intent.');
    if (!/^[a-f0-9]{64}$/u.test(input.meaningDigest ?? '')) fail('invalid-value', 'Accepted bill meaning digest is required.');
    const source = input.source;
    const accepted = source && db.prepare(`SELECT 1 FROM operation_journal WHERE operation_kind='intake-outcome.email.v1' AND state='applied'
      AND json_extract(result_identity,'$.status')='applied' AND json_extract(result_identity,'$.kind')='obligation'
      AND json_extract(result_identity,'$.loopId')=? AND json_extract(result_identity,'$.sourceExternalId')=?
      AND json_extract(result_identity,'$.sourceVersion')=? AND json_extract(result_identity,'$.outcomeId')=?`).get(input.actionId, source.externalId, source.version, source.outcomeId);
    if (!accepted) fail('conflict', 'The exact admitted email outcome is unavailable.');
    const id = bindingId(input.actionId), digest = billActionDigest(input);
    const admission = row(db, input.logicalOperationId);
    if (admission && (admission.operation_kind !== BILL_ACTION_KINDS[3] || admission.intent_digest !== digest)) fail('intent-mismatch', 'The admission operation ID was reused with changed intent.');
    const prior = row(db, id);
    if (prior) {
      if (prior.operation_kind !== BILL_ACTION_KINDS[0] || prior.intent_digest !== digest) fail('intent-mismatch', 'The action already has a different immutable native create intent.');
      return decode(prior);
    }
    const collisions = db.prepare('SELECT result_identity FROM operation_journal WHERE operation_kind=?').all(BILL_ACTION_KINDS[0]);
    if (collisions.some(item => JSON.parse(item.result_identity).semanticKey === input.semanticKey)) fail('conflict', 'The accepted action correlation already has a binding requiring review.');
    put(db, input.logicalOperationId, BILL_ACTION_KINDS[3], digest, input, 'pending', 0);
    return put(db, id, BILL_ACTION_KINDS[0], digest, { ...input, eligibilityRevision: 0, reviewAt: null, cardId: null }, 'pending', 0);
  });
  service.settleBillActionBinding = (input, assertCurrent) => mutate(null, db => {
    fence(assertCurrent);
    validate(input, ['actionId', 'cardId']);
    const prior = row(db, bindingId(input.actionId)), value = decode(prior);
    if (!value) fail('not-found', 'The reserved native binding is unavailable.');
    if (value.cardId && value.cardId !== input.cardId) fail('conflict', 'Another native card owns the action.');
    const admission = row(db, value.logicalOperationId);
    if (!admission || admission.operation_kind !== BILL_ACTION_KINDS[3]) fail('conflict', 'The original admission intent is unavailable.');
    put(db, admission.logical_operation_id, admission.operation_kind, admission.intent_digest, { ...decode(admission), cardId: input.cardId, outcome: 'bound' }, 'applied', 0);
    return put(db, prior.logical_operation_id, prior.operation_kind, prior.intent_digest, { ...value, cardId: input.cardId }, 'applied', value.eligibilityRevision);
  });
  service.beginBillActionOperation = (input, assertCurrent) => mutate(null, db => {
    fence(assertCurrent);
    validate(input, ['schemaVersion', 'loopId', 'logicalOperationId', 'action', 'actionId', 'cardId', 'tenantId', 'boardId', 'patch', 'expectedUpdatedAt', 'expectedEligibilityRevision', 'reviewAt', 'timeZone', 'offsetMinutes', 'actorId', 'sourceIdentity']);
    if (input.schemaVersion !== 1 || input.action === 'handle' && (!Number.isFinite(input.expectedUpdatedAt) || JSON.stringify(input.patch) !== '{"status":"done"}') || input.action === 'defer' && (!Number.isSafeInteger(input.expectedEligibilityRevision) || input.expectedEligibilityRevision < 0 || !Number.isFinite(Date.parse(input.reviewAt)) || typeof input.timeZone !== 'string' || !Number.isInteger(input.offsetMinutes))) fail('invalid-value', 'Bill operation requires its original conditional intent.');
    const kind = input.action === 'handle' ? BILL_ACTION_KINDS[1] : input.action === 'defer' ? BILL_ACTION_KINDS[2] : fail('invalid-request', 'Unsupported bill action.');
    const digest = billActionDigest(input), prior = row(db, input.logicalOperationId);
    if (prior) {
      if (prior.operation_kind !== kind || prior.intent_digest !== digest) fail('intent-mismatch', 'The operation ID was reused with changed intent.');
      return decode(prior);
    }
    const binding = decode(row(db, bindingId(input.actionId)));
    if (!binding?.cardId || binding.cardId !== input.cardId || binding.boardId !== input.boardId || binding.tenantId !== input.tenantId) fail('conflict', 'The exact native binding is unavailable.');
    const unresolved = db.prepare("SELECT result_identity FROM operation_journal WHERE operation_kind IN (?,?) AND state IN ('pending','unknown')").all(...BILL_ACTION_KINDS.slice(1, 3));
    if (unresolved.some(item => JSON.parse(item.result_identity).actionId === input.actionId)) fail('conflict', 'An unresolved operation requires reconciliation first.');
    return put(db, input.logicalOperationId, kind, digest, { ...input, outcome: 'unknown' }, 'pending', input.expectedUpdatedAt ?? input.expectedEligibilityRevision);
  });
  service.settleBillActionOperation = (input, assertCurrent) => mutate(null, db => {
    fence(assertCurrent);
    validate(input, ['logicalOperationId', 'outcome']);
    const prior = row(db, input.logicalOperationId), value = decode(prior);
    if (!value || !BILL_ACTION_KINDS.slice(1, 3).includes(prior.operation_kind)) fail('not-found', 'The submitted bill operation is unavailable.');
    if (!['unknown', 'handled-observed', 'conflict', 'not-applied'].includes(input.outcome)) fail('invalid-request', 'Unsupported native operation outcome.');
    if (!['pending', 'unknown'].includes(prior.state)) return value;
    return put(db, prior.logical_operation_id, prior.operation_kind, prior.intent_digest, { ...value, outcome: input.outcome }, input.outcome === 'handled-observed' ? 'applied' : input.outcome, prior.observed_revision);
  });
  service.commitBillActionDefer = (input, assertCurrent) => mutate(null, db => {
    fence(assertCurrent);
    validate(input, ['schemaVersion', 'loopId', 'logicalOperationId', 'expectedEligibilityRevision', 'reviewAt', 'timeZone', 'offsetMinutes']);
    const prior = row(db, input.logicalOperationId), operation = decode(prior);
    if (prior?.operation_kind !== BILL_ACTION_KINDS[2]) fail('not-found', 'The submitted defer operation is unavailable.');
    if (prior.state === 'applied') return operation;
    if (!['pending', 'unknown'].includes(prior.state)) fail('conflict', 'The defer operation cannot be completed.');
    const stored = row(db, bindingId(operation.actionId)), binding = decode(stored);
    if (binding.eligibilityRevision !== operation.expectedEligibilityRevision) fail('conflict', 'Later eligibility changed.');
    const next = { ...binding, reviewAt: operation.reviewAt, timeZone: operation.timeZone, offsetMinutes: operation.offsetMinutes, eligibilityRevision: binding.eligibilityRevision + 1 };
    put(db, stored.logical_operation_id, stored.operation_kind, stored.intent_digest, next, 'applied', next.eligibilityRevision);
    return put(db, prior.logical_operation_id, prior.operation_kind, prior.intent_digest, { ...operation, outcome: 'applied', eligibilityRevision: next.eligibilityRevision }, 'applied', next.eligibilityRevision);
  });
}
