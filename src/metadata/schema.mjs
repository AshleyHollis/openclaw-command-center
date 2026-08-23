export const SOURCE_SCHEMA_VERSION = 1;
export const LEGACY_METADATA_SCHEMA_VERSION = 2;
export const COMMAND_CENTER_SCHEMA_VERSION = 3;

export const metadataTableNames = Object.freeze([
  'topics', 'source_references', 'source_convention_state', 'presentation_preferences',
  'attention_activity_links', 'proposal_states', 'policy_versions', 'projection_bookkeeping',
  'operation_journal', 'session_state', 'activity_records', 'migration_state',
  'migration_channels', 'migration_occurrences', 'migration_completion'
]);
export const paraCategories = Object.freeze(['project', 'area', 'resource', 'archive']);
export const topicLifecycles = Object.freeze(['provisioning', 'active', 'retired']);
export const conventionAspects = Object.freeze(['name', 'location', 'display_label']);
export const conventionStates = Object.freeze(['managed', 'customized']);
export const proposalStates = Object.freeze(['pending', 'accepted', 'rejected', 'withdrawn']);

const metadataSchemaV2CoreSql = `
CREATE TABLE topics (
  topic_id TEXT PRIMARY KEY,
  para_category TEXT NOT NULL CHECK (para_category IN ('project', 'area', 'resource', 'archive')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('provisioning', 'active', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_references (
  reference_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE RESTRICT,
  source_system TEXT NOT NULL CHECK (length(trim(source_system)) > 0),
  source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  external_source_id TEXT NOT NULL CHECK (length(trim(external_source_id)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_observed_revision TEXT,
  UNIQUE (source_system, source_kind, external_source_id)
) STRICT;

CREATE TABLE source_convention_state (
  reference_id TEXT NOT NULL REFERENCES source_references(reference_id) ON DELETE CASCADE,
  aspect TEXT NOT NULL CHECK (aspect IN ('name', 'location', 'display_label')),
  state TEXT NOT NULL CHECK (state IN ('managed', 'customized')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reference_id, aspect)
) STRICT;

CREATE TABLE presentation_preferences (
  topic_id TEXT PRIMARY KEY REFERENCES topics(topic_id) ON DELETE CASCADE,
  display_label TEXT NOT NULL DEFAULT '' CHECK (length(display_label) <= 300),
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE attention_activity_links (
  link_id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  topic_id TEXT REFERENCES topics(topic_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (attention_id, activity_id)
) STRICT;

CREATE TABLE proposal_states (
  proposal_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE policy_versions (
  policy_id TEXT PRIMARY KEY,
  version TEXT NOT NULL CHECK (length(trim(version)) > 0),
  digest TEXT NOT NULL CHECK (length(trim(digest)) > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE projection_bookkeeping (
  projection_id TEXT PRIMARY KEY,
  source_revision TEXT NOT NULL CHECK (length(trim(source_revision)) > 0),
  input_digest TEXT NOT NULL CHECK (length(trim(input_digest)) > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE operation_journal (
  logical_operation_id TEXT PRIMARY KEY,
  transport_request_id TEXT NOT NULL CHECK (length(trim(transport_request_id)) > 0),
  intent_digest TEXT NOT NULL CHECK (length(trim(intent_digest)) > 0),
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'not-applied', 'conflict', 'unknown')),
  result_status TEXT,
  result_identity TEXT,
  observed_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_state (
  reference_id TEXT PRIMARY KEY REFERENCES source_references(reference_id) ON DELETE CASCADE,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE activity_records (
  activity_id TEXT PRIMARY KEY,
  topic_id TEXT REFERENCES topics(topic_id) ON DELETE CASCADE,
  logical_operation_id TEXT NOT NULL,
  transport_request_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'not-applied', 'conflict', 'unknown')),
  observed_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (logical_operation_id)
) STRICT;

PRAGMA user_version = 2;
`;

const schemaLedgerSql = `
CREATE TABLE schema_migrations (
  sequence INTEGER PRIMARY KEY,
  migration_id TEXT NOT NULL UNIQUE,
  migration_digest TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  applied_build TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

const metadataSchemaV3MigrationTablesSql = `
CREATE TABLE migration_state (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'legacy-discord-v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  config_digest TEXT NOT NULL CHECK (length(trim(config_digest)) > 0),
  source_digest TEXT NOT NULL CHECK (length(trim(source_digest)) > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'provisioning', 'importing', 'verifying', 'review')),
  failure_code TEXT,
  failure_summary TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE migration_channels (
  source_channel_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE RESTRICT,
  note_folder_reference_id TEXT NOT NULL REFERENCES source_references(reference_id) ON DELETE RESTRICT,
  session_reference_id TEXT NOT NULL REFERENCES source_references(reference_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'provisioning', 'importing', 'verifying', 'review', 'complete')),
  expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
  expected_digest TEXT NOT NULL CHECK (length(trim(expected_digest)) > 0),
  imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
  imported_digest TEXT NOT NULL CHECK (length(trim(imported_digest)) > 0),
  next_ordinal INTEGER NOT NULL CHECK (next_ordinal >= 0),
  failure_code TEXT,
  failure_summary TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE (topic_id),
  UNIQUE (note_folder_reference_id),
  UNIQUE (session_reference_id)
) STRICT;

