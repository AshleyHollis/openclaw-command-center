import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';
import { assertLogicalOperationId } from '../sources/operation-journal.mjs';

function bounded(value) { return String(value ?? '').slice(0, 180); }
function unboundRevision(referenceId) { return `unbound:${referenceId}`; }
function sameIntent(left, right) {
  const normalize = (value) => Object.fromEntries(Object.keys(value ?? {}).sort().map((key) => [key, value[key]]));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export class TopicRecoveryService {
  constructor(options = {}) {
    this.metadata = options.metadata;
    this.gateway = options.gateway ?? options.api?.runtime?.gateway;
    this.sessionStore = options.sessionStore ?? options.api?.runtime?.agent?.session;
    this.noteVaultRoots = options.noteVaultRoots ?? (options.noteVaultRoot === undefined ? [] : [options.noteVaultRoot]);
    this.noteVaultRoot = this.noteVaultRoots[0];
    this.now = options.now ?? (() => new Date().toISOString());
  }

  prepareMutation(input, operationKind, intent) {
    const logicalOperationId = assertLogicalOperationId(input.logicalOperationId);
    const previous = this.metadata.getTopicOperation(logicalOperationId);
    if (previous) {
      if (previous.operationKind !== operationKind || !sameIntent(previous.intent, intent)) throw sourceError('intent-mismatch', 'Logical operation ID was reused with a different Source Recovery intent.');
      if (previous.state === 'applied') return { logicalOperationId, replay: previous.result };
    }
    const topic = this.metadata.getTopic(intent.topicId);
    const reference = this.metadata.getSourceReference(intent.referenceId);
    if (!topic || topic.lifecycle !== 'active' || !reference || reference.topicId !== intent.topicId) throw sourceError('conflict', 'Source Recovery mutations require an active or Archived Topic and an exact Topic-owned Source Reference.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== topic.revision) throw sourceError('conflict', 'Source Recovery Topic revision is stale.', { currentRevision: topic.revision, expectedRevision: input.expectedRevision });
    if (typeof input.expectedSourceRevision !== 'string' || input.expectedSourceRevision.length === 0) throw sourceError('invalid-request', 'Source Recovery mutations require expectedSourceRevision.');
    if (!previous) this.metadata.recordTopicOperation({ logicalOperationId, topicId: intent.topicId, operationKind, state: 'pending', currentStep: 'verify-exact-source', intent, updatedAt: this.now() });
    return { logicalOperationId, replay: null };
  }

  finishMutation(logicalOperationId, operationKind, intent, result) {
    const completed = this.metadata.completeTopicRecoveryMutation({ logicalOperationId, operationKind, intent, result, recovery: result.recovery, expectedRevision: intent.expectedRevision, updatedAt: this.now() });
    return { ...result, recovery: completed.recovery, topicRevision: completed.topic.revision };
  }

  async ensureRequiredOrDetected(topicId, referenceId) {
    const persisted = this.metadata.listSourceRecovery?.(topicId)?.find((item) => item.referenceId === referenceId && item.state === 'required');
    const inspection = await this.inspect(topicId, referenceId);
    if (persisted) return inspection;
    if (inspection.available) throw sourceError('conflict', 'The exact source is available and has no unresolved Source Recovery state.');
    await this.markMissing(topicId, referenceId, inspection.failure ?? 'authoritative-source-unavailable');
    return inspection;
  }

  async exactReplacementLocator(locator, referenceId) {
    if (typeof locator !== 'string' || !path.isAbsolute(locator)) throw sourceError('invalid-request', 'An explicit replacement Note Folder must be an absolute path.');
    const roots = (this.noteVaultRoots ?? []).filter((root) => typeof root === 'string' && path.isAbsolute(root));
    if (roots.length === 0) throw sourceError('capability-unavailable', 'A configured absolute Note root is required before replacing a Note Folder binding.');
    const candidate = path.resolve(locator);
    const insideRoot = (await Promise.all(roots.map(async (configured) => realpath(configured).catch(() => null)))).some((root) => {
      const relative = root ? path.relative(root, candidate) : '';
      return root && relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!insideRoot) throw sourceError('unsafe-path', 'The replacement Note Folder must remain inside a configured Note root.');
    const stat = await lstat(candidate).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw sourceError('source-recovery', 'The explicit replacement Note Folder must be an existing real directory.');
    if (await realpath(candidate) !== candidate) throw sourceError('unsafe-path', 'The replacement Note Folder cannot be a path alias.');
    const owner = (this.metadata.listSourceLocators?.() ?? []).find((item) => item.locator === candidate);
    if (owner && owner.referenceId !== referenceId) throw sourceError('conflict', 'The explicit replacement Note Folder is already bound to another Source Reference.');
    return { locator: candidate, observedRevision: `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}` };
  }

  async inspect(topicId, referenceId) {
    const reference = this.metadata.getSourceReference(referenceId);
    if (!reference || reference.topicId !== topicId) throw sourceError('source-recovery', 'The exact Topic-owned Source Reference was not found.');
    const locatorRecord = this.metadata.getSourceLocator?.(referenceId);
    const locator = locatorRecord?.locator ?? reference.externalSourceId;
    let available = false;
    let failure = null;
    if (reference.sourceSystem === 'obsidian') {
      const stat = await lstat(locator).catch((error) => { failure = error?.code ?? 'not-found'; return null; });
      if (stat?.isSymbolicLink() || !stat?.isDirectory()) failure = 'unsafe-or-not-directory';
      if (stat && !failure) {
        const canonical = await realpath(locator).catch(() => null);
        if (canonical !== locator) failure = 'locator-alias';
        else {
          const identity = `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
          if (!locatorRecord?.observedRevision) failure = 'exact-folder-identity-unverified';
          else if (locatorRecord.observedRevision !== identity) failure = 'exact-folder-identity-mismatch';
          else available = true;
        }
      }
    } else if (reference.sourceSystem === 'openclaw') {
      if (!this.gateway?.request && !this.sessionStore?.listSessionEntries) failure = 'sessions-capability-unavailable';
      else {
        const listing = this.sessionStore?.listSessionEntries
          ? this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true }).map((row) => ({ ['k' + 'ey']: row.sessionKey, ...(row.entry ?? {}) }))
          : await this.gateway.request('sessions.list', {});
        const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
        const matches = rows.filter((row) => (row?.key ?? row?.sessionKey ?? row?.session?.key) === locator);
        const expectedSessionId = this.metadata.getSessionState?.(referenceId)?.sessionId ?? null;
        const actualSessionId = matches[0]?.sessionId ?? matches[0]?.id ?? matches[0]?.session?.sessionId ?? null;
        if (matches.length === 1 && (expectedSessionId === null || actualSessionId === expectedSessionId)) available = true;
        else failure = matches.length === 0 ? 'exact-session-missing' : 'exact-session-ambiguous';
      }
    } else failure = 'unsupported-source-kind';
    return { available, failure, locator, reference };
  }

  async verify(input = {}) {
    const topicId = String(input.topicId ?? '').trim();
    const referenceId = String(input.referenceId ?? '').trim();
    const operationKind = 'topics.recovery.verify';
    const intent = { topicId, referenceId, expectedRevision: input.expectedRevision, expectedSourceRevision: input.expectedSourceRevision, replacementLocator: input.replacementLocator ?? null };
    const operation = this.prepareMutation(input, operationKind, intent);
    if (operation.replay) return operation.replay;
    const reference = this.metadata.getSourceReference(referenceId);
    if (!reference || reference.topicId !== topicId) throw sourceError('source-recovery', 'The exact Topic-owned Source Reference was not found.');
    let inspection = await this.ensureRequiredOrDetected(topicId, referenceId);
    const currentRevision = this.metadata.getSourceLocator?.(referenceId)?.observedRevision ?? reference.observedRevision ?? unboundRevision(referenceId);
    let state = 'resolved';
    if (input.replacementLocator !== undefined) {
      if (reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note_folder') throw sourceError('unsupported-operation', 'A replacementLocator applies only to Note Folder Source References.');
      const replacement = await this.exactReplacementLocator(input.replacementLocator, referenceId);
      this.metadata.applyFolderRecoveryBinding({ referenceId, locator: replacement.locator, observedRevision: replacement.observedRevision, expectedSourceRevision: input.expectedSourceRevision, updatedAt: this.now() });
      this.metadata.setSourceConventionState?.({ referenceId, aspect: 'location', state: 'customized', expectedValue: replacement.locator, updatedAt: this.now() });
      inspection = { ...inspection, available: true, failure: null, locator: replacement.locator };
      state = 'replaced';
    } else if (input.expectedSourceRevision !== currentRevision) throw sourceError('conflict', 'Source Recovery verification revision is stale.', { currentRevision, expectedRevision: input.expectedSourceRevision });
    if (!inspection.available) throw sourceError('source-recovery', `Explicit Source Recovery verification failed: ${inspection.failure}.`, { topicId, referenceId, lastLocator: inspection.locator });
    const recovery = {
      recoveryId: `recovery:${referenceId}`,
      topicId,
      referenceId,
      sourceKind: inspection.reference.sourceKind,
      state,
      lastLocator: inspection.locator,
      lastIdentity: inspection.reference.externalSourceId,
      failure: state === 'replaced' ? 'resolved by explicit authorized replacement' : 'resolved by explicit exact verification',
      diagnostics: [{ topicId, referenceId, sourceKind: inspection.reference.sourceKind, check: state === 'replaced' ? 'explicit-replacement' : 'exact-identity', result: 'verified' }],
      updatedAt: this.now()
    };
    return this.finishMutation(operation.logicalOperationId, operationKind, intent, { status: state, recovery });
  }

  async relink(input = {}) {
    return this.replaceSession(input, { addReference: false, operationKind: 'topics.recovery.relink', resultStatus: 'relinked' });
  }

  async replace(input = {}) {
    const reference = this.metadata.getSourceReference(input.referenceId);
    if (reference?.sourceSystem === 'obsidian') return this.verify({ ...input, replacementLocator: input.replacementLocator });
    return this.replaceSession(input, { addReference: true, operationKind: 'topics.recovery.replace', resultStatus: 'replaced' });
  }

  async replaceSession(input, { addReference, operationKind, resultStatus }) {
    const topicId = String(input.topicId ?? '').trim();
    const referenceId = String(input.referenceId ?? '').trim();
    const reference = this.metadata.getSourceReference(referenceId);
    if (!reference || reference.topicId !== topicId || reference.sourceSystem !== 'openclaw' || reference.sourceKind !== 'session') throw sourceError('unsupported-operation', 'Exact Session relink/replacement requires a Topic-owned Session Source Reference.');
    const sessionKey = String(input.sessionKey ?? '').trim();
    const sessionId = String(input.sessionId ?? '').trim();
    const intent = { topicId, referenceId, sessionKey, sessionId, expectedRevision: input.expectedRevision, expectedSourceRevision: input.expectedSourceRevision, addReference };
    const operation = this.prepareMutation(input, operationKind, intent);
    if (operation.replay) return operation.replay;
    await this.ensureRequiredOrDetected(topicId, referenceId);
    if (!sessionKey || !sessionId || !this.gateway?.request && !this.sessionStore?.listSessionEntries) throw sourceError('invalid-request', 'Exact Session key, sessionId, and Sessions capability are required.');
    const current = this.metadata.getSourceLocator?.(referenceId);
    const currentRevision = current?.observedRevision ?? this.metadata.getSessionState?.(referenceId)?.sessionId ?? reference.observedRevision ?? null;
    const listing = this.sessionStore?.listSessionEntries
      ? this.sessionStore.listSessionEntries({ agentId: 'main', readOnly: true }).map((row) => ({ ['k' + 'ey']: row.sessionKey, ...(row.entry ?? {}) }))
      : await this.gateway.request('sessions.list', {});
    const rows = Array.isArray(listing) ? listing : listing?.sessions ?? listing?.items ?? [];
    const matches = rows.filter((row) => (row?.key ?? row?.sessionKey ?? row?.session?.key) === sessionKey && (row?.sessionId ?? row?.id ?? row?.session?.sessionId) === sessionId);
    if (matches.length !== 1) throw sourceError('source-recovery', 'The explicit Session replacement identity could not be verified exactly.');
    let replacementReferenceId = referenceId;
    let alreadyApplied = false;
    if (addReference) {
      replacementReferenceId = `session:${topicId}:${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`;
      const existing = this.metadata.getSourceReference(replacementReferenceId);
      alreadyApplied = existing?.externalSourceId === sessionKey && this.metadata.getSessionState?.(replacementReferenceId)?.sessionId === sessionId;
      if (input.expectedSourceRevision !== currentRevision && !alreadyApplied) throw sourceError('conflict', 'Session Source Recovery revision is stale.', { currentRevision, expectedRevision: input.expectedSourceRevision });
      if (!existing) this.metadata.createSourceReference({ version: 1, referenceId: replacementReferenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: sessionId });
      this.metadata.setSessionState?.({ referenceId: replacementReferenceId, sessionId, status: 'open', isPrimary: true, updatedAt: this.now() });
    } else {
      this.metadata.applySessionRecoveryRelink({ referenceId, sessionKey, sessionId, expectedSourceRevision: input.expectedSourceRevision, updatedAt: this.now() });
    }
    const recovery = { recoveryId: `recovery:${referenceId}`, topicId, referenceId, sourceKind: 'session', state: 'replaced', lastLocator: sessionKey, lastIdentity: sessionId, failure: `resolved by explicit exact Session ${addReference ? 'replacement' : 'relink'}`, diagnostics: [{ topicId, referenceId, sourceKind: 'session', check: addReference ? 'explicit-replacement' : 'explicit-relink', result: 'verified' }], updatedAt: this.now() };
    return this.finishMutation(operation.logicalOperationId, operationKind, intent, { status: resultStatus, replacementReferenceId, recovery });
  }

  async markMissing(topicId, referenceId, failure) {
    const reference = this.metadata.getSourceReference(referenceId);
    const locatorRecord = this.metadata.getSourceLocator?.(referenceId);
    const locator = locatorRecord?.locator ?? reference?.externalSourceId ?? null;
    if (!reference || reference.topicId !== topicId) return null;
    return this.metadata.recordSourceRecovery({
      recoveryId: `recovery:${referenceId}`,
      topicId,
      referenceId,
      sourceKind: reference.sourceKind,
      state: 'required',
      lastLocator: bounded(locator),
      lastIdentity: bounded(locatorRecord?.observedRevision ?? reference.externalSourceId),
      failure: bounded(failure),
      diagnostics: [{ topicId, referenceId, sourceKind: reference.sourceKind, lastLocator: bounded(locator), check: bounded(failure), routes: ['verify-exact', 'authorized-replacement'] }],
      updatedAt: this.now()
    });
  }
}

export function createTopicRecoveryService(options) { return new TopicRecoveryService(options); }
