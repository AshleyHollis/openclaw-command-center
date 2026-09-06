import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCommandCenterProjectionRoot } from '../metadata/path.mjs';
import { sourceError } from '../sources/errors.mjs';

const markerName = '.topic-search.invalidated.json';
// Prepared corpora are process-local. Fence every attempt, including a failed
// marker write whose durable denial falls back to metadata bookkeeping.
const invalidationAttempts = new Map();

function markerPath(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') return null;
  return path.join(resolveCommandCenterProjectionRoot(stateDir), markerName);
}

export function hasTopicSearchInvalidationMarker(stateDir) {
  const target = markerPath(stateDir);
  return target ? existsSync(target) : false;
}

function oversizedCommitDigest(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw sourceError('projection-unavailable', 'Search commit evidence is not a regular file.');
    const digest = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024);
    let remaining = before.size;
    while (remaining > 0n) {
      const bytes = readSync(descriptor, chunk, 0, Number(remaining < BigInt(chunk.length) ? remaining : BigInt(chunk.length)), null);
      if (bytes === 0) throw sourceError('conflict', 'Search commit evidence changed during fingerprinting.');
      digest.update(chunk.subarray(0, bytes)); remaining -= BigInt(bytes);
    }
    const after = fstatSync(descriptor, { bigint: true }); const named = lstatSync(file, { bigint: true });
    if (!named.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((field) => before[field] !== after[field] || after[field] !== named[field])) throw sourceError('conflict', 'Search commit evidence changed during fingerprinting.');
    return digest.digest('hex');
  } finally { closeSync(descriptor); }
}

// Existing marker + committed generation IDs form a durable publication fence.
// Including both prevents absence -> invalidation -> rebuilt absence from ABA.
export function readTopicSearchFreshness(stateDir) {
  const target = markerPath(stateDir);
  if (!target) return null;
  const read = (file, { disposableCommit = false } = {}) => {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw sourceError('projection-unavailable', 'Search freshness evidence is unsafe.');
      if (stat.size > 64 * 1024) {
        if (!disposableCommit) throw sourceError('projection-unavailable', 'Search freshness evidence is unsafe.');
        return { digest: oversizedCommitDigest(file) };
      }
      return readFileSync(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const generation = (name) => {
    const contents = read(path.join(path.dirname(target), name), { disposableCommit: true });
    if (contents === null) return null;
    if (typeof contents !== 'string') return `corrupt:${contents.digest}`;
    let commit;
    try { commit = JSON.parse(contents); } catch { /* A disposable corrupt record still has an exact replacement fence. */ }
    return commit?.schemaVersion === 1 && typeof commit.generation === 'string' && commit.generation && commit.generation.length <= 128
      ? commit.generation : `corrupt:${createHash('sha256').update(contents).digest('hex')}`;
  };
  const marker = read(target);
  return Object.freeze({ invalidation: marker === null ? null : createHash('sha256').update(marker).digest('hex'), attempt: invalidationAttempts.get(target) ?? null, projections: Object.freeze([generation('topic-search-notes.commit.json'), generation('topic-search-conversations.commit.json')]) });
}

export function assertTopicSearchFreshness(stateDir, expected) {
  if (JSON.stringify(readTopicSearchFreshness(stateDir)) !== JSON.stringify(expected)) throw sourceError('conflict', 'Topic Search sources changed after snapshot preparation. Prepare a fresh snapshot.');
}

export function markTopicSearchInvalidated(stateDir) {
  const target = markerPath(stateDir);
  if (!target) return false;
  invalidationAttempts.set(target, randomUUID());
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, state: 'invalidated', generation: randomUUID() })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
  return true;
}

export function clearTopicSearchInvalidationMarker(stateDir) {
  const target = markerPath(stateDir);
  if (!target) return false;
  try { unlinkSync(target); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
