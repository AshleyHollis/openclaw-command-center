import { createHash } from 'node:crypto';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { IMPORTED_HISTORY_OPERATION, NATIVE_HISTORY_OPERATION } from './imported-history.mjs';
import { TOPIC_BOOTSTRAP_OPERATION } from './topic-bootstrap.mjs';
import { CONDITIONAL_PRIMARY_MODE, PROVISIONING_PRIMARY_OPERATION, provisioningPrimaryOperationId } from './provisioning-primary.mjs';

export const RECONCILIATION_OPERATION = 'workspace.reconcile.v1';
const kinds = new Set([IMPORTED_HISTORY_OPERATION, NATIVE_HISTORY_OPERATION, TOPIC_BOOTSTRAP_OPERATION]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const operationId = value => isCanonicalUuid(value) && value === value.toLowerCase();
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// A pinned import plan owns admission and its child-ID claims, not child effects.
// Source-specific bootstrap/history owners retain dispatch and recovery rules.
// Only digests and operation identities are stored here, never source content.
export function installReconciliationMetadata(service, { mutate, readMany, assertMutation, ErrorType }) {
  const fail = (code = 'reconciliation-intent-invalid') => { throw new ErrorType(code, code); };
  const authority = check => { if (typeof check !== 'function' || check()?.then) fail('reconciliation-authority-unavailable'); };
  function inputOf(input) {
    if (!exact(input, ['logicalOperationId', 'planDigest', 'children']) || !operationId(input.logicalOperationId) || !digest(input.planDigest) ||
      !Array.isArray(input.children) || input.children.length === 0 || input.children.length > 256) fail();
    const ids = new Set([input.logicalOperationId]);
    const children = input.children.map(child => {
      if (!exact(child, ['logicalOperationId', 'operationKind', 'intentDigest']) || !operationId(child.logicalOperationId) ||
        ids.has(child.logicalOperationId) || !kinds.has(child.operationKind) || !digest(child.intentDigest)) fail();
      ids.add(child.logicalOperationId);
      return { logicalOperationId: child.logicalOperationId, operationKind: child.operationKind, intentDigest: child.intentDigest };
    }).sort((left, right) => left.logicalOperationId.localeCompare(right.logicalOperationId));
    return { logicalOperationId: input.logicalOperationId, planDigest: input.planDigest, children };
  }
  const intentDigest = value => hash({ planDigest: value.planDigest, children: value.children });
  function decode(row) {
    try {
      if (!row || row.operation_kind !== RECONCILIATION_OPERATION || typeof row.result_identity !== 'string' || Buffer.byteLength(row.result_identity) > 131072) fail();
      const value = JSON.parse(row.result_identity);
      if (!exact(value, ['schemaVersion', 'logicalOperationId', 'planDigest', 'children', 'phase', 'revision'])) fail();
      const normalized = inputOf({ logicalOperationId: value.logicalOperationId, planDigest: value.planDigest, children: value.children });
      if (value.schemaVersion !== 1 || value.logicalOperationId !== row.logical_operation_id || JSON.stringify(normalized.children) !== JSON.stringify(value.children) ||
        !['reserved', 'applied'].includes(value.phase) || value.revision !== (value.phase === 'reserved' ? 1 : 2) ||
        row.intent_digest !== intentDigest(value) || row.state !== (value.phase === 'applied' ? 'applied' : 'pending') ||
        row.result_status !== value.phase || row.observed_revision !== String(value.revision)) fail();
      return freeze(value);
    } catch { fail('reconciliation-receipt-invalid'); }
  }
  const select = "SELECT * FROM operation_journal WHERE operation_kind = 'workspace.reconcile.v1' ORDER BY logical_operation_id";
  service.listReconciliations = () => readMany(select, [], decode);
  service.getReconciliation = id => service.listReconciliations().find(row => row.logicalOperationId === id) ?? null;
  // The notification owner invokes this synchronous check while holding its
  // BEGIN IMMEDIATE on this same metadata database; no writer can add claims
  // between this read and that owner's commit.
  service.assertUnclaimedReconciliationOperation = id => {
    if (service.listReconciliations().some(plan => plan.logicalOperationId === id || plan.children.some(child => child.logicalOperationId === id.toLowerCase()))) fail('reconciliation-child-conflict');
    for (const operation of service.listTopicOperations()) {
      if (operation.intent?.primaryMode === CONDITIONAL_PRIMARY_MODE && [operation.logicalOperationId, provisioningPrimaryOperationId(operation.logicalOperationId)].includes(id.toLowerCase())) fail('provisioning-operation-conflict');
    }
  };
  function assertChildClaim(db, candidate, generic = false) {
    // Conditional provisioning reserves the future native child before a folder
    // exists. Other owners must not consume that ID during folder preparation.
    for (const row of db.prepare("SELECT logical_operation_id,intent_json FROM topic_operations WHERE operation_kind='topics.create'").all()) {
      const intent = JSON.parse(row.intent_json);
      if (intent.primaryMode !== CONDITIONAL_PRIMARY_MODE) continue;
      const childId = provisioningPrimaryOperationId(row.logical_operation_id);
      if ([row.logical_operation_id, childId].includes(candidate.logicalOperationId?.toLowerCase()) &&
        (generic || candidate.logicalOperationId !== childId || candidate.operationKind !== PROVISIONING_PRIMARY_OPERATION)) fail('provisioning-operation-conflict');
    }
    for (const plan of db.prepare(select).all().map(decode)) {
      const claim = plan.children.find(child => child.logicalOperationId === candidate.logicalOperationId?.toLowerCase());
      if (claim && (generic || claim.logicalOperationId !== candidate.logicalOperationId || claim.operationKind !== candidate.operationKind || claim.intentDigest !== candidate.intentDigest)) fail('reconciliation-child-conflict');
    }
  }
  service.reserveReconciliation = (input, check) => mutate('notes', db => {
    assertMutation('sessions'); authority(check);
    const normalized = inputOf(input);
    assertChildClaim(db, normalized, true);
    const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(normalized.logicalOperationId);
    if (existing) {
      if (existing.operation_kind !== RECONCILIATION_OPERATION || existing.intent_digest !== intentDigest(normalized)) fail('intent-mismatch');
      return decode(existing);
    }
    const plans = db.prepare(select).all().map(decode);
    for (const child of normalized.children) {
      assertChildClaim(db, child, true);
      if (plans.some(plan => plan.logicalOperationId === child.logicalOperationId || plan.children.some(other => other.logicalOperationId === child.logicalOperationId))) fail('reconciliation-child-conflict');
      const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(child.logicalOperationId);
      if (row && (row.operation_kind !== child.operationKind || row.intent_digest !== child.intentDigest)) fail('reconciliation-child-conflict');
    }
    service.assertImportedHistoryCapacity(normalized.children
      .filter(child => [IMPORTED_HISTORY_OPERATION, NATIVE_HISTORY_OPERATION].includes(child.operationKind))
      .map(child => child.logicalOperationId));
    const value = { schemaVersion: 1, ...normalized, phase: 'reserved', revision: 1 };
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_journal (logical_operation_id,transport_request_id,intent_digest,operation_kind,state,result_status,result_identity,observed_revision,created_at,updated_at)
      VALUES (?,?,?,?,'pending','reserved',?,'1',?,?)`).run(value.logicalOperationId, value.logicalOperationId, intentDigest(value), RECONCILIATION_OPERATION, JSON.stringify(value), now, now);
    authority(check);
    return freeze(value);
  });
  service.completeReconciliation = (input, check) => mutate('notes', db => {
    assertMutation('sessions'); authority(check);
    if (!exact(input, ['logicalOperationId', 'expectedRevision', 'planDigest']) || !isCanonicalUuid(input.logicalOperationId) || !digest(input.planDigest) || !Number.isSafeInteger(input.expectedRevision)) fail();
    const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (!row) fail('reconciliation-reservation-missing');
    const current = decode(row);
    if (current.planDigest !== input.planDigest) fail('intent-mismatch');
    if (current.revision !== input.expectedRevision) fail('stale-revision');
    if (current.phase !== 'reserved') fail('reconciliation-terminal');
    for (const child of current.children) {
      const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(child.logicalOperationId);
      if (!row || row.operation_kind !== child.operationKind || row.intent_digest !== child.intentDigest || row.state !== 'applied') fail('reconciliation-incomplete');
      const receipt = child.operationKind === TOPIC_BOOTSTRAP_OPERATION ? service.getTopicBootstrap(child.logicalOperationId)
        : service.listImportedHistories().find(history => history.logicalOperationId === child.logicalOperationId);
      if (!receipt || receipt.phase !== (child.operationKind === TOPIC_BOOTSTRAP_OPERATION ? 'applied' : 'verified')) fail('reconciliation-incomplete');
    }
    const value = { ...current, phase: 'applied', revision: 2 };
    db.prepare("UPDATE operation_journal SET state='applied',result_status='applied',result_identity=?,observed_revision='2',updated_at=? WHERE logical_operation_id=?")
      .run(JSON.stringify(value), new Date().toISOString(), value.logicalOperationId);
    authority(check);
    return freeze(value);
  });
  return Object.freeze({ assertChildClaim });
}
