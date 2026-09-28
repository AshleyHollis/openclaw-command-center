import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const START_MS = Date.parse('2026-08-27T22:00:00.000Z');
export const RELEASE_MS = Date.parse('2026-08-27T23:00:00.000Z');

export function fictionalEpisodes() {
  return ['episode-sample', 'episode-a'].map(episodeId => ({
    episodeId, sourceCapabilityId: 'monitor', sourceKind: 'operational',
    state: 'Active', severity: 'High', attentionSince: new Date(START_MS).toISOString(), evidenceFacts: {}
  }));
}

// Separate from CC metadata: an isolated, durable fictional provider receipt.
// This deliberately does not exercise the actual OpenClaw host or web push.
export function openFictionalProvider(stateDir) {
  const db = new DatabaseSync(path.join(stateDir, 'fictional-notification-provider.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS deliveries (logical_operation_id TEXT PRIMARY KEY, emission_id TEXT NOT NULL, candidate_digest TEXT NOT NULL, cleared INTEGER NOT NULL DEFAULT 0) STRICT');
  return {
    record(candidate) {
      const digest = createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
      const prior = db.prepare('SELECT * FROM deliveries WHERE logical_operation_id = ?').get(candidate.logicalOperationId);
      if (prior) {
        if (prior.candidate_digest !== digest || prior.emission_id !== candidate.emissionId) throw new Error('Fictional provider candidate intent changed on replay.');
        return 'replay';
      }
      db.prepare('INSERT INTO deliveries (logical_operation_id, emission_id, candidate_digest) VALUES (?, ?, ?)').run(candidate.logicalOperationId, candidate.emissionId, digest);
      return 'new';
    },
    delivered() { return db.prepare('SELECT * FROM deliveries').all(); },
    clear(logicalOperationId) {
      if (db.prepare('UPDATE deliveries SET cleared = 1 WHERE logical_operation_id = ?').run(logicalOperationId).changes !== 1) throw new Error('Fictional provider clear did not own a delivery.');
      return { status: 'cleared', attempted: 1, cleared: 1, failed: 0, ambiguous: 0 };
    },
    close() { db.close(); }
  };
}
