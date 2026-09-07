import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSafeDirectory } from './note-path.mjs';
import { sourceError } from './errors.mjs';

const ownership = new AsyncLocalStorage();
const ownerKey = (metadata) => metadata?.databasePath ? path.resolve(metadata.databasePath) : null;

export function ownsNoteFilesystem(metadata) {
  const key = ownerKey(metadata);
  return !key || ownership.getStore()?.get(key)?.active === true;
}

// Enrollment, binding and Note effects share the existing contentless host lock.
// Keep ownership through metadata completion; process death releases SQLite's
// lease, while descendants of a released async scope must acquire it afresh.
export async function withNoteFilesystemOwner(metadata, action, { acquire } = {}) {
  if (ownsNoteFilesystem(metadata)) return action();
  const key = ownerKey(metadata);
  const directory = await assertSafeDirectory(path.dirname(key));
  const lockPath = path.join(directory, 'note-filesystem-coordinator.sqlite');
  acquire ??= (await import('openclaw/plugin-sdk/sqlite-runtime')).tryAcquireExclusiveSqliteCoordinator;
  if (typeof acquire !== 'function') throw sourceError('capability-unavailable', 'The host Note recovery coordinator is unavailable.');
  let lock;
  const started = Date.now();
  while (!lock) {
    const stat = await lstat(lockPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw sourceError('source-recovery', 'The Note coordinator path is unsafe.');
    lock = acquire(lockPath, { busyTimeoutMs: 0 });
    if (!lock) {
      if (Date.now() - started >= 30_000) throw sourceError('unavailable', 'Another Note operation still owns the filesystem coordinator.');
      await delay(20);
    }
  }
  const lease = { active: true };
  const context = new Map(ownership.getStore() ?? []); context.set(key, lease);
  try { return await ownership.run(context, action); }
  finally { lease.active = false; lock.release(); }
}
