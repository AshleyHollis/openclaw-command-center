import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setHostDurableFolderStager } from '../../src/sources/note-folder-identity.mjs';
import { setHostNoteFilesystemCoordinator } from '../../src/sources/note-filesystem-owner.mjs';

// A deliberately small host-contract double. It stages within the supplied
// directory and publishes with link(), matching the only semantics these
// source-owner tests require without borrowing a plugin-tree SDK fallback.
export function createHostFileAccessFixture() {
  const held = new Set();
  const stageDurableFileInDirectory = async ({ directory, content, mode }) => {
    const staged = path.join(directory.realPath, `.fixture-stage-${randomUUID()}`);
    const stagedDescriptor = fs.openSync(staged, 'wx', mode);
    try {
      fs.writeSync(stagedDescriptor, content);
      fs.fsyncSync(stagedDescriptor);
    } finally { fs.closeSync(stagedDescriptor); }
    return Object.freeze({
      async publish(name, { overwrite = false } = {}) {
        if (overwrite) throw new Error('The fixture does not permit overwrite publication.');
        await link(staged, path.join(directory.realPath, name));
        const heldDirectory = fs.openSync(directory.realPath, 'r');
        try { fs.fsyncSync(heldDirectory); }
        catch (error) { throw Object.assign(new Error('The fixture could not make the publication durable.'), { code: 'helper-failed', cause: error }); }
        finally { fs.closeSync(heldDirectory); }
      },
      async cleanup() {
        await unlink(staged).catch(error => { if (error?.code !== 'ENOENT') throw error; });
        return Object.freeze({ status: 'removed' });
      }
    });
  };
  const tryAcquireExclusiveSqliteCoordinator = lockPath => {
    if (held.has(lockPath)) return null;
    held.add(lockPath);
    return Object.freeze({ release: () => { held.delete(lockPath); } });
  };
  return Object.freeze({ stageDurableFileInDirectory, tryAcquireExclusiveSqliteCoordinator });
}

export function installHostFileAccessFixture() {
  const fileAccess = createHostFileAccessFixture();
  const releaseStager = setHostDurableFolderStager(fileAccess.stageDurableFileInDirectory);
  const releaseCoordinator = setHostNoteFilesystemCoordinator(fileAccess.tryAcquireExclusiveSqliteCoordinator);
  return () => { releaseCoordinator(); releaseStager(); };
}
