import { createHash } from 'node:crypto';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';

export const IMPORTED_HISTORY_OPERATION = 'history.import.v1';
const intentKeys = ['schemaVersion', 'sourceManifestSha256', 'trustedPublicKeySha256', 'sourceChannelId', 'sourceDigest', 'expectedCount', 'agentId', 'topicId', 'expectedTopicRevision'];
const receiptKeys = ['schemaVersion', 'historyId', 'logicalOperationId', 'intent', 'target', 'disposition', 'phase', 'revision', 'verifiedCount', 'sessionLifecycleRevision', 'transcriptGeneration', 'anchorDigest'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Dedicated commands own these permanent presentation/recovery receipts. The
// native Session remains the only transcript store; no message text is stored.
export function installImportedHistoryMetadata(service, { mutate, inspect, readMany, assertChildClaim, ErrorType }) {
  const fail = (code = 'history-intent-invalid') => { throw new ErrorType(code, code); };
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\x00-\x1f]/.test(value);
  const assertAuthority = assertCurrent => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('history-authority-unavailable');
  };
  function proofOf(value) {
    if (!value || Object.keys(value).some(key => !['sessionLifecycleRevision', 'transcriptGeneration', 'anchorDigest', 'verifiedCount'].includes(key)) || !text(value.sessionLifecycleRevision) || !(text(value.transcriptGeneration) || (value.transcriptGeneration === null && value.verifiedCount === 0)) || typeof value.anchorDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.anchorDigest) || !Number.isSafeInteger(value.verifiedCount) || value.verifiedCount < 0) fail('history-proof-conflict');
    return { sessionLifecycleRevision: value.sessionLifecycleRevision, transcriptGeneration: value.transcriptGeneration, anchorDigest: value.anchorDigest, verifiedCount: value.verifiedCount };
  }
  function assertTopic(db, intent) {
    if (intent.topicId === null) return;
    const topic = db.prepare('SELECT lifecycle, revision FROM topics WHERE topic_id = ?').get(intent.topicId);
    if (!topic || topic.lifecycle !== 'active' || topic.revision !== intent.expectedTopicRevision) fail('stale-revision');
  }
  function intentOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !intentKeys.includes(key))) fail();
    if (value.schemaVersion !== 1 || ![value.sourceManifestSha256, value.trustedPublicKeySha256, value.sourceDigest].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) fail();
    if (!text(value.sourceChannelId) || typeof value.agentId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.agentId) || !Number.isSafeInteger(value.expectedCount) || value.expectedCount < 0) fail();
    if (value.topicId === null ? value.expectedTopicRevision !== null : !text(value.topicId) || !Number.isSafeInteger(value.expectedTopicRevision) || value.expectedTopicRevision < 0) fail();
    return Object.fromEntries(intentKeys.map(key => [key, value[key]]));
  }
  function targetOf(intent, historyId) {
    const bytes = Buffer.from(hash(['history-session-v1', intent.agentId, historyId]), 'hex').subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return { agentId: intent.agentId, sessionKey: `agent:${intent.agentId}:command-center:history:${historyId}`, sessionId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
  }
  const historyIdOf = intent => hash(['discord-preservation-v1', intent.sourceManifestSha256, intent.sourceChannelId]);
  function decode(row) {
    try {
      if (!row || row.operation_kind !== IMPORTED_HISTORY_OPERATION || typeof row.result_identity !== 'string' || Buffer.byteLength(row.result_identity) > 16384) fail('history-receipt-invalid');
      const value = JSON.parse(row.result_identity);
      if (!value || typeof value !== 'object' || Object.keys(value).some(key => !receiptKeys.includes(key))) fail('history-receipt-invalid');
      const intent = intentOf(value.intent);
      if (value.schemaVersion !== 1 || value.disposition !== 'historical' || value.historyId !== historyIdOf(intent) || value.logicalOperationId !== row.logical_operation_id || !isCanonicalUuid(value.logicalOperationId) || row.intent_digest !== hash(intent) || JSON.stringify(value.target) !== JSON.stringify(targetOf(intent, value.historyId))) fail('history-receipt-invalid');
      if (!['reserved', 'creating', 'importing', 'verified'].includes(value.phase) || row.result_status !== value.phase || !Number.isSafeInteger(value.revision) || value.revision < 1 || row.observed_revision !== String(value.revision) || row.state !== (value.phase === 'verified' ? 'applied' : 'pending')) fail('history-receipt-invalid');
      if (value.phase === 'reserved' || value.phase === 'creating') {
        if (value.revision !== (value.phase === 'reserved' ? 1 : 2) || value.verifiedCount !== 0 || value.sessionLifecycleRevision !== null || value.transcriptGeneration !== null || value.anchorDigest !== null) fail('history-receipt-invalid');
      } else {
        proofOf({ sessionLifecycleRevision: value.sessionLifecycleRevision, transcriptGeneration: value.transcriptGeneration, anchorDigest: value.anchorDigest, verifiedCount: value.verifiedCount });
        if (value.sessionLifecycleRevision !== value.logicalOperationId) fail('history-receipt-invalid');
        if (value.revision < 3 || value.verifiedCount > intent.expectedCount || (value.phase === 'verified' && (value.revision < 4 || value.verifiedCount !== intent.expectedCount))) fail('history-receipt-invalid');
      }
      return freeze(value);
    } catch { fail('history-receipt-invalid'); }
  }
  function decodeRows(rows) {
    const histories = new Set();
    const targets = new Set();
    return rows.map(decode).map(value => {
      const target = JSON.stringify(value.target);
      if (histories.has(value.historyId) || targets.has(target)) fail('history-receipt-invalid');
      histories.add(value.historyId);
      targets.add(target);
      return value;
    });
  }
  const select = "SELECT * FROM operation_journal WHERE operation_kind = 'history.import.v1' ORDER BY logical_operation_id";
  service.listImportedHistories = () => decodeRows(readMany(select, [], row => row));
  service.getImportedHistory = historyId => service.listImportedHistories().find(row => row.historyId === historyId) ?? null;
  // Validation/identity only: planned Topics may not exist yet. Actual reservation
  // still enforces their original active revision inside its write transaction.
  service.inspectImportedHistory = (input, assertCurrent) => inspect(db => {
    assertAuthority(assertCurrent);
    if (!input || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'intent') || !isCanonicalUuid(input.logicalOperationId)) fail();
    const intent = intentOf(input.intent);
    const intentDigest = hash(intent);
    assertChildClaim(db, { logicalOperationId: input.logicalOperationId, operationKind: IMPORTED_HISTORY_OPERATION, intentDigest });
    const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (existing && (existing.operation_kind !== IMPORTED_HISTORY_OPERATION || existing.intent_digest !== intentDigest)) fail('intent-mismatch');
    const rows = decodeRows(db.prepare(select).all());
    if (!existing && (rows.some(row => row.historyId === historyIdOf(intent)) || rows.length >= 100)) fail('history-reservation-conflict');
    return freeze({ logicalOperationId: input.logicalOperationId, intent, intentDigest, target: targetOf(intent, historyIdOf(intent)), receipt: existing ? decode(existing) : null });
  });
  const reserve = (input, assertCurrent, reportCreation) => mutate('sessions', db => {
    const result = (reservation, created) => reportCreation ? Object.freeze({ reservation, created }) : reservation;
    if (!input || Object.keys(input).some(key => !['logicalOperationId', 'intent'].includes(key)) || !isCanonicalUuid(input.logicalOperationId)) fail();
    assertAuthority(assertCurrent);
    const intent = intentOf(input.intent);
    assertChildClaim(db, { logicalOperationId: input.logicalOperationId, operationKind: IMPORTED_HISTORY_OPERATION, intentDigest: hash(intent) });
    const historyId = historyIdOf(intent);
    const rows = decodeRows(db.prepare(select).all());
    const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (existing) {
      if (existing.operation_kind !== IMPORTED_HISTORY_OPERATION || existing.intent_digest !== hash(intent)) fail('intent-mismatch');
      return result(decode(existing), false);
    }
    if (rows.some(row => row.historyId === historyId) || rows.length >= 100) fail('history-reservation-conflict');
    assertTopic(db, intent);
    const value = { schemaVersion: 1, historyId, logicalOperationId: input.logicalOperationId, intent, target: targetOf(intent, historyId), disposition: 'historical', phase: 'reserved', revision: 1, verifiedCount: 0, sessionLifecycleRevision: null, transcriptGeneration: null, anchorDigest: null };
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_journal (logical_operation_id, transport_request_id, intent_digest, operation_kind, state, result_status, result_identity, observed_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 'reserved', ?, '1', ?, ?)`).run(input.logicalOperationId, input.logicalOperationId, hash(intent), IMPORTED_HISTORY_OPERATION, JSON.stringify(value), now, now);
    return result(decode(db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId)), true);
  });
  service.reserveImportedHistory = (input, assertCurrent) => reserve(input, assertCurrent, false);
  service.beginImportedHistory = (input, assertCurrent) => reserve(input, assertCurrent, true);
  // Only the winner of this durable CAS may dispatch native creation. A retry
  // may continue a reservation that never dispatched; creating + missing native
  // evidence remains unknown, never permission to recreate a deleted Session.
  service.dispatchImportedHistoryCreation = (input, assertCurrent) => mutate('sessions', db => {
    if (!input || Object.keys(input).some(key => !['historyId', 'logicalOperationId', 'expectedRevision'].includes(key)) || !isCanonicalUuid(input.logicalOperationId) || !Number.isSafeInteger(input.expectedRevision)) fail();
    assertAuthority(assertCurrent);
    const current = decodeRows(db.prepare(select).all()).find(row => row.historyId === input.historyId);
    if (!current || current.logicalOperationId !== input.logicalOperationId) fail('history-reservation-conflict');
    if (current.revision !== input.expectedRevision) fail('stale-revision');
    if (current.phase !== 'reserved') fail('history-creation-already-dispatched');
    assertTopic(db, current.intent);
    const value = { ...current, phase: 'creating', revision: current.revision + 1 };
    assertAuthority(assertCurrent);
    db.prepare("UPDATE operation_journal SET result_status = 'creating', result_identity = ?, observed_revision = ?, updated_at = ? WHERE logical_operation_id = ?")
      .run(JSON.stringify(value), String(value.revision), new Date().toISOString(), current.logicalOperationId);
    return decode(db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(current.logicalOperationId));
  });
  // These internal owner commands record proof already obtained by the native
  // import owner. They do not themselves assert that a transcript was inspected.
  function advance(input, assertCurrent, complete) {
    return mutate('sessions', db => {
      if (!input || Object.keys(input).some(key => !['historyId', 'logicalOperationId', 'expectedRevision', 'proof'].includes(key)) || !isCanonicalUuid(input.logicalOperationId) || !Number.isSafeInteger(input.expectedRevision)) fail();
      assertAuthority(assertCurrent);
      const current = decodeRows(db.prepare(select).all()).find(row => row.historyId === input.historyId);
      if (!current || current.logicalOperationId !== input.logicalOperationId) fail('history-reservation-conflict');
      if (current.revision !== input.expectedRevision) fail('stale-revision');
      if (current.phase === 'verified') fail('history-terminal');
      if (current.phase === 'reserved') fail('history-creation-not-dispatched');
      assertTopic(db, current.intent);
      const proof = proofOf(input.proof);
      if (proof.sessionLifecycleRevision !== current.logicalOperationId) fail('history-proof-conflict');
      if (proof.verifiedCount > current.intent.expectedCount || proof.verifiedCount < current.verifiedCount || (current.transcriptGeneration !== null && proof.transcriptGeneration !== current.transcriptGeneration) || (current.anchorDigest !== null && proof.verifiedCount === current.verifiedCount && proof.anchorDigest !== current.anchorDigest)) fail('history-proof-conflict');
      if (complete && (current.phase !== 'importing' || proof.verifiedCount !== current.intent.expectedCount)) fail('history-incomplete');
      const value = { ...current, ...proof, phase: complete ? 'verified' : 'importing', revision: current.revision + 1 };
      assertAuthority(assertCurrent);
      db.prepare('UPDATE operation_journal SET state = ?, result_status = ?, result_identity = ?, observed_revision = ?, updated_at = ? WHERE logical_operation_id = ?')
        .run(complete ? 'applied' : 'pending', value.phase, JSON.stringify(value), String(value.revision), new Date().toISOString(), current.logicalOperationId);
      return decode(db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(current.logicalOperationId));
    });
  }
  service.checkpointImportedHistory = (input, assertCurrent) => advance(input, assertCurrent, false);
  service.completeImportedHistory = (input, assertCurrent) => advance(input, assertCurrent, true);
}
