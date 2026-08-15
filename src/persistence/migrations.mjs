import { createHash } from 'node:crypto';
import { requireVerifiedSnapshot } from './archive-bridge.mjs';
import { initialSchemaStatements, PLUGIN_BUILD, SCHEMA_VERSION } from './schema.mjs';

export class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function migrationChecksum(migration) {
  return digest({
    version: migration.version,
    id: migration.id,
    destructive: migration.destructive === true,
    compatiblePluginBuild: migration.compatiblePluginBuild,
    statements: migration.statements
  });
}

function freezeMigration(value) {
  const migration = {
    ...value,
    destructive: value.destructive === true,
    statements: Object.freeze([...value.statements])
  };
  return Object.freeze({ ...migration, checksum: value.checksum || migrationChecksum(migration) });
}

export const migrationCatalog = Object.freeze([
  freezeMigration({
    version: SCHEMA_VERSION,
    id: 'command-center-metadata-initial-v1',
    destructive: false,
    compatiblePluginBuild: PLUGIN_BUILD,
    statements: initialSchemaStatements
  })
]);

export function verifyMigrationCatalog(catalog = migrationCatalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) throw new MigrationError('MIGRATION_CATALOG_INVALID', 'Migration catalog must contain an initial migration');
  const ids = new Set();
  let expectedVersion = 1;
  for (const migration of catalog) {
    if (!migration || migration.version !== expectedVersion || typeof migration.id !== 'string' || ids.has(migration.id) ||
      !Array.isArray(migration.statements) || typeof migration.compatiblePluginBuild !== 'string' || migrationChecksum(migration) !== migration.checksum) {
      throw new MigrationError('MIGRATION_CATALOG_INVALID', 'Migration catalog ordering or checksum is invalid');
    }
    ids.add(migration.id);
    expectedVersion += 1;
  }
  return catalog;
}

export function catalogHead(catalog = migrationCatalog) {
  verifyMigrationCatalog(catalog);
  return catalog.at(-1).version;
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function readMigrationState(database) {
  const schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
  const ledgerExists = tableExists(database, 'migration_ledger');
  const ledger = ledgerExists
    ? database.prepare('SELECT version, migration_id, checksum, destructive, compatible_plugin_build FROM migration_ledger ORDER BY version').all()
    : [];
  return { schemaVersion, ledgerExists, ledger };
}

function ledgerDigest(ledger) {
  return digest(ledger.map(({ version, migration_id, checksum, destructive, compatible_plugin_build }) => ({ version, migration_id, checksum, destructive, compatible_plugin_build })));
}

export function validateMigrationLedger(database, { catalog = migrationCatalog, pluginBuild = PLUGIN_BUILD } = {}) {
  verifyMigrationCatalog(catalog);
  const state = readMigrationState(database);
  const head = catalogHead(catalog);
  if (state.schemaVersion > head) throw new MigrationError('SCHEMA_FUTURE', 'Database schema is newer than this plugin release');
  if (state.schemaVersion === 0) {
    if (state.ledgerExists || tableExists(database, 'topics')) throw new MigrationError('MIGRATION_STATE_INVALID', 'Unversioned metadata schema cannot be repaired automatically');
    return { ...state, ledgerDigest: ledgerDigest([]) };
  }
  if (!state.ledgerExists || state.ledger.length !== state.schemaVersion) throw new MigrationError('MIGRATION_LEDGER_INVALID', 'Migration ledger does not match schema version');
  for (let index = 0; index < state.ledger.length; index += 1) {
    const actual = state.ledger[index];
    const expected = catalog[index];
    if (!expected || actual.version !== expected.version || actual.migration_id !== expected.id || actual.checksum !== expected.checksum ||
      actual.destructive !== Number(expected.destructive) || actual.compatible_plugin_build !== expected.compatiblePluginBuild) {
      throw new MigrationError('MIGRATION_LEDGER_INVALID', 'Migration ledger contains an unknown, reordered, or altered transition');
    }
    if (expected.compatiblePluginBuild !== pluginBuild) throw new MigrationError('PLUGIN_BUILD_INCOMPATIBLE', 'Installed plugin build is not compatible with an applied migration');
  }
  return { ...state, ledgerDigest: ledgerDigest(state.ledger) };
}

function assertSchemaRange(current, target, schemaRange) {
  if (!schemaRange || !Number.isInteger(schemaRange.readable?.min) || !Number.isInteger(schemaRange.readable?.max) || !Number.isInteger(schemaRange.writable?.min) || !Number.isInteger(schemaRange.writable?.max)) {
    throw new MigrationError('SCHEMA_RANGE_INVALID', 'Plugin schema compatibility range is invalid');
  }
  if (current > schemaRange.readable.max || (current !== 0 && current < schemaRange.readable.min)) {
    throw new MigrationError('SCHEMA_RANGE_UNSUPPORTED', 'Database schema is outside the plugin readable range');
  }
  if (target > schemaRange.writable.max || target < schemaRange.writable.min) {
    throw new MigrationError('SCHEMA_RANGE_UNSUPPORTED', 'Migration target is outside the plugin writable range');
  }
}

/** Apply immutable, forward-only migrations with ledger and DDL in one transaction. */
export async function applyMigrations(database, {
  catalog = migrationCatalog,
  pluginBuild = PLUGIN_BUILD,
  schemaRange,
  archiveBridge,
  stateDirectory,
  databasePath,
  beforeCommit
} = {}) {
  verifyMigrationCatalog(catalog);
  const before = validateMigrationLedger(database, { catalog, pluginBuild });
  const head = catalogHead(catalog);
  assertSchemaRange(before.schemaVersion, head, schemaRange);
  let current = before;
  for (let position = before.schemaVersion; position < head; position += 1) {
    if (catalog[position].compatiblePluginBuild !== pluginBuild) {
      throw new MigrationError('PLUGIN_BUILD_INCOMPATIBLE', 'Installed plugin build is not compatible with the pending migration');
    }
  }
  for (let position = before.schemaVersion; position < head; position += 1) {
    const migration = catalog[position];
    if (migration.destructive) {
      await requireVerifiedSnapshot(archiveBridge, {
        stateDirectory,
        databasePath,
        schemaVersion: position,
        ledgerHead: current.ledger.at(-1)?.migration_id || null,
        ledgerDigest: current.ledgerDigest
      });
    }
    let committed = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      for (const statement of migration.statements) database.exec(statement);
      database.prepare('INSERT INTO migration_ledger (version, migration_id, checksum, destructive, compatible_plugin_build, applied_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(migration.version, migration.id, migration.checksum, Number(migration.destructive), migration.compatiblePluginBuild, new Date().toISOString());
      if (migration.version === 1) database.prepare('INSERT INTO database_identity (singleton, created_by_build) VALUES (1, ?)').run(pluginBuild);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      await beforeCommit?.(migration);
      database.exec('COMMIT');
      committed = true;
      current = validateMigrationLedger(database, { catalog, pluginBuild });
    } catch (error) {
      if (!committed) {
        try { database.exec('ROLLBACK'); } catch { /* no transaction was opened */ }
      }
      throw error instanceof MigrationError ? error : new MigrationError('MIGRATION_TRANSACTION_FAILED', 'Migration transaction failed before commit');
    }
  }
  return current;
}
