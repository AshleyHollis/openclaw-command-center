import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import canonical from '../compatibility-tuple.json' with { type: 'json' };
import {
  recoveryManifestFileName,
  recoveryMigrationId,
  recoverySnapshotFileName,
  resolveCommandCenterRecoveryMigrationPath
} from './path.mjs';
import {
  MIGRATION_DIGEST,
  MIGRATION_FROM_VERSION,
  MIGRATION_ID,
  MIGRATION_TO_VERSION,
  V1_TO_V2_MIGRATION_DIGEST,
  V1_TO_V2_MIGRATION_ID,
  V2_TO_V3_MIGRATION_DIGEST,
  V2_TO_V3_MIGRATION_ID,
  V3_TO_V4_MIGRATION_DIGEST,
  V3_TO_V4_MIGRATION_ID,
  V4_TO_V5_MIGRATION_DIGEST,
  V4_TO_V5_MIGRATION_ID,
  validateMigrationLedger
} from './migration-ledger.mjs';
import { inspectSchema } from './schema.mjs';

export const RECOVERY_FORMAT_VERSION = 1;
export const RECOVERY_SNAPSHOT_SCHEMA_VERSION = 1;
const recoverySnapshotSchemaVersions = new Set([1, 2, 3, 4, 5]);

const currentRelease = Object.freeze({
  package: canonical.package,
  host: canonical.host,
  pluginApi: canonical.pluginApi,
  commandCenterSchema: canonical.commandCenterSchema,
  capabilityBridgeProtocol: canonical.capabilityBridgeProtocol
});
const schemaFiveRelease = Object.freeze(canonical.priorRelease);
const schemaFourRelease = Object.freeze({ ...schemaFiveRelease, commandCenterSchema: Object.freeze({ readable: Object.freeze({ min: 1, max: 4 }), migratable: Object.freeze({ min: 1, max: 3 }), writable: Object.freeze({ min: 4, max: 4 }) }) });
const schemaThreeRelease = Object.freeze({ ...schemaFourRelease, package: Object.freeze({ name: canonical.package.name, version: '0.2.0', build: '0.2.0' }), commandCenterSchema: Object.freeze({ readable: Object.freeze({ min: 1, max: 3 }), migratable: Object.freeze({ min: 1, max: 2 }), writable: Object.freeze({ min: 3, max: 3 }) }) });
const schemaTwoRelease = Object.freeze({ ...schemaThreeRelease, commandCenterSchema: Object.freeze({ readable: Object.freeze({ min: 1, max: 2 }), migratable: Object.freeze({ min: 1, max: 1 }), writable: Object.freeze({ min: 2, max: 2 }) }) });
const schemaOneRelease = Object.freeze({
  package: Object.freeze({ name: canonical.package.name, version: '0.1.0', build: '0.1.0' }),
  host: Object.freeze({ range: '=2026.8.1-beta.2' }),
  pluginApi: Object.freeze({ package: 'openclaw', range: '=2026.8.1-beta.2' }),
  commandCenterSchema: Object.freeze({ readable: Object.freeze({ min: 1, max: 1 }), writable: Object.freeze({ min: 1, max: 1 }) }),
  capabilityBridgeProtocol: Object.freeze({ min: 1, max: 1 })
});

function recoveryContractForSchema(schemaVersion, { legacyTarget = false } = {}) {
  if (schemaVersion === 1) return { migration: { id: V1_TO_V2_MIGRATION_ID, digest: V1_TO_V2_MIGRATION_DIGEST, fromVersion: 1, toVersion: 2 }, sourceRelease: schemaOneRelease, targetRelease: legacyTarget ? schemaThreeRelease : currentRelease };
  if (schemaVersion === 2) return { migration: { id: V2_TO_V3_MIGRATION_ID, digest: V2_TO_V3_MIGRATION_DIGEST, fromVersion: 2, toVersion: 3 }, sourceRelease: schemaTwoRelease, targetRelease: legacyTarget ? schemaThreeRelease : currentRelease };
  if (schemaVersion === 3) return { migration: { id: V3_TO_V4_MIGRATION_ID, digest: V3_TO_V4_MIGRATION_DIGEST, fromVersion: 3, toVersion: 4 }, sourceRelease: schemaThreeRelease, targetRelease: currentRelease };
  if (schemaVersion === 4) return { migration: { id: V4_TO_V5_MIGRATION_ID, digest: V4_TO_V5_MIGRATION_DIGEST, fromVersion: 4, toVersion: 5 }, sourceRelease: schemaFourRelease, targetRelease: currentRelease };
  return { migration: { id: MIGRATION_ID, digest: MIGRATION_DIGEST, fromVersion: MIGRATION_FROM_VERSION, toVersion: MIGRATION_TO_VERSION }, sourceRelease: schemaFiveRelease, targetRelease: currentRelease };
}

