export function rebuildProjectionStructures(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DROP TABLE IF EXISTS projection_topic_summary; DROP TABLE IF EXISTS projection_metadata;');
    database.exec(`CREATE TABLE projection_topic_summary (
      topic_id TEXT PRIMARY KEY REFERENCES topics(topic_id) ON UPDATE RESTRICT ON DELETE CASCADE,
      para_category TEXT NOT NULL,
      current_source_count INTEGER NOT NULL CHECK (current_source_count >= 0)
    );
    CREATE TABLE projection_metadata (
      projection_name TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      rebuilt_at TEXT NOT NULL
    );`);
    database.exec(`INSERT INTO projection_topic_summary (topic_id, para_category, current_source_count)
      SELECT t.topic_id, t.para_category, COUNT(s.source_reference_id)
      FROM topics t LEFT JOIN source_references s ON s.topic_id = t.topic_id AND s.is_current = 1
      GROUP BY t.topic_id, t.para_category`);
    database.prepare('INSERT INTO projection_metadata (projection_name, generation, rebuilt_at) VALUES (?, ?, ?)')
      .run('topic-summary', 1, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
    throw error;
  }
}

export function readTopicProjection(database, topicId) {
  return database.prepare('SELECT topic_id, para_category, current_source_count FROM projection_topic_summary WHERE topic_id = ?').get(topicId) || null;
}
