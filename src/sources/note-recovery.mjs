import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownsNoteFilesystem, withNoteFilesystemOwner } from './note-filesystem-owner.mjs';
import { revisionForBytes } from './reference.mjs';
import { sourceError } from './errors.mjs';

const KIND = 'notes.filesystem-effect';
const identity = (stat) => stat ? { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } : null;
const sameIdentity = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

// One host-owned SQLite transaction protects both the filesystem effect and its
// metadata receipt. Its file is contentless; only the existing metadata journal
// stores recovery provenance. Process death releases the lock, never a timer.
export class NoteRecovery {
  constructor(adapter, options) {
    this.adapter = adapter;
    this.metadata = options.metadata;
    this.acquire = options.tryAcquireExclusiveSqliteCoordinator;
    this.enabled = Boolean(this.metadata?.databasePath && this.metadata?.recordTopicOperation);
    this.effects = options.noteRecoveryEffects !== false;
  }

  get owned() { return !this.enabled || ownsNoteFilesystem(this.metadata); }

  assertReadAdmission(records) {
    if (this.effects || !this.enabled) return;
    const unresolved = records ?? this.metadata.listTopicOperations(this.adapter.topicId).filter((record) => record.operationKind === KIND && ['pending', 'unknown'].includes(record.state));
    if (unresolved.length) throw sourceError('source-recovery', 'An interrupted Note operation requires explicit recovery before read-only Note access.');
  }

  async run(action) {
    if (this.owned) return action();
    return withNoteFilesystemOwner(this.metadata, async () => { await this.recover(); return action(); }, { acquire: this.acquire });
  }

  record(record, state, currentStep, result = record.result) {
    return this.metadata.recordTopicOperation({ ...record, state, currentStep, result, updatedAt: this.adapter.now() });
  }

  matchesBinding(result) {
    const current = this.metadata.getSourceLocator?.(this.adapter.noteFolderReferenceId);
    return result?.noteFolderReferenceId === this.adapter.noteFolderReferenceId && current
      && result.folderBinding?.locatorVersion === current.locatorVersion
      && result.folderBinding?.observedRevision === current.observedRevision
      && result.root === current.locator;
  }

  async reconcile(input, operation) {
    if (!this.enabled || !input.logicalOperationId) return null;
    if (!this.owned) return this.run(() => this.reconcile(input, operation));
    const record = this.metadata.getTopicOperation(`notes.fs:${input.logicalOperationId}`);
    if (!record) return null;
    const { intent, result } = record;
    const sourcePath = input.path ?? input.sourcePath ?? input.notePath;
    const destinationPath = ['create', 'edit'].includes(operation) ? sourcePath : input.destinationPath ?? input.newPath;
    const desiredRevision = ['create', 'edit'].includes(operation) ? revisionForBytes(Buffer.from(input.text ?? input.content)) : input.expectedRevision;
    if (record.topicId !== this.adapter.topicId || intent.operation !== operation || intent.sourcePath !== sourcePath || intent.destinationPath !== destinationPath || intent.expectedRevision !== input.expectedRevision || intent.desiredRevision !== desiredRevision) throw sourceError('intent-mismatch', 'Note filesystem operation ID was reused with a different intent.');
    await this.adapter.resolveRoot();
    if (!this.matchesBinding(result)) return { outcome: 'conflict' };
    if (record.state === 'not-applied' && operation === 'create') {
      const parent = await this.adapter.openParent(result.root, intent.destinationPath, { operation: 'recovery' });
      try {
        await this.recoverCreateRecord(record, parent);
        const current = this.metadata.getTopicOperation(record.logicalOperationId);
        if (current.state === 'not-applied') return { outcome: 'not-applied' };
        return this.reconcile(input, operation);
      } finally { await parent.handle.close(); }
    }
    if (record.state === 'not-applied') return { outcome: 'not-applied' };
    if (record.state !== 'applied') return { outcome: 'unknown' };
    const root = await this.adapter.resolveRoot();
    if (result.root !== root) return { outcome: 'conflict' };
    const parent = await this.adapter.openParent(root, intent.destinationPath, { operation: 'recovery' });
    try {
      const chain = result.chains[1];
      if (chain.length !== parent.chain.length || chain.some((part, index) => !sameIdentity(part.identity, identity(parent.chain[index].stat)))) return { outcome: 'conflict' };
      const current = await this.inspect(parent.target);
      if (!current || !sameIdentity(current.identity, result.publishedIdentity) || current.revision !== intent.desiredRevision) return { outcome: 'conflict' };
      const note = await this.adapter.read({ path: intent.destinationPath });
      if (operation === 'create' && note.sourceReference.referenceId !== result.sourceReference.referenceId) return { outcome: 'conflict' };
      const final = await this.inspect(parent.target);
      if (!final || !sameIdentity(final.identity, result.publishedIdentity) || final.revision !== intent.desiredRevision || note.revision !== intent.desiredRevision) return { outcome: 'conflict' };
      await this.adapter.assertChainStable(parent.chain);
      return { outcome: 'applied', value: { schemaVersion: 1, status: 'reconciled', note, logicalOperationId: input.logicalOperationId, ...(['create', 'edit'].includes(operation) ? {} : { previousPath: intent.sourcePath }) } };
    } finally { await parent.handle.close(); }
  }