export class RecoveryMaterialError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecoveryMaterialError';
    this.code = code;
    Object.assign(this, details);
  }
}

function hashFile(filename) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filename, 'r');
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return 'sha256:' + hash.digest('hex');
}

function syncFile(filename) {
  // Windows rejects fsync on a read-only descriptor; the temporary manifest is
  // writable until publication, so use a read/write descriptor on every host.
  const descriptor = openSync(filename, 'r+');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function syncDirectory(directory) {
  try {
    const descriptor = openSync(directory, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch { /* directory fsync is unavailable on some supported filesystems */ }
}

function assertRegular(filename, label) {
  let info;
  try { info = lstatSync(filename); } catch (error) {
    throw new RecoveryMaterialError('recovery-material-missing', label + ' is missing.', { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new RecoveryMaterialError('recovery-material-obstructed', label + ' must be a regular file.');
  return info;
}

function assertDirectory(directory, label) {
  let info;
  try { info = lstatSync(directory); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new RecoveryMaterialError('recovery-material-obstructed', label + ' could not be inspected.', { cause: error });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RecoveryMaterialError('recovery-material-obstructed', label + ' must be a real directory.');
  return true;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function databaseFingerprint(database) {
  const candidates = ['topics', 'source_references', 'source_convention_state', 'presentation_preferences', 'attention_activity_links', 'proposal_states', 'policy_versions', 'projection_bookkeeping', 'operation_journal', 'session_state', 'activity_records'];
  const tables = candidates.filter((table) => database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
  const hash = createHash('sha256');
  hash.update(canonicalJson({
    schemaVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
    tables
  }) + '\n');
  for (const table of tables) {
    hash.update(canonicalJson({ table }) + '\n');
    for (const row of database.prepare('SELECT * FROM ' + table + ' ORDER BY 1').iterate()) {
      hash.update(canonicalJson(row) + '\n');
    }
  }
  return 'sha256:' + hash.digest('hex');
}

function inspectClosedSnapshot(snapshotPath, expectedSchemaVersion) {
  assertRegular(snapshotPath, 'Recovery snapshot');
  let database;
  try {
    database = new DatabaseSync(snapshotPath, { readOnly: true });
    const schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
    const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (schemaVersion !== expectedSchemaVersion || !recoverySnapshotSchemaVersions.has(schemaVersion)) throw new RecoveryMaterialError('recovery-schema-mismatch', 'Recovery snapshot does not contain its declared source schema.');
    if (integrity !== 'ok') throw new RecoveryMaterialError('recovery-integrity-failure', 'Recovery snapshot failed SQLite integrity checking.');
    const shape = inspectSchema(database, schemaVersion);
    if (!shape.valid) throw new RecoveryMaterialError('recovery-schema-mismatch', 'Recovery snapshot does not match its declared source schema.', { problems: shape.problems });
    return Object.freeze({ schemaVersion, fingerprint: databaseFingerprint(database) });
  } catch (error) {
    if (error instanceof RecoveryMaterialError) throw error;
    throw new RecoveryMaterialError('recovery-integrity-failure', 'Recovery snapshot could not be opened and verified.', { cause: error });
  } finally {
    try { database?.close(); } catch { /* verification cleanup */ }
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest is not an object.');
  const allowed = ['formatVersion', 'snapshotId', 'snapshotFile', 'migration', 'snapshot', 'sourceRelease', 'targetRelease', 'state'];
  if (Object.keys(manifest).some((key) => !allowed.includes(key))) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest contains unsupported fields.');
  if (manifest.formatVersion !== RECOVERY_FORMAT_VERSION || !/^sha256:[a-f0-9]{64}$/u.test(manifest.snapshotId ?? '') || manifest.snapshotFile !== recoverySnapshotFileName) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest identity or format differs.');
  if (!manifest.snapshot || !Number.isSafeInteger(manifest.snapshot.size) || manifest.snapshot.size <= 0 || typeof manifest.snapshot.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(manifest.snapshot.sha256) || !recoverySnapshotSchemaVersions.has(manifest.snapshot.schemaVersion) || typeof manifest.snapshot.sourceFingerprint !== 'string') throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest snapshot facts are invalid.');
  const currentContract = recoveryContractForSchema(manifest.snapshot.schemaVersion);
  const legacyContract = recoveryContractForSchema(manifest.snapshot.schemaVersion, { legacyTarget: true });
  if (!manifest.migration || canonicalJson(manifest.migration) !== canonicalJson(currentContract.migration)) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest migration contract differs.');
  if (manifest.snapshotId !== manifest.snapshot.sha256) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery snapshot identity does not match its content digest.');
  const releaseMatches = canonicalJson(manifest.sourceRelease) === canonicalJson(currentContract.sourceRelease)
    && [currentContract.targetRelease, legacyContract.targetRelease, schemaFiveRelease, schemaFourRelease, ...(manifest.snapshot.schemaVersion === 1 ? [schemaTwoRelease] : [])].some((target) => canonicalJson(manifest.targetRelease) === canonicalJson(target));
  if (!releaseMatches) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest compatibility facts differ.');
  if (!['prepared', 'committed'].includes(manifest.state)) throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest state is invalid.');
  return manifest;
}

export function recoveryDirectoryPath(stateDir) {
  return resolveCommandCenterRecoveryMigrationPath(stateDir, recoveryMigrationId);
}

export function readRecoveryMaterial(stateDir) {
  const directory = recoveryDirectoryPath(stateDir);
  assertMigrationParentChain(directory);
  if (!assertDirectory(directory, 'Recovery migration directory')) return Object.freeze({ exists: false, directory });
  const manifestPath = path.join(directory, recoveryManifestFileName);
  const snapshotPath = path.join(directory, recoverySnapshotFileName);
  assertRegular(manifestPath, 'Recovery manifest');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (error) {
    throw new RecoveryMaterialError('recovery-manifest-invalid', 'Recovery manifest is not valid JSON.', { cause: error });
  }
  validateManifestShape(manifest);
  const snapshotStat = assertRegular(snapshotPath, 'Recovery snapshot');
  if (snapshotStat.size !== manifest.snapshot.size || hashFile(snapshotPath) !== manifest.snapshot.sha256) throw new RecoveryMaterialError('recovery-integrity-failure', 'Recovery snapshot hash or size differs from its manifest.');
  const snapshot = inspectClosedSnapshot(snapshotPath, manifest.snapshot.schemaVersion);
  if (snapshot.fingerprint !== manifest.snapshot.sourceFingerprint) throw new RecoveryMaterialError('recovery-integrity-failure', 'Recovery snapshot application data differs from its manifest.');
  return Object.freeze({ exists: true, directory, manifest: Object.freeze(manifest), manifestPath, snapshotPath, snapshot });
}

function makeManifest({ state, size, sha256, sourceFingerprint, schemaVersion }) {
  const contract = recoveryContractForSchema(schemaVersion);
  return {
    formatVersion: RECOVERY_FORMAT_VERSION,
    snapshotId: sha256,
    snapshotFile: recoverySnapshotFileName,
    migration: contract.migration,
    snapshot: { schemaVersion, size, sha256, sourceFingerprint },
    sourceRelease: contract.sourceRelease,
    targetRelease: contract.targetRelease,
    state
  };
}

function writeManifest(filename, manifest) {
  const temporary = filename + '.publishing-' + process.pid + '-' + Date.now();
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  syncFile(temporary);
  renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}

function assertMigrationParentChain(directory) {
  const commandCenter = path.dirname(path.dirname(path.dirname(directory)));
  const plugins = path.dirname(commandCenter);
  const recovery = path.dirname(path.dirname(directory));
  const migrations = path.dirname(directory);
  for (const candidate of [plugins, commandCenter, recovery, migrations, directory]) {
    let info;
    try { info = lstatSync(candidate); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RecoveryMaterialError('recovery-material-obstructed', 'Recovery path must contain only real directories.');
  }
}

export function ensureRecoverySnapshot({ stateDir, databasePath, sourceSchemaVersion = RECOVERY_SNAPSHOT_SCHEMA_VERSION }) {
  const directory = recoveryDirectoryPath(stateDir);
  assertMigrationParentChain(directory);
  const existing = readRecoveryMaterial(stateDir);
  if (existing.exists) return existing;

  const parent = path.dirname(directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = directory + '.publishing-' + process.pid + '-' + Date.now();
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  const temporarySnapshot = path.join(temporary, recoverySnapshotFileName);
  try {
    let source;
    try {
      source = new DatabaseSync(databasePath, { readOnly: true });
      const sourceSchema = Number(source.prepare('PRAGMA user_version').get().user_version);
      const integrity = source.prepare('PRAGMA integrity_check').get()?.integrity_check;
      const shape = inspectSchema(source, sourceSchemaVersion);
      if (!recoverySnapshotSchemaVersions.has(sourceSchemaVersion) || sourceSchema !== sourceSchemaVersion || integrity !== 'ok' || !shape.valid) throw new RecoveryMaterialError('recovery-source-invalid', 'The pre-migration database is not a verified source-schema store.');
      const sourceFingerprint = databaseFingerprint(source);
      const escaped = temporarySnapshot.replaceAll("'", "''");
      source.exec("VACUUM INTO '" + escaped + "'");
      const info = assertRegular(temporarySnapshot, 'Published recovery snapshot');
      const snapshot = inspectClosedSnapshot(temporarySnapshot, sourceSchemaVersion);
      if (snapshot.fingerprint !== sourceFingerprint) throw new RecoveryMaterialError('recovery-integrity-failure', 'The published recovery snapshot does not match the source database.');
      chmodSync(temporarySnapshot, 0o444);
      const sha256 = hashFile(temporarySnapshot);
      const manifest = makeManifest({ state: 'prepared', size: info.size, sha256, sourceFingerprint, schemaVersion: sourceSchemaVersion });
      const manifestPath = path.join(temporary, recoveryManifestFileName);
      writeManifest(manifestPath, manifest);
      chmodSync(manifestPath, 0o644);
      syncDirectory(temporary);
    } finally {
      try { source?.close(); } catch { /* snapshot cleanup */ }
    }
    if (existsSync(directory)) throw new RecoveryMaterialError('recovery-material-obstructed', 'Recovery migration directory appeared during publication.');
    renameSync(temporary, directory);
    syncDirectory(parent);
    return readRecoveryMaterial(stateDir);
  } catch (error) {
    try { rmSync(temporary, { recursive: true, force: true }); } catch { /* cleanup our named temporary */ }
    throw error instanceof RecoveryMaterialError ? error : new RecoveryMaterialError('recovery-publication-failure', 'Recovery snapshot publication failed.', { cause: error });
  }
}

export function markRecoveryCommitted(material) {
  if (!material?.exists || !material.manifestPath) throw new TypeError('material must be a published recovery directory');
  const manifest = { ...material.manifest, state: 'committed' };
  writeManifest(material.manifestPath, manifest);
  const stateDir = path.resolve(material.directory, '..', '..', '..', '..', '..');
  return readRecoveryMaterial(stateDir);
}

export function inspectDatabaseAgainstRecoverySnapshot(databasePath, material) {
  if (!material?.exists) return false;
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    return Number(database.prepare('PRAGMA user_version').get().user_version) === material.manifest.snapshot.schemaVersion
      && databaseFingerprint(database) === material.manifest.snapshot.sourceFingerprint;
  } catch { return false; } finally {
    try { database?.close(); } catch { /* inspection cleanup */ }
  }
}

export function isRollbackSnapshot(databasePath, material) {
  return Boolean(material?.exists && material.manifest.state === 'committed' && inspectDatabaseAgainstRecoverySnapshot(databasePath, material));
}

export function expectedRollbackRelease(stateDir) {
  return structuredClone(stateDir ? readRecoveryMaterial(stateDir).manifest.sourceRelease : canonical.priorRelease);
}

export function currentReleaseContract() {
  return structuredClone(currentRelease);
}

export function verifyRollbackMaterial(stateDir, { snapshotId, priorRelease }, databasePath) {
  const material = readRecoveryMaterial(stateDir);
  if (!material.exists) throw new RecoveryMaterialError('rollback-snapshot-missing', 'The retained rollback snapshot is missing.');
  if (snapshotId !== material.manifest.snapshotId) throw new RecoveryMaterialError('rollback-snapshot-mismatch', 'The requested rollback snapshot is not the retained verified snapshot.');
  if (canonicalJson(priorRelease) !== canonicalJson(material.manifest.sourceRelease)) throw new RecoveryMaterialError('rollback-release-mismatch', 'The requested prior release is not the exact compatible release for this snapshot.');
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (Number(database.prepare('PRAGMA user_version').get().user_version) !== MIGRATION_TO_VERSION) throw new Error('current schema differs');
    const ledger = validateMigrationLedger(database, { snapshotId: material.manifest.snapshotId });
    if (!ledger.valid) throw new Error('migration ledger differs');
  } catch (error) {
    throw new RecoveryMaterialError('rollback-database-mismatch', 'The current database ledger does not bind this recovery snapshot.', { cause: error });
  } finally {
    try { database?.close(); } catch { /* rollback verification cleanup */ }
  }
  return Object.freeze({
    verified: true,
    snapshotId: material.manifest.snapshotId,
    migrationId: material.manifest.migration.id,
    migrationDigest: material.manifest.migration.digest,
    sourceSchema: material.manifest.snapshot.schemaVersion,
    priorRelease: structuredClone(material.manifest.sourceRelease),
    snapshotSha256: material.manifest.snapshot.sha256,
    snapshotSize: material.manifest.snapshot.size
  });
}
