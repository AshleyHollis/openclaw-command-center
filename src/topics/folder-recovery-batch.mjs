import { sourceError } from '../sources/errors.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';

function binding(input) {
  if (!input || typeof input !== 'object') throw sourceError('invalid-request', 'Each Note Folder recovery binding is required.');
  const topicId = String(input.topicId ?? '').trim();
  const referenceId = String(input.referenceId ?? '').trim();
  const mode = input.mode;
  if (!topicId || !referenceId || !['verify', 'enroll', 'rebind'].includes(mode)) throw sourceError('invalid-request', 'Each Note Folder recovery binding requires an exact Topic, Source Reference, and recovery mode.');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.expectedSourceRevision !== 'string' || !input.expectedSourceRevision || !Number.isSafeInteger(input.expectedLocatorVersion) || input.expectedLocatorVersion < 0) throw sourceError('invalid-request', 'Each Note Folder recovery binding requires its original conditional revisions.');
  const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
  const replacementLocator = ['enroll', 'rebind'].includes(mode) ? String(input.replacementLocator ?? '').trim() : undefined;
  const expectedReplacementIdentity = mode === 'rebind' ? String(input.expectedReplacementIdentity ?? '').trim() : undefined;
  if (['enroll', 'rebind'].includes(mode) && !replacementLocator) throw sourceError('invalid-request', 'An enrollment or rebind binding requires its exact approved Note Folder locator.');
  if (mode === 'rebind' && !/^note-folder:1:[0-9a-f-]{36}:[0-9a-f]{64}$/u.test(expectedReplacementIdentity)) throw sourceError('invalid-request', 'A rebind binding requires the exact current Note Folder identity.');
  return Object.freeze({ topicId, referenceId, mode, expectedRevision: input.expectedRevision, expectedSourceRevision: input.expectedSourceRevision, expectedLocatorVersion: input.expectedLocatorVersion, logicalOperationId, ...(replacementLocator ? { replacementLocator } : {}), ...(expectedReplacementIdentity ? { expectedReplacementIdentity } : {}) });
}

function ownerInput(item) {
  return Object.freeze({ topicId: item.topicId, referenceId: item.referenceId,
    expectedRevision: item.expectedRevision, expectedSourceRevision: item.expectedSourceRevision,
    logicalOperationId: item.logicalOperationId, ...(['enroll', 'rebind'].includes(item.mode) ? { replacementLocator: item.replacementLocator } : {}), ...(item.mode === 'rebind' ? { expectedReplacementIdentity: item.expectedReplacementIdentity } : {}) });
}