  async prepareCreate({ input, root, parent, bytes, sourceReference }) {
    const prior = input.logicalOperationId ? this.metadata.getTopicOperation(`notes.fs:${input.logicalOperationId}`) : null;
    if (prior) {
      const reconciled = await this.reconcile(input, 'create');
      if (reconciled?.outcome !== 'not-applied') throw sourceError('conflict', 'The prior Note create cannot resume its prepared staging inode.');
      return this.record(prior, 'pending', 'prepared');
    }
    const temporary = this.adapter.descriptorPath(parent.handle, `.${parent.leaf}.command-center-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let temporaryStat;
    try { await handle.writeFile(bytes); await handle.sync(); temporaryStat = await handle.stat(); }
    finally { await handle.close(); }
    await this.adapter.assertChainStable(parent.chain);
    return this.prepare({ input, operation: 'create', root, sourceParent: parent, sourceStat: null, claim: null, temporary, temporaryStat, sourceReference });
  }

  async prepare({ input, operation, root, sourceParent, destinationParent = sourceParent, sourceStat, claim, temporary = null, temporaryStat = null, sourceReference }) {
    if (!this.enabled) return null;
    const logicalOperationId = `notes.fs:${input.logicalOperationId ?? randomUUID()}`;
    const intent = { version: 1, operation, sourcePath: sourceParent.relativePath, destinationPath: destinationParent.relativePath,
      expectedRevision: input.expectedRevision, desiredRevision: temporary ? revisionForBytes(Buffer.from(input.text ?? input.content)) : input.expectedRevision };
    const prior = this.metadata.getTopicOperation(logicalOperationId);
    if (prior && JSON.stringify(prior.intent) !== JSON.stringify(intent)) throw sourceError('intent-mismatch', 'Note filesystem operation ID was reused with a different intent.');
    const aliases = claim ? [{ parentPath: sourceParent.relativePath, name: path.basename(claim), identity: identity(sourceStat), chain: 0 }] : [];
    if (temporary) aliases.push({ parentPath: sourceParent.relativePath, name: path.basename(temporary), identity: identity(temporaryStat), chain: 0 });
    // Record currently verified legacy staging aliases before changing a name.
    // Recovery itself only opens these exact entries; it never scans patterns.
    for (const name of sourceStat ? await readdir(this.adapter.descriptorPath(sourceParent.handle)) : []) {
      if (name === sourceParent.leaf || !name.includes('.command-center-')) continue;
      const stat = await lstat(this.adapter.descriptorPath(sourceParent.handle, name));
      if (sameIdentity(identity(stat), identity(sourceStat))) aliases.push({ parentPath: sourceParent.relativePath, name, identity: identity(stat), chain: 0 });
    }
    this.adapter.assertCurrentRoot(root);
    const result = { root, noteFolderReferenceId: this.adapter.noteFolderReferenceId ?? null,
      folderBinding: { locatorVersion: this.adapter.rootLocatorVersion, observedRevision: this.adapter.rootObservedRevision },
      chains: [sourceParent.chain, destinationParent.chain].map((chain) => chain.map((component) => ({ path: path.relative(root, component.namedPath).split(path.sep).join('/'), identity: identity(component.stat) }))),
      sourceIdentity: identity(sourceStat), claimName: claim ? path.basename(claim) : null, temporaryName: temporary ? path.basename(temporary) : null,
      ...(operation === 'create' ? { createPublicationProtocol: 1 } : {}),
      publishedIdentity: identity(temporaryStat ?? sourceStat), sourceReference, aliases };
    return this.record({ logicalOperationId, topicId: this.adapter.topicId, operationKind: KIND, intent, result }, 'pending', 'prepared');
  }

  async recoverCreateRecord(record, parent) {
    const { intent, result } = record;
    if (!this.matchesBinding(result) || !result.sourceReference || result.sourceReference.topicId !== this.adapter.topicId) throw sourceError('source-recovery', 'The Note create no longer has its exact source owner.');
    const chain = result.chains[1];
    if (chain.length !== parent.chain.length || chain.some((part, index) => !sameIdentity(part.identity, identity(parent.chain[index].stat)))) throw sourceError('source-recovery', 'The Note create ancestor identity changed.');
    if (!result.temporaryName || path.basename(result.temporaryName) !== result.temporaryName) throw sourceError('source-recovery', 'The Note create staging proof is invalid.');
    const staged = await this.inspect(this.adapter.descriptorPath(parent.handle, result.temporaryName));
    const destination = await this.inspect(parent.target);
    const owned = (candidate) => candidate && sameIdentity(candidate.identity, result.publishedIdentity) && candidate.revision === intent.desiredRevision;
    await this.adapter.assertChainStable(parent.chain);
    if (owned(destination)) {
      await this.adapter.observe(result.sourceReference);
      await this.adapter.assertChainStable(parent.chain);
      return this.record(record, 'applied', 'metadata-applied');
    }
    if (!destination && owned(staged)) {
      // Only this versioned protocol durably marks the attempt before link.
      // Older prepared receipts and attempted publications cannot prove absence;
      // inode timestamps or matching bytes cannot upgrade them into that proof.
      if (result.createPublicationProtocol === 1 && record.currentStep === 'prepared') return this.record(record, 'not-applied', 'prepared');
      throw sourceError('unknown', 'The Note create may have published before its destination disappeared.');
    }
    throw sourceError(destination || staged ? 'conflict' : 'unknown', 'The Note create has no proven current publication or safely unpublished staging inode.');
  }

  async inspect(target) {
    let file;
    try {
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (!before.isFile()) throw sourceError('source-recovery', 'Note recovery found a non-regular candidate.');
      const bytes = await file.readFile(); const after = await file.stat(); const named = await lstat(target);
      if (!sameIdentity(before, after) || !sameIdentity(after, named) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw sourceError('conflict', 'A Note recovery candidate changed during verification.');
      return { identity: identity(after), revision: revisionForBytes(bytes), bytes };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await file?.close(); }
  }

  async recover() {
    const records = this.metadata.listTopicOperations(this.adapter.topicId).filter((record) => record.operationKind === KIND && ['pending', 'unknown'].includes(record.state));
    this.assertReadAdmission(records);
    if (!records.length) return;
    const root = await this.adapter.resolveRoot();
    for (const record of records) {
      const binding = this.metadata.getSourceLocator?.(this.adapter.noteFolderReferenceId);
      const priorVersion = record.result?.folderBinding?.locatorVersion;
      if (record.result?.noteFolderReferenceId === this.adapter.noteFolderReferenceId && Number.isInteger(priorVersion) && priorVersion > 0 && binding?.locatorVersion > priorVersion) {
        // A verified newer metadata binding retires automatic recovery, not the
        // original uncertainty or proof. Exact old-ID retries remain conflicts.
        this.adapter.assertCurrentRoot(root);
        if (record.state !== 'unknown') this.record(record, 'unknown', record.currentStep);
        continue;
      }
      await this.recoverRecord(record, root);
    }
  }

  async knownAliases(expected) {
    const paths = new Set();
    const root = this.adapter.fsSafeRoot.rootReal;
    for (const record of this.metadata.listTopicOperations(this.adapter.topicId)) {
      if (record.operationKind !== KIND || record.result?.root !== root || !this.matchesBinding(record.result)) continue;
      for (const alias of record.result.aliases ?? []) {
        if (!sameIdentity(alias.identity, identity(expected))) continue;
        if (path.basename(alias.name) !== alias.name) throw sourceError('source-recovery', 'A recorded Note alias is invalid.');
        const parent = await this.adapter.openParent(root, alias.parentPath, { operation: 'recovery' });
        try {
          const chain = record.result.chains[alias.chain];
          if (chain.length !== parent.chain.length || chain.some((part, index) => !sameIdentity(part.identity, identity(parent.chain[index].stat)))) throw sourceError('source-recovery', 'A recorded Note alias ancestor was replaced.');
          const stat = await lstat(this.adapter.descriptorPath(parent.handle, alias.name)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (stat && sameIdentity(identity(stat), alias.identity)) paths.add(path.join(path.dirname(path.join(root, alias.parentPath)), alias.name));
          await this.adapter.assertChainStable(parent.chain);
        } finally { await parent.handle.close(); }
      }
    }
    return paths;
  }

  async recoverRecord(record, root) {
    const { intent, result } = record;
    let sourceParent; let destinationParent;
    try {
      if (result.root !== root || !this.matchesBinding(result)) throw sourceError('source-recovery', 'The interrupted Note belongs to a different or unproven Note Folder binding generation.');
      for (const chain of result.chains) for (const component of chain) {
        if (path.isAbsolute(component.path) || component.path.split('/').some((part) => part === '..' || part === '.')) throw sourceError('source-recovery', 'The Note recovery path is invalid.');
        const stat = await lstat(path.join(root, component.path));
        if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(component.identity, identity(stat))) throw sourceError('source-recovery', 'An interrupted Note ancestor was replaced.');
      }
      sourceParent = await this.adapter.openParent(root, intent.sourcePath, { operation: 'recovery' });
      destinationParent = await this.adapter.openParent(root, intent.destinationPath, { operation: 'recovery' });
      if (intent.operation === 'create') return await this.recoverCreateRecord(record, destinationParent);
      if (path.basename(result.claimName) !== result.claimName || !result.claimName) throw sourceError('source-recovery', 'The Note recovery claim is invalid.');
      const claimPath = this.adapter.descriptorPath(sourceParent.handle, result.claimName);
      const source = await this.inspect(sourceParent.target); const claim = await this.inspect(claimPath);
      const destination = intent.sourcePath === intent.destinationPath ? source : await this.inspect(destinationParent.target);
      await this.adapter.assertChainStable(sourceParent.chain); await this.adapter.assertChainStable(destinationParent.chain);
      const original = (candidate) => candidate && sameIdentity(candidate.identity, result.sourceIdentity) && candidate.revision === intent.expectedRevision;
      const published = (candidate) => candidate && sameIdentity(candidate.identity, result.publishedIdentity) && candidate.revision === intent.desiredRevision;
      if (result.rollback) {
        if (path.basename(result.rollback.name) !== result.rollback.name) throw sourceError('source-recovery', 'The Note rollback quarantine is invalid.');
        const quarantinePath = this.adapter.descriptorPath(destinationParent.handle, result.rollback.name);
        const quarantined = await this.inspect(quarantinePath);
        await this.adapter.assertChainStable(sourceParent.chain); await this.adapter.assertChainStable(destinationParent.chain);
        if (quarantined && !sameIdentity(quarantined.identity, result.rollback.identity)) throw sourceError('conflict', 'The quarantined Note was replaced externally.');
        if (quarantined && !sameIdentity(quarantined.identity, result.publishedIdentity)) {
          await this.adapter.restoreClaim(quarantinePath, destinationParent.target);
          if (intent.operation !== 'edit' && !source && original(claim)) await this.adapter.restoreClaim(claimPath, sourceParent.target);
          throw sourceError('conflict', 'A foreign Note replacement was preserved during rollback recovery.');
        }
        if (!quarantined && destination) throw sourceError('conflict', 'The interrupted rollback has not safely quarantined its target.');
      }
      if (published(destination) && (record.currentStep === 'filesystem-applied' || intent.operation === 'edit' || !source)) {
        if (record.currentStep !== 'filesystem-applied' && !original(claim)) throw sourceError('conflict', 'The original Note recovery claim is no longer proven.');
        await this.adapter.assertChainStable(sourceParent.chain); await this.adapter.assertChainStable(destinationParent.chain);
        const reference = intent.operation === 'edit' ? { ...result.sourceReference, observedRevision: intent.desiredRevision }
          : this.adapter.noteReference(root, intent.destinationPath, intent.desiredRevision);
        await this.adapter.observe(reference);
        return this.record(record, 'applied', 'metadata-applied');
      }
      if (original(source) && (!destination || intent.operation === 'edit')) return this.record(record, 'not-applied', 'restored');
      if (!source && !destination && original(claim)) {
        if (!await this.adapter.restoreClaim(claimPath, sourceParent.target)) throw sourceError('conflict', 'A foreign Note appeared during recovery.');
        await this.adapter.assertChainStable(sourceParent.chain);
        // The claim pathname can be replaced after inspect closes its handle.
        // Never authorize a retry from a link to an unproven replacement inode.
        if (!original(await this.inspect(sourceParent.target))) throw sourceError('conflict', 'The restored Note no longer matches its recorded claim.');
        return this.record(record, 'not-applied', 'restored');
      }
      throw sourceError('conflict', 'The interrupted Note has an unproven or externally replaced candidate.');
    } catch (error) {
      // Recovery status is not filesystem provenance. A later metadata failure
      // must not erase the completed phase needed to reconcile on the next run.
      this.record(record, 'unknown', record.currentStep);
      throw error;
    } finally { await sourceParent?.handle.close(); await destinationParent?.handle.close(); }
  }
}