CREATE TABLE migration_occurrences (
  source_channel_id TEXT NOT NULL REFERENCES migration_channels(source_channel_id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL,
  occurrence_digest TEXT NOT NULL CHECK (length(trim(occurrence_digest)) > 0),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  destination_message_id TEXT,
  destination_anchor_json TEXT,
  destination_anchor_digest TEXT,
  PRIMARY KEY (source_channel_id, occurrence_id),
  UNIQUE (source_channel_id, display_order)
) STRICT;

CREATE TABLE migration_completion (
  completion_id TEXT PRIMARY KEY CHECK (completion_id = 'legacy-discord-v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  config_digest TEXT NOT NULL CHECK (length(trim(config_digest)) > 0),
  source_digest TEXT NOT NULL CHECK (length(trim(source_digest)) > 0),
  verified_channel_count INTEGER NOT NULL CHECK (verified_channel_count >= 0),
  verified_occurrence_count INTEGER NOT NULL CHECK (verified_occurrence_count >= 0),
  completion_revision INTEGER NOT NULL CHECK (completion_revision >= 1),
  verified_at TEXT NOT NULL
) STRICT;
`;

export const metadataSchemaV2Sql = `${metadataSchemaV2CoreSql}${schemaLedgerSql}\nPRAGMA user_version = 2;\n`;
export const metadataSchemaSql = `${metadataSchemaV2CoreSql.replace('PRAGMA user_version = 2;', 'PRAGMA user_version = 3;')}${metadataSchemaV3MigrationTablesSql}${schemaLedgerSql}\nPRAGMA user_version = 3;\n`;

const baseColumns = Object.freeze({
  topics: [['topic_id', 'TEXT', 1, 1], ['para_category', 'TEXT', 1, 0], ['lifecycle', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  source_references: [['reference_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['source_system', 'TEXT', 1, 0], ['source_kind', 'TEXT', 1, 0], ['external_source_id', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['last_observed_revision', 'TEXT', 0, 0]],
  source_convention_state: [['reference_id', 'TEXT', 1, 1], ['aspect', 'TEXT', 1, 2], ['state', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  presentation_preferences: [['topic_id', 'TEXT', 1, 1], ['display_label', 'TEXT', 1, 0], ['sort_order', 'INTEGER', 1, 0], ['collapsed', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  attention_activity_links: [['link_id', 'TEXT', 1, 1], ['attention_id', 'TEXT', 1, 0], ['activity_id', 'TEXT', 1, 0], ['topic_id', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0]],
  proposal_states: [['proposal_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  policy_versions: [['policy_id', 'TEXT', 1, 1], ['version', 'TEXT', 1, 0], ['digest', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  projection_bookkeeping: [['projection_id', 'TEXT', 1, 1], ['source_revision', 'TEXT', 1, 0], ['input_digest', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  operation_journal: [['logical_operation_id', 'TEXT', 1, 1], ['transport_request_id', 'TEXT', 1, 0], ['intent_digest', 'TEXT', 1, 0], ['operation_kind', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['result_status', 'TEXT', 0, 0], ['result_identity', 'TEXT', 0, 0], ['observed_revision', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  session_state: [['reference_id', 'TEXT', 1, 1], ['session_id', 'TEXT', 0, 0], ['status', 'TEXT', 1, 0], ['is_primary', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  activity_records: [['activity_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 0, 0], ['logical_operation_id', 'TEXT', 1, 0], ['transport_request_id', 'TEXT', 1, 0], ['operation_kind', 'TEXT', 1, 0], ['outcome', 'TEXT', 1, 0], ['observed_revision', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  migration_state: [['state_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['config_digest', 'TEXT', 1, 0], ['source_digest', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['phase', 'TEXT', 1, 0], ['failure_code', 'TEXT', 0, 0], ['failure_summary', 'TEXT', 0, 0], ['failure_count', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  migration_channels: [['source_channel_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['note_folder_reference_id', 'TEXT', 1, 0], ['session_reference_id', 'TEXT', 1, 0], ['session_id', 'TEXT', 1, 0], ['phase', 'TEXT', 1, 0], ['expected_count', 'INTEGER', 1, 0], ['expected_digest', 'TEXT', 1, 0], ['imported_count', 'INTEGER', 1, 0], ['imported_digest', 'TEXT', 1, 0], ['next_ordinal', 'INTEGER', 1, 0], ['failure_code', 'TEXT', 0, 0], ['failure_summary', 'TEXT', 0, 0], ['failure_count', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  migration_occurrences: [['source_channel_id', 'TEXT', 1, 1], ['occurrence_id', 'TEXT', 1, 2], ['occurrence_digest', 'TEXT', 1, 0], ['display_order', 'INTEGER', 1, 0], ['destination_message_id', 'TEXT', 0, 0], ['destination_anchor_json', 'TEXT', 0, 0], ['destination_anchor_digest', 'TEXT', 0, 0]],
  migration_completion: [['completion_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['config_digest', 'TEXT', 1, 0], ['source_digest', 'TEXT', 1, 0], ['verified_channel_count', 'INTEGER', 1, 0], ['verified_occurrence_count', 'INTEGER', 1, 0], ['completion_revision', 'INTEGER', 1, 0], ['verified_at', 'TEXT', 1, 0]]
});

const baseForeignKeys = Object.freeze({
  source_references: ['topics|topic_id|topic_id|RESTRICT'],
  source_convention_state: ['source_references|reference_id|reference_id|CASCADE'],
  presentation_preferences: ['topics|topic_id|topic_id|CASCADE'],
  attention_activity_links: ['topics|topic_id|topic_id|CASCADE'],
  proposal_states: ['topics|topic_id|topic_id|CASCADE'],
  session_state: ['source_references|reference_id|reference_id|CASCADE'],
  activity_records: ['topics|topic_id|topic_id|CASCADE'],
  migration_channels: ['topics|topic_id|topic_id|RESTRICT', 'source_references|note_folder_reference_id|reference_id|RESTRICT', 'source_references|session_reference_id|reference_id|RESTRICT'],
  migration_occurrences: ['migration_channels|source_channel_id|source_channel_id|CASCADE']
});
const expectedLedgerColumns = Object.freeze([
  ['sequence', 'INTEGER', 0, 1], ['migration_id', 'TEXT', 1, 0], ['migration_digest', 'TEXT', 1, 0],
  ['from_version', 'INTEGER', 1, 0], ['to_version', 'INTEGER', 1, 0], ['snapshot_id', 'TEXT', 1, 0],
  ['applied_build', 'TEXT', 1, 0], ['applied_at', 'TEXT', 1, 0]
]);
function normalizedSql(value) { return String(value ?? '').replace(/\s+/gu, ' ').trim().replace(/;$/u, ''); }
function definitions(sql) {
  return Object.freeze(Object.fromEntries(
    [...sql.matchAll(/CREATE TABLE ([a-z_]+) \([\s\S]*?\n\) STRICT;/gu)].map((match) => [match[1], normalizedSql(match[0])])
  ));
}
const expectedTableDefinitions = definitions(metadataSchemaSql);
const expectedTableDefinitionsV2 = definitions(metadataSchemaV2Sql);

export const metadataSchemaV1Sql = metadataSchemaV2CoreSql
  .replace('  last_observed_revision TEXT,\n', '')
  .replace(/\nCREATE TABLE operation_journal \([\s\S]*?\n\) STRICT;\n/gu, '\n')
  .replace(/\nCREATE TABLE session_state \([\s\S]*?\n\) STRICT;\n/gu, '\n')
  .replace(/\nCREATE TABLE activity_records \([\s\S]*?\n\) STRICT;\n/gu, '\n')
  .replace('PRAGMA user_version = 2;', 'PRAGMA user_version = 1;');

export const metadataSchemaV1ToV2Sql = `
ALTER TABLE source_references ADD COLUMN last_observed_revision TEXT;

CREATE TABLE operation_journal (
  logical_operation_id TEXT PRIMARY KEY,
  transport_request_id TEXT NOT NULL CHECK (length(trim(transport_request_id)) > 0),
  intent_digest TEXT NOT NULL CHECK (length(trim(intent_digest)) > 0),
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'not-applied', 'conflict', 'unknown')),
  result_status TEXT,
  result_identity TEXT,
  observed_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_state (
  reference_id TEXT PRIMARY KEY REFERENCES source_references(reference_id) ON DELETE CASCADE,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE activity_records (
  activity_id TEXT PRIMARY KEY,
  topic_id TEXT REFERENCES topics(topic_id) ON DELETE CASCADE,
  logical_operation_id TEXT NOT NULL,
  transport_request_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'not-applied', 'conflict', 'unknown')),
  observed_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (logical_operation_id)
) STRICT;

