import path from 'node:path';

export const metadataDatabaseFileName = 'metadata.sqlite';

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
