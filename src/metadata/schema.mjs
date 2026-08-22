export const COMMAND_CENTER_SCHEMA_VERSION = 1;

export const metadataTableNames = Object.freeze([
  'topics',
  'source_references',
  'source_convention_state',
  'presentation_preferences',
  'attention_activity_links',
  'proposal_states',
  'policy_versions',
  'projection_bookkeeping'
]);

export const paraCategories = Object.freeze(['project', 'area', 'resource', 'archive']);
export const topicLifecycles = Object.freeze(['provisioning', 'active', 'retired']);
export const conventionAspects = Object.freeze(['name', 'location', 'display_label']);
export const conventionStates = Object.freeze(['managed', 'customized']);
export const proposalStates = Object.freeze(['pending', 'accepted', 'rejected', 'withdrawn']);

export const metadataSchemaSql = `
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

PRAGMA user_version = 1;
`;

const expectedColumns = Object.freeze({
  topics: [['topic_id', 'TEXT', 1, 1], ['para_category', 'TEXT', 1, 0], ['lifecycle', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  source_references: [['reference_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['source_system', 'TEXT', 1, 0], ['source_kind', 'TEXT', 1, 0], ['external_source_id', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  source_convention_state: [['reference_id', 'TEXT', 1, 1], ['aspect', 'TEXT', 1, 2], ['state', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  presentation_preferences: [['topic_id', 'TEXT', 1, 1], ['display_label', 'TEXT', 1, 0], ['sort_order', 'INTEGER', 1, 0], ['collapsed', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  attention_activity_links: [['link_id', 'TEXT', 1, 1], ['attention_id', 'TEXT', 1, 0], ['activity_id', 'TEXT', 1, 0], ['topic_id', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0]],
  proposal_states: [['proposal_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  policy_versions: [['policy_id', 'TEXT', 1, 1], ['version', 'TEXT', 1, 0], ['digest', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  projection_bookkeeping: [['projection_id', 'TEXT', 1, 1], ['source_revision', 'TEXT', 1, 0], ['input_digest', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]]
});

const expectedForeignKeys = Object.freeze({
  source_references: ['topics|topic_id|topic_id|RESTRICT'],
  source_convention_state: ['source_references|reference_id|reference_id|CASCADE'],
  presentation_preferences: ['topics|topic_id|topic_id|CASCADE'],
  attention_activity_links: ['topics|topic_id|topic_id|CASCADE'],
  proposal_states: ['topics|topic_id|topic_id|CASCADE']
});

const expectedIndexes = Object.freeze({});

function normalizedSql(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().replace(/;$/u, '');
}

const expectedTableDefinitions = Object.freeze(Object.fromEntries(
  [...metadataSchemaSql.matchAll(/CREATE TABLE ([a-z_]+) \([\s\S]*?\n\) STRICT;/gu)]
    .map((match) => [match[1], normalizedSql(match[0])])
));

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function inspectSchema(database) {
  const problems = [];
  const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = objects.filter((row) => row.type === 'table').map((row) => row.name);
  if (!sameArray(tables, [...metadataTableNames].sort())) problems.push('application table set differs');
  const allowedObjects = new Set(metadataTableNames);
  if (objects.some((row) => !allowedObjects.has(row.name))) problems.push('unexpected application schema object');

  for (const table of metadataTableNames) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row.type, row.notnull, row.pk]);
    if (!sameArray(columns.map((row) => JSON.stringify(row)), (expectedColumns[table] ?? []).map((row) => JSON.stringify(row)))) problems.push(`${table} columns differ`);
    const tableShape = database.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table);
    if (!tableShape || tableShape.strict !== 1) problems.push(`${table} is not STRICT`);
    const ddl = normalizedSql(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql);
    if (ddl !== expectedTableDefinitions[table]) problems.push(`${table} definition differs`);
  }

  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const expectedIndexNames = Object.keys(expectedIndexes).sort();
  if (!sameArray(indexes, expectedIndexNames)) problems.push('application index set differs');
  for (const index of expectedIndexNames) {
    const expected = expectedIndexes[index];
    const columns = database.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index).map((row) => row.name);
    if (!sameArray(columns, expected.columns)) problems.push(`${index} columns differ`);
    const listed = database.prepare('PRAGMA index_list(source_references)').all().find((row) => row.name === index);
    if (!listed || listed.unique !== 1) problems.push(`${index} is not UNIQUE`);
    if (!listed || listed.partial !== expected.partial) problems.push(`${index} partial flag differs`);
    if (listed && listed.origin !== 'c') problems.push(`${index} origin differs`);
    const indexSql = normalizedSql(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)?.sql);
    if (indexSql !== normalizedSql(expected.sql)) problems.push(`${index} definition differs`);
  }
  for (const table of metadataTableNames) {
    const actual = database.prepare(`PRAGMA foreign_key_list(${table})`).all().map((row) => `${row.table}|${row.from}|${row.to}|${row.on_delete}`).sort();
    const expected = [...(expectedForeignKeys[table] ?? [])].sort();
    if (!sameArray(actual, expected)) problems.push(`${table} foreign keys differ`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) problems.push('foreign-key integrity check failed');
  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze(problems) });
}
