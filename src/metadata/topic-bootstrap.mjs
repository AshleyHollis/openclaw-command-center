import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { assertConditionalFolderClaims } from './provisioning-primary.mjs';

export const TOPIC_BOOTSTRAP_OPERATION = 'topic.bootstrap.v1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const marker = value => typeof value === 'string' && /^note-folder:1:[a-f0-9-]{36}:[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\x00-\x1f]/.test(value);
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const overlaps = (left, right) => [path.relative(left, right), path.relative(right, left)].some(relative => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));

// Initial adoption owns a distinct permanent receipt. It never invokes Topic
// creation, demotes an existing Primary, or rewrites a legacy import record.
export function installTopicBootstrapMetadata(service, { mutate, inspect, readMany, assertMutation, assertChildClaim, ErrorType }) {
  const fail = (code = 'bootstrap-intent-invalid') => { throw new ErrorType(code, code); };
  const check = authority => { if (typeof authority !== 'function' || authority()?.then) fail('bootstrap-authority-unavailable'); };
  function intentOf(value, logicalOperationId) {
    if (!exact(value, ['schemaVersion', 'mappingDigest', 'topicId', 'name', 'paraCategory', 'folder', 'primary']) || value.schemaVersion !== 1 ||
      !digest(value.mappingDigest) || !isCanonicalUuid(value.topicId) || !text(value.name) || value.name.length > 300 ||
      !['project', 'area', 'resource'].includes(value.paraCategory) || !exact(value.folder, ['path', 'directoryIdentity', 'markerIdentity']) ||
      !text(value.folder.path) || !path.isAbsolute(value.folder.path) || path.resolve(value.folder.path) !== value.folder.path ||
      !digest(value.folder.directoryIdentity) || !(value.folder.markerIdentity === null || marker(value.folder.markerIdentity)) ||
      !(exact(value.primary, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision']) ||
        exact(value.primary, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'creation']) && value.primary.creation === 'if-absent' &&
        value.primary.sessionKey === `agent:${value.primary.agentId}:command-center:topic:${value.topicId}:primary` &&
        value.primary.sessionId === logicalOperationId && value.primary.lifecycleRevision === logicalOperationId) || !/^[a-z0-9_-]{1,64}$/.test(value.primary.agentId) ||
      !text(value.primary.sessionKey) || !value.primary.sessionKey.startsWith(`agent:${value.primary.agentId}:`) ||
      value.primary.sessionKey === `agent:${value.primary.agentId}:main` || !text(value.primary.sessionId) ||
      !(value.primary.lifecycleRevision === null || text(value.primary.lifecycleRevision))) fail();
    return structuredClone(value);
  }
  function decode(row) {
    try {
      if (row.operation_kind !== TOPIC_BOOTSTRAP_OPERATION || typeof row.result_identity !== 'string' || Buffer.byteLength(row.result_identity) > 16384) fail();
      const value = JSON.parse(row.result_identity);
      if (!exact(value, ['schemaVersion', 'logicalOperationId', 'intent', 'phase', 'revision', 'folderIdentity', 'folderReferenceId', 'sessionReferenceId']) ||
        value.schemaVersion !== 1 || !isCanonicalUuid(value.logicalOperationId) || value.logicalOperationId !== row.logical_operation_id ||
        hash(intentOf(value.intent, value.logicalOperationId)) !== row.intent_digest || value.folderReferenceId !== `note-folder:${value.intent.topicId}` ||
        value.sessionReferenceId !== `session:${value.intent.topicId}:primary` || !['reserved', 'creating', 'applied'].includes(value.phase) ||
        value.phase === 'creating' && value.intent.primary.creation !== 'if-absent' ||
        value.revision !== (value.phase === 'reserved' ? 1 : value.phase === 'creating' ? 2 : value.intent.primary.creation === 'if-absent' ? 3 : 2) || row.observed_revision !== String(value.revision) || row.result_status !== value.phase ||
        row.state !== (value.phase === 'applied' ? 'applied' : 'pending') ||
        (value.phase !== 'applied' ? value.folderIdentity !== null : !marker(value.folderIdentity) || (value.intent.folder.markerIdentity !== null && value.folderIdentity !== value.intent.folder.markerIdentity))) fail();
      return freeze(value);
    } catch { fail('bootstrap-receipt-invalid'); }
  }
  const select = "SELECT * FROM operation_journal WHERE operation_kind = 'topic.bootstrap.v1' ORDER BY logical_operation_id";
  service.listTopicBootstraps = () => readMany(select, [], decode);
  service.getTopicBootstrap = id => service.listTopicBootstraps().find(row => row.logicalOperationId === id) ?? null;
  function assertAvailable(db, intent, operationId, folderIdentity = intent.folder.markerIdentity) {
    assertConditionalFolderClaims(db, intent.folder.path, operationId, ErrorType);
    if (db.prepare('SELECT 1 FROM topics WHERE topic_id = ?').get(intent.topicId)) fail('bootstrap-ownership-conflict');
    for (const row of db.prepare(select).all().map(decode)) {
      if (row.logicalOperationId === operationId) continue;
      const other = row.intent;
      if (other.topicId === intent.topicId || other.folder.directoryIdentity === intent.folder.directoryIdentity ||
        (folderIdentity !== null && (other.folder.markerIdentity === folderIdentity || row.folderIdentity === folderIdentity)) || overlaps(other.folder.path, intent.folder.path) ||
        other.primary.sessionKey === intent.primary.sessionKey || (other.primary.agentId === intent.primary.agentId && other.primary.sessionId === intent.primary.sessionId)) fail('bootstrap-ownership-conflict');
    }
    for (const history of service.listImportedHistories()) {
      if (history.target.sessionKey === intent.primary.sessionKey || (history.target.agentId === intent.primary.agentId && history.target.sessionId === intent.primary.sessionId)) fail('bootstrap-ownership-conflict');
    }
    for (const row of db.prepare(`SELECT r.source_system,r.source_kind,r.external_source_id,r.last_observed_revision,l.locator,l.observed_revision,s.session_id FROM source_references r
      LEFT JOIN source_locators l ON l.reference_id=r.reference_id LEFT JOIN session_state s ON s.reference_id=r.reference_id`).all()) {
      const locator = row.locator ?? row.external_source_id;
      if (row.source_system === 'obsidian' && row.source_kind === 'note_folder' && (overlaps(locator, intent.folder.path) ||
        (folderIdentity !== null && [row.observed_revision, row.last_observed_revision].includes(folderIdentity)))) fail('bootstrap-ownership-conflict');
      if (row.source_system === 'openclaw' && row.source_kind === 'session' && (locator === intent.primary.sessionKey || row.external_source_id === intent.primary.sessionKey || row.session_id === intent.primary.sessionId)) fail('bootstrap-ownership-conflict');
    }
  }
  service.inspectTopicBootstrap = (input, assertCurrent) => inspect(db => {
    check(assertCurrent);
    if (!exact(input, ['logicalOperationId', 'intent']) || !isCanonicalUuid(input.logicalOperationId)) fail();
    const intent = intentOf(input.intent, input.logicalOperationId);
    const intentDigest = hash(intent);
    assertChildClaim(db, { logicalOperationId: input.logicalOperationId, operationKind: TOPIC_BOOTSTRAP_OPERATION, intentDigest });
    const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (existing && (existing.operation_kind !== TOPIC_BOOTSTRAP_OPERATION || !isDeepStrictEqual(decode(existing).intent, intent))) fail('intent-mismatch');
    const receipt = existing ? decode(existing) : null;
    if (receipt?.phase !== 'applied') assertAvailable(db, intent, input.logicalOperationId);
    return freeze({ logicalOperationId: input.logicalOperationId, intent, intentDigest, receipt });
  });
  service.reserveTopicBootstrap = (input, assertCurrent) => mutate('notes', db => {
    assertMutation('sessions'); check(assertCurrent);
    if (!exact(input, ['logicalOperationId', 'intent']) || !isCanonicalUuid(input.logicalOperationId)) fail();
    const intent = intentOf(input.intent, input.logicalOperationId);
    assertChildClaim(db, { logicalOperationId: input.logicalOperationId, operationKind: TOPIC_BOOTSTRAP_OPERATION, intentDigest: hash(intent) });
    const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (existing) {
      if (existing.operation_kind !== TOPIC_BOOTSTRAP_OPERATION || !isDeepStrictEqual(decode(existing).intent, intent)) fail('intent-mismatch');
      return decode(existing);
    }
    assertAvailable(db, intent, input.logicalOperationId);
    const value = { schemaVersion: 1, logicalOperationId: input.logicalOperationId, intent, phase: 'reserved', revision: 1, folderIdentity: null,
      folderReferenceId: `note-folder:${intent.topicId}`, sessionReferenceId: `session:${intent.topicId}:primary` };
    const now = new Date().toISOString(); check(assertCurrent);
    db.prepare(`INSERT INTO operation_journal (logical_operation_id,transport_request_id,intent_digest,operation_kind,state,result_status,result_identity,observed_revision,created_at,updated_at)
      VALUES (?,?,?,?,'pending','reserved',?,'1',?,?)`).run(input.logicalOperationId, input.logicalOperationId, hash(intent), TOPIC_BOOTSTRAP_OPERATION, JSON.stringify(value), now, now);
    return freeze(value);
  });
  // Only this durable transition permits a first native create. A creating
  // receipt with no native effect remains unknown, not permission to redispatch.
  service.dispatchTopicBootstrapPrimary = (input, assertCurrent) => mutate('notes', db => {
    assertMutation('sessions'); check(assertCurrent);
    if (!exact(input, ['logicalOperationId', 'expectedRevision']) || !isCanonicalUuid(input.logicalOperationId) || !Number.isSafeInteger(input.expectedRevision)) fail();
    const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (!row) fail('bootstrap-reservation-missing');
    const current = decode(row);
    if (current.revision !== input.expectedRevision) fail('stale-revision');
    if (current.phase !== 'reserved' || current.intent.primary.creation !== 'if-absent') fail('bootstrap-creation-already-dispatched');
    assertAvailable(db, current.intent, current.logicalOperationId);
    const value = { ...current, phase: 'creating', revision: 2 };
    check(assertCurrent);
    db.prepare("UPDATE operation_journal SET result_status='creating',result_identity=?,observed_revision='2',updated_at=? WHERE logical_operation_id=?")
      .run(JSON.stringify(value), new Date().toISOString(), current.logicalOperationId);
    return freeze(value);
  });
  // assertExactSources is synchronous and runs inside this transaction, before
  // and after writes. The Topic bootstrap owner supplies held source witnesses.
  service.completeTopicBootstrap = (input, assertExactSources) => mutate('notes', db => {
    assertMutation('sessions'); check(assertExactSources);
    if (!exact(input, ['logicalOperationId', 'expectedRevision', 'folderIdentity']) || !isCanonicalUuid(input.logicalOperationId) || !marker(input.folderIdentity)) fail();
    const row = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id = ?').get(input.logicalOperationId);
    if (!row) fail('bootstrap-reservation-missing');
    const current = decode(row);
    if (input.expectedRevision !== current.revision) fail('stale-revision');
    if (current.phase === 'applied') fail('bootstrap-terminal');
    if (current.phase !== (current.intent.primary.creation === 'if-absent' ? 'creating' : 'reserved')) fail('bootstrap-incomplete');
    const intent = current.intent;
    if (intent.folder.markerIdentity !== null && intent.folder.markerIdentity !== input.folderIdentity) fail('bootstrap-source-conflict');
    assertAvailable(db, intent, input.logicalOperationId, input.folderIdentity);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO topics (topic_id,para_category,lifecycle,revision,name,activated_at,created_at,updated_at) VALUES (?,?,'active',0,?,?,?,?)")
      .run(intent.topicId, intent.paraCategory, intent.name, now, now, now);
    for (const [referenceId, system, kind, locator, revision] of [
      [current.folderReferenceId, 'obsidian', 'note_folder', intent.folder.path, input.folderIdentity],
      [current.sessionReferenceId, 'openclaw', 'session', intent.primary.sessionKey, intent.primary.lifecycleRevision]
    ]) {
      db.prepare('INSERT INTO source_references (reference_id,topic_id,source_system,source_kind,external_source_id,last_observed_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(referenceId, intent.topicId, system, kind, locator, revision, now, now);
      db.prepare("INSERT INTO source_locators (reference_id,locator,locator_version,ownership,observed_revision,updated_at) VALUES (?,?,1,'external',?,?)").run(referenceId, locator, revision, now);
    }
    db.prepare("INSERT INTO session_state (reference_id,session_id,status,is_primary,updated_at) VALUES (?,?,'open',1,?)").run(current.sessionReferenceId, intent.primary.sessionId, now);
    const value = { ...current, phase: 'applied', revision: current.revision + 1, folderIdentity: input.folderIdentity };
    db.prepare("UPDATE operation_journal SET state='applied',result_status='applied',result_identity=?,observed_revision=?,updated_at=? WHERE logical_operation_id=?")
      .run(JSON.stringify(value), String(value.revision), now, input.logicalOperationId);
    check(assertExactSources);
    return freeze(value);
  });
}
