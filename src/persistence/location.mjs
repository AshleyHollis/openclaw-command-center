import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const persistenceDirectoryName = 'command-center';
export const databaseFileName = 'metadata.sqlite';

function unsafe(value) {
  return typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve the only Command Center-owned database location. The caller owns
 * resolving the OpenClaw state directory; this module deliberately never
 * consults process.cwd(), HOME, configuration files, or a live Gateway.
 */
export function resolveDatabaseLocation(stateDirectory) {
  if (unsafe(stateDirectory)) throw new Error('A resolved absolute state directory is required');
  const pluginDirectory = path.join(stateDirectory, 'plugins', persistenceDirectoryName);
  const databasePath = path.join(pluginDirectory, databaseFileName);
  if (!contained(stateDirectory, pluginDirectory) || !contained(stateDirectory, databasePath)) {
    throw new Error('Command Center database location escapes the state directory');
  }
  return Object.freeze({ stateDirectory, pluginDirectory, databasePath });
}

async function assertDirectory(directory, label) {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is missing or unsafe`);
}

async function createSafeChild(parent, name, label) {
  const child = path.join(parent, name);
  const existing = await lstat(child).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`${label} is missing or unsafe`);
    return child;
  }
  // Create one component at a time. Recursive mkdir would follow an existing
  // intermediate symlink before the final directory could be inspected.
  await mkdir(child);
  await assertDirectory(child, label);
  return child;
}

/** Create only the plugin-owned child directory below an existing state root. */
export async function prepareDatabaseLocation(stateDirectory) {
  const location = resolveDatabaseLocation(stateDirectory);
  await assertDirectory(location.stateDirectory, 'Resolved state directory');
  const pluginsDirectory = await createSafeChild(location.stateDirectory, 'plugins', 'OpenClaw plugins directory');
  const pluginDirectory = await createSafeChild(pluginsDirectory, persistenceDirectoryName, 'Command Center persistence directory');
  if (pluginDirectory !== location.pluginDirectory) throw new Error('Command Center database location escapes the state directory');
  const database = await lstat(location.databasePath).catch(() => undefined);
  if (database && (!database.isFile() || database.isSymbolicLink())) throw new Error('Command Center database file is unsafe');
  return location;
}
