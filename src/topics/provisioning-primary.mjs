import { isDeepStrictEqual } from 'node:util';
import { inspectNoteFolderCandidate, withBootstrapNoteFolder } from '../sources/note-folder-identity.mjs';
import { sourceError } from '../sources/errors.mjs';

// The surrounding provisioning owner holds the existing Note filesystem lock.
// Native creation has a fixed identity and a single durable dispatch claimant.
export async function finishConditionalProvisioning({ metadata, sessionStore, env, parentOperationId, expectedTopicRevision, assertCurrent, mode = 'execute' }) {
  const read = sessionStore?.getSessionEntry; const patch = sessionStore?.patchSessionEntry;
  if (typeof read !== 'function' || typeof patch !== 'function') throw sourceError('capability-unavailable', 'Conditional native Primary creation requires the exact Session SDK.');
  const check = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then || sessionStore.getSessionEntry !== read || sessionStore.patchSessionEntry !== patch) throw sourceError('provisioning-authority-unavailable', 'Current provisioning authority and native bindings are required.');
  };
  check();
  if (!['execute', 'verify'].includes(mode)) throw sourceError('preparation-mode-invalid', 'Unknown preparation mode.');
  let receipt = mode === 'verify' ? metadata.getProvisioningPrimary(parentOperationId) : metadata.reserveProvisioningPrimary({ parentOperationId, expectedTopicRevision }, check);
  if (mode === 'verify' && receipt?.phase !== 'applied') throw sourceError('preparation-incomplete', 'Verification requires a completed Primary.');
  const primary = receipt.intent.primary;
  const locator = receipt.intent.folder.locator;
  const candidate = await inspectNoteFolderCandidate(locator.locator);
  if (candidate.markerIdentity !== locator.observedRevision) throw sourceError('source-recovery', 'The original provisioning Note Folder changed.');
  let dispatching = false;
  const assertSources = () => {
    check();
    const entry = read.call(sessionStore, { agentId: primary.agentId, sessionKey: primary.sessionKey, env, readConsistency: 'latest' });
    if (receipt.phase === 'reserved') {
      if (entry) throw sourceError('provisioning-primary-conflict', 'The new Primary destination is already occupied.');
      return;
    }
    if (!entry && receipt.phase === 'creating') {
      if (dispatching) return;
      throw sourceError('provisioning-creation-unknown', 'Creation was dispatched but its exact native effect is unavailable; no replacement was created.');
    }
    if (!entry || entry.sessionId !== primary.sessionId || entry.lifecycleRevision !== primary.lifecycleRevision || entry.sendPolicy === 'deny') {
      throw sourceError('source-recovery', 'The original Primary identity is unavailable or changed.');
    }
  };
  return withBootstrapNoteFolder(candidate.path, { expectedDirectoryIdentity: candidate.directoryIdentity, expectedIdentity: locator.observedRevision,
    markerId: receipt.logicalOperationId, assertCurrent: assertSources }, async witness => {
    const assertExactSources = () => { witness.assertCurrent(); assertSources(); };
    assertExactSources(); metadata.assertProvisioningPrimary(receipt, check);
    if (receipt.phase === 'reserved') {
      receipt = metadata.dispatchProvisioningPrimary(receipt, assertExactSources);
      dispatching = true;
      try {
        await patch.call(sessionStore, { agentId: primary.agentId, sessionKey: primary.sessionKey, env,
          fallbackEntry: { sessionId: primary.sessionId, lifecycleRevision: primary.lifecycleRevision, label: receipt.intent.root.name, updatedAt: Date.now() },
          skipMaintenance: true, preserveActivity: true, requireWriteSuccess: true,
          update: (entry, context) => {
            if (context.existingEntry) throw sourceError('provisioning-primary-conflict', 'The destination was claimed before native creation.');
            return entry;
          },
          assertCommitAllowed: () => { assertExactSources(); metadata.assertProvisioningPrimary(receipt, check); }
        });
      } finally { dispatching = false; }
    }
    assertExactSources();
    if (receipt.phase === 'applied') metadata.assertProvisioningPrimary(receipt, check);
    else receipt = metadata.completeProvisioningPrimary(receipt, assertExactSources);
    if (!isDeepStrictEqual(metadata.getProvisioningPrimary(parentOperationId), receipt)) throw sourceError('stale-revision', 'Provisioning completion changed.');
    return receipt;
  });
}
