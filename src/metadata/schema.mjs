export const SOURCE_SCHEMA_VERSION = 1;
export const LEGACY_METADATA_SCHEMA_VERSION = 2;
export const LEGACY_MIGRATION_SCHEMA_VERSION = 3;
export const ATTENTION_METADATA_SCHEMA_VERSION = 4;
export const PRIOR_COMMAND_CENTER_SCHEMA_VERSION = 5;
export const SCHEMA_SIX_COMMAND_CENTER_VERSION = 6;
export const SCHEMA_SEVEN_COMMAND_CENTER_VERSION = 7;
export const COMMAND_CENTER_SCHEMA_VERSION = 8;

export const metadataTableNames = Object.freeze([
  'topics', 'source_references', 'source_convention_state', 'presentation_preferences',
  'attention_activity_links', 'proposal_states', 'policy_versions', 'projection_bookkeeping',
  'operation_journal', 'session_state', 'activity_records', 'migration_state',
  'migration_channels', 'migration_occurrences', 'migration_completion',
  'attention_episodes', 'attention_occurrences', 'attention_attempts',
  'attention_approvals', 'attention_activity_records'
  , 'source_locators', 'topic_operations', 'source_recovery'
  , 'notification_settings', 'notification_policy_epochs', 'notification_slots',
  'notification_emissions', 'notification_clear_operations'
  , 'topic_analysis_settings', 'topic_analysis_runs', 'topic_analysis_watermarks',
  'topic_analysis_cursors', 'topic_analysis_evidence', 'topic_proposals', 'topic_reviews',
  'topic_application_plans', 'topic_application_steps'
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

const metadataSchemaV4AttentionTablesSql = `
CREATE TABLE attention_episodes (
  episode_id TEXT PRIMARY KEY,
  identity_digest TEXT NOT NULL CHECK (length(trim(identity_digest)) > 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  source_capability_id TEXT NOT NULL CHECK (length(trim(source_capability_id)) > 0),
  stable_subject_id TEXT NOT NULL CHECK (length(trim(stable_subject_id)) > 0),
  attention_reason TEXT NOT NULL CHECK (length(trim(attention_reason)) > 0),
  state TEXT NOT NULL CHECK (state IN ('Active', 'Snoozed', 'Action running', 'Resolved', 'Withdrawn')),
  severity TEXT NOT NULL CHECK (severity IN ('Routine', 'High', 'Critical')),
  attention_since TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  terminal_at TEXT,
  snoozed_until TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  topic_id TEXT,
  source_reference_id TEXT,
  diagnosis_json TEXT NOT NULL CHECK (length(trim(diagnosis_json)) > 0),
  evidence_json TEXT NOT NULL CHECK (length(trim(evidence_json)) > 0),
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE attention_occurrences (
  occurrence_row_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES attention_episodes(episode_id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  occurrence_version TEXT,
  occurred_at TEXT NOT NULL,
  derived_severity TEXT NOT NULL CHECK (derived_severity IN ('Routine', 'High', 'Critical')),
  evidence_json TEXT NOT NULL CHECK (length(trim(evidence_json)) > 0),
  transition_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (episode_id, occurrence_key)
) STRICT;

CREATE TABLE attention_attempts (
  attempt_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES attention_episodes(episode_id) ON DELETE CASCADE,
  logical_operation_id TEXT NOT NULL UNIQUE,
  action_id TEXT NOT NULL CHECK (length(trim(action_id)) > 0),
  expected_episode_revision INTEGER NOT NULL CHECK (expected_episode_revision >= 1),
  expected_source_revision TEXT,
  target_json TEXT NOT NULL CHECK (length(trim(target_json)) > 0),
  parameters_json TEXT NOT NULL CHECK (length(trim(parameters_json)) > 0),
  disclosure_digest TEXT NOT NULL CHECK (length(trim(disclosure_digest)) > 0),
  idempotent_retryable INTEGER NOT NULL CHECK (idempotent_retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'applied', 'not-applied', 'partial', 'conflict', 'unknown', 'failed')),
  outcome TEXT,
  verification_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE attention_approvals (
  approval_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attention_attempts(attempt_id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES attention_episodes(episode_id) ON DELETE CASCADE,
  episode_revision INTEGER NOT NULL CHECK (episode_revision >= 1),
  diagnosis_json TEXT NOT NULL CHECK (length(trim(diagnosis_json)) > 0),
  target_json TEXT NOT NULL CHECK (length(trim(target_json)) > 0),
  parameters_json TEXT NOT NULL CHECK (length(trim(parameters_json)) > 0),
  plan_revision TEXT NOT NULL CHECK (length(trim(plan_revision)) > 0),
  side_effects_json TEXT NOT NULL CHECK (length(trim(side_effects_json)) > 0),
  host TEXT NOT NULL CHECK (length(trim(host)) > 0),
  operator_id TEXT NOT NULL CHECK (length(trim(operator_id)) > 0),
  precondition_revision TEXT NOT NULL CHECK (length(trim(precondition_revision)) > 0),
  policy_revision TEXT NOT NULL CHECK (length(trim(policy_revision)) > 0),
  disclosure_digest TEXT NOT NULL CHECK (length(trim(disclosure_digest)) > 0),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'consumed', 'expired', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE attention_activity_records (
  activity_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES attention_episodes(episode_id) ON DELETE RESTRICT,
  logical_operation_id TEXT NOT NULL,
  attempt_id TEXT,
  topic_id TEXT,
  source_reference_id TEXT,
  actor_mode TEXT NOT NULL CHECK (actor_mode IN ('automatic', 'manual', 'system')),
  action_id TEXT,
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'failed', 'not-applied', 'partial', 'conflict', 'unknown', 'resolved', 'withdrawn')),
  verification_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER attention_activity_records_no_update
BEFORE UPDATE ON attention_activity_records
BEGIN
  SELECT RAISE(ABORT, 'attention Activity is append-only');
END;

CREATE TRIGGER attention_activity_records_no_delete
BEFORE DELETE ON attention_activity_records
BEGIN
  SELECT RAISE(ABORT, 'attention Activity is append-only');
END;
`;

export const metadataSchemaV2Sql = `${metadataSchemaV2CoreSql}${schemaLedgerSql}\nPRAGMA user_version = 2;\n`;
export const metadataSchemaV3Sql = `${metadataSchemaV2CoreSql.replace('PRAGMA user_version = 2;', 'PRAGMA user_version = 3;')}${metadataSchemaV3MigrationTablesSql}${schemaLedgerSql}\nPRAGMA user_version = 3;\n`;
export const metadataSchemaV4Sql = `${metadataSchemaV2CoreSql.replace('PRAGMA user_version = 2;', 'PRAGMA user_version = 4;')}${metadataSchemaV3MigrationTablesSql}${metadataSchemaV4AttentionTablesSql}${schemaLedgerSql}\nPRAGMA user_version = 4;\n`;
export const metadataSchemaV5Sql = metadataSchemaV4Sql
  .replace('  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),\n  updated_at TEXT NOT NULL\n) STRICT;', '  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),\n  updated_at TEXT NOT NULL,\n  was_primary INTEGER NOT NULL DEFAULT 0 CHECK (was_primary IN (0, 1)),\n  display_name TEXT NOT NULL DEFAULT \'\' CHECK (length(display_name) <= 300)\n) STRICT;')
  .replaceAll('PRAGMA user_version = 4;', 'PRAGMA user_version = 5;');

const metadataSchemaV6TopicTablesSql = `
CREATE TABLE source_locators (
  reference_id TEXT PRIMARY KEY REFERENCES source_references(reference_id) ON DELETE CASCADE,
  locator TEXT NOT NULL CHECK (length(trim(locator)) > 0),
  locator_version INTEGER NOT NULL DEFAULT 1 CHECK (locator_version >= 1),
  ownership TEXT NOT NULL CHECK (ownership IN ('created', 'adopted', 'external')),
  observed_revision TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_operations (
  logical_operation_id TEXT PRIMARY KEY,
  topic_id TEXT REFERENCES topics(topic_id) ON DELETE SET NULL,
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'not-applied', 'conflict', 'unknown')),
  current_step TEXT NOT NULL CHECK (length(trim(current_step)) > 0),
  intent_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_recovery (
  recovery_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL REFERENCES source_references(reference_id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('note_folder', 'session')),
  state TEXT NOT NULL CHECK (state IN ('required', 'resolved', 'replaced')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_locator TEXT,
  last_identity TEXT,
  failure TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

export const metadataSchemaV6Sql = `${metadataSchemaV5Sql.replace('PRAGMA user_version = 5;', 'PRAGMA user_version = 6;')
  .replace('  updated_at TEXT NOT NULL\n) STRICT;\n\nCREATE TABLE source_references', "  updated_at TEXT NOT NULL,\n  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),\n  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 300),\n  activated_at TEXT\n) STRICT;\n\nCREATE TABLE source_references")
  .replace("  state TEXT NOT NULL CHECK (state IN ('managed', 'customized')),\n  updated_at TEXT NOT NULL,", "  state TEXT NOT NULL CHECK (state IN ('managed', 'customized')),\n  updated_at TEXT NOT NULL,\n  expected_value TEXT,")}${metadataSchemaV6TopicTablesSql}\nPRAGMA user_version = 6;\n`;

const metadataSchemaV7NotificationTablesSql = `
CREATE TABLE notification_settings (
  settings_id TEXT PRIMARY KEY CHECK (settings_id = 'global'),
  due_reminders INTEGER NOT NULL CHECK (due_reminders IN (0, 1)),
  important_items INTEGER NOT NULL CHECK (important_items IN (0, 1)),
  critical_realerts INTEGER NOT NULL CHECK (critical_realerts IN (0, 1)),
  quiet_hours_enabled INTEGER NOT NULL CHECK (quiet_hours_enabled IN (0, 1)),
  quiet_hours_start TEXT NOT NULL CHECK (quiet_hours_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  quiet_hours_end TEXT NOT NULL CHECK (quiet_hours_end GLOB '[0-2][0-9]:[0-5][0-9]'),
  time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) > 0),
  generic_preview INTEGER NOT NULL CHECK (generic_preview IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE notification_policy_epochs (
  epoch_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL CHECK (length(trim(episode_id)) > 0),
  severity TEXT NOT NULL CHECK (severity IN ('Reminder', 'High', 'Critical')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  activation_at_ms INTEGER NOT NULL,
  active_accumulated_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_accumulated_ms >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'terminal', 'cleared')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (episode_id, generation)
) STRICT;

CREATE TABLE notification_slots (
  slot_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  slot_kind TEXT NOT NULL CHECK (length(trim(slot_kind)) > 0),
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'emitted', 'cancelled')),
  logical_operation_id TEXT,
  emission_id TEXT,
  queued_at_ms INTEGER,
  emitted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (epoch_id, slot_kind)
) STRICT;

CREATE TABLE notification_emissions (
  emission_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  logical_operation_id TEXT NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  generic_preview INTEGER NOT NULL CHECK (generic_preview IN (0, 1)),
  summary_count INTEGER NOT NULL DEFAULT 0 CHECK (summary_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('sent', 'partial', 'failed', 'ambiguous', 'suppressed', 'expired', 'cleared')),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE notification_clear_operations (
  logical_operation_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'cleared', 'partial', 'ambiguous')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;

const metadataSchemaV8TopicAnalysisTablesSql = `
CREATE TABLE topic_analysis_settings (
  settings_id TEXT PRIMARY KEY CHECK (settings_id = 'global'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_time TEXT NOT NULL CHECK (local_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  next_due_at TEXT,
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_analysis_runs (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  trigger TEXT NOT NULL CHECK (trigger IN ('weekly', 'manual', 'catch-up')),
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'success', 'failed')),
  baseline_cursor_json TEXT NOT NULL,
  success_cursor_json TEXT,
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  evaluated_count INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_count >= 0),
  proposal_count INTEGER NOT NULL DEFAULT 0 CHECK (proposal_count >= 0),
  retained_overflow_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_overflow_count >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
) STRICT;

CREATE TABLE topic_analysis_watermarks (
  subject_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('topic', 'source')),
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  observed_revision TEXT NOT NULL,
  last_success_run_id TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_analysis_cursors (
  cursor_id TEXT PRIMARY KEY CHECK (cursor_id = 'global'),
  next_topic_id TEXT,
  next_source_id TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_analysis_evidence (
  evidence_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES topic_proposals(proposal_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  fact TEXT NOT NULL CHECK (length(trim(fact)) BETWEEN 1 AND 320),
  material INTEGER NOT NULL CHECK (material IN (0, 1)),
  kind TEXT CHECK (kind IS NULL OR length(kind) BETWEEN 1 AND 80),
  observed_at TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1))
) STRICT;

CREATE TABLE topic_proposals (
  proposal_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  predecessor_id TEXT,
  successor_id TEXT,
  operation TEXT NOT NULL,
  affected_topic_ids_json TEXT NOT NULL,
  affected_source_ids_json TEXT NOT NULL,
  planned_source_ids_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  provenance_json TEXT NOT NULL,
  consequences_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  reversibility_json TEXT NOT NULL,
  material_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'adjusted', 'kept', 'suppressed', 'superseded', 'applied', 'failed', 'blocked')),
  decision_revision INTEGER,
  suppressed_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_reviews (
  review_id TEXT PRIMARY KEY CHECK (review_id = 'topic-review:global'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  episode_revision INTEGER NOT NULL CHECK (episode_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('Active', 'Snoozed', 'Resolved')),
  snoozed_until TEXT,
  groups_json TEXT NOT NULL,
  retained_blockers_json TEXT NOT NULL,
  application_summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_application_plans (
  application_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  plan_revision TEXT NOT NULL,
  review_revision INTEGER NOT NULL CHECK (review_revision >= 0),
  current_proposals_json TEXT NOT NULL,
  approved_proposals_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preview', 'running', 'complete', 'failed')),
  outcomes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE topic_application_steps (
  application_id TEXT NOT NULL REFERENCES topic_application_plans(application_id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES topic_proposals(proposal_id) ON DELETE RESTRICT,
  logical_operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  preconditions_json TEXT NOT NULL,
  compensation_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'applied', 'failed', 'blocked', 'compensated', 'source-recovery', 'ambiguous')),
  outcome_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (application_id, step_id),
  UNIQUE (logical_operation_id)
) STRICT;
`;

export const metadataSchemaV7Sql = `${metadataSchemaV6Sql.replace('PRAGMA user_version = 6;', 'PRAGMA user_version = 7;').replaceAll("outcome IN ('applied', 'failed', 'not-applied', 'conflict', 'unknown')", "outcome IN ('applied', 'not-applied', 'conflict', 'unknown')")}${metadataSchemaV7NotificationTablesSql}\nPRAGMA user_version = 7;\n`;
export const metadataSchemaSql = `${metadataSchemaV7Sql.replace("outcome IN ('applied', 'not-applied', 'conflict', 'unknown')", "outcome IN ('applied', 'failed', 'not-applied', 'conflict', 'unknown')").replace('PRAGMA user_version = 7;', 'PRAGMA user_version = 8;')}${metadataSchemaV8TopicAnalysisTablesSql}\nPRAGMA user_version = 8;\n`;

const baseColumns = Object.freeze({
  topics: [['topic_id', 'TEXT', 1, 1], ['para_category', 'TEXT', 1, 0], ['lifecycle', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['name', 'TEXT', 1, 0], ['activated_at', 'TEXT', 0, 0]],
  source_references: [['reference_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['source_system', 'TEXT', 1, 0], ['source_kind', 'TEXT', 1, 0], ['external_source_id', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['last_observed_revision', 'TEXT', 0, 0]],
  source_convention_state: [['reference_id', 'TEXT', 1, 1], ['aspect', 'TEXT', 1, 2], ['state', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['expected_value', 'TEXT', 0, 0]],
  presentation_preferences: [['topic_id', 'TEXT', 1, 1], ['display_label', 'TEXT', 1, 0], ['sort_order', 'INTEGER', 1, 0], ['collapsed', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  attention_activity_links: [['link_id', 'TEXT', 1, 1], ['attention_id', 'TEXT', 1, 0], ['activity_id', 'TEXT', 1, 0], ['topic_id', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0]],
  proposal_states: [['proposal_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  policy_versions: [['policy_id', 'TEXT', 1, 1], ['version', 'TEXT', 1, 0], ['digest', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  projection_bookkeeping: [['projection_id', 'TEXT', 1, 1], ['source_revision', 'TEXT', 1, 0], ['input_digest', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  operation_journal: [['logical_operation_id', 'TEXT', 1, 1], ['transport_request_id', 'TEXT', 1, 0], ['intent_digest', 'TEXT', 1, 0], ['operation_kind', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['result_status', 'TEXT', 0, 0], ['result_identity', 'TEXT', 0, 0], ['observed_revision', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  session_state: [['reference_id', 'TEXT', 1, 1], ['session_id', 'TEXT', 0, 0], ['status', 'TEXT', 1, 0], ['is_primary', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0], ['was_primary', 'INTEGER', 1, 0], ['display_name', 'TEXT', 1, 0]],
  activity_records: [['activity_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 0, 0], ['logical_operation_id', 'TEXT', 1, 0], ['transport_request_id', 'TEXT', 1, 0], ['operation_kind', 'TEXT', 1, 0], ['outcome', 'TEXT', 1, 0], ['observed_revision', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  migration_state: [['state_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['config_digest', 'TEXT', 1, 0], ['source_digest', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['phase', 'TEXT', 1, 0], ['failure_code', 'TEXT', 0, 0], ['failure_summary', 'TEXT', 0, 0], ['failure_count', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  migration_channels: [['source_channel_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['note_folder_reference_id', 'TEXT', 1, 0], ['session_reference_id', 'TEXT', 1, 0], ['session_id', 'TEXT', 1, 0], ['phase', 'TEXT', 1, 0], ['expected_count', 'INTEGER', 1, 0], ['expected_digest', 'TEXT', 1, 0], ['imported_count', 'INTEGER', 1, 0], ['imported_digest', 'TEXT', 1, 0], ['next_ordinal', 'INTEGER', 1, 0], ['failure_code', 'TEXT', 0, 0], ['failure_summary', 'TEXT', 0, 0], ['failure_count', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  migration_occurrences: [['source_channel_id', 'TEXT', 1, 1], ['occurrence_id', 'TEXT', 1, 2], ['occurrence_digest', 'TEXT', 1, 0], ['display_order', 'INTEGER', 1, 0], ['destination_message_id', 'TEXT', 0, 0], ['destination_anchor_json', 'TEXT', 0, 0], ['destination_anchor_digest', 'TEXT', 0, 0]],
  migration_completion: [['completion_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['config_digest', 'TEXT', 1, 0], ['source_digest', 'TEXT', 1, 0], ['verified_channel_count', 'INTEGER', 1, 0], ['verified_occurrence_count', 'INTEGER', 1, 0], ['completion_revision', 'INTEGER', 1, 0], ['verified_at', 'TEXT', 1, 0]],
  attention_episodes: [['episode_id', 'TEXT', 1, 1], ['identity_digest', 'TEXT', 1, 0], ['generation', 'INTEGER', 1, 0], ['source_capability_id', 'TEXT', 1, 0], ['stable_subject_id', 'TEXT', 1, 0], ['attention_reason', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['severity', 'TEXT', 1, 0], ['attention_since', 'TEXT', 1, 0], ['occurred_at', 'TEXT', 1, 0], ['terminal_at', 'TEXT', 0, 0], ['snoozed_until', 'TEXT', 0, 0], ['revision', 'INTEGER', 1, 0], ['topic_id', 'TEXT', 0, 0], ['source_reference_id', 'TEXT', 0, 0], ['diagnosis_json', 'TEXT', 1, 0], ['evidence_json', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0]],
  attention_occurrences: [['occurrence_row_id', 'TEXT', 1, 1], ['episode_id', 'TEXT', 1, 0], ['occurrence_key', 'TEXT', 1, 0], ['occurrence_version', 'TEXT', 0, 0], ['occurred_at', 'TEXT', 1, 0], ['derived_severity', 'TEXT', 1, 0], ['evidence_json', 'TEXT', 1, 0], ['transition_json', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0]],
  attention_attempts: [['attempt_id', 'TEXT', 1, 1], ['episode_id', 'TEXT', 1, 0], ['logical_operation_id', 'TEXT', 1, 0], ['action_id', 'TEXT', 1, 0], ['expected_episode_revision', 'INTEGER', 1, 0], ['expected_source_revision', 'TEXT', 0, 0], ['target_json', 'TEXT', 1, 0], ['parameters_json', 'TEXT', 1, 0], ['disclosure_digest', 'TEXT', 1, 0], ['idempotent_retryable', 'INTEGER', 1, 0], ['retry_count', 'INTEGER', 1, 0], ['state', 'TEXT', 1, 0], ['outcome', 'TEXT', 0, 0], ['verification_revision', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  attention_approvals: [['approval_id', 'TEXT', 1, 1], ['attempt_id', 'TEXT', 1, 0], ['episode_id', 'TEXT', 1, 0], ['episode_revision', 'INTEGER', 1, 0], ['diagnosis_json', 'TEXT', 1, 0], ['target_json', 'TEXT', 1, 0], ['parameters_json', 'TEXT', 1, 0], ['plan_revision', 'TEXT', 1, 0], ['side_effects_json', 'TEXT', 1, 0], ['host', 'TEXT', 1, 0], ['operator_id', 'TEXT', 1, 0], ['precondition_revision', 'TEXT', 1, 0], ['policy_revision', 'TEXT', 1, 0], ['disclosure_digest', 'TEXT', 1, 0], ['expires_at', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  attention_activity_records: [['activity_id', 'TEXT', 1, 1], ['episode_id', 'TEXT', 1, 0], ['logical_operation_id', 'TEXT', 1, 0], ['attempt_id', 'TEXT', 0, 0], ['topic_id', 'TEXT', 0, 0], ['source_reference_id', 'TEXT', 0, 0], ['actor_mode', 'TEXT', 1, 0], ['action_id', 'TEXT', 0, 0], ['operation_kind', 'TEXT', 1, 0], ['outcome', 'TEXT', 1, 0], ['verification_revision', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  source_locators: [['reference_id', 'TEXT', 1, 1], ['locator', 'TEXT', 1, 0], ['locator_version', 'INTEGER', 1, 0], ['ownership', 'TEXT', 1, 0], ['observed_revision', 'TEXT', 0, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_operations: [['logical_operation_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 0, 0], ['operation_kind', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['current_step', 'TEXT', 1, 0], ['intent_json', 'TEXT', 1, 0], ['result_json', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  source_recovery: [['recovery_id', 'TEXT', 1, 1], ['topic_id', 'TEXT', 1, 0], ['reference_id', 'TEXT', 1, 0], ['source_kind', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['last_locator', 'TEXT', 0, 0], ['last_identity', 'TEXT', 0, 0], ['failure', 'TEXT', 1, 0], ['diagnostics_json', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]]
  , topic_analysis_settings: [['settings_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['enabled', 'INTEGER', 1, 0], ['weekday', 'INTEGER', 1, 0], ['local_time', 'TEXT', 1, 0], ['time_zone', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['next_due_at', 'TEXT', 0, 0], ['initialized', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_analysis_runs: [['run_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['trigger', 'TEXT', 1, 0], ['outcome', 'TEXT', 1, 0], ['baseline_cursor_json', 'TEXT', 1, 0], ['success_cursor_json', 'TEXT', 0, 0], ['changed_count', 'INTEGER', 1, 0], ['evaluated_count', 'INTEGER', 1, 0], ['proposal_count', 'INTEGER', 1, 0], ['retained_overflow_count', 'INTEGER', 1, 0], ['started_at', 'TEXT', 1, 0], ['finished_at', 'TEXT', 0, 0], ['error', 'TEXT', 0, 0]],
  topic_analysis_watermarks: [['subject_id', 'TEXT', 1, 1], ['subject_type', 'TEXT', 1, 0], ['topic_id', 'TEXT', 1, 0], ['observed_revision', 'TEXT', 1, 0], ['last_success_run_id', 'TEXT', 0, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_analysis_cursors: [['cursor_id', 'TEXT', 1, 1], ['next_topic_id', 'TEXT', 0, 0], ['next_source_id', 'TEXT', 0, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_analysis_evidence: [['evidence_id', 'TEXT', 1, 1], ['proposal_id', 'TEXT', 1, 0], ['source_id', 'TEXT', 1, 0], ['source_revision', 'TEXT', 1, 0], ['fact', 'TEXT', 1, 0], ['material', 'INTEGER', 1, 0], ['kind', 'TEXT', 0, 0], ['observed_at', 'TEXT', 1, 0], ['current', 'INTEGER', 1, 0]],
  topic_proposals: [['proposal_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['revision', 'INTEGER', 1, 0], ['predecessor_id', 'TEXT', 0, 0], ['successor_id', 'TEXT', 0, 0], ['operation', 'TEXT', 1, 0], ['affected_topic_ids_json', 'TEXT', 1, 0], ['affected_source_ids_json', 'TEXT', 1, 0], ['planned_source_ids_json', 'TEXT', 1, 0], ['before_json', 'TEXT', 1, 0], ['after_json', 'TEXT', 1, 0], ['rationale', 'TEXT', 1, 0], ['provenance_json', 'TEXT', 1, 0], ['consequences_json', 'TEXT', 1, 0], ['dependencies_json', 'TEXT', 1, 0], ['blockers_json', 'TEXT', 1, 0], ['reversibility_json', 'TEXT', 1, 0], ['material_digest', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['decision_revision', 'INTEGER', 0, 0], ['suppressed_digest', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_reviews: [['review_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['episode_revision', 'INTEGER', 1, 0], ['state', 'TEXT', 1, 0], ['snoozed_until', 'TEXT', 0, 0], ['groups_json', 'TEXT', 1, 0], ['retained_blockers_json', 'TEXT', 1, 0], ['application_summary_json', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_application_plans: [['application_id', 'TEXT', 1, 1], ['schema_version', 'INTEGER', 1, 0], ['plan_revision', 'TEXT', 1, 0], ['review_revision', 'INTEGER', 1, 0], ['current_proposals_json', 'TEXT', 1, 0], ['approved_proposals_json', 'TEXT', 1, 0], ['dependencies_json', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0], ['outcomes_json', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  topic_application_steps: [['application_id', 'TEXT', 1, 1], ['step_id', 'TEXT', 1, 2], ['proposal_id', 'TEXT', 1, 0], ['logical_operation_id', 'TEXT', 1, 0], ['operation_kind', 'TEXT', 1, 0], ['intent_json', 'TEXT', 1, 0], ['preconditions_json', 'TEXT', 1, 0], ['compensation_json', 'TEXT', 1, 0], ['state', 'TEXT', 1, 0], ['outcome_json', 'TEXT', 0, 0], ['updated_at', 'TEXT', 1, 0]],
  notification_settings: [['settings_id', 'TEXT', 1, 1], ['due_reminders', 'INTEGER', 1, 0], ['important_items', 'INTEGER', 1, 0], ['critical_realerts', 'INTEGER', 1, 0], ['quiet_hours_enabled', 'INTEGER', 1, 0], ['quiet_hours_start', 'TEXT', 1, 0], ['quiet_hours_end', 'TEXT', 1, 0], ['time_zone', 'TEXT', 1, 0], ['generic_preview', 'INTEGER', 1, 0], ['revision', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0]],
  notification_policy_epochs: [['epoch_id', 'TEXT', 1, 1], ['episode_id', 'TEXT', 1, 0], ['severity', 'TEXT', 1, 0], ['generation', 'INTEGER', 1, 0], ['activation_at_ms', 'INTEGER', 1, 0], ['active_accumulated_ms', 'INTEGER', 1, 0], ['state', 'TEXT', 1, 0], ['created_at_ms', 'INTEGER', 1, 0], ['updated_at_ms', 'INTEGER', 1, 0]],
  notification_slots: [['slot_id', 'TEXT', 1, 1], ['epoch_id', 'TEXT', 1, 0], ['episode_id', 'TEXT', 1, 0], ['slot_kind', 'TEXT', 1, 0], ['due_at_ms', 'INTEGER', 1, 0], ['status', 'TEXT', 1, 0], ['logical_operation_id', 'TEXT', 0, 0], ['emission_id', 'TEXT', 0, 0], ['queued_at_ms', 'INTEGER', 0, 0], ['emitted_at_ms', 'INTEGER', 0, 0], ['created_at_ms', 'INTEGER', 1, 0], ['updated_at_ms', 'INTEGER', 1, 0]],
  notification_emissions: [['emission_id', 'TEXT', 1, 1], ['epoch_id', 'TEXT', 1, 0], ['episode_id', 'TEXT', 1, 0], ['logical_operation_id', 'TEXT', 1, 0], ['emitted_at_ms', 'INTEGER', 1, 0], ['expires_at_ms', 'INTEGER', 1, 0], ['generic_preview', 'INTEGER', 1, 0], ['summary_count', 'INTEGER', 1, 0], ['status', 'TEXT', 1, 0], ['updated_at_ms', 'INTEGER', 1, 0]],
  notification_clear_operations: [['logical_operation_id', 'TEXT', 1, 1], ['episode_id', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0], ['attempt_count', 'INTEGER', 1, 0], ['updated_at_ms', 'INTEGER', 1, 0]]
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
  migration_occurrences: ['migration_channels|source_channel_id|source_channel_id|CASCADE'],
  attention_occurrences: ['attention_episodes|episode_id|episode_id|CASCADE'],
  attention_attempts: ['attention_episodes|episode_id|episode_id|CASCADE'],
  attention_approvals: ['attention_attempts|attempt_id|attempt_id|CASCADE', 'attention_episodes|episode_id|episode_id|CASCADE'],
  attention_activity_records: ['attention_episodes|episode_id|episode_id|RESTRICT']
  , source_locators: ['source_references|reference_id|reference_id|CASCADE']
  , topic_operations: ['topics|topic_id|topic_id|SET NULL']
  , source_recovery: ['topics|topic_id|topic_id|CASCADE', 'source_references|reference_id|reference_id|CASCADE']
  , topic_analysis_watermarks: ['topics|topic_id|topic_id|CASCADE']
  , topic_analysis_evidence: ['topic_proposals|proposal_id|proposal_id|CASCADE']
  , topic_application_steps: ['topic_application_plans|application_id|application_id|CASCADE', 'topic_proposals|proposal_id|proposal_id|RESTRICT']
});
const expectedLedgerColumns = Object.freeze([
  ['sequence', 'INTEGER', 0, 1], ['migration_id', 'TEXT', 1, 0], ['migration_digest', 'TEXT', 1, 0],
  ['from_version', 'INTEGER', 1, 0], ['to_version', 'INTEGER', 1, 0], ['snapshot_id', 'TEXT', 1, 0],
  ['applied_build', 'TEXT', 1, 0], ['applied_at', 'TEXT', 1, 0]
]);
function normalizedSql(value) { return String(value ?? '').replace(/\s+/gu, ' ').replace(/\s+,/gu, ',').replace(/\)\s+\)/gu, '))').trim().replace(/;$/u, ''); }
function definitions(sql) {
  return Object.freeze(Object.fromEntries(
    [...sql.matchAll(/CREATE TABLE ([a-z_]+) \([\s\S]*?\n\) STRICT;/gu)].map((match) => [match[1], normalizedSql(match[0])])
  ));
}
const expectedTableDefinitions = definitions(metadataSchemaSql);
const expectedTableDefinitionsV7 = definitions(metadataSchemaV7Sql);
const expectedTableDefinitionsV6 = definitions(metadataSchemaV6Sql);
const expectedTableDefinitionsV4 = definitions(metadataSchemaV4Sql);
const expectedTableDefinitionsV3 = definitions(metadataSchemaV3Sql);
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
export const metadataSchemaV3ToV4Sql = `${metadataSchemaV4AttentionTablesSql}\nPRAGMA user_version = 4;\n`;
export const metadataSchemaV4ToV5Sql = `
ALTER TABLE session_state ADD COLUMN was_primary INTEGER NOT NULL DEFAULT 0 CHECK (was_primary IN (0, 1));
ALTER TABLE session_state ADD COLUMN display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 300);
PRAGMA user_version = 5;
`;
export const metadataSchemaV5ToV6Sql = `
ALTER TABLE topics ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE topics ADD COLUMN name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 300);
ALTER TABLE topics ADD COLUMN activated_at TEXT;
ALTER TABLE source_convention_state ADD COLUMN expected_value TEXT;
UPDATE topics SET name = COALESCE((SELECT NULLIF(trim(display_label), '') FROM presentation_preferences WHERE presentation_preferences.topic_id = topics.topic_id), topic_id);
UPDATE topics SET activated_at = updated_at WHERE lifecycle <> 'provisioning';
${metadataSchemaV6TopicTablesSql}
INSERT INTO source_locators (reference_id, locator, locator_version, ownership, observed_revision, updated_at)
SELECT reference_id, external_source_id, 1, 'external', last_observed_revision, updated_at FROM source_references;
PRAGMA user_version = 6;
`;

export const metadataSchemaV6ToV7Sql = `${metadataSchemaV7NotificationTablesSql}\nPRAGMA user_version = 7;\n`;
export const metadataSchemaV7ToV8Sql = `
ALTER TABLE activity_records RENAME TO activity_records_legacy;
CREATE TABLE activity_records (
  activity_id TEXT PRIMARY KEY,
  topic_id TEXT REFERENCES topics(topic_id) ON DELETE CASCADE,
  logical_operation_id TEXT NOT NULL,
  transport_request_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(trim(operation_kind)) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'failed', 'not-applied', 'conflict', 'unknown')),
  observed_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (logical_operation_id)
) STRICT;
INSERT INTO activity_records (activity_id, topic_id, logical_operation_id, transport_request_id, operation_kind, outcome, observed_revision, created_at, updated_at)
SELECT activity_id, topic_id, logical_operation_id, transport_request_id, operation_kind, outcome, observed_revision, created_at, updated_at FROM activity_records_legacy;
DROP TABLE activity_records_legacy;
${metadataSchemaV8TopicAnalysisTablesSql}
PRAGMA user_version = 8;
`;

const attentionTables = Object.freeze(['attention_episodes', 'attention_occurrences', 'attention_attempts', 'attention_approvals', 'attention_activity_records']);
const attentionActivityTriggers = Object.freeze(['attention_activity_records_no_delete', 'attention_activity_records_no_update']);
const migrationTables = Object.freeze(['migration_state', 'migration_channels', 'migration_occurrences', 'migration_completion']);
const topicLifecycleTables = Object.freeze(['source_locators', 'topic_operations', 'source_recovery']);
const notificationTables = Object.freeze(['notification_settings', 'notification_policy_epochs', 'notification_slots', 'notification_emissions', 'notification_clear_operations']);
const topicAnalysisTables = Object.freeze(['topic_analysis_settings', 'topic_analysis_runs', 'topic_analysis_watermarks', 'topic_analysis_cursors', 'topic_analysis_evidence', 'topic_proposals', 'topic_reviews', 'topic_application_plans', 'topic_application_steps']);
const v7Tables = Object.freeze(Object.keys(baseColumns).filter((table) => !topicAnalysisTables.includes(table)));
const v1Tables = Object.freeze(Object.keys(baseColumns).filter((table) => !['operation_journal', 'session_state', 'activity_records', ...migrationTables, ...attentionTables, ...topicLifecycleTables, ...notificationTables, ...topicAnalysisTables].includes(table)));
const v2Tables = Object.freeze(Object.keys(baseColumns).filter((table) => ![...migrationTables, ...attentionTables, ...topicLifecycleTables, ...notificationTables, ...topicAnalysisTables].includes(table)));
const v3Tables = Object.freeze(Object.keys(baseColumns).filter((table) => ![...attentionTables, ...topicLifecycleTables, ...notificationTables, ...topicAnalysisTables].includes(table)));
const columnsBeforeV5 = (table) => table === 'session_state' ? baseColumns[table].filter(([name]) => !['was_primary', 'display_name'].includes(name)) : baseColumns[table];
const v5Tables = Object.freeze(Object.keys(baseColumns).filter((table) => !topicLifecycleTables.includes(table) && !notificationTables.includes(table) && !topicAnalysisTables.includes(table)));
const v6Tables = Object.freeze(Object.keys(baseColumns).filter((table) => !notificationTables.includes(table) && !topicAnalysisTables.includes(table)));
const columnsForV5 = (table) => {
  if (table === 'topics') return baseColumns[table].filter(([name]) => !['revision', 'name', 'activated_at'].includes(name));
  if (table === 'source_convention_state') return baseColumns[table].filter(([name]) => name !== 'expected_value');
  return baseColumns[table];
};
const v5Columns = Object.freeze(Object.fromEntries(v5Tables.map((table) => [table, columnsForV5(table)])));
const v6Columns = Object.freeze(Object.fromEntries(v6Tables.map((table) => [table, baseColumns[table]])));
const v4Columns = Object.freeze(Object.fromEntries(v5Tables.map((table) => [table, columnsBeforeV5(table).filter(([name]) => table !== 'source_convention_state' || name !== 'expected_value').filter(([name]) => table !== 'topics' || !['revision', 'name', 'activated_at'].includes(name))])));
const v1Columns = Object.freeze(Object.fromEntries(v1Tables.map((table) => [table, table === 'source_references' ? v4Columns[table].filter(([name]) => name !== 'last_observed_revision') : v4Columns[table]])));
const v2Columns = Object.freeze(Object.fromEntries(v2Tables.map((table) => [table, v4Columns[table]])));
const v3Columns = Object.freeze(Object.fromEntries(v3Tables.map((table) => [table, v4Columns[table]])));
const v1Definitions = definitions(metadataSchemaV1Sql);
const v2ForeignKeys = Object.freeze(Object.fromEntries(v2Tables.map((table) => [table, baseForeignKeys[table] ?? []])));
const v3ForeignKeys = Object.freeze(Object.fromEntries(v3Tables.map((table) => [table, baseForeignKeys[table] ?? []])));
const v1ForeignKeys = Object.freeze(Object.fromEntries(v1Tables.map((table) => [table, v2ForeignKeys[table] ?? []])));
function sameArray(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }

export function inspectSchema(database, schemaVersion = COMMAND_CENTER_SCHEMA_VERSION) {
  const problems = [];
  const current = schemaVersion === COMMAND_CENTER_SCHEMA_VERSION;
  const schemaSeven = schemaVersion === SCHEMA_SEVEN_COMMAND_CENTER_VERSION;
  const schemaSix = schemaVersion === SCHEMA_SIX_COMMAND_CENTER_VERSION;
  const prior = schemaVersion === PRIOR_COMMAND_CENTER_SCHEMA_VERSION;
  const schemaFour = schemaVersion === ATTENTION_METADATA_SCHEMA_VERSION;
  const columnsForVersion = current ? baseColumns : schemaSeven ? Object.fromEntries(Object.entries(baseColumns).filter(([table]) => v7Tables.includes(table))) : schemaSix ? v6Columns : prior ? v5Columns : schemaFour ? v4Columns : schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION ? v3Columns : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? v2Columns : v1Columns;
  const definitionsForVersion = current ? expectedTableDefinitions : schemaSeven ? expectedTableDefinitionsV7 : schemaSix ? expectedTableDefinitionsV6 : prior ? definitions(metadataSchemaV5Sql) : schemaFour ? expectedTableDefinitionsV4 : schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION ? expectedTableDefinitionsV3 : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? expectedTableDefinitionsV2 : v1Definitions;
  const foreignKeysForVersion = current ? baseForeignKeys : schemaSeven ? Object.fromEntries(v7Tables.map((table) => [table, baseForeignKeys[table] ?? []])) : schemaSix || prior || schemaFour ? Object.fromEntries(v6Tables.map((table) => [table, baseForeignKeys[table] ?? []])) : schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION ? v3ForeignKeys : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? v2ForeignKeys : v1ForeignKeys;
  const applicationTables = current ? metadataTableNames : schemaSeven ? v7Tables : schemaSix ? v6Tables : prior || schemaFour ? v5Tables : schemaVersion === LEGACY_MIGRATION_SCHEMA_VERSION ? v3Tables : schemaVersion === LEGACY_METADATA_SCHEMA_VERSION ? v2Tables : v1Tables;
  const expectedTables = schemaVersion >= LEGACY_METADATA_SCHEMA_VERSION ? [...applicationTables, 'schema_migrations'] : [...applicationTables];
  const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = objects.filter((row) => row.type === 'table').map((row) => row.name);
  if (!sameArray(tables, expectedTables.slice().sort())) problems.push('application table set differs');
  const hasAttention = schemaVersion >= ATTENTION_METADATA_SCHEMA_VERSION;
  const allowedObjects = new Set([...expectedTables, ...(hasAttention ? attentionActivityTriggers : [])]);
  if (objects.some((row) => !allowedObjects.has(row.name))) problems.push('unexpected application schema object');
  if (hasAttention && !sameArray(objects.filter((row) => row.type === 'trigger').map((row) => row.name), [...attentionActivityTriggers])) problems.push('attention Activity trigger set differs');
  for (const table of applicationTables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row.type, row.notnull, row.pk]);
    if (!sameArray(columns.map(JSON.stringify), (columnsForVersion[table] ?? []).map(JSON.stringify))) problems.push(`${table} columns differ`);
    const tableShape = database.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table);
    if (!tableShape || tableShape.strict !== 1) problems.push(`${table} is not STRICT`);
    const ddl = normalizedSql(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql);
    const alterCompatible = (current || schemaSeven || schemaSix) && (table === 'topics' || table === 'source_convention_state');
    if (!alterCompatible && ddl !== definitionsForVersion[table]) problems.push(`${table} definition differs`);
    if (current && table === 'topics') {
      for (const requiredConstraint of [
        "CHECK (para_category IN ('project', 'area', 'resource', 'archive'))",
        "CHECK (lifecycle IN ('provisioning', 'active', 'retired'))",
        'CHECK (revision >= 0)',
        'CHECK (length(name) <= 300)'
      ]) if (!ddl.includes(requiredConstraint)) problems.push(`topics definition omits ${requiredConstraint}`);
    }
    if (current && table === 'source_convention_state') {
      for (const requiredConstraint of [
        "CHECK (aspect IN ('name', 'location', 'display_label'))",
        "CHECK (state IN ('managed', 'customized'))"
      ]) if (!ddl.includes(requiredConstraint)) problems.push(`source_convention_state definition omits ${requiredConstraint}`);
    }
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
export function inspectSchemaV3(database) { return inspectSchema(database, LEGACY_MIGRATION_SCHEMA_VERSION); }
export function inspectMigrationLedger(database) {
  const rows = database.prepare('SELECT sequence, migration_id, migration_digest, from_version, to_version, snapshot_id, applied_build, applied_at FROM schema_migrations ORDER BY sequence').all();
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}
