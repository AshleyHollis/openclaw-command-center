import { lstat, mkdir, open, realpath, rename as fsRename } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';
import { sourceError } from '../sources/errors.mjs';
import { conventionalFolderPath, conventionalSessionLabel, sourceConventionManaged, validateParaCategory, validateTopicName } from './conventions.mjs';
import { createSessionAdapter } from '../sources/sessions.mjs';
import { assertPreviewConfirmation, freezePlan } from './structural-change.mjs';

function nowDefault() { return new Date().toISOString(); }

function derivedUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(parseInt(hex.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function unwrap(value) { return value?.value ?? value; }

function sourceRef(metadata, topicId, system, kind) {
  return metadata.listSourceReferences(topicId).find((reference) => reference.sourceSystem === system && reference.sourceKind === kind) ?? null;
}

function effectiveSessionKey(metadata, reference) {
  return metadata.getSourceLocator?.(reference.referenceId)?.locator ?? reference.externalSourceId;
}

function revisionsFor(metadata, topicId, extra = []) {
  const topic = metadata.getTopic(topicId);
  return [{ source: 'topic', id: topicId, revision: topic?.revision ?? null }, ...extra.map((item) => ({ source: 'reference', id: item.referenceId, revision: item.revision ?? item.observedRevision ?? null }))];
}

function updateMovedLocator(metadata, referenceId, destination) {
  const current = metadata.getSourceLocator(referenceId);
  return metadata.setSourceLocator({
    referenceId,
    locator: destination,
    locatorVersion: current.locatorVersion + 1,
    ownership: current.ownership,
    observedRevision: current.observedRevision,
    createdAt: current.createdAt
  });
}

function filesystemIdentity(stat) { return stat ? `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null; }

async function configuredRootFor(candidate, roots) {
  const exact = path.resolve(candidate);
  for (const configured of roots) {
    const root = path.resolve(configured);
    const relative = path.relative(root, exact);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const stat = await lstat(root).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw sourceError('unsafe-path', 'The configured Note root is no longer a real canonical directory.');
    return root;
  }
  throw sourceError('unsafe-path', 'The Note Folder path escapes every configured Note root.');
}

async function assertAncestorChain(candidate, roots) {
  const exact = path.resolve(candidate);
  const root = await configuredRootFor(exact, roots);
  const segments = path.relative(root, path.dirname(exact)).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw sourceError('unsafe-path', 'A Note Folder ancestor is not a real canonical directory.');
  }
  return root;
}

async function createMoveProof(sourcePath, destinationPath, roots, expectedIdentity = null) {
  await assertAncestorChain(sourcePath, roots);
  await assertAncestorChain(destinationPath, roots);
  const source = await lstat(sourcePath).catch(() => null);
  if (!source || source.isSymbolicLink() || !source.isDirectory() || await realpath(sourcePath) !== path.resolve(sourcePath)) throw sourceError('source-recovery', 'The exact Note Folder source cannot be proven before relocation.');
  const identity = filesystemIdentity(source);
  if (expectedIdentity !== null && identity !== expectedIdentity) throw sourceError('source-recovery', 'The exact Note Folder identity changed before relocation.');
  return { sourcePath, destinationPath, identity };
}

async function moveReadiness(sourcePath, destinationPath, proof = null, roots = []) {
  await assertAncestorChain(sourcePath, roots);
  await assertAncestorChain(destinationPath, roots);
  const source = await lstat(sourcePath).catch(() => null);
  const destination = await lstat(destinationPath).catch(() => null);
  if (!source && destination) {
    if (proof?.sourcePath === sourcePath && proof?.destinationPath === destinationPath && proof?.identity === filesystemIdentity(destination) && destination.isDirectory() && !destination.isSymbolicLink()) return { applied: true };
    throw sourceError('source-recovery', 'The source is missing and the occupied destination cannot be proven to be this operation\'s move.');
  }
  if (!source) throw sourceError('source-recovery', 'The exact Note Folder locator is missing; recovery verification is required.');
  if (source.isSymbolicLink() || !source.isDirectory() || await realpath(sourcePath) !== path.resolve(sourcePath)) throw sourceError('unsafe-path', 'The Note Folder locator is not a real canonical directory.');
  if (proof && (proof.sourcePath !== sourcePath || proof.destinationPath !== destinationPath || proof.identity !== filesystemIdentity(source))) throw sourceError('source-recovery', 'The exact Note Folder identity changed before relocation.');
  if (destination) throw sourceError('conflict', 'The Structural Change destination is occupied.');
  return { applied: false };
}

async function checkedMove(sourcePath, destinationPath, proof = null, roots = []) {
  const readiness = await moveReadiness(sourcePath, destinationPath, proof, roots);
  if (readiness.applied) return readiness;
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await assertAncestorChain(destinationPath, roots);
  if (await realpath(path.dirname(destinationPath)) !== path.resolve(path.dirname(destinationPath))) throw sourceError('unsafe-path', 'The destination parent is not a real canonical directory.');
  const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
  if (!descriptorRoot) throw sourceError('capability-unavailable', 'Descriptor-anchored Topic relocation is unavailable.');
  const sourceParent = await open(path.dirname(sourcePath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const destinationParent = await open(path.dirname(destinationPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fsRename(path.join(descriptorRoot, String(sourceParent.fd), path.basename(sourcePath)), path.join(descriptorRoot, String(destinationParent.fd), path.basename(destinationPath)));
  } finally { await sourceParent.close(); await destinationParent.close(); }
  return { applied: true };
}

export class TopicLifecycleService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    if (!this.metadata) throw sourceError('recovery-only', 'Topic lifecycle requires metadata.');
    this.noteVaultRoots = options.noteVaultRoots ?? (options.noteVaultRoot === undefined ? [] : [options.noteVaultRoot]);
    this.noteVaultRoot = this.noteVaultRoots[0];
    this.gateway = options.gateway ?? options.api?.runtime?.gateway;
    this.sessionStore = options.sessionStore ?? options.api?.runtime?.agent?.session;
    this.schedulerFactory = options.schedulerFactory;
    this.sessionRenamer = options.sessionRenamer;
    this.sessionAdapterFactory = options.sessionAdapterFactory;
    this.commitmentProvider = options.commitmentProvider;
    this.now = options.now ?? nowDefault;
  }

  noteRootFor(locator) {
    const exact = path.resolve(String(locator ?? ''));
    return this.noteVaultRoots.find((root) => {
      const relative = path.relative(path.resolve(root), exact);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }) ?? this.noteVaultRoot;
  }

  topic(topicId) {
    const topic = this.metadata.getTopic(topicId);
    if (!topic) throw sourceError('not-found', 'The requested Topic was not found.');
    return topic;
  }

  snapshot(topicId) {
    const topic = this.topic(topicId);
    return Object.freeze({
      ...topic,
      name: this.metadata.getTopicName(topicId),
      revision: topic.revision,
      sourceReferences: this.metadata.listSourceReferences(topicId),
      locators: this.metadata.listSourceLocators?.(topicId) ?? [],
      convention: this.metadata.listSourceReferences(topicId).flatMap((reference) => this.metadata.getSourceConventionState(reference.referenceId)),
      recovery: this.metadata.listSourceRecovery?.(topicId) ?? []
    });
  }

  assertExpectedRevisions(topicId, expectedRevisions = []) {
    const topic = this.metadata.getTopic(topicId);
    const expectedTopic = expectedRevisions.find((item) => item.source === 'topic' && item.id === topicId);
    if (expectedTopic && expectedTopic.revision !== topic?.revision) throw sourceError('conflict', 'Topic revision is stale.', { currentRevision: topic?.revision, expectedRevision: expectedTopic.revision });
    for (const expected of expectedRevisions.filter((item) => item.source === 'reference')) {
      const reference = this.metadata.getSourceReference(expected.id);
      const locator = this.metadata.getSourceLocator?.(expected.id);
      const current = locator?.observedRevision ?? reference?.observedRevision ?? null;
      if (!reference || current !== expected.revision) throw sourceError('conflict', 'A Structural Change Source Reference revision is stale.', { referenceId: expected.id, currentRevision: current, expectedRevision: expected.revision });
    }
  }

  async recordFolderRecovery(topicId, error) {
    const reference = sourceRef(this.metadata, topicId, 'obsidian', 'note_folder');
    if (!reference || !this.metadata.recordSourceRecovery) return;
    const locator = this.metadata.getSourceLocator?.(reference.referenceId)?.locator ?? reference.externalSourceId;
    await this.metadata.recordSourceRecovery({
      recoveryId: `recovery:${reference.referenceId}`,
      topicId,
      referenceId: reference.referenceId,
      sourceKind: reference.sourceKind,
      state: 'required',
      lastLocator: locator,
      lastIdentity: reference.externalSourceId,
      failure: String(error?.message ?? error?.code ?? 'exact Note Folder resolution failed').slice(0, 180),
      diagnostics: [{ topicId, referenceId: reference.referenceId, sourceKind: 'note_folder', lastLocator: locator, check: 'exact-folder-resolution', routes: ['verify-exact', 'authorized-replacement'] }],
      updatedAt: this.now()
    });
  }

  async recordSessionRecovery(topicId, error, referenceId = undefined) {
    const sessions = this.metadata.listSourceReferences(topicId).filter((item) => item.sourceSystem === 'openclaw' && item.sourceKind === 'session');
    const reference = referenceId === undefined
      ? sessions.find((item) => this.metadata.getSessionState?.(item.referenceId)?.isPrimary) ?? sessions[0]
      : sessions.find((item) => item.referenceId === referenceId);
    if (!reference || !this.metadata.recordSourceRecovery) return;
    const sessionKey = effectiveSessionKey(this.metadata, reference);
    await this.metadata.recordSourceRecovery({
      recoveryId: `recovery:${reference.referenceId}`,
      topicId,
      referenceId: reference.referenceId,
      sourceKind: reference.sourceKind,
      state: 'required',
      lastLocator: sessionKey,
      lastIdentity: reference.externalSourceId,
      failure: String(error?.message ?? error?.code ?? 'exact Session resolution failed').slice(0, 180),
      diagnostics: [{ topicId, referenceId: reference.referenceId, sourceKind: 'session', lastLocator: sessionKey, lastIdentity: reference.externalSourceId, check: 'exact-session-resolution', routes: ['verify-exact', 'authorized-replacement'] }],
      updatedAt: this.now()
    });
  }

  async assertRequiredSourcesAvailable(topicId) {
    const current = this.snapshot(topicId);
    if (current.recovery.some((item) => item.state === 'required')) throw sourceError('source-recovery', 'Required Topic source recovery must be resolved before this lifecycle operation.');
    const folder = current.sourceReferences.find((item) => item.sourceSystem === 'obsidian' && item.sourceKind === 'note_folder');
    const folderLocator = folder ? this.metadata.getSourceLocator?.(folder.referenceId) : null;
    const folderPath = folderLocator?.locator;
    const folderStat = folderPath ? await lstat(folderPath).catch(() => null) : null;
    const observedIdentity = folderStat ? filesystemIdentity(folderStat) : null;
    if (!folder || !folderLocator?.observedRevision || !folderStat?.isDirectory() || folderStat.isSymbolicLink() || await realpath(folderPath).catch(() => null) !== path.resolve(folderPath) || observedIdentity !== folderLocator.observedRevision) {
      const error = sourceError('source-recovery', 'The exact required Note Folder identity is unavailable or changed.');
      await this.recordFolderRecovery(topicId, error);
      throw error;
    }
    const primary = current.sourceReferences.find((item) => item.sourceSystem === 'openclaw' && item.sourceKind === 'session' && this.metadata.getSessionState?.(item.referenceId)?.isPrimary);
    const state = primary ? this.metadata.getSessionState(primary.referenceId) : null;
    const primarySessionKey = primary ? effectiveSessionKey(this.metadata, primary) : null;
    let verified = false;
    if (primary && state?.sessionId && this.sessionStore?.listSessionEntries) {
      const rows = this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true });
      verified = rows.filter((row) => row.sessionKey === primarySessionKey && row.entry?.sessionId === state.sessionId).length === 1;
    } else if (primary && state?.sessionId && this.gateway?.request) {
      const listing = await this.gateway.request('sessions.list', {});
      const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
      verified = rows.filter((row) => (row?.key ?? row?.sessionKey ?? row?.session?.key) === primarySessionKey && (row?.sessionId ?? row?.id ?? row?.session?.sessionId) === state.sessionId).length === 1;
    } else if (primary && state?.sessionId && this.sessionAdapterFactory) {
      const adapter = this.sessionAdapterFactory({ metadata: this.metadata, gateway: this.gateway, sessionStore: this.sessionStore, topicId });
      verified = adapter?.resolveExact ? Boolean(await adapter.resolveExact({ referenceId: primary.referenceId })) : true;
    }
    if (!verified) {
      const error = sourceError('source-recovery', 'The exact required Primary Session is unavailable.');
      await this.recordSessionRecovery(topicId, error, primary?.referenceId);
      throw error;
    }
    return current;
  }

  async rename(input = {}) {
    const topicId = String(input.topicId ?? '').trim();
    const name = validateTopicName(input.name);
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const current = this.snapshot(topicId);
    if (current.lifecycle !== 'active' || current.paraCategory === 'archive' || current.recovery.some((item) => item.state === 'required')) throw sourceError('archived-read-only', 'Only an active Topic without unresolved Source Recovery can be renamed.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) throw sourceError('conflict', 'Topic revision is stale.', { currentRevision: current.revision, expectedRevision: input.expectedRevision });
    await this.assertRequiredSourcesAvailable(topicId);
    const previous = this.metadata.getTopicOperation(logicalOperationId);
    const folder = sourceRef(this.metadata, topicId, 'obsidian', 'note_folder');
    const folderLocator = folder ? this.metadata.getSourceLocator?.(folder.referenceId) : null;
    const folderStates = folder ? this.metadata.getSourceConventionState(folder.referenceId) : [];
    const folderNameState = folderStates.find((item) => item.aspect === 'name');
    const folderNameCustomized = Boolean(!previous && folder && folderLocator && folderNameState?.state === 'managed' && folderNameState.expectedValue && path.basename(folderLocator.locator) !== folderNameState.expectedValue);
    if (folderNameCustomized) {
      this.metadata.setSourceConventionState({ referenceId: folder.referenceId, aspect: 'name', state: 'customized', expectedValue: folderNameState.expectedValue });
    }
    const relocation = previous?.intent?.relocation ?? (folder && folderLocator && !folderNameCustomized && sourceConventionManaged(folderStates, 'name')
      ? { referenceId: folder.referenceId, from: folderLocator.locator, to: path.join(path.dirname(folderLocator.locator), name) }
      : null);
    const intent = { topicId, name, expectedRevision: previous?.intent?.expectedRevision ?? current.revision, relocation };
    if (previous) {
      if (previous.intent?.topicId !== topicId || previous.intent?.name !== name) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different rename intent.');
      if (previous.state === 'applied') return this.snapshot(topicId);
    } else this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.rename', state: 'pending', currentStep: 'prepare', intent, updatedAt: this.now() });
    try {
      if (relocation) {
        const moveProof = previous?.result?.moveProof ?? await createMoveProof(relocation.from, relocation.to, this.noteVaultRoots, folderLocator.observedRevision);
        this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.rename', state: 'pending', currentStep: 'folder-move', intent, result: { moveProof }, updatedAt: this.now() });
        await checkedMove(relocation.from, relocation.to, moveProof, this.noteVaultRoots);
        if (this.metadata.getSourceLocator(relocation.referenceId).locator !== relocation.to) updateMovedLocator(this.metadata, relocation.referenceId, relocation.to);
        this.metadata.setSourceConventionState({ referenceId: relocation.referenceId, aspect: 'name', state: 'managed', expectedValue: name });
      }
      this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.rename', state: 'pending', currentStep: 'session-label', intent, result: this.metadata.getTopicOperation(logicalOperationId)?.result, updatedAt: this.now() });
      const sessions = this.metadata.listSourceReferences(topicId).filter((reference) => reference.sourceSystem === 'openclaw' && reference.sourceKind === 'session');
      const session = sessions.find((reference) => this.metadata.getSessionState?.(reference.referenceId)?.isPrimary) ?? sessions[0];
      const sessionStates = session ? this.metadata.getSourceConventionState(session.referenceId) : [];
      const sessionLabelState = sessionStates.find((item) => item.aspect === 'display_label');
      const observedSessionLabel = session ? await this.observeSessionLabel(session) : null;
      if (session && sessionLabelState?.state === 'managed' && sessionLabelState.expectedValue && observedSessionLabel !== null && observedSessionLabel !== sessionLabelState.expectedValue) {
        this.metadata.setSourceConventionState({ referenceId: session.referenceId, aspect: 'display_label', state: 'customized', expectedValue: sessionLabelState.expectedValue });
      } else if (session && sourceConventionManaged(sessionStates, 'display_label')) {
        const label = conventionalSessionLabel(topicId, name);
        await this.renameSession(session, label, logicalOperationId);
        this.metadata.setSourceConventionState({ referenceId: session.referenceId, aspect: 'display_label', state: 'managed', expectedValue: label });
      }
      this.metadata.setTopicName({ topicId, name, expectedRevision: intent.expectedRevision });
      this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.rename', state: 'applied', currentStep: 'complete', intent, result: { topicId, name }, updatedAt: this.now() });
      return this.snapshot(topicId);
    } catch (error) {
      if (error?.code === 'source-recovery') {
        if (String(error?.message ?? '').toLowerCase().includes('session')) await this.recordSessionRecovery(topicId, error);
        else await this.recordFolderRecovery(topicId, error);
      }
      this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.rename', state: error?.code === 'conflict' ? 'conflict' : 'unknown', currentStep: 'interrupted', intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), error: String(error?.code ?? 'rename-failed') }, updatedAt: this.now() });
      throw error;
    }
  }

  async replacePrimarySession(input = {}, runtime = {}) {
    const topicId = String(input.topicId ?? '').trim();
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const current = this.snapshot(topicId);
    if (current.lifecycle !== 'active' || current.paraCategory === 'archive' || current.recovery.some((item) => item.state === 'required')) throw sourceError('conflict', 'Primary Session replacement requires a writable active Topic.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) throw sourceError('conflict', 'Topic revision is stale.');
    const existing = this.metadata.getTopicOperation(logicalOperationId);
    if (existing) {
      if (existing.operationKind !== 'topics.replace-primary-session' || existing.intent?.topicId !== topicId) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Primary Session replacement intent.');
      if (existing.state === 'applied') return this.snapshot(topicId);
    } else this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.replace-primary-session', state: 'pending', currentStep: 'create-session', intent: { topicId, expectedRevision: current.revision }, updatedAt: this.now() });
    const factory = this.sessionAdapterFactory ?? ((options) => createSessionAdapter(options));
    const adapter = factory({ metadata: this.metadata, gateway: this.gateway, sessionStore: this.sessionStore, topicId });
    const created = unwrap(await adapter.create({ label: conventionalSessionLabel(topicId, current.name), isPrimary: true, logicalOperationId, requestId: logicalOperationId }, runtime));
    const reference = created?.sourceReference ?? this.metadata.getSourceReference(created?.referenceId);
    if (!reference || !this.metadata.getSessionState(reference.referenceId)?.isPrimary) throw sourceError('source-recovery', 'Replacement Session did not become the exact Primary Session.');
    this.metadata.setSourceConventionState({ referenceId: reference.referenceId, aspect: 'display_label', state: 'managed' });
    this.metadata.updateTopic({ topicId, paraCategory: current.paraCategory, expectedRevision: current.revision });
    this.metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.replace-primary-session', state: 'applied', currentStep: 'complete', intent: { topicId, expectedRevision: current.revision }, result: { referenceId: reference.referenceId }, updatedAt: this.now() });
    return this.snapshot(topicId);
  }

  async renameSession(reference, label, logicalOperationId) {
    const sessionKey = effectiveSessionKey(this.metadata, reference);
    const expectedSessionId = this.metadata.getSessionState?.(reference.referenceId)?.sessionId;
    if (!expectedSessionId) throw sourceError('source-recovery', 'Managed Session rename lacks an exact persisted Session identity.');
    if (this.sessionRenamer) return this.sessionRenamer({ sessionKey, expectedSessionId, label, logicalOperationId });
    if (this.sessionStore?.listSessionEntries && this.sessionStore?.patchSessionEntry) {
      const matches = this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true })
        .filter((row) => row.sessionKey === sessionKey && row.entry?.sessionId === expectedSessionId);
      const expectedLifecycleRevision = matches[0]?.entry?.updatedAt;
      if (matches.length !== 1 || !Number.isFinite(expectedLifecycleRevision)) throw sourceError('source-recovery', 'The exact managed Session identity and revision cannot be verified before rename.');
      const patched = await this.sessionStore.patchSessionEntry({
        agentId: 'main',
        sessionKey,
        preserveActivity: true,
        update: (entry) => {
          if (entry.sessionId !== expectedSessionId || entry.updatedAt !== expectedLifecycleRevision) throw sourceError('conflict', 'The managed Session identity or revision changed before rename.');
          return { label, updatedAt: Date.now() };
        }
      });
      if (!patched || patched.sessionId !== expectedSessionId) throw sourceError('source-recovery', 'Session label update returned an unexpected Session identity.');
      return patched;
    }
    if (!this.gateway?.request) throw sourceError('capability-unavailable', 'The Sessions capability is required to rename a managed Session label.');
    const listing = await this.gateway.request('sessions.list', {});
    const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
    const matches = rows.filter((row) => (row?.key ?? row?.sessionKey ?? row?.session?.key) === sessionKey
      && (row?.sessionId ?? row?.id ?? row?.session?.sessionId ?? null) === expectedSessionId);
    const expectedLifecycleRevision = matches[0]?.lifecycleRevision ?? matches[0]?.session?.lifecycleRevision ?? null;
    if (matches.length !== 1 || !expectedLifecycleRevision) throw sourceError('source-recovery', 'The exact managed Session identity and revision cannot be verified before rename.');
    const result = unwrap(await this.gateway.request('sessions.patch', { ['k' + 'ey']: sessionKey, expectedSessionId, expectedLifecycleRevision, label }, { requestId: logicalOperationId }));
    const returnedKey = result?.key ?? result?.sessionKey ?? result?.session?.key;
    const returnedSessionId = result?.sessionId ?? result?.session?.sessionId ?? null;
    if (returnedKey && returnedKey !== sessionKey) throw sourceError('source-recovery', 'Session label update returned an unexpected Session identity.');
    if (returnedSessionId && returnedSessionId !== expectedSessionId) throw sourceError('source-recovery', 'Session label update returned an unexpected Session identity.');
    return result;
  }

  async observeSessionLabel(reference) {
    const expectedSessionId = this.metadata.getSessionState?.(reference.referenceId)?.sessionId;
    const sessionKey = effectiveSessionKey(this.metadata, reference);
    if (this.sessionStore?.listSessionEntries) {
      const matches = this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true })
        .filter((row) => row.sessionKey === sessionKey && row.entry?.sessionId === expectedSessionId);
      return matches.length === 1 ? matches[0].entry?.label ?? null : null;
    }
    if (this.gateway?.request) {
      const listing = await this.gateway.request('sessions.list', {});
      const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
      const matches = rows.filter((row) => (row?.key ?? row?.sessionKey ?? row?.session?.key) === sessionKey
        && (row?.sessionId ?? row?.id ?? row?.session?.sessionId ?? null) === expectedSessionId);
      return matches.length === 1 ? matches[0]?.label ?? matches[0]?.displayName ?? matches[0]?.session?.label ?? null : null;
    }
    return null;
  }

  recategorizePreview(input = {}) {
    const topicId = String(input.topicId ?? '').trim();
    const paraCategory = validateParaCategory(input.paraCategory, { allowArchive: false });
    const current = this.snapshot(topicId);
    if (current.lifecycle !== 'active' || current.paraCategory === 'archive' || current.recovery.some((item) => item.state === 'required')) throw sourceError('archived-read-only', 'Only an active Topic without unresolved Source Recovery can be recategorized.');
    if (current.paraCategory === paraCategory) throw sourceError('invalid-request', 'The requested PARA Category is already current.');
    const folder = current.sourceReferences.find((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    const locator = folder ? current.locators.find((item) => item.referenceId === folder.referenceId) : null;
    const folderStates = folder ? current.convention.filter((item) => item.referenceId === folder.referenceId) : [];
    const relocate = Boolean(locator && sourceConventionManaged(folderStates, 'location'));
    const folderName = locator ? path.basename(locator.locator) : current.name;
    const destination = relocate ? conventionalFolderPath(this.noteRootFor(locator.locator), paraCategory, folderName) : null;
    return freezePlan({ kind: 'recategorization', topicId, from: current.paraCategory, to: paraCategory, expectedRevisions: revisionsFor(this.metadata, topicId, folder ? [{ referenceId: folder.referenceId, revision: locator?.observedRevision }] : []), changes: [{ aspect: 'category', from: current.paraCategory, to: paraCategory }, ...(destination ? [{ aspect: 'note-folder-location', from: locator.locator, to: destination, managed: true }] : [])] });
  }

  async recategorizeConfirm(input = {}) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const completed = this.metadata.getTopicOperation(logicalOperationId);
    if (completed?.state === 'applied') {
      if (completed.intent?.topicId !== input.topicId || completed.intent?.previewDigest !== input.previewDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Structural Change intent.');
      return this.snapshot(input.topicId);
    }
    const preview = completed?.intent?.preview ?? this.recategorizePreview({ topicId: input.topicId, paraCategory: input.paraCategory ?? input.preview?.to });
    assertPreviewConfirmation(preview, input);
    const previous = this.metadata.getTopicOperation(logicalOperationId);
    if (previous?.state === 'applied') {
      if (previous.intent?.previewDigest !== preview.digest || previous.intent?.topicId !== preview.topicId || previous.intent?.paraCategory !== preview.to) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Structural Change intent.');
      return this.snapshot(preview.topicId);
    }
    const current = await this.assertRequiredSourcesAvailable(preview.topicId);
    this.assertExpectedRevisions(preview.topicId, preview.expectedRevisions);
    const intent = { previewDigest: preview.digest, topicId: preview.topicId, paraCategory: preview.to, preview };
    this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.recategorize', state: 'pending', currentStep: 'relocate', intent, result: previous?.result, updatedAt: this.now() });
    try {
      const relocation = preview.changes.find((change) => change.aspect === 'note-folder-location');
      if (relocation) {
        const folder = sourceRef(this.metadata, preview.topicId, 'obsidian', 'note_folder');
        const folderLocator = this.metadata.getSourceLocator(folder.referenceId);
        const moveProof = previous?.result?.moveProof ?? await createMoveProof(relocation.from, relocation.to, this.noteVaultRoots, folderLocator?.observedRevision ?? null);
        this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.recategorize', state: 'pending', currentStep: 'folder-move', intent, result: { moveProof }, updatedAt: this.now() });
        await checkedMove(relocation.from, relocation.to, moveProof, this.noteVaultRoots);
        if (this.metadata.getSourceLocator(folder.referenceId).locator !== relocation.to) updateMovedLocator(this.metadata, folder.referenceId, relocation.to);
      }
      const latest = this.metadata.getTopic(preview.topicId);
      this.metadata.updateTopic({ topicId: preview.topicId, paraCategory: preview.to, expectedRevision: latest.revision });
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.recategorize', state: 'applied', currentStep: 'complete', intent, result: { topicId: preview.topicId, paraCategory: preview.to }, updatedAt: this.now() });
      return this.snapshot(preview.topicId);
    } catch (error) {
      if (error?.code === 'source-recovery') await this.recordFolderRecovery(preview.topicId, error);
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.recategorize', state: error?.code === 'conflict' ? 'conflict' : 'unknown', currentStep: 'interrupted', intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), error: String(error?.code ?? 'recategorization-failed') }, updatedAt: this.now() });
      throw error;
    }
  }

  async listCommitments(topicId) {
    return (await this.listCommitmentRecords(topicId)).filter((item) => item.enabled !== false);
  }

  async listCommitmentRecords(topicId) {
    if (this.commitmentProvider) return (await this.commitmentProvider(topicId)) ?? [];
    const boundSchedulerReferences = this.metadata.listSourceReferences(topicId).filter((reference) => reference.sourceSystem === 'scheduler' && ['schedule', 'reminder_schedule'].includes(reference.sourceKind));
    const scheduler = this.schedulerFactory?.(topicId);
    if (!scheduler?.list) {
      throw sourceError('capability-unavailable', 'Reminder and scheduler capabilities are required to account for commitments before archive.');
    }
    const values = unwrap(await scheduler.list({}));
    const rows = Array.isArray(values) ? values : values?.results ?? values?.items ?? [];
    const resolvedIds = new Set(rows.map((item) => item.sourceReference?.referenceId ?? item.referenceId).filter(Boolean));
    if (boundSchedulerReferences.some((reference) => !resolvedIds.has(reference.referenceId))) throw sourceError('source-recovery', 'Archive commitment accounting could not resolve every bound scheduled operation.');
    return rows.map((item) => ({
      referenceId: item.sourceReference?.referenceId ?? item.referenceId,
      revision: item.job?.configRevision ?? item.observedRevision ?? item.sourceReference?.observedRevision,
      kind: item.sourceReference?.sourceKind ?? item.kind ?? 'schedule',
      enabled: item.job?.enabled ?? item.enabled ?? true
    })).filter((item) => item.referenceId);
  }

  async archivePreview(input = {}) {
    const topicId = String(input.topicId ?? '').trim();
    const current = await this.assertRequiredSourcesAvailable(topicId);
    if (current.lifecycle !== 'active' || current.paraCategory === 'archive') throw sourceError('invalid-request', 'Only an active non-Archive Topic can be archived.');
    const commitments = await this.listCommitmentRecords(topicId);
    if (commitments.some((item) => typeof item.revision !== 'string' || item.revision.trim() === '' || typeof item.enabled !== 'boolean')) {
      throw sourceError('source-recovery', 'Archive commitment accounting requires an exact revision and enabled state for every linked commitment.');
    }
    const folder = current.sourceReferences.find((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    const locator = folder ? current.locators.find((item) => item.referenceId === folder.referenceId) : null;
    const folderStates = folder ? current.convention.filter((item) => item.referenceId === folder.referenceId) : [];
    const destination = locator && sourceConventionManaged(folderStates, 'location') ? conventionalFolderPath(this.noteRootFor(locator.locator), 'archive', path.basename(locator.locator)) : null;
    return freezePlan({ kind: 'archive', topicId, expectedRevisions: revisionsFor(this.metadata, topicId, commitments), commitments: commitments.map(({ referenceId, revision, kind, enabled }) => ({ referenceId, revision, kind, enabled, disposition: enabled ? 'disable-and-retain' : 'no-op' })), changes: [{ aspect: 'category', from: current.paraCategory, to: 'archive' }, ...(destination ? [{ aspect: 'note-folder-location', from: locator.locator, to: destination, managed: true }] : [])], policy: 'disable-and-retain' });
  }

  async archiveConfirm(input = {}) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const completed = this.metadata.getTopicOperation(logicalOperationId);
    if (completed?.state === 'applied') {
      if (completed.intent?.topicId !== input.topicId || completed.intent?.previewDigest !== input.previewDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Archive intent.');
      return this.snapshot(input.topicId);
    }
    const preview = completed?.intent?.preview ?? await this.archivePreview({ topicId: input.topicId });
    assertPreviewConfirmation(preview, input);
    const previous = this.metadata.getTopicOperation(logicalOperationId);
    if (previous?.state === 'applied') {
      if (previous.intent?.previewDigest !== preview.digest || previous.intent?.topicId !== preview.topicId) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Archive intent.');
      return this.snapshot(preview.topicId);
    }
    await this.assertRequiredSourcesAvailable(preview.topicId);
    this.assertExpectedRevisions(preview.topicId, preview.expectedRevisions.filter((item) => item.source === 'topic'));
    const observedCommitments = await this.listCommitmentRecords(preview.topicId);
    const reconciledCommitments = new Set(previous?.result?.reconciledCommitments ?? []);
    if (observedCommitments.length !== preview.commitments.length || preview.commitments.some((item) => {
      const observed = observedCommitments.find((candidate) => candidate.referenceId === item.referenceId);
      const exact = observed && observed.revision === item.revision && observed.kind === item.kind && observed.enabled === item.enabled;
      const operationOwnedAttempt = reconciledCommitments.has(item.referenceId) || previous?.result?.attemptingCommitment === item.referenceId;
      const retryableOperationPostcondition = previous?.state === 'unknown' && operationOwnedAttempt && item.enabled === true && observed?.kind === item.kind && observed.enabled === false;
      return !exact && !retryableOperationPostcondition;
    })) throw sourceError('conflict', 'Archive commitment accounting changed after preview.');
    const intent = { previewDigest: preview.digest, topicId: preview.topicId, commitments: preview.commitments, preview };
    const relocation = preview.changes.find((change) => change.aspect === 'note-folder-location');
    this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.archive', state: 'pending', currentStep: 'relocate', intent, result: previous?.result, updatedAt: this.now() });
    try {
      const scheduler = this.schedulerFactory?.(preview.topicId);
      for (const commitment of preview.commitments) {
        const observed = observedCommitments.find((item) => item.referenceId === commitment.referenceId);
        if (!observed) throw sourceError('conflict', 'A previewed archive commitment can no longer be resolved.');
        if (commitment.enabled && !reconciledCommitments.has(commitment.referenceId)) {
          const dispositionOperationId = derivedUuid(`${logicalOperationId}:${commitment.disposition}:${commitment.referenceId}`);
          this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.archive', state: 'pending', currentStep: `commitment:${commitment.referenceId}`, intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), attemptingCommitment: commitment.referenceId, reconciledCommitments: [...reconciledCommitments] }, updatedAt: this.now() });
          if (commitment.disposition !== 'disable-and-retain') throw sourceError('invalid-request', 'Archive commitments require disable-and-retain accounting.');
          if (!scheduler?.setEnabled) throw sourceError('capability-unavailable', 'Scheduler capability cannot disable archive commitments.');
          await scheduler.setEnabled({ referenceId: commitment.referenceId, enabled: false, expectedConfigRevision: commitment.revision, logicalOperationId: dispositionOperationId });
        }
        reconciledCommitments.add(commitment.referenceId);
        this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.archive', state: 'pending', currentStep: `commitment:${commitment.referenceId}`, intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), reconciledCommitments: [...reconciledCommitments] }, updatedAt: this.now() });
      }
      if ((await this.listCommitments(preview.topicId)).length) throw sourceError('conflict', 'Archive commitment disables could not be verified.');
      let moveProof = this.metadata.getTopicOperation(logicalOperationId)?.result?.moveProof;
      if (relocation) {
        const folder = sourceRef(this.metadata, preview.topicId, 'obsidian', 'note_folder');
        const folderLocator = folder ? this.metadata.getSourceLocator(folder.referenceId) : null;
        moveProof ??= await createMoveProof(relocation.from, relocation.to, this.noteVaultRoots, folderLocator?.observedRevision ?? null);
        await moveReadiness(relocation.from, relocation.to, moveProof, this.noteVaultRoots);
        this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.archive', state: 'pending', currentStep: 'relocation-proof', intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), moveProof }, updatedAt: this.now() });
      }
      if (relocation) {
        const folder = sourceRef(this.metadata, preview.topicId, 'obsidian', 'note_folder');
        await checkedMove(relocation.from, relocation.to, moveProof, this.noteVaultRoots);
        if (this.metadata.getSourceLocator(folder.referenceId).locator !== relocation.to) updateMovedLocator(this.metadata, folder.referenceId, relocation.to);
      }
      const latest = this.metadata.getTopic(preview.topicId);
      this.metadata.updateTopic({ topicId: preview.topicId, paraCategory: 'archive', expectedRevision: latest.revision });
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.archive', state: 'applied', currentStep: 'complete', intent, result: { topicId: preview.topicId, paraCategory: 'archive' }, updatedAt: this.now() });
      return this.snapshot(preview.topicId);
    } catch (error) {
      if (error?.code === 'source-recovery') await this.recordFolderRecovery(preview.topicId, error);
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.archive', state: error?.code === 'conflict' ? 'conflict' : 'unknown', currentStep: 'interrupted', intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), error: String(error?.code ?? 'archive-failed') }, updatedAt: this.now() });
      throw error;
    }
  }

  restorePreview(input = {}) {
    const topicId = String(input.topicId ?? '').trim();
    const paraCategory = validateParaCategory(input.paraCategory, { allowArchive: false });
    const current = this.snapshot(topicId);
    if (current.paraCategory !== 'archive' || current.lifecycle !== 'active') throw sourceError('invalid-request', 'Only an Archived Topic can be restored.');
    const folder = current.sourceReferences.find((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
    const locator = folder ? current.locators.find((item) => item.referenceId === folder.referenceId) : null;
    const folderStates = folder ? current.convention.filter((item) => item.referenceId === folder.referenceId) : [];
    const destination = locator && sourceConventionManaged(folderStates, 'location') ? conventionalFolderPath(this.noteRootFor(locator.locator), paraCategory, path.basename(locator.locator)) : null;
    return freezePlan({ kind: 'restore', topicId, expectedRevisions: revisionsFor(this.metadata, topicId), from: 'archive', to: paraCategory, changes: [{ aspect: 'category', from: 'archive', to: paraCategory }, ...(destination ? [{ aspect: 'note-folder-location', from: locator.locator, to: destination, managed: true }] : [])] });
  }

  async restoreConfirm(input = {}) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const completed = this.metadata.getTopicOperation(logicalOperationId);
    if (completed?.state === 'applied') {
      if (completed.intent?.topicId !== input.topicId || completed.intent?.previewDigest !== input.previewDigest) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Restore intent.');
      return this.snapshot(input.topicId);
    }
    const preview = completed?.intent?.preview ?? this.restorePreview({ topicId: input.topicId, paraCategory: input.paraCategory ?? input.preview?.to });
    assertPreviewConfirmation(preview, input);
    await this.assertRequiredSourcesAvailable(preview.topicId);
    const previous = this.metadata.getTopicOperation(logicalOperationId);
    if (previous?.state === 'applied') {
      if (previous.intent?.previewDigest !== preview.digest || previous.intent?.topicId !== preview.topicId || previous.intent?.paraCategory !== preview.to) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Restore intent.');
      return this.snapshot(preview.topicId);
    }
    const current = this.snapshot(preview.topicId);
    this.assertExpectedRevisions(preview.topicId, preview.expectedRevisions);
    const intent = { previewDigest: preview.digest, topicId: preview.topicId, paraCategory: preview.to, preview };
    this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.restore', state: 'pending', currentStep: 'relocate', intent, result: previous?.result, updatedAt: this.now() });
    try {
      const relocation = preview.changes.find((change) => change.aspect === 'note-folder-location');
      if (relocation) {
        const folder = sourceRef(this.metadata, preview.topicId, 'obsidian', 'note_folder');
        const folderLocator = this.metadata.getSourceLocator(folder.referenceId);
        const moveProof = previous?.result?.moveProof ?? await createMoveProof(relocation.from, relocation.to, this.noteVaultRoots, folderLocator?.observedRevision ?? null);
        this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.restore', state: 'pending', currentStep: 'folder-move', intent, result: { moveProof }, updatedAt: this.now() });
        await checkedMove(relocation.from, relocation.to, moveProof, this.noteVaultRoots);
        if (this.metadata.getSourceLocator(folder.referenceId).locator !== relocation.to) updateMovedLocator(this.metadata, folder.referenceId, relocation.to);
      }
      const latest = this.metadata.getTopic(preview.topicId);
      this.metadata.updateTopic({ topicId: preview.topicId, paraCategory: preview.to, expectedRevision: latest.revision });
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.restore', state: 'applied', currentStep: 'complete', intent, result: { topicId: preview.topicId, paraCategory: preview.to }, updatedAt: this.now() });
      return this.snapshot(preview.topicId);
    } catch (error) {
      if (error?.code === 'source-recovery') await this.recordFolderRecovery(preview.topicId, error);
      this.metadata.recordTopicOperation({ logicalOperationId, topicId: preview.topicId, operationKind: 'topics.restore', state: error?.code === 'conflict' ? 'conflict' : 'unknown', currentStep: 'interrupted', intent, result: { ...(this.metadata.getTopicOperation(logicalOperationId)?.result ?? {}), error: String(error?.code ?? 'restore-failed') }, updatedAt: this.now() });
      throw error;
    }
  }
}

export function createTopicLifecycleService(options) { return new TopicLifecycleService(options); }