CREATE TABLE schema_migrations (
  sequence INTEGER PRIMARY KEY,
  migration_id TEXT NOT NULL UNIQUE,
  migration_digest TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  applied_build TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

PRAGMA user_version = 2;
`;
export const metadataSchemaV2ToV3Sql = `${metadataSchemaV3MigrationTablesSql}\nPRAGMA user_version = 3;\n`;

const v1Tables = Object.freeze(Object.keys(baseColumns).filter((table) => !['operation_journal', 'session_state', 'activity_records', 'migration_state', 'migration_channels', 'migration_occurrences', 'migration_completion'].includes(table)));
const v2Tables = Object.freeze(Object.keys(baseColumns).filter((table) => !['migration_state', 'migration_channels', 'migration_occurrences', 'migration_completion'].includes(table)));
const v1Columns = Object.freeze(Object.fromEntries(v1Tables.map((table) => [table, table === 'source_references' ? baseColumns[table].filter(([name]) => name !== 'last_observed_revision') : baseColumns[table]])));
const v2Columns = Object.freeze(Object.fromEntries(v2Tables.map((table) => [table, baseColumns[table]])));
const v1Definitions = definitions(metadataSchemaV1Sql);
const v2ForeignKeys = Object.freeze(Object.fromEntries(v2Tables.map((table) => [table, baseForeignKeys[table] ?? []])));
const v1ForeignKeys = Object.freeze(Object.fromEntries(v1Tables.map((table) => [table, v2ForeignKeys[table] ?? []])));
function sameArray(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }

export function inspectSchema(database, schemaVersion = COMMAND_CENTER_SCHEMA_VERSION) {
  const problems = [];
  const current = schemaVersion === COMMAND_CENTER_SCHEMA_VERSION;
  const columnsForVersion = current ? baseColumns : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? v2Columns : v1Columns;
  const definitionsForVersion = current ? expectedTableDefinitions : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? expectedTableDefinitionsV2 : v1Definitions;
  const foreignKeysForVersion = current ? baseForeignKeys : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? v2ForeignKeys : v1ForeignKeys;
  const applicationTables = current ? metadataTableNames : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? v2Tables : v1Tables;
  const expectedTables = current ? [...applicationTables, 'schema_migrations'] : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? [...applicationTables, 'schema_migrations'] : [...applicationTables];
  const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = objects.filter((row) => row.type === 'table').map((row) => row.name);
  if (!sameArray(tables, expectedTables.slice().sort())) problems.push('application table set differs');
  const allowedObjects = new Set(expectedTables);
  if (objects.some((row) => !allowedObjects.has(row.name))) problems.push('unexpected application schema object');
  for (const table of applicationTables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row.type, row.notnull, row.pk]);
    if (!sameArray(columns.map(JSON.stringify), (columnsForVersion[table] ?? []).map(JSON.stringify))) problems.push(`${table} columns differ`);
    const tableShape = database.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table);
    if (!tableShape || tableShape.strict !== 1) problems.push(`${table} is not STRICT`);
    const ddl = normalizedSql(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql);
    if (ddl !== definitionsForVersion[table]) problems.push(`${table} definition differs`);
  }
  if (schemaVersion >= LEGACY_METADATA_SCHEMA_VERSION) {
    const columns = database.prepare('PRAGMA table_info(schema_migrations)').all().map((row) => [row.name, row.type, row.notnull, row.pk]);
    if (!sameArray(columns.map(JSON.stringify), expectedLedgerColumns.map(JSON.stringify))) problems.push('schema_migrations columns differ');
    if (database.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get('schema_migrations')?.strict !== 1) problems.push('schema_migrations is not STRICT');
    const ddl = normalizedSql(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()?.sql);
    if (ddl !== definitionsForVersion.schema_migrations) problems.push('schema_migrations definition differs');
  }
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  if (indexes.length !== 0) problems.push('application index set differs');
  for (const table of applicationTables) {
    const actual = database.prepare(`PRAGMA foreign_key_list(${table})`).all().map((row) => `${row.table}|${row.from}|${row.to}|${row.on_delete}`).sort();
    if (!sameArray(actual, [...(foreignKeysForVersion[table] ?? [])].sort())) problems.push(`${table} foreign keys differ`);
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) problems.push('foreign-key integrity check failed');
  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze(problems) });
}
export function inspectSchemaV1(database) { return inspectSchema(database, SOURCE_SCHEMA_VERSION); }
export function inspectSchemaV2(database) { return inspectSchema(database, LEGACY_METADATA_SCHEMA_VERSION); }
export function inspectMigrationLedger(database) {
  const rows = database.prepare('SELECT sequence, migration_id, migration_digest, from_version, to_version, snapshot_id, applied_build, applied_at FROM schema_migrations ORDER BY sequence').all();
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}
