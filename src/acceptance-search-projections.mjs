import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const PROJECTIONS = Object.freeze([
  Object.freeze({ kind: 'notes', projectionId: 'topic-search-notes', table: 'note_documents' }),
  Object.freeze({ kind: 'conversations', projectionId: 'topic-search-conversations', table: 'conversation_documents' })
]);

export const COMMITTED_SEARCH_PROJECTION_FILES = Object.freeze(PROJECTIONS.flatMap(({ projectionId }) => [
  `${projectionId}.commit.json`,
  `${projectionId}.json`,
  `${projectionId}.sqlite`
]).sort());

function regularFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Committed projection evidence contains a non-regular artifact.');
  return file;
}

function jsonFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Committed projection evidence contains an unsafe JSON artifact.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function digestFile(file) {
  return `sha256:${createHash('sha256').update(readFileSync(regularFile(file))).digest('hex')}`;
}

function artifactFingerprint(projectionRoot) {
  return COMMITTED_SEARCH_PROJECTION_FILES.map((name) => {
    const stat = lstatSync(path.join(projectionRoot, name), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Committed projection evidence contains a non-regular artifact.');
    return `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }).join('|');
}

function assertNoGroupedPublication(projectionRoot) {
  if (existsSync(path.join(projectionRoot, '.projections.group-publication.json'))) throw new Error('Committed projection evidence is unavailable during grouped publication.');
}

export function captureSearchProjectionEvidence({ projectionRoot, metadataDatabasePath } = {}) {
  if (typeof projectionRoot !== 'string' || !projectionRoot.trim()) throw new TypeError('projectionRoot must be a non-empty string');
  if (typeof metadataDatabasePath !== 'string' || !metadataDatabasePath.trim()) throw new TypeError('metadataDatabasePath must be a non-empty string');
  const artifacts = {};
  for (const name of readdirSync(projectionRoot).sort((left, right) => left.localeCompare(right))) {
    const file = path.join(projectionRoot, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Projection evidence contains a non-regular artifact.');
    artifacts[name] = Object.freeze({ bytes: stat.size, digest: digestFile(file) });
  }
  const metadata = new DatabaseSync(regularFile(metadataDatabasePath), { readOnly: true });
  try {
    const bookkeeping = metadata.prepare("SELECT projection_id AS projectionId, source_revision AS sourceRevision, input_digest AS inputDigest FROM projection_bookkeeping WHERE projection_id IN ('topic-search-notes', 'topic-search-conversations') ORDER BY projection_id").all();
    return Object.freeze({ artifacts: Object.freeze(artifacts), bookkeeping: Object.freeze(bookkeeping.map((row) => Object.freeze(row))) });
  } finally {
    metadata.close();
  }
}

export function verifyCommittedSearchProjectionSet({ projectionRoot, metadataDatabasePath, requiredTopicIds = [] } = {}) {
  if (typeof projectionRoot !== 'string' || !projectionRoot.trim()) throw new TypeError('projectionRoot must be a non-empty string');
  if (typeof metadataDatabasePath !== 'string' || !metadataDatabasePath.trim()) throw new TypeError('metadataDatabasePath must be a non-empty string');
  if (!Array.isArray(requiredTopicIds) || requiredTopicIds.some((topicId) => typeof topicId !== 'string' || !topicId)) throw new TypeError('requiredTopicIds must contain non-empty strings');

  assertNoGroupedPublication(projectionRoot);
  const initialFingerprint = artifactFingerprint(projectionRoot);
  const metadata = new DatabaseSync(regularFile(metadataDatabasePath), { readOnly: true });
  const manifests = [];
  const rowCounts = {};
  const topicRowCounts = {};
  try {
    for (const projection of PROJECTIONS) {
      const base = path.join(projectionRoot, projection.projectionId);
      const databasePath = regularFile(`${base}.sqlite`);
      const commit = jsonFile(`${base}.commit.json`);
      const manifest = jsonFile(`${base}.json`);
      if (commit.schemaVersion !== 1 || manifest.schemaVersion !== 1 || manifest.projectionId !== projection.projectionId || commit.generation !== manifest.generation) throw new Error('Committed projection generation evidence is inconsistent.');
      if (digestFile(databasePath) !== commit.databaseDigest) throw new Error('Committed projection database digest does not match its commit record.');
      if (!Array.isArray(manifest.topicIds) || requiredTopicIds.some((topicId) => !manifest.topicIds.includes(topicId))) throw new Error('Committed projection Topic coverage is incomplete.');

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Committed projection database integrity failed.');
        const generation = database.prepare('SELECT * FROM projection_generations WHERE projection_id = ? AND schema_version = 1 AND committed = 1').get(projection.projectionId);
        if (!generation || generation.generation !== manifest.generation || generation.source_revision !== manifest.sourceRevision || generation.input_digest !== manifest.inputDigest || manifest.databaseDigest !== generation.input_digest || generation.row_count !== manifest.rowCount || generation.covered_topic_ids !== JSON.stringify(manifest.topicIds)) throw new Error('Committed projection database generation does not match its manifest.');
        const checkpoint = metadata.prepare('SELECT * FROM projection_bookkeeping WHERE projection_id = ?').get(projection.projectionId);
        if (!checkpoint || checkpoint.source_revision !== manifest.sourceRevision || checkpoint.input_digest !== manifest.inputDigest) throw new Error('Committed projection metadata bookkeeping does not match its manifest.');
        rowCounts[projection.kind] = database.prepare(`SELECT count(*) AS count FROM ${projection.table}`).get().count;
        if (rowCounts[projection.kind] !== manifest.rowCount) throw new Error('Committed projection row count does not match its manifest.');
        topicRowCounts[projection.kind] = Object.freeze(Object.fromEntries(requiredTopicIds.map((topicId) => [topicId, database.prepare(`SELECT count(*) AS count FROM ${projection.table} WHERE topic_id = ?`).get(topicId).count])));
      } finally {
        database.close();
      }
      manifests.push(manifest);
    }
  } finally {
    metadata.close();
  }

  assertNoGroupedPublication(projectionRoot);
  if (artifactFingerprint(projectionRoot) !== initialFingerprint) throw new Error('Committed projection artifacts changed during verification.');

  const normalizedTopicIds = manifests.map((manifest) => [...new Set(manifest.topicIds)].sort((left, right) => left.localeCompare(right)));
  if (JSON.stringify(normalizedTopicIds[0]) !== JSON.stringify(normalizedTopicIds[1])) throw new Error('Committed Note and Conversation projections do not have identical Topic coverage.');
  return Object.freeze({
    files: COMMITTED_SEARCH_PROJECTION_FILES,
    topicIds: Object.freeze(normalizedTopicIds[0]),
    rowCounts: Object.freeze(rowCounts),
    topicRowCounts: Object.freeze(topicRowCounts),
    generations: Object.freeze(Object.fromEntries(manifests.map((manifest) => [manifest.projectionId, manifest.generation])))
  });
}
