import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { isNoteFolderIdentity } from '../sources/note-folder-identity-format.mjs';

export const PROVISIONING_PRIMARY_OPERATION = 'topic.provisioning-primary.v1';
export const CONDITIONAL_PRIMARY_MODE = 'conditional-native-v1';
const overlaps = (left, right) => [path.relative(left, right), path.relative(right, left)].some(relative => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));

// Both preparation owners call this inside their existing SQLite transaction.
// A durable reservation owns its folder before any Source Locator exists.
export function assertConditionalFolderClaims(db, folderPath, operationId, ErrorType) {
  for (const row of db.prepare("SELECT logical_operation_id,intent_json FROM topic_operations WHERE operation_kind='topics.create' AND state NOT IN ('applied','not-applied')").all()) {
    const intent = JSON.parse(row.intent_json);
    if (intent.primaryMode === CONDITIONAL_PRIMARY_MODE && row.logical_operation_id !== operationId && overlaps(intent.folderPath, folderPath)) {
      throw new ErrorType('preparation-folder-conflict', 'Another conditional preparation owns this Note Folder.');
    }
  }
}
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => isCanonicalUuid(value) && value === value.toLowerCase();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export function provisioningPrimaryOperationId(parentId) {
  const bytes = hash(`provisioning-primary-v1:${parentId}`);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-8${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`;
}

// Internal, explicitly authorized preparation. Deferred interactive Topic
// creation keeps its separate legacy contract; it cannot modify these receipts.
export function installProvisioningPrimaryMetadata(service, { mutate, inspect, readMany, assertMutation, assertChildClaim, ErrorType }) {
  const fail = (code = 'provisioning-primary-conflict') => { throw new ErrorType(code, code); };
  const check = authority => { if (typeof authority !== 'function' || authority()?.then) fail('provisioning-authority-unavailable'); };
  function rootIntent(input) {
    if (!(exact(input, ['logicalOperationId', 'topicId', 'name', 'paraCategory', 'folderPath']) || exact(input, ['logicalOperationId', 'topicId', 'name', 'paraCategory', 'folderPath', 'preparationDigest'])) || !uuid(input.logicalOperationId) || !uuid(input.topicId) ||
      typeof input.name !== 'string' || !input.name.trim() || Buffer.byteLength(input.name) > 255 || /[\\/\x00-\x1f]/u.test(input.name) ||
      !['project', 'area', 'resource'].includes(input.paraCategory) || typeof input.folderPath !== 'string' ||
      !path.isAbsolute(input.folderPath) || path.resolve(input.folderPath) !== input.folderPath ||
      !(input.preparationDigest === undefined || input.preparationDigest === null || typeof input.preparationDigest === 'string' && /^[a-f0-9]{64}$/.test(input.preparationDigest))) fail('provisioning-intent-invalid');
    return { name: input.name, paraCategory: input.paraCategory, topicId: input.topicId, folderPath: input.folderPath, primaryMode: CONDITIONAL_PRIMARY_MODE,
      ...(input.preparationDigest == null ? {} : { preparationDigest: input.preparationDigest }) };
  }
  const parent = (db, id) => db.prepare('SELECT * FROM topic_operations WHERE logical_operation_id=?').get(id);
  const rollbackStarted = row => row?.current_step?.startsWith('rollback-');
  const parentResult = row => row?.result_json ? JSON.parse(row.result_json) : {};
  function assertFolderAvailable(db, intent, id) {
    assertConditionalFolderClaims(db, intent.folderPath, id, ErrorType);
    if (service.listTopicBootstraps().some(row => overlaps(row.intent.folder.path, intent.folderPath))) fail('preparation-folder-conflict');
    for (const reference of service.listSourceReferences()) {
      if (reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.topicId !== intent.topicId &&
        overlaps(service.getSourceLocator(reference.referenceId)?.locator ?? reference.externalSourceId, intent.folderPath)) fail('preparation-folder-conflict');
    }
  }
  const select = `SELECT * FROM operation_journal WHERE operation_kind='${PROVISIONING_PRIMARY_OPERATION}' ORDER BY logical_operation_id`;
  function decode(row) {
    try {
      if (!row || row.operation_kind !== PROVISIONING_PRIMARY_OPERATION || typeof row.result_identity !== 'string' || Buffer.byteLength(row.result_identity) > 32768) fail();
      const value = JSON.parse(row.result_identity);
      if (!exact(value, ['schemaVersion', 'logicalOperationId', 'intent', 'phase', 'revision']) || value.schemaVersion !== 1 ||
        !exact(value.intent, ['parentOperationId', 'root', 'topicRevision', 'folder', 'primary']) ||
        !uuid(value.intent.parentOperationId) || value.logicalOperationId !== provisioningPrimaryOperationId(value.intent.parentOperationId) ||
        row.logical_operation_id !== value.logicalOperationId || hash(value.intent) !== row.intent_digest ||
        !['reserved', 'creating', 'applied', 'rolled-back'].includes(value.phase) ||
        value.revision !== ({ reserved: 1, creating: 2, applied: 3, 'rolled-back': 3 })[value.phase] ||
        row.observed_revision !== String(value.revision) || row.result_status !== value.phase ||
        row.state !== (value.phase === 'applied' ? 'applied' : value.phase === 'rolled-back' ? 'not-applied' : 'pending') ||
        !isDeepStrictEqual(value.intent.root, rootIntent({ logicalOperationId: value.intent.parentOperationId, ...Object.fromEntries(Object.entries(value.intent.root).filter(([key]) => key !== 'primaryMode')) })) ||
        !Number.isSafeInteger(value.intent.topicRevision) || value.intent.topicRevision < 0 ||
        !exact(value.intent.primary, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'referenceId', 'sessionUpdatedAt']) ||
        !Number.isSafeInteger(value.intent.primary.sessionUpdatedAt) || value.intent.primary.sessionUpdatedAt <= 0 ||
        !isDeepStrictEqual(value.intent.primary, primaryOf(value.intent.parentOperationId, value.intent.root.topicId, value.intent.primary.sessionUpdatedAt))) fail();
      return freeze(value);
    } catch { fail('provisioning-primary-receipt-invalid'); }
  }
  function primaryOf(parentId, topicId, sessionUpdatedAt = null) {
    const id = provisioningPrimaryOperationId(parentId);
    return { agentId: 'main', sessionKey: `agent:main:command-center:topic:${topicId}:primary`, sessionId: id, lifecycleRevision: id, referenceId: `session:${topicId}:primary`, sessionUpdatedAt };
  }
  function sessionUpdatedAtOf(db, parentId) {
    const value = Date.parse(parent(db, parentId)?.created_at ?? '');
    if (!Number.isSafeInteger(value) || value <= 0) fail('provisioning-primary-receipt-invalid');
    return value;
  }
  service.getProvisioningPrimary = parentId => readMany(select, [], decode).find(row => row.intent.parentOperationId === parentId) ?? null;
  function assertParent(db, parentId, intent) {
    const root = parent(db, parentId);
    if (!root || root.operation_kind !== 'topics.create' || root.topic_id !== intent.topicId || !isDeepStrictEqual(JSON.parse(root.intent_json), intent) || root.state === 'not-applied' || rollbackStarted(root)) fail();
    return root;
  }
  function folderBasis(topicId) {
    const referenceId = `note-folder:${topicId}`;
    const reference = service.getSourceReference(referenceId); const locator = service.getSourceLocator(referenceId);
    if (reference?.topicId !== topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note_folder' ||
      !isNoteFolderIdentity(locator?.observedRevision) || !locator.locator) fail('provisioning-folder-unavailable');
    return { reference, locator };
  }
  function assertBasis(db, receipt) {
    const { intent } = receipt;
    assertFolderAvailable(db, intent.root, intent.parentOperationId);
    const root = assertParent(db, intent.parentOperationId, intent.root);
    if (intent.primary.sessionUpdatedAt !== sessionUpdatedAtOf(db, intent.parentOperationId)) fail();
    const topic = service.getTopic(intent.root.topicId);
    if (!topic || topic.name !== intent.root.name || topic.paraCategory !== intent.root.paraCategory ||
      topic.revision !== intent.topicRevision + (receipt.phase === 'applied' ? 1 : 0) ||
      topic.lifecycle !== (receipt.phase === 'applied' ? 'active' : 'provisioning') ||
      intent.folder.locator.locator !== intent.root.folderPath || !isDeepStrictEqual(folderBasis(topic.topicId), intent.folder) || (root.state === 'applied') !== (receipt.phase === 'applied')) fail();
    if (receipt.phase === 'applied') {
      const primary = intent.primary;
      const reference = service.getSourceReference(primary.referenceId); const locator = service.getSourceLocator(primary.referenceId); const state = service.getSessionState(primary.referenceId);
      if (reference?.topicId !== topic.topicId || reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session' || reference.externalSourceId !== primary.sessionKey ||
        locator?.locator !== primary.sessionKey || locator.observedRevision !== primary.lifecycleRevision ||
        state?.sessionId !== primary.sessionId || state.status !== 'open' || state.isPrimary !== true) fail();
    }
  }
  function assertUnbound(intent) {
    const primary = intent.primary;
    for (const reference of service.listSourceReferences()) {
      if (reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session') continue;
      const locator = service.getSourceLocator(reference.referenceId); const state = service.getSessionState(reference.referenceId);
      if (reference.topicId === intent.root.topicId || reference.externalSourceId === primary.sessionKey || locator?.locator === primary.sessionKey || state?.sessionId === primary.sessionId) fail();
    }
    if (service.listTopicBootstraps().some(row => row.intent.primary.sessionKey === primary.sessionKey || row.intent.primary.sessionId === primary.sessionId) ||
      service.listImportedHistories().some(row => row.target.sessionKey === primary.sessionKey || row.target.sessionId === primary.sessionId)) fail();
  }
  function inspectRoot(db, input, authority) {
    check(authority);
    const intent = rootIntent(input); const id = input.logicalOperationId;
    assertFolderAvailable(db, intent, id);
    const current = parent(db, id);
    if (current) {
      assertParent(db, id, intent);
      const topic = service.getTopic(input.topicId); const primary = service.getProvisioningPrimary(id);
      if (!topic) fail();
      if (topic.revision !== (primary?.phase === 'applied' ? 1 : 0)) fail('stale-revision');
      if (topic.name !== intent.name || topic.paraCategory !== intent.paraCategory || topic.lifecycle !== (primary?.phase === 'applied' ? 'active' : 'provisioning')) fail();
      if (primary) assertBasis(db, primary);
      const planned = primaryOf(id, input.topicId, sessionUpdatedAtOf(db, id));
      if (primary?.phase !== 'applied') assertUnbound({ root: intent, primary: planned });
      return { intent, operation: service.getTopicOperation(id), primaryReceipt: primary, primary: planned };
    }
    assertChildClaim(db, { logicalOperationId: id }, true);
    assertChildClaim(db, { logicalOperationId: provisioningPrimaryOperationId(id) }, true);
    if (service.getTopic(input.topicId) || db.prepare('SELECT 1 FROM operation_journal WHERE logical_operation_id IN (?,?)').get(id, provisioningPrimaryOperationId(id)) ||
      service.listTopicBootstraps().some(row => row.intent.topicId === input.topicId)) fail();
    assertUnbound({ root: intent, primary: primaryOf(id, input.topicId) });
    return { intent, operation: null, primaryReceipt: null, primary: primaryOf(id, input.topicId) };
  }
  service.inspectConditionalProvisioning = (input, authority) => inspect(db => freeze(inspectRoot(db, input, authority)));
  service.reserveConditionalProvisioning = (input, authority) => mutate('notes', db => {
    assertMutation('sessions');
    const inspected = inspectRoot(db, input, authority);
    if (inspected.operation) return inspected.operation;
    const { intent } = inspected; const id = input.logicalOperationId;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO topics (topic_id,para_category,lifecycle,revision,name,created_at,updated_at) VALUES (?,?,'provisioning',0,?,?,?)").run(input.topicId, input.paraCategory, input.name, now, now);
    db.prepare("INSERT INTO topic_operations (logical_operation_id,topic_id,operation_kind,state,current_step,intent_json,created_at,updated_at) VALUES (?,?,'topics.create','pending','folder',?,?,?)").run(id, input.topicId, JSON.stringify(intent), now, now);
    check(authority); return service.getTopicOperation(id);
  });
  service.reserveProvisioningPrimary = (input, authority) => mutate('sessions', db => {
    check(authority);
    if (!exact(input, ['parentOperationId', 'expectedTopicRevision']) || !uuid(input.parentOperationId) || !Number.isSafeInteger(input.expectedTopicRevision)) fail('provisioning-intent-invalid');
    if (input.expectedTopicRevision !== 0) fail('stale-revision');
    const root = parent(db, input.parentOperationId); if (!root) fail();
    const rootValue = JSON.parse(root.intent_json);
    if (rootValue.primaryMode !== CONDITIONAL_PRIMARY_MODE) fail();
    assertParent(db, input.parentOperationId, rootValue);
    const id = provisioningPrimaryOperationId(input.parentOperationId);
    const existing = db.prepare('SELECT * FROM operation_journal WHERE logical_operation_id=?').get(id);
    if (existing) { const receipt = decode(existing); if (receipt.intent.topicRevision !== input.expectedTopicRevision) fail('stale-revision'); assertBasis(db, receipt); return receipt; }
    const intent = { parentOperationId: input.parentOperationId, root: rootValue, topicRevision: input.expectedTopicRevision,
      folder: folderBasis(rootValue.topicId), primary: primaryOf(input.parentOperationId, rootValue.topicId, sessionUpdatedAtOf(db, input.parentOperationId)) };
    const value = { schemaVersion: 1, logicalOperationId: id, intent, phase: 'reserved', revision: 1 };
    assertBasis(db, value); assertUnbound(intent);
    assertChildClaim(db, { logicalOperationId: id, operationKind: PROVISIONING_PRIMARY_OPERATION, intentDigest: hash(intent) });
    const now = new Date().toISOString(); check(authority);
    db.prepare("INSERT INTO operation_journal (logical_operation_id,transport_request_id,intent_digest,operation_kind,state,result_status,result_identity,observed_revision,created_at,updated_at) VALUES (?,?,?,?,'pending','reserved',?,'1',?,?)").run(id, id, hash(intent), PROVISIONING_PRIMARY_OPERATION, JSON.stringify(value), now, now);
    return freeze(value);
  });
  service.assertProvisioningPrimary = (receipt, authority) => inspect(db => {
    check(authority);
    const current = service.getProvisioningPrimary(receipt.intent.parentOperationId);
    if (!isDeepStrictEqual(current, receipt)) fail('stale-revision');
    assertBasis(db, current); if (current.phase !== 'applied') assertUnbound(current.intent);
  });
  service.dispatchProvisioningPrimary = (receipt, authority) => mutate('sessions', db => {
    check(authority);
    const current = service.getProvisioningPrimary(receipt.intent.parentOperationId);
    if (!isDeepStrictEqual(current, receipt) || current.phase !== 'reserved') fail('stale-revision');
    assertBasis(db, current); assertUnbound(current.intent);
    const value = { ...current, phase: 'creating', revision: 2 }; const now = new Date().toISOString(); check(authority);
    db.prepare("UPDATE operation_journal SET result_status='creating',result_identity=?,observed_revision='2',updated_at=? WHERE logical_operation_id=?").run(JSON.stringify(value), now, current.logicalOperationId);
    db.prepare("UPDATE topic_operations SET state='unknown',current_step='session-dispatched',updated_at=? WHERE logical_operation_id=?").run(now, current.intent.parentOperationId);
    return freeze(value);
  });
  service.completeProvisioningPrimary = (receipt, authority) => mutate('sessions', db => {
    assertMutation('notes'); check(authority);
    const current = service.getProvisioningPrimary(receipt.intent.parentOperationId);
    if (!isDeepStrictEqual(current, receipt) || current.phase !== 'creating') fail('stale-revision');
    assertBasis(db, current); assertUnbound(current.intent);
    const { intent } = current; const primary = intent.primary; const now = new Date().toISOString();
    db.prepare('INSERT INTO source_references (reference_id,topic_id,source_system,source_kind,external_source_id,last_observed_revision,created_at,updated_at) VALUES (?,?,\'openclaw\',\'session\',?,?,?,?)').run(primary.referenceId, intent.root.topicId, primary.sessionKey, primary.lifecycleRevision, now, now);
    db.prepare("INSERT INTO source_locators (reference_id,locator,locator_version,ownership,observed_revision,updated_at) VALUES (?,?,1,'created',?,?)").run(primary.referenceId, primary.sessionKey, primary.lifecycleRevision, now);
    db.prepare("INSERT INTO session_state (reference_id,session_id,status,is_primary,display_name,updated_at) VALUES (?,?,'open',1,?,?)").run(primary.referenceId, primary.sessionId, intent.root.name, now);
    db.prepare("INSERT INTO source_convention_state (reference_id,aspect,state,expected_value,updated_at) VALUES (?,'display_label','managed',?,?)").run(primary.referenceId, intent.root.name, now);
    db.prepare("UPDATE topics SET lifecycle='active',revision=revision+1,activated_at=?,updated_at=? WHERE topic_id=?").run(now, now, intent.root.topicId);
    const result = { topicId: intent.root.topicId, folderReferenceId: intent.folder.reference.referenceId, sessionReferenceId: primary.referenceId };
    db.prepare("UPDATE topic_operations SET state='applied',current_step='complete',result_json=?,updated_at=? WHERE logical_operation_id=?").run(JSON.stringify(result), now, intent.parentOperationId);
    const value = { ...current, phase: 'applied', revision: 3 };
    db.prepare("UPDATE operation_journal SET state='applied',result_status='applied',result_identity=?,observed_revision='3',updated_at=? WHERE logical_operation_id=?").run(JSON.stringify(value), now, current.logicalOperationId);
    check(authority); assertBasis(db, value); return freeze(value);
  });

  // The parent operation is the durable owner of the directory before its
  // Source Locator can exist. These transitions never infer ownership from a
  // matching final pathname. The filesystem owner supplies and verifies the
  // physical witness at each external-effect boundary.
  function folderCreation(db, parentId) {
    const row = parent(db, parentId);
    if (!row || row.operation_kind !== 'topics.create') fail();
    return parentResult(row).folderCreation ?? null;
  }
  service.getConditionalFolderCreation = parentId => inspect(db => freeze(folderCreation(db, parentId)));
  function folderRoot(db, parentId) {
    if (!uuid(parentId)) fail('provisioning-intent-invalid');
    const row = parent(db, parentId);
    if (!row || row.operation_kind !== 'topics.create' || row.state === 'applied' || row.state === 'not-applied' || rollbackStarted(row)) fail();
    const root = JSON.parse(row.intent_json);
    const expectedRoot = rootIntent({ logicalOperationId: parentId,
      ...Object.fromEntries(Object.entries(root).filter(([key]) => key !== 'primaryMode')) });
    if (root.primaryMode !== CONDITIONAL_PRIMARY_MODE || !isDeepStrictEqual(root, expectedRoot)) fail();
    const topic = service.getTopic(root.topicId);
    if (!topic || topic.lifecycle !== 'provisioning' || topic.name !== root.name || topic.paraCategory !== root.paraCategory || topic.revision !== 0) fail();
    return { row, root };
  }
  function writeFolderCreation(db, row, receipt, authority) {
    const result = { ...parentResult(row), folderCreation: receipt };
    const now = new Date().toISOString(); check(authority);
    db.prepare('UPDATE topic_operations SET result_json=?,updated_at=? WHERE logical_operation_id=?').run(JSON.stringify(result), now, row.logical_operation_id);
    return freeze(receipt);
  }
  service.prepareConditionalFolderCreation = (input, authority) => mutate('notes', db => {
    check(authority);
    if (!exact(input, ['parentOperationId', 'expectedTopicRevision', 'stagePath']) || input.expectedTopicRevision !== 0) fail('provisioning-intent-invalid');
    const { row, root } = folderRoot(db, input.parentOperationId);
    if (typeof input.stagePath !== 'string' || !path.isAbsolute(input.stagePath) || path.resolve(input.stagePath) !== input.stagePath ||
      input.stagePath === root.folderPath || path.dirname(input.stagePath) !== path.dirname(root.folderPath) ||
      !path.basename(input.stagePath).startsWith(`.command-center-provisioning-${input.parentOperationId}-`)) fail('provisioning-intent-invalid');
    const receipt = { operationId: input.parentOperationId, stagePath: input.stagePath, finalPath: root.folderPath, phase: 'prepared' };
    const existing = folderCreation(db, input.parentOperationId);
    if (existing) { if (existing.operationId !== receipt.operationId || existing.stagePath !== receipt.stagePath || existing.finalPath !== receipt.finalPath) fail(); return freeze(existing); }
    if (service.getSourceLocator(`note-folder:${root.topicId}`)) fail();
    return writeFolderCreation(db, row, receipt, authority);
  });
  service.identifyConditionalFolderCreation = (input, authority) => mutate('notes', db => {
    check(authority);
    if (!exact(input, ['parentOperationId', 'stagePath', 'directoryIdentity', 'markerIdentity']) ||
      !/^[a-f0-9]{64}$/.test(input.directoryIdentity) || !isNoteFolderIdentity(input.markerIdentity)) fail('provisioning-intent-invalid');
    const { row, root } = folderRoot(db, input.parentOperationId);
    const current = folderCreation(db, input.parentOperationId);
    if (!current || current.operationId !== input.parentOperationId || current.stagePath !== input.stagePath || current.finalPath !== root.folderPath) fail();
    const receipt = { ...current, directoryIdentity: input.directoryIdentity, markerIdentity: input.markerIdentity, phase: 'identified' };
    if (current.phase !== 'prepared') { if (!isDeepStrictEqual(current, receipt)) fail(); return freeze(current); }
    return writeFolderCreation(db, row, receipt, authority);
  });
  service.publishConditionalFolderCreation = (input, authority) => mutate('notes', db => {
    check(authority);
    if (!exact(input, ['parentOperationId', 'stagePath', 'directoryIdentity', 'markerIdentity'])) fail('provisioning-intent-invalid');
    const { row, root } = folderRoot(db, input.parentOperationId);
    const current = folderCreation(db, input.parentOperationId);
    if (!current || current.operationId !== input.parentOperationId || current.stagePath !== input.stagePath || current.finalPath !== root.folderPath ||
      current.directoryIdentity !== input.directoryIdentity || current.markerIdentity !== input.markerIdentity || !['identified', 'published'].includes(current.phase)) fail();
    if (current.phase === 'published') return freeze(current);
    return writeFolderCreation(db, row, { ...current, phase: 'published' }, authority);
  });

  function rollbackRow(db, parentId) {
    if (!uuid(parentId)) fail('provisioning-intent-invalid');
    const row = parent(db, parentId);
    if (!row || row.operation_kind !== 'topics.create' || row.state === 'applied' || row.state === 'not-applied') fail();
    const root = JSON.parse(row.intent_json);
    const expectedRoot = rootIntent({ logicalOperationId: parentId,
      ...Object.fromEntries(Object.entries(root).filter(([key]) => key !== 'primaryMode')) });
    if (root.primaryMode !== CONDITIONAL_PRIMARY_MODE || !isDeepStrictEqual(root, expectedRoot)) fail();
    return { row, root };
  }
  function readRollback(db, parentId) { return parentResult(parent(db, parentId)).rollback ?? null; }
  service.getConditionalProvisioningRollback = parentId => inspect(db => freeze(readRollback(db, parentId)));
  function writeRollback(db, row, receipt, authority) {
    const result = { ...parentResult(row), rollback: receipt };
    const now = new Date().toISOString(); check(authority);
    db.prepare("UPDATE topic_operations SET state='unknown',current_step=?,result_json=?,updated_at=? WHERE logical_operation_id=?")
      .run(`rollback-${receipt.phase}`, JSON.stringify(result), now, row.logical_operation_id);
    return freeze(receipt);
  }
  function assertRollbackBasis(db, receipt, row, root) {
    if (!isDeepStrictEqual(receipt.root, root) || receipt.parentOperationId !== row.logical_operation_id ||
      row.current_step !== `rollback-${receipt.phase}` || !isDeepStrictEqual(readRollback(db, row.logical_operation_id), receipt)) fail();
    const topic = service.getTopic(root.topicId);
    if (!topic || topic.lifecycle !== 'provisioning' || topic.revision !== receipt.topicRevision ||
      topic.name !== root.name || topic.paraCategory !== root.paraCategory) fail();
    if (!isDeepStrictEqual(folderCreation(db, row.logical_operation_id), receipt.folderCreation)) fail();
    const primary = service.getProvisioningPrimary(row.logical_operation_id);
    if (!isDeepStrictEqual(primary, receipt.primaryReceipt)) fail();
    const folderRef = service.getSourceReference(`note-folder:${root.topicId}`);
    const folderLocator = service.getSourceLocator(`note-folder:${root.topicId}`);
    if (receipt.phase === 'folder-cleared') {
      if (folderRef || folderLocator) fail();
    } else if (!isDeepStrictEqual(folderLocator, receipt.folderLocator) ||
      (folderRef && (folderRef.topicId !== root.topicId || folderRef.sourceKind !== 'note_folder' || folderRef.sourceSystem !== 'obsidian'))) fail();
    const refs = service.listSourceReferences(root.topicId);
    const allowed = receipt.phase === 'folder-cleared' ? [] : [`note-folder:${root.topicId}`];
    if (refs.some(ref => !allowed.includes(ref.referenceId))) fail();
    const sessionRef = service.getSourceReference(receipt.primary.referenceId);
    // Conditional Primary attachment and Topic activation commit together. A
    // Session reference on a still-provisioning Topic has another owner.
    if (sessionRef) fail();
  }
  service.beginConditionalProvisioningRollback = (input, authority) => mutate('notes', db => {
    assertMutation('sessions'); check(authority);
    if (!exact(input, ['parentOperationId', 'expectedTopicRevision']) || !Number.isSafeInteger(input.expectedTopicRevision)) fail('provisioning-intent-invalid');
    const { row, root } = rollbackRow(db, input.parentOperationId);
    const existing = readRollback(db, input.parentOperationId);
    if (existing) { if (input.expectedTopicRevision !== existing.topicRevision) fail('stale-revision'); assertRollbackBasis(db, existing, row, root); return freeze(existing); }
    const topic = service.getTopic(root.topicId);
    if (!topic || topic.lifecycle !== 'provisioning' || topic.revision !== input.expectedTopicRevision || topic.name !== root.name || topic.paraCategory !== root.paraCategory) fail('stale-revision');
    const primaryReceipt = service.getProvisioningPrimary(input.parentOperationId);
    if (primaryReceipt?.phase === 'applied') fail();
    const folderReceipt = folderCreation(db, input.parentOperationId);
    const folderLocator = service.getSourceLocator(`note-folder:${root.topicId}`);
    if (folderLocator?.ownership === 'created' && folderReceipt?.phase !== 'published') fail('provisioning-folder-unavailable');
    if (folderReceipt?.phase === 'published' && folderLocator && (folderLocator.locator !== root.folderPath ||
      folderLocator.observedRevision !== folderReceipt.markerIdentity || folderLocator.ownership !== 'created')) fail('provisioning-folder-unavailable');
    if (folderLocator && (folderLocator.locator !== root.folderPath || !isNoteFolderIdentity(folderLocator.observedRevision))) fail();
    const folderRef = service.getSourceReference(`note-folder:${root.topicId}`);
    if (Boolean(folderRef) !== Boolean(folderLocator) || (folderRef && (folderRef.topicId !== root.topicId ||
      folderRef.sourceKind !== 'note_folder' || folderRef.sourceSystem !== 'obsidian'))) fail();
    const receipt = { schemaVersion: 1, parentOperationId: input.parentOperationId, root, topicRevision: topic.revision,
      folderCreation: folderReceipt, folderLocator, primaryReceipt, primary: primaryOf(input.parentOperationId, root.topicId, sessionUpdatedAtOf(db, input.parentOperationId)),
      phase: 'prepared', revision: 1 };
    const refs = service.listSourceReferences(root.topicId);
    if (refs.some(ref => ref.referenceId !== `note-folder:${root.topicId}`)) fail();
    return writeRollback(db, row, receipt, authority);
  });
  service.advanceConditionalProvisioningRollback = (receipt, nextPhase, authority) => mutate('notes', db => {
    assertMutation('sessions'); check(authority);
    const { row, root } = rollbackRow(db, receipt?.parentOperationId);
    const current = readRollback(db, receipt.parentOperationId);
    if (!isDeepStrictEqual(current, receipt)) fail('stale-revision');
    assertRollbackBasis(db, current, row, root);
    const phases = { prepared: 'session-cleared', 'session-cleared': 'folder-cleaning', 'folder-cleaning': 'folder-cleared' };
    if (phases[current.phase] !== nextPhase) fail('stale-revision');
    if (nextPhase === 'folder-cleared' && service.getSourceReference(`note-folder:${root.topicId}`))
      db.prepare('DELETE FROM source_references WHERE reference_id=? AND topic_id=?').run(`note-folder:${root.topicId}`, root.topicId);
    return writeRollback(db, row, { ...current, phase: nextPhase, revision: current.revision + 1 }, authority);
  });
  service.finishConditionalProvisioningRollback = (receipt, authority) => mutate('notes', db => {
    assertMutation('sessions'); check(authority);
    const { row, root } = rollbackRow(db, receipt?.parentOperationId);
    const current = readRollback(db, receipt.parentOperationId);
    if (!isDeepStrictEqual(current, receipt) || current.phase !== 'folder-cleared') fail('stale-revision');
    assertRollbackBasis(db, current, row, root);
    if (service.listSourceReferences(root.topicId).length) fail();
    const now = new Date().toISOString(); check(authority);
    db.prepare('DELETE FROM topics WHERE topic_id=? AND lifecycle=\'provisioning\' AND revision=?').run(root.topicId, receipt.topicRevision);
    const result = { ...parentResult(row), rollback: { ...current, phase: 'rolled-back', revision: 5 } };
    if (current.primaryReceipt) {
      const child = { ...current.primaryReceipt, phase: 'rolled-back', revision: 3 };
      db.prepare("UPDATE operation_journal SET state='not-applied',result_status='rolled-back',result_identity=?,observed_revision='3',updated_at=? WHERE logical_operation_id=?")
        .run(JSON.stringify(child), now, current.primaryReceipt.logicalOperationId);
    }
    db.prepare("UPDATE topic_operations SET topic_id=NULL,state='not-applied',current_step='rolled-back',result_json=?,updated_at=? WHERE logical_operation_id=?")
      .run(JSON.stringify(result), now, row.logical_operation_id);
    return freeze(result.rollback);
  });
}
