import { constants, fstatSync, lstatSync, readSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertSafeDirectory } from './note-path.mjs';
import { sourceError } from './errors.mjs';

export const NOTE_FOLDER_IDENTITY_FILE = '.command-center-folder-identity';
const physicalIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const sameIdentity = (left, right) => left && right && physicalIdentity(left) === physicalIdentity(right);
const directoryIdentity = stat => createHash('sha256').update(physicalIdentity(stat)).digest('hex');

// The marker is a logical identity, not an uncopyable credential. Its physical
// identity and the directory identity are also bound in metadata; Note recovery
// separately requires the exact locator generation and operation/file proofs.
async function folderIdentity(root, enroll, bootstrap) {
  let directory; let marker;
  try {
    const canonical = await assertSafeDirectory(root);
    const before = await lstat(canonical, { bigint: true });
    directory = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const held = await directory.stat({ bigint: true });
    if (!sameIdentity(before, held)) throw sourceError('source-recovery', 'The Note Folder identity changed while opening it.');
    if (bootstrap && directoryIdentity(held) !== bootstrap.expectedDirectoryIdentity) throw sourceError('source-recovery', 'The approved Note Folder was replaced before enrollment.');
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
    if (!descriptorRoot) throw sourceError('capability-unavailable', 'Descriptor-anchored Note Folder identity is unavailable.');
    const target = path.join(descriptorRoot, String(directory.fd), NOTE_FOLDER_IDENTITY_FILE);
    if (enroll) {
      const existing = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!existing) {
        // Exact fork runtime contract: the host owns native staging and its patched
        // dependency. Never toggle global native mode or publish unfinished bytes.
        const { stageDurableFileInDirectory } = await import('openclaw/plugin-sdk/file-access-runtime');
        if (typeof stageDurableFileInDirectory !== 'function') throw sourceError('capability-unavailable', 'The host durable folder enrollment contract is unavailable.');
        let staged;
        try {
          bootstrap?.assertCurrent();
          staged = await stageDurableFileInDirectory({
            directory: { path: canonical, realPath: canonical, identity: { dev: held.dev, ino: held.ino } },
            content: `${JSON.stringify({ version: 1, id: bootstrap?.markerId ?? randomUUID() })}\n`, mode: 0o600
          });
          bootstrap?.assertCurrent();
          if (!sameIdentity(held, lstatSync(canonical, { bigint: true })) || !sameIdentity(held, fstatSync(directory.fd, { bigint: true }))) throw sourceError('source-recovery', 'The approved Note Folder changed before marker publication.');
          // The host's retained-directory publish performs its commit without an
          // await, so this authority fence also guards the point of effect.
          await staged.publish(NOTE_FOLDER_IDENTITY_FILE, { overwrite: false });
        } catch (error) {
          if (!(error.code === 'already-exists' && error.details?.phase === 'publish' && error.details?.publication?.status === 'not-published')) throw error;
        } finally {
          const cleanup = await staged?.cleanup();
          if (cleanup?.status === 'preserved') throw sourceError('source-recovery', 'Folder enrollment retained an uncertain staging entry.');
        }
      }
    }
    marker = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const first = await marker.stat({ bigint: true });
    if (!first.isFile() || first.nlink !== 1n || first.size > 128n) throw sourceError('source-recovery', 'The reserved Note Folder identity marker is unsafe.');
    const buffer = Buffer.alloc(129);
    const { bytesRead } = await marker.read(buffer, 0, buffer.length, 0);
    const last = await marker.stat({ bigint: true });
    const named = await lstat(target, { bigint: true });
    if (bytesRead !== Number(first.size) || !sameIdentity(first, last) || !sameIdentity(last, named) || first.size !== last.size || first.mtimeNs !== last.mtimeNs || first.ctimeNs !== last.ctimeNs || last.size !== named.size || last.mtimeNs !== named.mtimeNs || last.ctimeNs !== named.ctimeNs || last.nlink !== 1n || named.nlink !== 1n) throw sourceError('source-recovery', 'The Note Folder identity marker changed during verification.');
    let value;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { /* rejected below */ }
    if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'id,version' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)) throw sourceError('source-recovery', 'The reserved Note Folder identity marker is invalid.');
    if (bootstrap && bootstrap.expectedIdentity === null && value.id !== bootstrap.markerId) throw sourceError('source-recovery', 'Another operation owns this folder enrollment marker.');
    if (!sameIdentity(held, await lstat(canonical, { bigint: true }))) throw sourceError('source-recovery', 'The Note Folder identity changed during verification.');
    const physical = createHash('sha256').update(`${physicalIdentity(held)}:${physicalIdentity(last)}`).digest('hex');
    const identity = `note-folder:1:${value.id}:${physical}`;
    if (bootstrap && bootstrap.expectedIdentity !== null && identity !== bootstrap.expectedIdentity) throw sourceError('source-recovery', 'The bound Note Folder identity changed.');
    const assertCurrent = () => {
      bootstrap?.assertCurrent();
      try {
        const current = fstatSync(marker.fd, { bigint: true });
        const namedMarker = lstatSync(target, { bigint: true });
        const copy = Buffer.alloc(129);
        const read = readSync(marker.fd, copy, 0, copy.length, 0);
        if (!sameIdentity(held, lstatSync(canonical, { bigint: true })) || !sameIdentity(held, fstatSync(directory.fd, { bigint: true })) ||
          !sameIdentity(last, current) || !sameIdentity(current, namedMarker) || current.size !== last.size || current.mtimeNs !== last.mtimeNs ||
          current.ctimeNs !== last.ctimeNs || namedMarker.size !== last.size || namedMarker.mtimeNs !== last.mtimeNs || namedMarker.ctimeNs !== last.ctimeNs ||
          current.nlink !== 1n || namedMarker.nlink !== 1n || read !== bytesRead || !copy.subarray(0, read).equals(buffer.subarray(0, bytesRead))) throw new Error('changed');
      } catch { throw sourceError('source-recovery', 'The held Note Folder witness changed before completion.'); }
    };
    // A prior process may have died after rename but before sync. Sync the held
    // descriptors, then revalidate the SAME pre-sync snapshot, not newer bytes.
    if (enroll) { await marker.sync(); await directory.sync(); }
    assertCurrent();
    if (!bootstrap) return identity;
    return await bootstrap.run(Object.freeze({ identity, assertCurrent }));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw sourceError('source-recovery', 'The Note Folder identity marker is missing or unsafe; explicit Source Recovery is required.');
    throw error;
  } finally { await marker?.close(); await directory?.close(); }
}

