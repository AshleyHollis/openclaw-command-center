import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';

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
        !['reserved', 'creating', 'applied'].includes(value.phase) || value.revision !== ['reserved', 'creating', 'applied'].indexOf(value.phase) + 1 ||
        row.observed_revision !== String(value.revision) || row.result_status !== value.phase || row.state !== (value.phase === 'applied' ? 'applied' : 'pending') ||
        !isDeepStrictEqual(value.intent.root, rootIntent({ logicalOperationId: value.intent.parentOperationId, ...Object.fromEntries(Object.entries(value.intent.root).filter(([key]) => key !== 'primaryMode')) })) ||
        !Number.isSafeInteger(value.intent.topicRevision) || value.intent.topicRevision < 0 ||
        !exact(value.intent.primary, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'referenceId']) ||
        !isDeepStrictEqual(value.intent.primary, primaryOf(value.intent.parentOperationId, value.intent.root.topicId))) fail();
      return freeze(value);
    } catch { fail('provisioning-primary-receipt-invalid'); }
  }
  function primaryOf(parentId, topicId) {
    const id = provisioningPrimaryOperationId(parentId);
    return { agentId: 'main', sessionKey: `agent:main:command-center:topic:${topicId}:primary`, sessionId: id, lifecycleRevision: id, referenceId: `session:${topicId}:primary` };
  }
  service.getProvisioningPrimary = parentId => readMany(select, [], decode).find(row => row.intent.parentOperationId === parentId) ?? null;
  function assertParent(db, parentId, intent) {
    const root = parent(db, parentId);
    if (!root || root.operation_kind !== 'topics.create' || root.topic_id !== intent.topicId || !isDeepStrictEqual(JSON.parse(root.intent_json), intent) || root.state === 'not-applied') fail();
    return root;
  }
  function folderBasis(topicId) {
    const referenceId = `note-folder:${topicId}`;
    const reference = service.getSourceReference(referenceId); const locator = service.getSourceLocator(referenceId);
    if (reference?.topicId !== topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note_folder' ||
      !locator?.observedRevision?.startsWith('note-folder:1:') || !locator.locator) fail('provisioning-folder-unavailable');
    return { reference, locator };
  }
  function assertBasis(db, receipt) {
    const { intent } = receipt;
    assertFolderAvailable(db, intent.root, intent.parentOperationId);
    const root = assertParent(db, intent.parentOperationId, intent.root);
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
      if (primary?.phase !== 'applied') assertUnbound({ root: intent, primary: primaryOf(id, input.topicId) });
      return { intent, operation: service.getTopicOperation(id), primaryReceipt: primary, primary: primaryOf(id, input.topicId) };
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
      folder: folderBasis(rootValue.topicId), primary: primaryOf(input.parentOperationId, rootValue.topicId) };
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
}
