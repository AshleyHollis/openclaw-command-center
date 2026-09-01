export function readVerifiedMigrationCompletion(database, { completionId, topicId }) {
  const completion = database.prepare('SELECT * FROM migration_completion WHERE completion_id = ?').get(completionId);
  if (!completion) return undefined;
  const binding = database.prepare(`SELECT reference.reference_id AS referenceId, reference.external_source_id AS sessionKey, state.session_id AS sessionId
    FROM source_references AS reference JOIN session_state AS state ON state.reference_id = reference.reference_id
    WHERE reference.topic_id = ? AND reference.source_system = 'openclaw' AND reference.source_kind = 'session' AND state.is_primary = 1 AND state.status = 'open'`).get(topicId);
  if (!binding || typeof binding.referenceId !== 'string' || binding.referenceId.trim() === '') return undefined;
  return { completion: { ...completion }, binding: { ...binding } };
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export function retainPreparedMigrationFixtureEvidence(migrationExport) {
  if (!migrationExport || typeof migrationExport !== 'object' || Array.isArray(migrationExport) || !Array.isArray(migrationExport.channels)) throw new TypeError('Prepared migration fixture evidence requires an export with channels.');
  let occurrenceCount = 0;
  for (const [index, channel] of migrationExport.channels.entries()) {
    if (!channel || typeof channel !== 'object' || typeof channel.channelId !== 'string' || !channel.channelId || !Array.isArray(channel.messages)) throw new TypeError(`Prepared migration fixture channel ${index} is invalid.`);
    occurrenceCount += channel.messages.length;
  }
  const retained = deepFreeze(structuredClone(migrationExport));
  return Object.freeze({ migrationExport: retained, channelCount: retained.channels.length, occurrenceCount });
}
