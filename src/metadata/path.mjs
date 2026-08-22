import path from 'node:path';

export const metadataDatabaseFileName = 'metadata.sqlite';
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
