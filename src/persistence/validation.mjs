import { bridgeProtocolResult } from './archive-bridge.mjs';
import { diagnostic } from './diagnostics.mjs';
import { MigrationError, readMigrationState, validateMigrationLedger } from './migrations.mjs';
import { evaluateMode } from './mode.mjs';
import { requiredConstraintFragments, requiredIndexFragments, requiredIndexes, requiredTables, SUPPORTED_POLICY_VERSIONS } from './schema.mjs';

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function indexExists(database, index) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
}

function checks(database, options) {
  const { compatibility, archiveBridge, catalog, pluginBuild } = options;
  return [
    {
      name: 'sqlite-integrity',
      run: () => {
        const rows = database.prepare('PRAGMA integrity_check').all();
        return rows.length === 1 && Object.values(rows[0])[0] === 'ok'
          ? diagnostic('sqlite-integrity', true)
          : diagnostic('sqlite-integrity', false, { code: 'SQLITE_INTEGRITY_FAILED', critical: true, guidance: 'Restore a verified broad-archive snapshot and validate it with compatible code.' });
      }
    },
    {
      name: 'foreign-keys',
      run: () => {
        const enabled = database.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1;
        const violations = database.prepare('PRAGMA foreign_key_check').all();
        return enabled && violations.length === 0
          ? diagnostic('foreign-keys', true)
          : diagnostic('foreign-keys', false, { code: 'FOREIGN_KEY_VIOLATIONS', critical: true, guidance: 'Restore or repair durable metadata with compatible recovery tooling.' });
      }
    },
    {
      name: 'durable-schema',
      run: () => {
        const missing = requiredTables.filter((table) => !tableExists(database, table));
        const altered = Object.entries(requiredConstraintFragments).flatMap(([table, fragments]) => {
          const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || '';
          return fragments.every((fragment) => sql.includes(fragment)) ? [] : [table];
        });
        return missing.length === 0 && altered.length === 0
          ? diagnostic('durable-schema', true)
          : diagnostic('durable-schema', false, { code: 'DURABLE_SCHEMA_MISSING', observed: [...missing, ...altered], critical: true, guidance: 'Install compatible code or restore a verified broad-archive snapshot.' });
      }
    },
    {
      name: 'required-indexes',
      run: () => {
        const missing = requiredIndexes.filter((index) => !indexExists(database, index));
        const altered = Object.entries(requiredIndexFragments).flatMap(([index, fragment]) => {
          const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)?.sql || '';
          return sql.includes(fragment) ? [] : [index];
        });
        return missing.length === 0 && altered.length === 0
          ? diagnostic('required-indexes', true)
          : diagnostic('required-indexes', false, { code: 'REQUIRED_INDEX_MISSING', observed: [...missing, ...altered], critical: true, guidance: 'Restore durable metadata; required constraints are not rebuilt automatically.' });
      }
    },
    {
      name: 'source-reference-invariants',
      run: () => {
        const duplicateOwners = database.prepare("SELECT opaque_identifier FROM source_references WHERE is_current = 1 GROUP BY opaque_identifier, source_kind HAVING COUNT(DISTINCT topic_id) > 1").all();
        const invalidPrimary = database.prepare("SELECT source_reference_id FROM source_references WHERE source_role = 'primary_session' AND source_kind != 'session'").all();
        return duplicateOwners.length === 0 && invalidPrimary.length === 0
          ? diagnostic('source-reference-invariants', true)
          : diagnostic('source-reference-invariants', false, { code: 'SOURCE_REFERENCE_INVARIANT_FAILED', critical: true, guidance: 'Resolve source ownership explicitly; Command Center will not rebind references automatically.' });
      }
    },
    {
      name: 'migration-ledger',
      run: () => {
        try {
          validateMigrationLedger(database, { catalog, pluginBuild });
          return diagnostic('migration-ledger', true);
        } catch (error) {
          return diagnostic('migration-ledger', false, { code: error.code || 'MIGRATION_LEDGER_INVALID', critical: true, guidance: 'Use a verified broad-archive snapshot and a compatible plugin release.' });
        }
      }
    },
    {
      name: 'schema-range',
      run: () => {
        const version = readMigrationState(database).schemaVersion;
        const range = compatibility?.commandCenterSchema;
        const supported = range?.readable;
        const ok = Number.isInteger(version) && supported && version >= supported.min && version <= supported.max;
        return diagnostic('schema-range', ok, { code: 'SCHEMA_RANGE_UNSUPPORTED', observed: version, supported, critical: true, guidance: 'Install a compatible plugin release; Command Center never down-migrates.' });
      }
    },
    {
      name: 'policy-versions',
      run: () => {
        const rows = database.prepare('SELECT policy_name, version FROM policy_versions').all();
        const invalid = rows.some((row) => SUPPORTED_POLICY_VERSIONS[row.policy_name] !== row.version) || rows.length !== Object.keys(SUPPORTED_POLICY_VERSIONS).length;
        return diagnostic('policy-versions', !invalid, { code: 'POLICY_VERSION_UNSUPPORTED', critical: true, guidance: 'Install code that supports the restored policy version or restore a compatible snapshot.' });
      }
    },
    {
      name: 'plugin-build',
      run: () => {
        const identity = database.prepare('SELECT created_by_build FROM database_identity WHERE singleton = 1').get();
        const ledger = database.prepare('SELECT compatible_plugin_build FROM migration_ledger').all();
        const ok = identity && ledger.every((row) => row.compatible_plugin_build === pluginBuild);
        return diagnostic('plugin-build', ok, { code: 'PLUGIN_BUILD_INCOMPATIBLE', observed: identity?.created_by_build, supported: pluginBuild, critical: true, guidance: 'Install the compatible Command Center release before enabling mutations.' });
      }
    },
    {
      name: 'bridge-compatibility',
      run: () => {
        const result = bridgeProtocolResult(archiveBridge, compatibility?.capabilityBridgeProtocol || {});
        return diagnostic('bridge-compatibility', result.compatible, { code: 'BRIDGE_PROTOCOL_INCOMPATIBLE', observed: result.protocolVersion, supported: compatibility?.capabilityBridgeProtocol, critical: true, guidance: 'Connect the compatible OpenClaw broad-archive bridge before enabling mutations.' });
      }
    },
    {
      name: 'projections',
      run: () => {
        const available = tableExists(database, 'projection_topic_summary') && tableExists(database, 'projection_metadata');
        return diagnostic('projections', available, { code: 'PROJECTION_UNAVAILABLE', capability: 'projections', critical: false, guidance: 'Rebuild projections from durable Command Center metadata.' });
      }
    }
  ];
}

/** Complete non-mutating validation performed on every successful open. */
export function validateDatabase(database, options) {
  const results = [];
  for (const check of checks(database, options)) {
    try { results.push(check.run()); }
    catch (error) {
      results.push(diagnostic(check.name, false, {
        code: error instanceof MigrationError ? error.code : 'VALIDATION_CHECK_FAILED',
        critical: check.name !== 'projections',
        capability: check.name === 'projections' ? 'projections' : undefined,
        guidance: 'Inspect the named validation result and use compatible recovery steps.'
      }));
    }
  }
  return Object.freeze({ results: Object.freeze(results), evaluation: evaluateMode(results), schemaVersion: readMigrationState(database).schemaVersion });
}