function persistedBinding(metadata, item) {
  const topic = metadata.getTopic?.(item.topicId);
  const reference = metadata.getSourceReference?.(item.referenceId);
  const locator = metadata.getSourceLocator?.(item.referenceId);
  if (!topic || topic.lifecycle !== 'active' || !reference || reference.topicId !== item.topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note_folder' || !locator?.locator) return null;
  return { topic, reference, locator };
}

function hasRequiredRecovery(metadata, item) {
  return (metadata.listSourceRecovery?.(item.topicId) ?? []).some(recovery => recovery.referenceId === item.referenceId && recovery.state === 'required');
}

function existingIntentMatches(existing, item) {
  const intent = existing?.intent;
  return existing?.operationKind === 'topics.recovery.verify' && intent?.topicId === item.topicId && intent?.referenceId === item.referenceId &&
    intent?.expectedRevision === item.expectedRevision && intent?.expectedSourceRevision === item.expectedSourceRevision &&
    intent?.expectedLocatorVersion === item.expectedLocatorVersion && intent?.replacementLocator === (['enroll', 'rebind'].includes(item.mode) ? item.replacementLocator : null) &&
    (intent?.expectedReplacementIdentity ?? null) === (item.mode === 'rebind' ? item.expectedReplacementIdentity : null);
}

/**
 * Executes an operator-approved, pinned private manifest. Each entry contains
 * the original Topic/source revisions and logical operation ID, so an
 * interrupted enrollment resumes the existing TopicRecoveryService operation
 * instead of constructing a newer replacement intent.
 */
export function createTopicFolderRecoveryBatch({ metadata, topics } = {}) {
  if (!metadata || !topics?.recoveryInspect || !topics?.recoveryVerify) throw sourceError('source-unavailable', 'Topic recovery services are required for a controlled Note Folder batch.');

  async function preflight(item) {
    const persisted = persistedBinding(metadata, item);
    if (!persisted) return Object.freeze({ ...item, status: 'blocked', reason: 'exact-persisted-note-folder-binding-unavailable' });
    const existing = metadata.getTopicOperation?.(item.logicalOperationId);
    if (existing) {
      if (!existingIntentMatches(existing, item)) return Object.freeze({ ...item, status: 'blocked', reason: 'logical-operation-intent-mismatch' });
      if (existing.state !== 'applied') return Object.freeze({ ...item, status: 'resume-ready' });
      try {
        const inspection = await topics.recoveryInspect({ topicId: item.topicId, referenceId: item.referenceId });
        const rebindStillMatches = item.mode !== 'rebind' || inspection?.folderIdentity === item.expectedReplacementIdentity;
        return inspection?.available === true && rebindStillMatches
          ? Object.freeze({ ...item, status: 'already-healthy' })
          : Object.freeze({ ...item, status: 'blocked', reason: 'applied-recovery-no-longer-healthy' });
      } catch (error) { return Object.freeze({ ...item, status: 'blocked', reason: error?.code ?? 'applied-recovery-inspection-failed' }); }
    }
    if (persisted.topic.revision !== item.expectedRevision || (persisted.locator.observedRevision ?? persisted.reference.observedRevision) !== item.expectedSourceRevision || persisted.locator.locatorVersion !== item.expectedLocatorVersion || ['enroll', 'rebind'].includes(item.mode) && persisted.locator.locator !== item.replacementLocator) {
      return Object.freeze({ ...item, status: 'blocked', reason: 'conditional-binding-changed' });
    }
    let inspection;
    try { inspection = await topics.recoveryInspect({ topicId: item.topicId, referenceId: item.referenceId }); }
    catch (error) { return Object.freeze({ ...item, status: 'blocked', reason: error?.code ?? 'exact-folder-preflight-failed' }); }
    if (item.mode === 'verify' && inspection?.available === true && hasRequiredRecovery(metadata, item)) return Object.freeze({ ...item, status: 'ready' });
    if (item.mode === 'enroll' && inspection?.available !== true && inspection?.failure === 'exact-folder-identity-unverified') return Object.freeze({ ...item, status: 'ready' });
    // Rebinding is not inferred from a path: the private operator plan pins the
    // original marker UUID and the exact replacement physical identity.
    if (item.mode === 'rebind' && inspection?.available !== true && inspection?.failure === 'exact-folder-identity-mismatch' && inspection.locator === item.replacementLocator && inspection.folderIdentity === item.expectedReplacementIdentity && item.expectedSourceRevision.split(':')[2] === item.expectedReplacementIdentity.split(':')[2]) return Object.freeze({ ...item, status: 'ready' });
    if (inspection?.available === true && !hasRequiredRecovery(metadata, item)) return Object.freeze({ ...item, status: 'already-healthy' });
    return Object.freeze({ ...item, status: 'blocked', reason: inspection?.failure ?? 'unexpected-recovery-state' });
  }

  async function recover({ bindings, assertCurrent = () => {} } = {}) {
    if (!Array.isArray(bindings) || bindings.length === 0) throw sourceError('invalid-request', 'A controlled Note Folder batch requires an explicit pinned manifest.');
    const requested = bindings.map(binding);
    const references = new Set();
    for (const item of requested) {
      if (references.has(item.referenceId)) throw sourceError('invalid-request', 'A controlled Note Folder batch cannot repeat a Source Reference.');
      references.add(item.referenceId);
    }
    const receipts = [];
    for (const item of requested) {
      assertCurrent();
      const readiness = await preflight(item);
      if (readiness.status === 'already-healthy') { receipts.push(readiness); continue; }
      if (!['ready', 'resume-ready'].includes(readiness.status)) {
        receipts.push(readiness);
        return Object.freeze({ status: 'halted', receipts: Object.freeze(receipts) });
      }
      try {
        const result = await topics.recoveryVerify(ownerInput(item));
        assertCurrent();
        if (!result || !['resolved', 'replaced'].includes(result.status)) throw sourceError('unknown', 'The exact Note Folder recovery returned an unexpected outcome.');
        receipts.push(Object.freeze({ ...item, status: readiness.status === 'resume-ready' ? 'replayed' : 'recovered', recovery: result.recovery }));
      } catch (error) {
        receipts.push(Object.freeze({ ...item, status: 'blocked', reason: error?.code ?? 'recovery-failed' }));
        return Object.freeze({ status: 'halted', receipts: Object.freeze(receipts) });
      }
    }
    return Object.freeze({ status: 'completed', receipts: Object.freeze(receipts) });
  }

  return Object.freeze({ preflight, recover });
}
