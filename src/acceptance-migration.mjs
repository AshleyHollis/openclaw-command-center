export function readVerifiedMigrationCompletion(database, { completionId, topicId }) {
  const completion = database.prepare('SELECT * FROM migration_completion WHERE completion_id = ?').get(completionId);
  if (!completion) return undefined;
  const binding = database.prepare(`SELECT reference.reference_id AS referenceId, reference.external_source_id AS sessionKey, state.session_id AS sessionId
    FROM source_references AS reference JOIN session_state AS state ON state.reference_id = reference.reference_id
    WHERE reference.topic_id = ? AND reference.source_system = 'openclaw' AND reference.source_kind = 'session' AND state.is_primary = 1 AND state.status = 'open'`).get(topicId);
  if (!binding || typeof binding.referenceId !== 'string' || binding.referenceId.trim() === '') return undefined;
  return { completion: { ...completion }, binding: { ...binding } };
}
