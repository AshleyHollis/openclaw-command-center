export const PLUGIN_BUILD = '0.1.0';
export const INITIAL_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 2;
export const SUPPORTED_POLICY_VERSIONS = Object.freeze({ 'command-center-metadata': 1 });

export const requiredTables = Object.freeze([
  'database_identity',
  'migration_ledger',
  'topics',
  'source_references',
  'convention_state',
  'presentation_preferences',
  'attention_activity_links',
  'structural_change_proposals',
  'policy_versions'
]);

export const requiredIndexes = Object.freeze([
  'source_references_by_topic',
  'one_current_note_folder_per_topic',
  'one_current_primary_session_per_topic',
  'one_current_note_folder_owner',
  'one_current_conversation_owner'
]);

export const requiredIndexFragments = Object.freeze({
  source_references_by_topic: 'ON source_references(topic_id)',
  one_current_note_folder_per_topic: "ON source_references(topic_id) WHERE is_current = 1 AND source_role = 'note_folder'",
  one_current_primary_session_per_topic: "ON source_references(topic_id) WHERE is_current = 1 AND source_role = 'primary_session'",
  one_current_note_folder_owner: "ON source_references(opaque_identifier) WHERE is_current = 1 AND source_role = 'note_folder'",
  one_current_conversation_owner: "ON source_references(opaque_identifier) WHERE is_current = 1 AND source_role IN ('primary_session', 'topic_conversation')"
});

export const requiredConstraintFragments = Object.freeze({
  topics: ["para_category IN ('Project', 'Area', 'Resource', 'Archive')", "lifecycle_state IN ('Provisioning', 'Active', 'Archived', 'Retired')"],
  source_references: ["source_kind IN ('note_folder', 'session')", "verification_state IN ('verified', 'unresolved', 'ambiguous')"],
  migration_ledger: ['version > 0', 'destructive IN (0, 1)']
});

export const requiredTriggers = Object.freeze({
  topic_id_immutable: 'BEFORE UPDATE OF topic_id ON topics'
});

export const projectionConstraintFragments = Object.freeze({
  projection_topic_summary: ['current_source_count INTEGER NOT NULL CHECK (current_source_count >= 0)'],
  projection_metadata: ['generation INTEGER NOT NULL CHECK (generation >= 0)']
});

// This deliberately contains metadata and opaque external identifiers only.
// It has no Note body, Session message, transcript, imported history, or
// scheduler/job/schedule payload column.
export const initialSchemaStatements = Object.freeze([
  `CREATE TABLE database_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    created_by_build TEXT NOT NULL CHECK (length(created_by_build) > 0)
  )`,
  `CREATE TABLE migration_ledger (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    migration_id TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)),
    compatible_plugin_build TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE topics (
    topic_id TEXT PRIMARY KEY CHECK (length(topic_id) BETWEEN 1 AND 160),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    para_category TEXT NOT NULL CHECK (para_category IN ('Project', 'Area', 'Resource', 'Archive')),
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('Provisioning', 'Active', 'Archived', 'Retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE source_references (
    source_reference_id TEXT PRIMARY KEY CHECK (length(source_reference_id) BETWEEN 1 AND 160),
    topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('note_folder', 'session')),
    source_role TEXT NOT NULL CHECK (source_role IN ('note_folder', 'primary_session', 'topic_conversation')),
    opaque_identifier TEXT NOT NULL CHECK (length(opaque_identifier) BETWEEN 1 AND 1024),
    verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unresolved', 'ambiguous')),
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
    originating_topic_id TEXT REFERENCES topics(topic_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK (
      (source_kind = 'note_folder' AND source_role = 'note_folder') OR
      (source_kind = 'session' AND source_role IN ('primary_session', 'topic_conversation'))
    )
  )`,
  'CREATE INDEX source_references_by_topic ON source_references(topic_id)',
  "CREATE UNIQUE INDEX one_current_note_folder_per_topic ON source_references(topic_id) WHERE is_current = 1 AND source_role = 'note_folder'",
  "CREATE UNIQUE INDEX one_current_primary_session_per_topic ON source_references(topic_id) WHERE is_current = 1 AND source_role = 'primary_session'",
  "CREATE UNIQUE INDEX one_current_note_folder_owner ON source_references(opaque_identifier) WHERE is_current = 1 AND source_role = 'note_folder'",
  "CREATE UNIQUE INDEX one_current_conversation_owner ON source_references(opaque_identifier) WHERE is_current = 1 AND source_role IN ('primary_session', 'topic_conversation')",
  `CREATE TABLE convention_state (
    convention_key TEXT PRIMARY KEY CHECK (length(convention_key) BETWEEN 1 AND 160),
    management_state TEXT NOT NULL CHECK (management_state IN ('managed', 'customized')),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE presentation_preferences (
    preference_key TEXT PRIMARY KEY CHECK (length(preference_key) BETWEEN 1 AND 160),
    preference_value TEXT NOT NULL CHECK (length(preference_value) <= 2048),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE attention_activity_links (
    link_id TEXT PRIMARY KEY CHECK (length(link_id) BETWEEN 1 AND 160),
    topic_id TEXT REFERENCES topics(topic_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    attention_identifier TEXT NOT NULL CHECK (length(attention_identifier) BETWEEN 1 AND 512),
    activity_identifier TEXT NOT NULL CHECK (length(activity_identifier) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE structural_change_proposals (
    proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) BETWEEN 1 AND 160),
    topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    change_kind TEXT NOT NULL CHECK (change_kind IN ('classification', 'source_ownership', 'primary_session', 'archive_restore', 'topology')),
    proposal_state TEXT NOT NULL CHECK (proposal_state IN ('proposed', 'accepted', 'rejected', 'applied')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE policy_versions (
    policy_name TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version > 0)
  )`,
  "INSERT INTO policy_versions (policy_name, version) VALUES ('command-center-metadata', 1)",
  // Projection structures are intentionally optional. They are derived only
  // from Topic and Source Reference metadata and may be dropped/rebuilt.
  `CREATE TABLE projection_topic_summary (
    topic_id TEXT PRIMARY KEY REFERENCES topics(topic_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    para_category TEXT NOT NULL,
    current_source_count INTEGER NOT NULL CHECK (current_source_count >= 0)
  )`,
  `CREATE TABLE projection_metadata (
    projection_name TEXT PRIMARY KEY,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    rebuilt_at TEXT NOT NULL
  )`
]);

function schemaStatementMap(kind) {
  const pattern = new RegExp(`^CREATE (?:UNIQUE )?${kind} ([a-z_]+)`, 'i');
  return new Map(initialSchemaStatements.map((statement) => [pattern.exec(statement.trim())?.[1], statement]).filter(([name]) => name));
}

// These are complete durable definitions, rather than a few representative
// fragments. Changing a durable constraint is corruption until a forward
// migration explicitly updates this schema contract.
const tableStatements = schemaStatementMap('TABLE');
const indexStatements = schemaStatementMap('INDEX');
export const requiredTableDefinitions = Object.freeze(Object.fromEntries(requiredTables.map((table) => [table, tableStatements.get(table)])));
export const requiredIndexDefinitions = Object.freeze(Object.fromEntries(requiredIndexes.map((index) => [index, indexStatements.get(index)])));
