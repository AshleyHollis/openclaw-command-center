import { isDeepStrictEqual } from 'node:util';
import { withNoteFilesystemOwner } from '../sources/note-filesystem-owner.mjs';
import { withBootstrapNoteFolder } from '../sources/note-folder-identity.mjs';
import { sourceError } from '../sources/errors.mjs';

// Explicit initial adoption only. Normal Topic creation and legacy import keep
// their existing contracts; the main-agent entry is never an exclusive Primary.
export async function adoptExistingTopic(options) {
  const { metadata, sessionStore, assertCurrent, storePath, env, mode } = options;
  if (!['execute', 'resume', 'verify'].includes(mode)) throw sourceError('invalid-request', 'A closed bootstrap mode is required.');
  const input = structuredClone(options.input);
  const checkAuthority = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) throw sourceError('unauthenticated', 'Current bootstrap authority is required.');
  };
  checkAuthority();
  let receipt = mode === 'execute' ? metadata.reserveTopicBootstrap(input, checkAuthority) : metadata.getTopicBootstrap(input.logicalOperationId);
  if (!receipt) throw sourceError('bootstrap-reservation-missing', 'The exact bootstrap reservation is unavailable.');
  if (!isDeepStrictEqual(receipt.intent, input.intent)) throw sourceError('intent-mismatch', 'Bootstrap must retain its original mapping and source identities.');
  if (mode === 'verify' && receipt.phase !== 'applied') throw sourceError('bootstrap-incomplete', 'Verification cannot execute a reserved bootstrap.');
  const createsPrimary = receipt.intent.primary.creation === 'if-absent';
  if (createsPrimary && typeof sessionStore?.patchSessionEntry !== 'function') throw sourceError('capability-unavailable', 'Conditional native Primary creation is unavailable.');
  let dispatching = false;
  const assertSources = () => {
    checkAuthority();
    const primary = receipt.intent.primary;
    const current = sessionStore.getSessionEntry({ agentId: primary.agentId, sessionKey: primary.sessionKey,
      ...(storePath ? { storePath } : {}), ...(env ? { env } : {}), readConsistency: 'latest' });
    if (createsPrimary && receipt.phase === 'reserved') {
      if (current) throw sourceError('bootstrap-source-conflict', 'The approved new Primary destination is occupied.');
      return;
    }
    if (!current && createsPrimary && receipt.phase === 'creating') {
      if (dispatching) return;
      throw sourceError('bootstrap-creation-unknown', 'Primary creation was dispatched but its exact native effect is unavailable; no replacement was created.');
    }
    if (!current || current.sessionId !== primary.sessionId || (current.lifecycleRevision ?? null) !== primary.lifecycleRevision ||
      current.sendPolicy === 'deny') throw sourceError('bootstrap-source-conflict', 'The approved active Primary identity is unavailable or changed.');
  };
  const assertReceipt = () => {
    if (!isDeepStrictEqual(metadata.getTopicBootstrap(receipt.logicalOperationId), receipt)) throw sourceError('stale-revision', 'The bootstrap receipt changed during source verification.');
  };
  return withNoteFilesystemOwner(metadata, async () => {
    assertSources(); assertReceipt();
    return withBootstrapNoteFolder(receipt.intent.folder.path, {
      expectedDirectoryIdentity: receipt.intent.folder.directoryIdentity, markerId: receipt.logicalOperationId,
      expectedIdentity: receipt.phase === 'applied' ? receipt.folderIdentity : receipt.intent.folder.markerIdentity,
      assertCurrent: assertSources
    }, async witness => {
      const assertExactSources = () => { witness.assertCurrent(); assertSources(); };
      assertExactSources(); assertReceipt();
      if (createsPrimary && receipt.phase === 'reserved') {
        receipt = metadata.dispatchTopicBootstrapPrimary({ logicalOperationId: receipt.logicalOperationId, expectedRevision: receipt.revision }, assertExactSources);
        const primary = receipt.intent.primary;
        // Only this invocation owns the durable dispatch transition. A later
        // resume may verify its effect, but cannot call native creation again.
        dispatching = true;
        try {
          await sessionStore.patchSessionEntry({ agentId: primary.agentId, sessionKey: primary.sessionKey,
            ...(storePath ? { storePath } : {}), ...(env ? { env } : {}),
            fallbackEntry: { sessionId: primary.sessionId, lifecycleRevision: primary.lifecycleRevision, updatedAt: Date.now(), label: receipt.intent.name },
            skipMaintenance: true, preserveActivity: true, requireWriteSuccess: true,
            update: (entry, context) => {
              if (context.existingEntry) throw sourceError('bootstrap-source-conflict', 'The new Primary destination was claimed before creation.');
              return entry;
            },
            assertCommitAllowed: () => { assertExactSources(); assertReceipt(); }
          });
        } finally { dispatching = false; }
        assertExactSources(); assertReceipt();
      }
      if (receipt.phase === 'applied') {
        const folder = metadata.getSourceReference(receipt.folderReferenceId);
        const location = metadata.getSourceLocator(receipt.folderReferenceId);
        const primary = metadata.getSourceReference(receipt.sessionReferenceId);
        const primaryLocation = metadata.getSourceLocator(receipt.sessionReferenceId);
        const session = metadata.getSessionState(receipt.sessionReferenceId);
        if (metadata.getTopic(receipt.intent.topicId)?.lifecycle !== 'active' || folder?.topicId !== receipt.intent.topicId ||
          folder.sourceKind !== 'note_folder' || location?.locator !== receipt.intent.folder.path || location.observedRevision !== receipt.folderIdentity ||
          primary?.topicId !== receipt.intent.topicId || primary.sourceKind !== 'session' || primary.externalSourceId !== receipt.intent.primary.sessionKey ||
          primaryLocation?.locator !== receipt.intent.primary.sessionKey ||
          session?.sessionId !== receipt.intent.primary.sessionId || session.status !== 'open' || session.isPrimary !== true) throw sourceError('bootstrap-ownership-conflict', 'Bootstrap verification cannot replace changed Topic bindings.');
        return receipt;
      }
      return metadata.completeTopicBootstrap({ logicalOperationId: receipt.logicalOperationId, expectedRevision: receipt.revision, folderIdentity: witness.identity }, assertExactSources);
    });
  });
}
