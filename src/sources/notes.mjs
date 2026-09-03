import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, rmdir, writeFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSourceReference, revisionForBytes } from './reference.mjs';
import { SourceServiceError, sourceError, nonBlank } from './errors.mjs';
import { assertSafeDirectory, assertSafeNotePath, isWithin, normalizeNotePath } from './note-path.mjs';

function bytesForText(value, field = 'text') {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== 'string') throw sourceError('invalid-request', `${field} must be Markdown text`);
  return Buffer.from(value, 'utf8');
}

function sameStat(left, right) {
  return sameIdentity(left, right) && left?.size === right?.size && left?.nlink === right?.nlink && left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function directoryRevision(stat) {
  return `fs:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function mutationResult(status, note, extra = {}) {
  return Object.freeze({ schemaVersion: 1, status, note: Object.freeze(note), ...extra });
}

export class NoteAdapter {
  constructor(options = {}) {
    this.metadata = options.metadata;
    this.topicId = nonBlank(options.topicId, 'topicId');
    this.noteFolderReferenceId = options.noteFolderReferenceId;
    this.root = options.topicRoot ?? options.root ?? options.noteFolderPath;
    this.beforeCommit = options.beforeCommit;
    this.beforeAtomicCommit = options.beforeAtomicCommit;
    this.afterAtomicPublish = options.afterAtomicPublish;
    this.afterSourceClaim = options.afterSourceClaim;
    this.beforeDirectoryComponentCreate = options.beforeDirectoryComponentCreate;
    this.beforePathIo = options.beforePathIo;
    this.afterRootResolved = options.afterRootResolved;
    this.fsSafeRootFactory = options.fsSafeRootFactory;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async resolveRoot() {
    if (this.root && this.metadata && !this.noteFolderReferenceId) {
      const matches = this.metadata.listSourceReferences?.(this.topicId)?.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder' && reference.externalSourceId === this.root) ?? [];
      if (matches.length === 1) this.noteFolderReferenceId = matches[0].referenceId;
    }
    if (this.metadata && this.noteFolderReferenceId) {
      const selected = this.metadata.getSourceReference?.(this.noteFolderReferenceId);
      if (!selected || selected.topicId !== this.topicId) throw sourceError('source-recovery', 'The Note Folder Source Reference is missing or ambiguous.');
      const locator = this.metadata.getSourceLocator?.(this.noteFolderReferenceId);
      this.root = locator?.locator ?? selected.externalSourceId;
      this.rootObservedRevision = locator?.observedRevision ?? null;
    }
    if (!this.root && this.metadata) {
      const references = this.metadata.listSourceReferences(this.topicId).filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note_folder');
      if (this.noteFolderReferenceId) {
        const selected = references.filter((reference) => reference.referenceId === this.noteFolderReferenceId);
        if (selected.length !== 1) throw sourceError('source-recovery', 'The Note Folder Source Reference is missing or ambiguous.');
        const locator = this.metadata.getSourceLocator?.(selected[0].referenceId);
        this.root = locator?.locator ?? selected[0].externalSourceId;
        this.rootObservedRevision = locator?.observedRevision ?? null;
      } else {
        if (references.length !== 1) throw sourceError('source-recovery', 'Exactly one Note Folder Source Reference is required.');
        this.noteFolderReferenceId = references[0].referenceId;
        const locator = this.metadata.getSourceLocator?.(references[0].referenceId);
        this.root = locator?.locator ?? references[0].externalSourceId;
        this.rootObservedRevision = locator?.observedRevision ?? null;
      }
    }
    if (!this.root) throw sourceError('source-recovery', 'A Note Folder Source Reference is required.');
    const checked = await assertSafeDirectory(this.root);
    const before = await lstat(checked);
    if (this.metadata && this.noteFolderReferenceId && !this.rootObservedRevision) {
      this.rootObservedRevision = directoryRevision(before);
      this.metadata.setSourceLocator?.({ referenceId: this.noteFolderReferenceId, locator: checked, ownership: 'external', observedRevision: this.rootObservedRevision });
    }
    if (this.rootObservedRevision && directoryRevision(before) !== this.rootObservedRevision) {
      throw sourceError('source-recovery', 'The Note Folder filesystem identity no longer matches its Source Reference. Explicit recovery is required.');
    }
    if (!this.fsSafeRoot || this.fsSafeRoot.rootDir !== checked || (this.rootObservedRevision && !sameIdentity(this.rootStat, before))) {
      const factory = this.fsSafeRootFactory ?? (await import('openclaw/plugin-sdk/security-runtime')).root;
      const fsSafeRoot = await factory(checked);
      const rootDescriptor = openSync(checked, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const held = fstatSync(rootDescriptor);
      const named = await lstat(checked).catch(() => null);
      if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, held) || !sameIdentity(held, named)) {
        closeSync(rootDescriptor);
        throw sourceError('conflict', 'The Note Folder changed while its fs-safe root was bound.');
      }
      if (this.rootDescriptor !== undefined) closeSync(this.rootDescriptor);
      this.fsSafeRoot = fsSafeRoot;
      this.rootDescriptor = rootDescriptor;
      this.rootStat = held;
    }
    await this.afterRootResolved?.({ root: this.fsSafeRoot.rootReal });
    return this.fsSafeRoot.rootReal;
  }

  noteReference(root, relativePath, revision) {
    const externalSourceId = `${root}/${relativePath}`;
    const matches = this.metadata?.listSourceReferences?.(this.topicId)?.filter((reference) => reference.sourceSystem === 'obsidian' && reference.sourceKind === 'note' && reference.externalSourceId === externalSourceId) ?? [];
    if (matches.length > 1) throw sourceError('source-recovery', 'The Note Source Reference is ambiguous.');
    return createSourceReference({
      referenceId: matches[0]?.referenceId ?? `note:${randomUUID()}`,
      topicId: this.topicId,
      sourceSystem: 'obsidian',
      sourceKind: 'note',
      externalSourceId,
      observedRevision: revision
    });
  }

  descriptorPath(handle, name = '') {
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
    if (!descriptorRoot) throw sourceError('capability-unavailable', 'No descriptor-anchored Note filesystem capability is available.');
    return name ? path.join(descriptorRoot, String(handle.fd), name) : path.join(descriptorRoot, String(handle.fd));
  }

  async duplicateRootHandle() {
    if (this.rootDescriptor === undefined || !this.rootStat) throw sourceError('source-recovery', 'The Note Folder root is not bound.');
    const handle = await open(this.descriptorPath({ fd: this.rootDescriptor }), constants.O_RDONLY | constants.O_DIRECTORY);
    if (!sameIdentity(this.rootStat, await handle.stat())) {
      await handle.close();
      throw sourceError('conflict', 'The held Note Folder identity changed.');
    }
    return handle;
  }

  close() {
    if (this.rootDescriptor === undefined) return;
    closeSync(this.rootDescriptor);
    this.rootDescriptor = undefined;
    this.rootStat = undefined;
  }

  async openParent(root, relativePath, { create = false, operation = 'read' } = {}) {
    const normalized = normalizeNotePath(relativePath);
    const fsSafeResolved = await this.fsSafeRoot.resolve(normalized);
    if (!isWithin(root, fsSafeResolved)) throw sourceError('unsafe-path', 'The Note path escaped its fs-safe root.');
    const segments = normalized.split('/');
    const leaf = segments.pop();
    const rootStat = this.rootStat;
    let handle = await this.duplicateRootHandle();
    const chain = [{ namedPath: root, stat: rootStat }];
    let namedParent = root;
    try {
      for (const segment of segments) {
        const anchoredChild = this.descriptorPath(handle, segment);
        let childStat = await lstat(anchoredChild).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        let created = false;
        if (!childStat && create) {
          await this.beforeDirectoryComponentCreate?.({ operation, parentPath: namedParent, segment });
          childStat = await lstat(anchoredChild).catch((error) => {
            if (error?.code === 'ENOENT') return null;
            throw error;
          });
          if (!childStat) {
            await mkdir(anchoredChild, { mode: 0o700 });
            created = true;
            childStat = await lstat(anchoredChild);
          }
        }
        if (!childStat) throw sourceError('not-found', 'The Note parent directory was not found.');
        if (childStat.isSymbolicLink() || !childStat.isDirectory()) throw sourceError('unsafe-path', 'A Note parent component is not a real directory.');
        let childHandle;
        try {
          childHandle = await open(anchoredChild, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          if (!sameIdentity(childStat, await childHandle.stat())) throw sourceError('conflict', 'A Note parent component changed while it was opened.');
          const childNamedPath = path.join(namedParent, segment);
          const namedChild = await lstat(childNamedPath).catch(() => null);
          if (!sameIdentity(childStat, namedChild)) throw sourceError('conflict', 'The Note directory path changed during traversal.');
          chain.push({ namedPath: childNamedPath, stat: childStat });
          await handle.close();
          handle = childHandle;
          childHandle = null;
          namedParent = childNamedPath;
        } catch (error) {
          await childHandle?.close();
          if (created) await rmdir(anchoredChild).catch(() => {});
          throw error;
        }
      }
      return { handle, chain, leaf, relativePath: normalized, target: this.descriptorPath(handle, leaf) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async assertChainStable(chain) {
    for (const component of chain) {
      const current = await lstat(component.namedPath).catch(() => null);
      if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(component.stat, current)) {
        throw sourceError('conflict', 'A Note path component changed during filesystem access.');
      }
    }
  }

  async readState(root, relativePath, operation = 'read') {
    await assertSafeNotePath(root, relativePath);
    const parent = await this.openParent(root, relativePath, { operation });
    let file;
    try {
      await this.beforePathIo?.({ operation, path: parent.relativePath });
      file = await open(parent.target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (!before.isFile()) throw sourceError('unsafe-path', 'A Note must be a regular file.');
      if (before.nlink !== 1 && !(await this.hasOnlyInternalAliases(parent, before))) throw sourceError('unsafe-path', 'Hard-linked Note aliases are not supported.');
      const bytes = await file.readFile();
      const after = await file.stat();
      const named = await lstat(parent.target);
      await this.assertChainStable(parent.chain);
      if (!sameStat(before, after) || !sameIdentity(after, named)) throw sourceError('conflict', 'The Note changed while it was being read.', { currentRevision: revisionForBytes(bytes), currentPath: parent.relativePath });
      return { bytes, stat: after, relativePath: parent.relativePath };
    } finally {
      await file?.close();
      await parent.handle.close();
    }
  }

  async hasOnlyInternalAliases(parent, expected) {
    const names = await readdir(this.descriptorPath(parent.handle));
    let links = 0;
    for (const name of names) {
      const stat = await lstat(this.descriptorPath(parent.handle, name)).catch(() => null);
      if (!sameIdentity(stat, expected)) continue;
      links += 1;
      if (name !== parent.leaf && !name.includes('.command-center-')) return false;
    }
    return links === expected.nlink;
  }

  async relocateInternalAliases(sourceParent, destinationParent, expected) {
    for (const name of await readdir(this.descriptorPath(sourceParent.handle))) {
      if (!name.includes('.command-center-')) continue;
      const candidate = this.descriptorPath(sourceParent.handle, name);
      const stat = await lstat(candidate).catch(() => null);
      if (!sameIdentity(stat, expected)) continue;
      const preserved = this.descriptorPath(destinationParent.handle, `.${destinationParent.leaf}.command-center-preserved-${randomUUID()}.tmp`);
      await rename(candidate, preserved);
    }
  }

  async read(input = {}) {
    const allowed = new Set(['schemaVersion', 'path', 'notePath', 'referenceId', 'observedRevision', 'observe', 'requestId']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw sourceError('invalid-request', `Note read contains unsupported field: ${key}`);
    const root = await this.resolveRoot();
    const state = await this.readState(root, input.path ?? input.notePath, 'read');
    if (input.referenceId !== undefined && input.referenceId !== this.noteFolderReferenceId) {
      const reference = this.metadata?.getSourceReference?.(input.referenceId);
      const expectedExternalId = `${root}/${state.relativePath}`;
      if (!reference || reference.topicId !== this.topicId || reference.sourceSystem !== 'obsidian' || reference.sourceKind !== 'note' || reference.externalSourceId !== expectedExternalId) {
        throw sourceError('source-recovery', 'The Note read does not match the exact Topic-owned Note Source Reference.');
      }
    }
    const revision = revisionForBytes(state.bytes);
    if (input.observedRevision !== undefined && input.observedRevision !== revision) throw sourceError('conflict', 'The authoritative Note changed after the search result was produced.');
    const candidateReference = this.noteReference(root, state.relativePath, revision);
    const sourceReference = input.observe === false ? candidateReference : await this.observe(candidateReference);
    return Object.freeze({
      schemaVersion: 1,
      path: state.relativePath,
      text: state.bytes.toString('utf8'),
      revision,
      sourceReference
    });
  }

  async browse(input = {}) {
    const root = await this.resolveRoot();
    const notes = [];
    const rootStat = this.rootStat;
    const rootHandle = await this.duplicateRootHandle();
    const visit = async (directoryHandle, relative = '', chain = [{ namedPath: root, stat: rootStat }]) => {
      const entries = await readdir(this.descriptorPath(directoryHandle), { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        await this.beforePathIo?.({ operation: 'browse', path: childRelative });
        const child = this.descriptorPath(directoryHandle, entry.name);
        const stat = await lstat(child);
        if (stat.isSymbolicLink()) throw sourceError('unsafe-path', 'Symlinked Note paths are not supported.');
        if (stat.isDirectory()) {
          const childHandle = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            if (!sameIdentity(stat, await childHandle.stat())) throw sourceError('conflict', 'A Note directory changed while it was opened.');
            const namedPath = path.join(root, ...childRelative.split('/'));
            const named = await lstat(namedPath).catch(() => null);
            if (!sameIdentity(stat, named)) throw sourceError('conflict', 'A Note directory path changed during browse.');
            await visit(childHandle, childRelative, [...chain, { namedPath, stat }]);
          } finally { await childHandle.close(); }
        }
        else if (stat.isFile() && /\.md$/iu.test(entry.name)) {
          const file = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes;
          try {
            const before = await file.stat();
            if (!sameIdentity(stat, before) || (before.nlink !== 1 && !(await this.hasOnlyInternalAliases({ handle: directoryHandle, leaf: entry.name }, before)))) throw sourceError('unsafe-path', 'Hard-linked or replaced Note aliases are not supported.');
            bytes = await file.readFile();
            const after = await file.stat();
            if (!sameStat(before, after)) throw sourceError('conflict', 'A Note changed during browse.');
          } finally { await file.close(); }
          await this.assertChainStable(chain);
          const revision = revisionForBytes(bytes);
          const candidateReference = this.noteReference(root, childRelative, revision);
          const sourceReference = input.observe === false ? candidateReference : await this.observe(candidateReference);
          notes.push(Object.freeze({
            schemaVersion: 1,
            path: childRelative,
            revision,
            sourceReference,
            ...(input.includeText === true ? { text: bytes.toString('utf8') } : {})
          }));
        } else if (!stat.isFile()) {
          throw sourceError('unsafe-path', 'The Note Folder contains a non-regular entry.');
        }
      }
    };
    try {
      await visit(rootHandle);
      await this.assertChainStable([{ namedPath: root, stat: rootStat }]);
    } finally { await rootHandle.close(); }
    return Object.freeze(notes);
  }

  async create(input = {}) {
    const notePath = normalizeNotePath(input.path ?? input.notePath);
    const bytes = bytesForText(input.text ?? input.content);
    const root = await this.resolveRoot();
    await assertSafeNotePath(root, notePath, { allowMissing: true });
    const existing = await this.read({ path: notePath }).catch((error) => {
      if (error?.code === 'not-found' || error?.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      const current = existing;
      if (current.revision === revisionForBytes(bytes)) {
        await this.observe(current.sourceReference);
        return mutationResult('reconciled', current, { logicalOperationId: input.logicalOperationId ?? null });
      }
      throw sourceError('conflict', 'The destination Note already exists.', { currentRevision: current.revision, currentPath: notePath });
    }
    const parent = await this.openParent(root, notePath, { create: true, operation: 'create' });
    const temporary = this.descriptorPath(parent.handle, `.${parent.leaf}.command-center-${randomUUID()}.tmp`);
    let publishedIdentity = null;
    try {
      await this.beforePathIo?.({ operation: 'create', path: notePath });
      await this.assertChainStable(parent.chain);
      if (await lstat(parent.target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) throw await this.pathConflict(parent.target, notePath, 'The destination Note already exists.');
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await this.beforeAtomicCommit?.({ operation: 'create', path: notePath });
      await this.assertChainStable(parent.chain);
      const temporaryStat = await lstat(temporary);
      try {
        await link(temporary, parent.target);
        publishedIdentity = temporaryStat;
      } catch (error) {
        if (error?.code === 'EEXIST') throw await this.pathConflict(parent.target, notePath, 'The destination Note appeared before commit.');
        throw error;
      }
      await this.assertChainStable(parent.chain);
      // Keep the staging name as a hard-linked recovery candidate. Node has no
      // conditional unlink primitive, so pathname cleanup cannot safely prove
      // that an already-open descriptor was not modified after validation.
      const revision = revisionForBytes(bytes);
      const note = { schemaVersion: 1, path: notePath, text: bytes.toString('utf8'), revision, sourceReference: this.noteReference(root, notePath, revision) };
      note.sourceReference = await this.observe(note.sourceReference);
      return mutationResult('applied', note, { logicalOperationId: input.logicalOperationId ?? null });
    } catch (error) {
      if (publishedIdentity) await this.unlinkIfIdentity(parent.target, publishedIdentity);
      // Unproven staging candidates are intentionally preserved.
      throw error;
    } finally {
      await parent.handle.close();
    }
  }

  async edit(input = {}) {
    const notePath = normalizeNotePath(input.path ?? input.notePath);
    const expectedRevision = nonBlank(input.expectedRevision, 'expectedRevision');
    const bytes = bytesForText(input.text ?? input.content);
    const root = await this.resolveRoot();
    const before = await this.read({ path: notePath, ...(input.referenceId === undefined ? {} : { referenceId: input.referenceId }) });
    const desiredRevision = revisionForBytes(bytes);
    if (before.revision === desiredRevision && before.revision !== expectedRevision) {
      await this.observe(before.sourceReference);
      return mutationResult('reconciled', before, { logicalOperationId: input.logicalOperationId ?? null });
    }
    if (before.revision !== expectedRevision) throw sourceError('conflict', 'The Note revision is stale.', { currentRevision: before.revision, currentPath: notePath, expectedRevision });
    await this.beforeCommit?.({ operation: 'edit', path: notePath, expectedRevision });
    const latest = await this.read({ path: notePath, ...(input.referenceId === undefined ? {} : { referenceId: input.referenceId }) });
    if (latest.revision !== expectedRevision) throw sourceError('conflict', 'The Note changed before commit.', { currentRevision: latest.revision, currentPath: notePath, expectedRevision });
    await this.atomicReplace(root, notePath, bytes, expectedRevision);
    const note = { schemaVersion: 1, path: notePath, text: bytes.toString('utf8'), revision: desiredRevision, sourceReference: { ...latest.sourceReference, observedRevision: desiredRevision } };
    note.sourceReference = await this.observe(note.sourceReference);
    return mutationResult('applied', note, { logicalOperationId: input.logicalOperationId ?? null });
  }

  async rename(input = {}) {
    return this.move({ ...input, destinationPath: input.destinationPath ?? input.newPath }, 'rename');
  }

  async move(input = {}, operation = 'move') {
    const sourcePath = normalizeNotePath(input.path ?? input.sourcePath);
    const destinationPath = normalizeNotePath(input.destinationPath ?? input.newPath);
    const expectedRevision = nonBlank(input.expectedRevision, 'expectedRevision');
    if (sourcePath === destinationPath) throw sourceError('invalid-path', 'A Note cannot be moved onto itself.');
    if (input.destinationTopicId !== undefined && input.destinationTopicId !== this.topicId) throw sourceError('cross-topic', 'Notes cannot move across Topics.');
    const root = await this.resolveRoot();
    const current = await this.read({ path: sourcePath, ...(input.referenceId === undefined ? {} : { referenceId: input.referenceId }) });
    if (current.revision !== expectedRevision) throw sourceError('conflict', 'The Note revision is stale.', { currentRevision: current.revision, currentPath: sourcePath, expectedRevision });
    await assertSafeNotePath(root, destinationPath, { allowMissing: true });
    const destinationExisting = await this.read({ path: destinationPath }).catch((error) => (error?.code === 'not-found' || error?.code === 'ENOENT') ? null : Promise.reject(error));
    if (destinationExisting) throw sourceError('conflict', 'The destination Note already exists.', { currentRevision: destinationExisting.revision, currentPath: destinationPath });
    await this.beforeCommit?.({ operation: 'move', path: sourcePath, destinationPath, expectedRevision });
    const latest = await this.read({ path: sourcePath, ...(input.referenceId === undefined ? {} : { referenceId: input.referenceId }) });
    if (latest.revision !== expectedRevision) throw sourceError('conflict', 'The Note changed before commit.', { currentRevision: latest.revision, currentPath: sourcePath, expectedRevision });
    const sourceParent = await this.openParent(root, sourcePath, { operation });
    let destinationParent;
    try {
      destinationParent = await this.openParent(root, destinationPath, { create: true, operation });
    } catch (error) {
      await sourceParent.handle.close();
      throw error;
    }
    const claim = this.descriptorPath(sourceParent.handle, `.${sourceParent.leaf}.command-center-claim-${randomUUID()}.tmp`);
    let claimed = false;
    let destinationLinked = false;
    let claimStat;
    try {
      await this.beforePathIo?.({ operation, path: sourcePath, destinationPath });
      await this.assertChainStable(sourceParent.chain);
      await this.assertChainStable(destinationParent.chain);
      await this.beforeAtomicCommit?.({ operation: 'move', path: sourcePath, destinationPath, expectedRevision });
      await rename(sourceParent.target, claim);
      claimed = true;
      claimStat = await lstat(claim);
      if (claimStat.nlink !== 1 && !(await this.hasOnlyInternalAliases(sourceParent, claimStat))) throw sourceError('unsafe-path', 'Hard-linked Note aliases are not supported.');
      const claimBytes = await this.readAnchoredFile(claim);
      if (revisionForBytes(claimBytes) !== expectedRevision) {
        claimed = !(await this.restoreClaim(claim, sourceParent.target));
        throw sourceError('conflict', 'The Note changed at the move commit boundary.', { currentRevision: revisionForBytes(claimBytes), currentPath: sourcePath, expectedRevision });
      }
      await this.afterSourceClaim?.({ operation: 'move', path: sourcePath, destinationPath, expectedRevision });
      await this.assertChainStable(sourceParent.chain);
      await this.assertChainStable(destinationParent.chain);
      try {
        await link(claim, destinationParent.target);
        destinationLinked = true;
      } catch (error) {
        if (error?.code === 'EEXIST') throw await this.pathConflict(destinationParent.target, destinationPath, 'The destination Note appeared before commit.');
        throw error;
      }
      await this.afterAtomicPublish?.({ operation: 'move', path: sourcePath, destinationPath, expectedRevision });
      const destinationStat = await lstat(destinationParent.target);
      if (!sameIdentity(claimStat, destinationStat)) throw sourceError('conflict', 'The destination Note identity changed during move.', { currentPath: destinationPath, expectedRevision });
      await this.assertChainStable(sourceParent.chain);
      await this.assertChainStable(destinationParent.chain);
      const finalClaimStat = await lstat(claim);
      const finalClaimBytes = await this.readAnchoredFile(claim);
      if (!sameIdentity(claimStat, finalClaimStat) || claimStat.size !== finalClaimStat.size || revisionForBytes(finalClaimBytes) !== expectedRevision) {
        throw sourceError('conflict', 'The Note changed after destination publication.', { currentRevision: revisionForBytes(finalClaimBytes), currentPath: sourcePath, expectedRevision });
      }
      await this.relocateInternalAliases(sourceParent, destinationParent, claimStat);
      claimed = false;
    } catch (error) {
      if (destinationLinked) await this.unlinkIfIdentity(destinationParent.target, claimStat);
      if (claimed) await this.restoreClaim(claim, sourceParent.target);
      throw error;
    } finally {
      await sourceParent.handle.close();
      await destinationParent.handle.close();
    }
    const note = { schemaVersion: 1, path: destinationPath, text: current.text, revision: current.revision, sourceReference: this.noteReference(root, destinationPath, current.revision) };
    note.sourceReference = await this.observe(note.sourceReference);
    return mutationResult('applied', note, { previousPath: sourcePath, logicalOperationId: input.logicalOperationId ?? null });
  }

  async atomicReplace(root, relativePath, bytes, expectedRevision) {
    const parent = await this.openParent(root, relativePath, { operation: 'edit' });
    const temporary = this.descriptorPath(parent.handle, `.${parent.leaf}.command-center-${randomUUID()}.tmp`);
    const claim = this.descriptorPath(parent.handle, `.${parent.leaf}.command-center-claim-${randomUUID()}.tmp`);
    let claimed = false;
    let published = false;
    let claimStat;
    let temporaryStat;
    try {
      await this.beforePathIo?.({ operation: 'edit', path: relativePath });
      await this.assertChainStable(parent.chain);
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      temporaryStat = await lstat(temporary);
      await this.beforeAtomicCommit?.({ operation: 'edit', path: relativePath, expectedRevision });
      await this.assertChainStable(parent.chain);
      await rename(parent.target, claim);
      claimed = true;
      claimStat = await lstat(claim);
      if (claimStat.nlink !== 1 && !(await this.hasOnlyInternalAliases(parent, claimStat))) throw sourceError('unsafe-path', 'Hard-linked Note aliases are not supported.');
      const claimBytes = await this.readAnchoredFile(claim);
      const currentRevision = revisionForBytes(claimBytes);
      if (currentRevision !== expectedRevision) {
        claimed = !(await this.restoreClaim(claim, parent.target));
        throw sourceError('conflict', 'The Note changed at the edit commit boundary.', { currentRevision, currentPath: relativePath, expectedRevision });
      }
      await this.afterSourceClaim?.({ operation: 'edit', path: relativePath, expectedRevision });
      await this.assertChainStable(parent.chain);
      try {
        await link(temporary, parent.target);
        published = true;
      } catch (error) {
        if (error?.code === 'EEXIST') throw await this.pathConflict(parent.target, relativePath, 'The Note path changed during atomic commit.');
        throw error;
      }
      await this.afterAtomicPublish?.({ operation: 'edit', path: relativePath, expectedRevision });
      const publishedStat = await lstat(parent.target);
      if (!sameIdentity(publishedStat, temporaryStat)) throw sourceError('conflict', 'The Note identity changed during atomic commit.', { currentPath: relativePath, expectedRevision });
      await this.assertChainStable(parent.chain);
      const finalClaimStat = await lstat(claim);
      const finalClaimBytes = await this.readAnchoredFile(claim);
      if (!sameStat(claimStat, finalClaimStat) || revisionForBytes(finalClaimBytes) !== expectedRevision) {
        throw sourceError('conflict', 'The claimed Note changed after replacement publication.', { currentRevision: revisionForBytes(finalClaimBytes), currentPath: relativePath, expectedRevision });
      }
      claimed = false;
    } catch (error) {
      if (published) await this.unlinkIfIdentity(parent.target, temporaryStat);
      if (claimed) await this.restoreClaim(claim, parent.target);
      // Preserve staging candidates whenever rollback ownership is uncertain.
      if (error instanceof SourceServiceError) throw error;
      throw error;
    } finally {
      await parent.handle.close();
    }
  }

  async readAnchoredFile(target) {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile(); } finally { await handle.close(); }
  }

  async restoreClaim(claim, target) {
    try {
      await link(claim, target);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    return true;
  }

  async unlinkIfIdentity(candidate, expected) {
    if (!expected) return false;
    const quarantine = `${candidate}.command-center-preserved-${randomUUID()}`;
    try { await rename(candidate, quarantine); } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    const quarantined = await lstat(quarantine).catch(() => null);
    if (sameIdentity(quarantined, expected)) return true;
    try { await rename(quarantine, candidate); } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      // Both names are authoritative candidates; preserve both for recovery.
    }
    return false;
  }

  async pathConflict(target, relativePath, message) {
    return sourceError('conflict', message, { currentRevision: revisionForBytes(await this.readAnchoredFile(target)), currentPath: relativePath });
  }

  async observe(reference, previousReference = null) {
    if (!this.metadata) return reference;
    const existing = this.metadata.getSourceReference?.(reference.referenceId);
    if (existing && this.metadata.observeSourceReference) return this.metadata.observeSourceReference({ referenceId: reference.referenceId, observedRevision: reference.observedRevision, updatedAt: this.now() });
    if (!existing && this.metadata.createSourceReference) return this.metadata.createSourceReference(reference);
    return reference;
  }
}

export function createNoteAdapter(options) {
  return new NoteAdapter(options);
}
