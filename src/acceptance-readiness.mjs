import { DatabaseSync } from 'node:sqlite';
import { COMMAND_CENTER_SCHEMA_VERSION } from './metadata/schema.mjs';

/** Build the pinned Control UI route for one authenticated plugin tab. */
export function controlUiPluginUrl({ gatewayUrl, pluginId, routeId, fragmentParameter, credential }) {
  const url = new URL('/plugin', gatewayUrl);
  url.searchParams.set('plugin', pluginId);
  url.searchParams.set('id', routeId);
  url.hash = `${encodeURIComponent(fragmentParameter)}=${encodeURIComponent(credential)}`;
  return url.toString();
}

/**
 * Match the Control UI bootstrap response emitted by the pinned host.
 *
 * The controller probes the canonical internal path, while the browser uses
 * the root resource alias when the served document declares an empty resource
 * base. Keep the alias exact and same-origin so an unrelated response cannot
 * satisfy the authentication evidence.
 */
export function isControlUiBootstrapUrl(value, { gatewayUrl, bootstrapPath }) {
  try {
    const candidate = new URL(value);
    const gateway = new URL(gatewayUrl);
    const canonical = new URL(bootstrapPath, gateway);
    const rootAlias = `/${canonical.pathname.split('/').filter(Boolean).at(-1)}`;
    return candidate.origin === gateway.origin &&
      (candidate.pathname === canonical.pathname || candidate.pathname === rootAlias);
  } catch {
    return false;
  }
}

/** True only after the plugin service has opened its current durable store. */
export function isCommandCenterMetadataReady(databasePath, Database = DatabaseSync) {
  let database;
  try {
    database = new Database(databasePath, { readOnly: true });
    return database.prepare('PRAGMA user_version').get().user_version === COMMAND_CENTER_SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
