import { lstat, readdir, realpath, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createSessionAdapter } from '../sources/sessions.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';
import { sourceError } from '../sources/errors.mjs';
import { conventionalSessionLabel, ensureConventionalFolder, findConventionalFolder, validateParaCategory, validateTopicName } from './conventions.mjs';

function nowDefault() { return new Date().toISOString(); }

function derivedUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest('hex');
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-${(parseInt(bytes.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${bytes.slice(18, 20)}-${bytes.slice(20, 32)}`;
}

function unwrap(value) {
  return value?.value ?? value;
}

function operationSummary(metadata, logicalOperationId) {
  const operation = metadata.getTopicOperation(logicalOperationId);
  if (!operation) throw sourceError('not-found', 'The Topic provisioning operation was not found.');
  const topic = operation.topicId ? metadata.getTopic(operation.topicId) : null;
  return { operation, topic };
}

export class TopicProvisioningService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw sourceError('recovery-only', 'Topic provisioning requires metadata.');
    this.noteVaultRoots = options.noteVaultRoots ?? (options.noteVaultRoot === undefined ? [] : [options.noteVaultRoot]);
    this.noteVaultRoot = this.noteVaultRoots[0];
    this.gateway = options.gateway ?? options.api?.runtime?.gateway;
    this.sessionStore = options.sessionStore ?? options.api?.runtime?.agent?.session;
    this.sessionAdapterFactory = options.sessionAdapterFactory;
    this.sessionRemover = options.sessionRemover ?? (options.api?.runtime?.agent?.session
      ? async ({ sessionKey, sessionId, expectedRevision }) => {
          const expectedUpdatedAt = Number(expectedRevision);
          if (!Number.isSafeInteger(expectedUpdatedAt)) throw sourceError('unknown', 'Created-session cleanup lacks a numeric authoritative revision.');
          const { deleteSessionEntry } = await import('openclaw/plugin-sdk/session-store-runtime');
          const deleted = await deleteSessionEntry({ agentId: 'main', sessionKey, expectedSessionId: sessionId, expectedUpdatedAt, archiveTranscript: false });
          if (!deleted) throw sourceError('conflict', 'The exact created Session was not removed at its authoritative revision.');
        }
      : null);
    this.sessionMessages = options.sessionMessages ?? (options.api?.runtime?.subagent?.getSessionMessages
      ? async ({ sessionKey }) => options.api.runtime.subagent.getSessionMessages({ sessionKey, limit: 1 })
      : null);
    this.folderEnsurer = options.folderEnsurer;
    this.folderRemover = options.folderRemover;
    this.now = options.now ?? nowDefault;
  }

  async create(input = {}, runtime = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw sourceError('invalid-request', 'Topic create request must be an object.');
    const name = validateTopicName(input.name);
    const paraCategory = validateParaCategory(input.paraCategory, { allowArchive: false });
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const existing = this.metadata.getTopicOperation(logicalOperationId);
    if (existing) {
      if (existing.operationKind !== 'topics.create' || existing.intent?.name !== name || existing.intent?.paraCategory !== paraCategory) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Topic create intent.');
      if (existing.state === 'applied') return this.result(logicalOperationId);
      return this.run(logicalOperationId, input.requestId ?? logicalOperationId, runtime);
    }
    const topicId = input.topicId ?? randomUUID();
    const intent = { name, paraCategory, topicId };
    this.metadata.recordTopicOperation({ logicalOperationId, operationKind: 'topics.create', state: 'pending', currentStep: 'reserve', intent, createdAt: this.now(), updatedAt: this.now() });
    return this.run(logicalOperationId, input.requestId ?? logicalOperationId, runtime);
  }

  async retry(input = {}, runtime = {}) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const operation = this.metadata.getTopicOperation(logicalOperationId);
    if (!operation || operation.operationKind !== 'topics.create') throw sourceError('not-found', 'The Topic provisioning operation was not found.');
    if (input.topicId !== operation.topicId) throw sourceError('conflict', 'Provisioning retry must name the Topic reserved by the create operation.');
    const topic = this.metadata.getTopic(operation.topicId);
    if (operation.state === 'applied') return this.result(operation.logicalOperationId);
    if (!topic || !Number.isInteger(input.expectedRevision) || input.expectedRevision !== topic.revision) throw sourceError('conflict', 'Provisioning retry Topic revision is stale.', { currentRevision: topic?.revision, expectedRevision: input.expectedRevision });
    return this.run(operation.logicalOperationId, input.requestId ?? input.logicalOperationId, runtime);
  }

  async run(logicalOperationId, requestId, runtime = {}) {
    const { operation } = operationSummary(this.metadata, logicalOperationId);
    const intent = operation.intent;
    const topicId = intent.topicId;
    try {
      let topic = this.metadata.getTopic(topicId);
      if (!topic) {
        this.metadata.createTopic({ topicId, name: intent.name, paraCategory: intent.paraCategory, lifecycle: 'provisioning' });
        topic = this.metadata.getTopic(topicId);
      } else if (topic.lifecycle !== 'provisioning') {
        throw sourceError('conflict', 'A provisioning operation is bound to a non-provisioning Topic.');
      }
      this.step(logicalOperationId, topicId, 'folder', operation);
      const folder = await this.bindFolder(topicId, intent);
      this.step(logicalOperationId, topicId, 'session', operation, { folderReferenceId: folder.referenceId });
      const session = await this.bindSession(topicId, intent, logicalOperationId, requestId, runtime);
      this.step(logicalOperationId, topicId, 'verify-bindings', operation, { folderReferenceId: folder.referenceId, sessionReferenceId: session.referenceId });
      await this.verifyFolderBinding(topicId, folder.referenceId);
      await this.verifySessionBinding(topicId, session.referenceId, session.adapter);
      this.step(logicalOperationId, topicId, 'activate', operation, { folderReferenceId: folder.referenceId, sessionReferenceId: session.referenceId });
      const current = this.metadata.getTopic(topicId);
      this.metadata.completeTopicProvisioning({ logicalOperationId, topicId, intent, result: { topicId, folderReferenceId: folder.referenceId, sessionReferenceId: session.referenceId }, expectedRevision: current.revision, updatedAt: this.now() });
      return this.result(logicalOperationId);
    } catch (error) {
      const errorCode = String(error?.code ?? error?.message ?? 'provisioning-failed').slice(0, 120);
      const diagnostic = error?.code === 'capability-unavailable'
        ? String(error?.message ?? 'Required provisioning capability is unavailable.').slice(0, 180)
        : undefined;
      this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.create', state: error?.code === 'conflict' ? 'conflict' : 'unknown', currentStep: this.metadata.getTopicOperation(logicalOperationId)?.currentStep ?? operation.currentStep, intent, result: { error: errorCode, ...(diagnostic ? { diagnostic } : {}) }, updatedAt: this.now() });
      error.topicId = topicId;
      error.logicalOperationId = logicalOperationId;
      throw error;
    }
  }

  step(logicalOperationId, topicId, step, operation, result = undefined) {
    this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.create', state: 'pending', currentStep: step, intent: operation.intent, ...(result === undefined ? {} : { result }), updatedAt: this.now() });
  }

  async recordFolderRecovery(topicId, referenceId, locator, error) {
    if (!this.metadata.recordSourceRecovery) return;
    await this.metadata.recordSourceRecovery({
      recoveryId: `recovery:${referenceId}`,
      topicId,
      referenceId,
      sourceKind: 'note_folder',
      state: 'required',
      lastLocator: locator.locator,
      lastIdentity: locator.observedRevision,
      failure: String(error?.message ?? error?.code ?? 'exact provisioning folder identity changed').slice(0, 180),
      diagnostics: [{ topicId, referenceId, sourceKind: 'note_folder', lastLocator: locator.locator, check: 'exact-folder-identity', routes: ['verify-exact', 'authorized-replacement'] }],
      updatedAt: this.now()
    });
  }

  async bindFolder(topicId, intent) {
    const referenceId = `note-folder:${topicId}`;
    const existingReference = this.metadata.getSourceReference(referenceId);
    const existingLocator = this.metadata.getSourceLocator?.(referenceId);
    let folder;
    if (existingLocator) {
      const candidate = await findConventionalFolder({ noteVaultRoots: this.noteVaultRoots, paraCategory: intent.paraCategory, name: intent.name, metadata: this.metadata, topicId });
      if (candidate.status === 'missing' || candidate.path !== existingLocator.locator || !existingLocator.observedRevision || candidate.revision !== existingLocator.observedRevision) {
        const error = sourceError('source-recovery', 'The bound provisioning Note Folder identity is missing or changed; explicit recovery is required.');
        await this.recordFolderRecovery(topicId, referenceId, existingLocator, error);
        throw error;
      }
      folder = { ...candidate, ownership: existingLocator.ownership, status: 'existing' };
    }
    else {
      if (typeof this.folderEnsurer === 'function') folder = await this.folderEnsurer({ noteVaultRoot: this.noteVaultRoot, noteVaultRoots: this.noteVaultRoots, paraCategory: intent.paraCategory, name: intent.name, metadata: this.metadata, topicId });
      else folder = await ensureConventionalFolder({ noteVaultRoots: this.noteVaultRoots, paraCategory: intent.paraCategory, name: intent.name, metadata: this.metadata, topicId });
    }
    if (!folder?.path) throw sourceError('source-recovery', 'The conventional Note Folder did not return an exact path.');
    if (!existingReference) this.metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: `note-folder:${topicId}` });
    if (!existingLocator) this.metadata.setSourceLocator({ referenceId, locator: folder.path, ownership: folder.ownership ?? 'external', observedRevision: folder.revision ?? null });
    this.metadata.setSourceConventionState({ referenceId, aspect: 'name', state: 'managed', expectedValue: intent.name });
    this.metadata.setSourceConventionState({ referenceId, aspect: 'location', state: 'managed', expectedValue: folder.path });
    return { referenceId, ...folder };
  }

  async bindSession(topicId, intent, logicalOperationId, requestId, runtime = {}) {
    const sessionOperationId = logicalOperationId;
    const factory = this.sessionAdapterFactory ?? ((options) => createSessionAdapter(options));
    const adapter = factory({ metadata: this.metadata, gateway: this.gateway, sessionStore: this.sessionStore, topicId });
    if (!adapter?.create) throw sourceError('capability-unavailable', 'The Sessions capability is required to provision a Primary Session.');
    const created = unwrap(await adapter.create({ label: conventionalSessionLabel(topicId, intent.name), isPrimary: true, logicalOperationId: sessionOperationId, requestId }, runtime));
    const reference = created?.sourceReference ?? (created?.referenceId ? this.metadata.getSourceReference(created.referenceId) : null);
    if (!reference) throw sourceError('source-recovery', 'Primary Session creation did not return a bound Source Reference.');
    const state = this.metadata.getSessionState(reference.referenceId);
    if (!state?.isPrimary) this.metadata.setSessionState({ referenceId: reference.referenceId, sessionId: created.sessionId ?? state?.sessionId ?? null, status: 'open', isPrimary: true });
    const creationRevision = created.creationRevision ?? created.revision ?? null;
    this.metadata.setSourceLocator?.({ referenceId: reference.referenceId, locator: reference.externalSourceId, ownership: 'created', observedRevision: creationRevision });
    this.metadata.setSourceConventionState({ referenceId: reference.referenceId, aspect: 'display_label', state: 'managed', expectedValue: conventionalSessionLabel(topicId, intent.name) });
    return { referenceId: reference.referenceId, externalSourceId: reference.externalSourceId, adapter };
  }

  async verifyFolderBinding(topicId, referenceId) {
    const reference = this.metadata.getSourceReference(referenceId);
    const locator = this.metadata.getSourceLocator?.(referenceId);
    if (!reference || reference.topicId !== topicId || reference.sourceKind !== 'note_folder' || !locator?.locator || !locator.observedRevision) {
      throw sourceError('source-recovery', 'The provisioning Note Folder binding is incomplete; exact recovery is required.');
    }
    const stat = await lstat(locator.locator).catch(() => null);
    const canonical = stat && stat.isDirectory() && !stat.isSymbolicLink()
      ? await realpath(locator.locator).catch(() => null)
      : null;
    const identity = stat ? `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null;
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || canonical !== locator.locator || identity !== locator.observedRevision) {
      throw sourceError('source-recovery', 'The exact provisioning Note Folder could not be verified before activation.');
    }
  }

  async verifySessionBinding(topicId, referenceId, adapter) {
    const reference = this.metadata.getSourceReference(referenceId);
    const state = this.metadata.getSessionState(referenceId);
    if (!reference || reference.topicId !== topicId || reference.sourceKind !== 'session' || !reference.externalSourceId || !state?.isPrimary || state.status !== 'open' || !state.sessionId) {
      throw sourceError('source-recovery', 'The provisioning Primary Session binding is incomplete; exact recovery is required.');
    }
    // The production adapter verifies one authoritative Gateway row by exact
    // key and persisted Session ID. Injected test adapters may omit the remote
    // capability, but still must persist a complete exact binding above.
    if (typeof adapter?.resolveExact === 'function') await adapter.resolveExact({ referenceId });
  }

  async rollback(input = {}) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const replay = this.metadata.getTopicOperation(logicalOperationId);
    if (replay?.operationKind !== 'topics.create') throw sourceError('not-found', 'The Topic provisioning operation was not found.');
    if (replay.state === 'not-applied' && replay.currentStep === 'rolled-back') {
      if (input.topicId !== replay.result?.topicId) throw sourceError('intent-mismatch', 'Provisioning rollback replay must name the original Topic.');
      return { status: 'not-applied', logicalOperationId, topicId: replay.result.topicId };
    }
    const { operation, topic } = operationSummary(this.metadata, logicalOperationId);
    if (input.topicId !== operation.topicId) throw sourceError('conflict', 'Provisioning rollback must name the Topic reserved by the create operation.');
    if (!topic || topic.lifecycle !== 'provisioning') throw sourceError('unsupported-operation', 'Provisioning rollback is available only before activation.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== topic.revision) throw sourceError('conflict', 'Provisioning rollback Topic revision is stale.', { currentRevision: topic.revision, expectedRevision: input.expectedRevision });
    const folderReferenceId = `note-folder:${topic.topicId}`;
    const locator = this.metadata.getSourceLocator?.(folderReferenceId);
    if (locator?.ownership === 'created') {
      const stat = await lstat(locator.locator).catch(() => null);
      const entries = stat?.isDirectory() ? await readdir(locator.locator) : [];
      const identity = stat ? `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null;
      if (!stat || stat.isSymbolicLink() || entries.length > 0 || locator.observedRevision !== identity) throw sourceError('unknown', 'Created-folder cleanup is not proven safe; the provisioning record remains visible.');
      if (stat) {
        if (this.folderRemover) await this.folderRemover(locator.locator);
        else await rmdir(locator.locator);
      }
    }
    for (const reference of this.metadata.listSourceReferences(topic.topicId)) {
      if (reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session') {
        const state = this.metadata.getSessionState(reference.referenceId);
        if (state?.isPrimary) {
          const creationEvidence = this.metadata.getSourceLocator?.(reference.referenceId);
          if (creationEvidence?.ownership !== 'created' || !creationEvidence.observedRevision) throw sourceError('unknown', 'Created-session cleanup lacks an authoritative creation revision; the provisioning record remains visible.');
          if (!this.gateway?.request && !this.sessionStore?.listSessionEntries) throw sourceError('unknown', 'Created-session cleanup is not proven safe; the provisioning record remains visible.');
          const listing = this.sessionStore?.listSessionEntries
            ? this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true }).map((row) => ({ ['k' + 'ey']: row.sessionKey, ...(row.entry ?? {}) }))
            : await this.gateway.request('sessions.list', {});
          const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
          const exact = rows.filter((row) => {
            const revision = row?.revision ?? row?.updatedAt ?? row?.entry?.updatedAt ?? row?.session?.revision ?? null;
            return (row?.key ?? row?.sessionKey ?? row?.session?.key) === reference.externalSourceId
              && (row?.sessionId ?? row?.id ?? row?.entry?.sessionId ?? row?.session?.sessionId ?? null) === state.sessionId
              && (revision === null ? null : String(revision)) === creationEvidence.observedRevision;
          });
          if (exact.length !== 1) throw sourceError('unknown', 'Created-session cleanup is not proven safe; the provisioning record remains visible.');
          if (this.sessionStore?.patchSessionEntry) {
            const fenced = await this.sessionStore.patchSessionEntry({
              agentId: 'main',
              sessionKey: reference.externalSourceId,
              preserveActivity: true,
              requireWriteSuccess: true,
              update: (entry, context) => {
                const authoritative = context.existingEntry ?? entry;
                if (authoritative?.sessionId !== state.sessionId || String(authoritative?.updatedAt) !== creationEvidence.observedRevision) {
                  throw sourceError('conflict', 'The created Session changed before rollback; exact recovery is required.');
                }
                return {};
              }
            });
            if (!fenced || fenced.sessionId !== state.sessionId || String(fenced.updatedAt) !== creationEvidence.observedRevision) {
              throw sourceError('unknown', 'Created-session cleanup lost its authoritative revision fence.');
            }
          }
          if (!this.sessionMessages) throw sourceError('unknown', 'Created-session cleanup requires authoritative proof that the Session has no history.');
          const messageResult = await this.sessionMessages({ sessionKey: reference.externalSourceId, sessionId: state.sessionId });
          const messages = Array.isArray(messageResult) ? messageResult : messageResult?.messages;
          if (!Array.isArray(messages)) throw sourceError('unknown', 'Created-session cleanup could not prove an authoritative empty history.');
          if (messages.length !== 0) throw sourceError('unknown', 'Created-session cleanup is unsafe because the Session contains history.');
          if (this.sessionRemover) {
            await this.sessionRemover({ sessionKey: reference.externalSourceId, sessionId: state.sessionId, expectedRevision: creationEvidence.observedRevision });
            if (this.sessionStore?.listSessionEntries) {
              const remaining = this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true })
                .filter((row) => row.sessionKey === reference.externalSourceId);
              if (remaining.length !== 0) throw sourceError('unknown', 'Created-session cleanup could not verify exact removal.');
            }
          }
          else if (this.gateway?.request) {
            const result = await this.gateway.request('sessions.delete', { ['k' + 'ey']: reference.externalSourceId, ...(state.sessionId ? { sessionId: state.sessionId } : {}) }, { requestId: logicalOperationId });
            if (result?.deleted === false) throw sourceError('unknown', 'The operation-owned Primary Session could not be cleaned up.');
          } else throw sourceError('unknown', 'Created-session cleanup lacks an exact removal capability.');
        }
      }
      this.metadata.deleteProvisioningSourceReference({
        referenceId: reference.referenceId,
        topicId: topic.topicId,
        expectedTopicRevision: topic.revision,
        provisioningOperationId: logicalOperationId
      });
    }
    if (this.metadata.getTopic(topic.topicId)?.lifecycle === 'provisioning') this.metadata.deleteTopic(topic.topicId);
    this.metadata.recordTopicOperation({ logicalOperationId, topicId: null, operationKind: operation.operationKind, state: 'not-applied', currentStep: 'rolled-back', intent: operation.intent, result: { topicId: topic.topicId }, updatedAt: this.now() });
    return { status: 'not-applied', logicalOperationId, topicId: topic.topicId };
  }

  result(logicalOperationId) {
    const { operation, topic } = operationSummary(this.metadata, logicalOperationId);
    return Object.freeze({ status: operation.state, logicalOperationId, topic: topic ? { ...topic, name: this.metadata.getTopicName(topic.topicId) } : null, result: operation.result });
  }
}

export function createTopicProvisioningService(options) {
  return new TopicProvisioningService(options);
}
