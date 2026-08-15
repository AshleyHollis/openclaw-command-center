import { createHash } from 'node:crypto';
import { requireVerifiedSnapshot } from './archive-bridge.mjs';
import { INITIAL_SCHEMA_VERSION, initialSchemaStatements, PLUGIN_BUILD } from './schema.mjs';

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
    version: INITIAL_SCHEMA_VERSION,
    id: 'command-center-metadata-initial-v1',
    destructive: false,
    compatiblePluginBuild: PLUGIN_BUILD,
    statements: initialSchemaStatements
  }),
  freezeMigration({
    version: 2,
    id: 'command-center-topic-identity-v2',
    destructive: false,
    compatiblePluginBuild: PLUGIN_BUILD,
    statements: [`CREATE TRIGGER topic_id_immutable
      BEFORE UPDATE OF topic_id ON topics
      BEGIN
        SELECT RAISE(ABORT, 'Topic identity is immutable');
      END`]
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

/**
 * A migration records the immutable minimum build that introduced its
 * transition. Historic entries therefore remain unchanged across later plugin
 * releases. The installed build is compatible when it meets the catalog-head
 * minimum; older ledger entries are verified against their own catalog records,
 * never rewritten to the current build.
 */
export function catalogCompatiblePluginBuild(catalog = migrationCatalog) {
  verifyMigrationCatalog(catalog);
  return catalog.at(-1).compatiblePluginBuild;
}

function parseBuild(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value || '');
  return match && { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

function compareBuilds(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function isPluginBuildCompatible(catalog = migrationCatalog, pluginBuild = PLUGIN_BUILD) {
  const minimum = catalogCompatiblePluginBuild(catalog);
  if (pluginBuild === minimum) return true;
  const installed = parseBuild(pluginBuild);
  const required = parseBuild(minimum);
  return Boolean(installed && required && compareBuilds(installed, required) >= 0);
}

export function validateInstalledPluginBuild(catalog = migrationCatalog, pluginBuild = PLUGIN_BUILD) {
  const expected = catalogCompatiblePluginBuild(catalog);
  if (typeof pluginBuild !== 'string' || !isPluginBuildCompatible(catalog, pluginBuild)) {
    throw new MigrationError('PLUGIN_BUILD_INCOMPATIBLE', 'Installed plugin build is not compatible with this migration catalog');
  }
  return expected;
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

export function validateMigrationLedger(database, { catalog = migrationCatalog } = {}) {
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
  beforeCommit,
  commit = () => database.exec('COMMIT')
} = {}) {
  verifyMigrationCatalog(catalog);
  validateInstalledPluginBuild(catalog, pluginBuild);
  const before = validateMigrationLedger(database, { catalog });
  const head = catalogHead(catalog);
  assertSchemaRange(before.schemaVersion, head, schemaRange);
  let current = before;
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
      await commit(migration, database);
      committed = true;
      current = validateMigrationLedger(database, { catalog });
    } catch (error) {
      if (!committed) {
        try { database.exec('ROLLBACK'); } catch { /* no transaction was opened */ }
      }
      throw error instanceof MigrationError ? error : new MigrationError('MIGRATION_TRANSACTION_FAILED', 'Migration transaction failed before commit');
    }
  }
  return current;
}