export function readNoteFolderIdentity(root) { return folderIdentity(root, false); }
// Only explicit creation, adoption and authorized Source Recovery call this.
export function enrollNoteFolderIdentity(root) { return folderIdentity(root, true); }

// Read-only preflight for an explicitly approved adoption, not automatic binding.
export async function inspectNoteFolderCandidate(root) {
  const canonical = await assertSafeDirectory(root);
  const before = await lstat(canonical, { bigint: true });
  const named = await lstat(path.join(canonical, NOTE_FOLDER_IDENTITY_FILE)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const markerIdentity = named ? await readNoteFolderIdentity(canonical) : null;
  if (!sameIdentity(before, await lstat(canonical, { bigint: true }))) throw sourceError('source-recovery', 'The Note Folder changed during adoption preflight.');
  return Object.freeze({ path: canonical, directoryIdentity: directoryIdentity(before), markerIdentity });
}

export function withBootstrapNoteFolder(root, options, run) {
  const { expectedDirectoryIdentity, expectedIdentity, markerId, assertCurrent } = options;
  if (!/^[a-f0-9]{64}$/.test(expectedDirectoryIdentity) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(markerId) ||
    !(expectedIdentity === null || typeof expectedIdentity === 'string') || typeof assertCurrent !== 'function' || typeof run !== 'function') throw sourceError('invalid-request', 'An exact approved bootstrap folder witness is required.');
  return folderIdentity(root, expectedIdentity === null, { expectedDirectoryIdentity, expectedIdentity, markerId,
    assertCurrent: () => { if (assertCurrent()?.then) throw sourceError('unauthenticated', 'Bootstrap authority must be synchronous.'); }, run });
}
