import path from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';

export const metadataDatabaseFileName = 'metadata.sqlite';
export const projectionDatabaseFileName = 'projections.sqlite';
export const projectionRootDirectoryName = 'projections';
export const recoveryMigrationId = 'command-center-metadata-v1-to-v2';
export const recoverySnapshotFileName = 'metadata.sqlite.snapshot';
export const recoveryManifestFileName = 'manifest.json';

/**
 * Resolve the one database owned by Command Center below OpenClaw's state
 * directory.  Keeping this function deliberately boring makes the ownership
 * boundary easy to test and prevents a guessed home-directory fallback.
 */
export function resolveCommandCenterDatabasePath(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    throw new TypeError('stateDir must be a non-empty string');
  }
  return path.join(stateDir, 'plugins', 'command-center', metadataDatabaseFileName);
}

export function resolveCommandCenterRecoveryMigrationPath(stateDir, migrationId = recoveryMigrationId) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') throw new TypeError('stateDir must be a non-empty string');
  if (typeof migrationId !== 'string' || migrationId.trim() === '' || migrationId.includes('/') || migrationId.includes('\\') || migrationId === '.' || migrationId === '..') {
    throw new TypeError('migrationId must be a safe relative identifier');
  }
  return path.join(stateDir, 'plugins', 'command-center', 'recovery', 'migrations', migrationId);
}

export function resolveCommandCenterProjectionDatabasePath(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') throw new TypeError('stateDir must be a non-empty string');
  return path.join(stateDir, 'plugins', 'command-center', projectionDatabaseFileName);
}

/**
 * Return the only disposable projection tree.  The chain is created beneath
 * the caller supplied state directory and each existing component is checked
 * so a link can never redirect generated content outside that tree.
 */
export function resolveCommandCenterProjectionRoot(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') throw new TypeError('stateDir must be a non-empty string');
  const root = path.resolve(stateDir);
  const parts = [root, path.join(root, 'plugins'), path.join(root, 'plugins', 'command-center'), path.join(root, 'plugins', 'command-center', projectionRootDirectoryName)];
  for (const part of parts) {
    mkdirSync(part, { recursive: true });
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('projection root must be an owned in-tree directory');
  }
  return parts.at(-1);
}

export const resolveCommandCenterProjectionPath = resolveCommandCenterProjectionDatabasePath;
export const resolveCommandCenterProjectionsPath = resolveCommandCenterProjectionDatabasePath;

export function resolveCommandCenterProjectionTemporaryPath(stateDir, generation) {
  if (typeof generation !== 'string' || !/^[0-9a-f-]{8,}$/u.test(generation)) throw new TypeError('generation must be a safe identifier');
  return path.join(stateDir, 'plugins', 'command-center', `.${projectionDatabaseFileName}.rebuilding-${generation}`);
}

export function resolveCommandCenterProjectionRollbackPath(stateDir, generation) {
  if (typeof generation !== 'string' || !/^[0-9a-f-]{8,}$/u.test(generation)) throw new TypeError('generation must be a safe identifier');
  return path.join(stateDir, 'plugins', 'command-center', `.${projectionDatabaseFileName}.rollback-${generation}`);
}
