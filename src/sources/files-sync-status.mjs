import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { FILES_SYNC_STATUS_NAME } from './note-path.mjs';
import { withVerifiedNoteFolderIdentity } from './note-folder-identity.mjs';
import { sameTransientFilesystemIdentity } from './filesystem-object-identity.mjs';

const MAX_STATUS_BYTES = 512;
const STATUS_FRESHNESS_MS = 90 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const states = new Set(['paused', 'waiting', 'running', 'succeeded', 'failed']);
const unavailable = Object.freeze({ schemaVersion: 1, state: 'unknown', lastSuccessAt: null, updatedAt: null });

function utcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const canonical = new Date(time).toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19) ? canonical : undefined;
}

export function validateFilesSyncStatus(value, { allowUnknown = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      Object.keys(value).sort().join(',') !== 'lastSuccessAt,schemaVersion,state,updatedAt') return undefined;
  const unknown = allowUnknown && value.state === 'unknown';
  if (!unknown && !states.has(value.state)) return undefined;
  const updatedAt = unknown && value.updatedAt === null ? null : utcTimestamp(value.updatedAt);
  const lastSuccessAt = value.lastSuccessAt === null ? null : utcTimestamp(value.lastSuccessAt);
  if (updatedAt === undefined || lastSuccessAt === undefined ||
      lastSuccessAt !== null && (updatedAt === null || lastSuccessAt > updatedAt)) return undefined;
  return { schemaVersion: 1, state: value.state, lastSuccessAt, updatedAt };
}

function sameSnapshot(left, right) {
  return sameTransientFilesystemIdentity(left, right) && left.mode === right.mode && left.uid === right.uid &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readStatusFile(statusPath) {
  let handle;
  try {
    handle = await open(statusPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n || stat.nlink !== 1n || stat.size > BigInt(MAX_STATUS_BYTES)) return unavailable;
    const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(statusPath, { bigint: true });
    if (bytesRead !== Number(stat.size) || !sameSnapshot(stat, after) || !sameSnapshot(after, named)) return unavailable;
    return validateFilesSyncStatus(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))) ?? unavailable;
  } catch (error) {
    return !handle && error?.code === 'ENOENT' ? undefined : unavailable;
  } finally {
    await handle?.close();
  }
}

export async function readFilesSyncStatus(binding, now = Date.now()) {
  // The folder witness owns the directory descriptor and rechecks the exact
  // enrolled identity before a status can leave the read.
  return withVerifiedNoteFolderIdentity(binding.locator, binding.observedRevision, async folder => {
    const status = await readStatusFile(path.join(folder.directoryPath, FILES_SYNC_STATUS_NAME));
    folder.assertCurrent();
    if (!status || status.state === 'unknown') return status;
    const age = now - Date.parse(status.updatedAt);
    if (age < -CLOCK_SKEW_MS) return unavailable;
    if (status.state !== 'paused' && age > STATUS_FRESHNESS_MS) return { ...status, state: 'unknown' };
    return status;
  }).catch(() => undefined);
}
