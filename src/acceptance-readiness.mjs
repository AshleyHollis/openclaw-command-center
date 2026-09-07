import { DatabaseSync } from 'node:sqlite';
import { COMMAND_CENTER_SCHEMA_VERSION } from './metadata/schema.mjs';

/** Coalesce polling within one phase while retaining its first and last progress. */
export function recordStartupObservation(observations, value) {
  const previous = observations.at(-1);
  if (value.stage === 'migration' && previous?.stage === 'migration' &&
      ['status', 'phase', 'complete', 'failureCode'].every(key => previous[key] === value[key])) {
    observations[observations.length - 1] = Object.freeze({ ...value,
      startedAtMs: previous.startedAtMs, firstImportedCount: previous.firstImportedCount,
      samples: previous.samples + 1 });
  } else {
    observations.push(Object.freeze({ ...value, startedAtMs: value.elapsedMs,
      ...(value.stage === 'migration' ? { firstImportedCount: value.importedCount, samples: 1 } : {}) }));
    // Preserve the first observation and the latest transitions if a failing
    // store oscillates indefinitely. This evidence never admits migration.
    if (observations.length > 20) observations.splice(1, 1);
  }
}

/** Build the pinned Control UI route for one authenticated plugin tab. */
export function controlUiPluginUrl({ gatewayUrl, pluginId, routeId, fragmentParameter, credential }) {
  const url = new URL('/plugin', gatewayUrl);
  url.searchParams.set('plugin', pluginId);
  url.searchParams.set('id', routeId);
  url.hash = `${encodeURIComponent(fragmentParameter)}=${encodeURIComponent(credential)}`;
  return url.toString();
}

/** Match the exact authenticated Control UI parent route inherited by a srcdoc frame. */
export function isControlUiPluginUrl(value, { gatewayUrl, pluginId, routeId }) {
  try {
    const candidate = new URL(value);
    const gateway = new URL(gatewayUrl);
    return candidate.origin === gateway.origin &&
      candidate.pathname === '/plugin' &&
      candidate.hash === '' &&
      [...candidate.searchParams].length === 2 &&
      candidate.searchParams.get('plugin') === pluginId &&
      candidate.searchParams.get('id') === routeId;
  } catch {
    return false;
  }
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

/** True only after the retained existing-data migration published its durable completion. */
export function isCommandCenterMigrationReady(databasePath, Database = DatabaseSync) {
  let database;
  try {
    database = new Database(databasePath, { readOnly: true });
    if (database.prepare('PRAGMA user_version').get().user_version !== COMMAND_CENTER_SCHEMA_VERSION) return false;
    const completion = database.prepare('SELECT schema_version FROM migration_completion WHERE completion_id = ?').get('legacy-discord-v1');
    return completion?.schema_version === 1;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

/** Read-only, content-free startup diagnosis. This is not a readiness substitute. */
export function readCommandCenterMigrationProgress(databasePath, Database = DatabaseSync) {
  let database;
  try {
    database = new Database(databasePath, { readOnly: true });
    database.exec('BEGIN');
    const schemaVersion = database.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion !== COMMAND_CENTER_SCHEMA_VERSION) return Object.freeze({ status: 'schema-pending', schemaVersion });
    const state = database.prepare('SELECT phase, revision, failure_code FROM migration_state WHERE state_id = ?').get('legacy-discord-v1');
    const completion = database.prepare('SELECT schema_version FROM migration_completion WHERE completion_id = ?').get('legacy-discord-v1');
    const counts = database.prepare("SELECT COUNT(*) AS channelCount, COALESCE(SUM(CASE WHEN phase = 'complete' THEN 1 ELSE 0 END), 0) AS completedChannels, COALESCE(SUM(expected_count), 0) AS expectedCount, COALESCE(SUM(imported_count), 0) AS importedCount FROM migration_channels").get();
    return Object.freeze({ status: 'observed', phase: state?.phase ?? null, complete: completion?.schema_version === 1,
      revision: state?.revision ?? null, failureCode: state?.failure_code ?? null, ...counts });
  } catch {
    // Opening, schema creation and concurrent transactions may race startup.
    // Never publish exception text containing filesystem paths or source data.
    return Object.freeze({ status: 'unavailable' });
  } finally { database?.close(); }
}
