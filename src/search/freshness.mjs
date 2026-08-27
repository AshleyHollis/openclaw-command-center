import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCommandCenterProjectionRoot } from '../metadata/path.mjs';

const markerName = '.topic-search.invalidated.json';

function markerPath(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') return null;
  return path.join(resolveCommandCenterProjectionRoot(stateDir), markerName);
}

export function hasTopicSearchInvalidationMarker(stateDir) {
  const target = markerPath(stateDir);
  return target ? existsSync(target) : false;
}

export function markTopicSearchInvalidated(stateDir) {
  const target = markerPath(stateDir);
  if (!target) return false;
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, state: 'invalidated' })}\n`, { mode: 0o600, flag: 'wx' });
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
