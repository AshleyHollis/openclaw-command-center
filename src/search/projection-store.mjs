import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveCommandCenterProjectionRoot } from '../metadata/path.mjs';
import { sourceError } from '../sources/errors.mjs';
import { buildFtsQuery, contextText, snippetText, validateSearchRequest } from './query.mjs';

const CONFIG = Object.freeze({
  note: Object.freeze({
    kind: 'note', projectionId: 'topic-search-notes', databaseFile: 'topic-search-notes.sqlite', commitFile: 'topic-search-notes.commit.json', manifestFile: 'topic-search-notes.json',
    table: 'note_documents', fts: 'note_documents_fts'
  }),
  conversation: Object.freeze({
    kind: 'conversation', projectionId: 'topic-search-conversations', databaseFile: 'topic-search-conversations.sqlite', commitFile: 'topic-search-conversations.commit.json', manifestFile: 'topic-search-conversations.json',
    table: 'conversation_documents', fts: 'conversation_documents_fts'
  })
});

export const SEARCH_PROJECTION_VERSIONS = Object.freeze({
  notes: Object.freeze({ projectionId: CONFIG.note.projectionId, formatVersion: 1 }),
  conversations: Object.freeze({ projectionId: CONFIG.conversation.projectionId, formatVersion: 1 })
});

function configFor(kind) {
  if (kind === 'notes') kind = 'note';
  if (kind === 'conversations') kind = 'conversation';
  const config = CONFIG[kind];
  if (!config) throw new TypeError('projection kind must be note or conversation');
  return config;
}

function assertOwnedRegular(file, allowMissing = false) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw sourceError('projection-unavailable', 'A projection artifact is not an owned regular file.');
    return true;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return false;
    throw error;
  }
}

function syncFile(file) {
  const descriptor = openSync(file, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fileDigest(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

const groupedPublicationFiles = Object.freeze(Object.values(CONFIG).flatMap((config) => [config.databaseFile, config.commitFile, config.manifestFile]));
const groupedPublicationQueues = new Map();
const activeGroupedPublications = new Map();

function groupedMarker(root) { return path.join(root, '.projections.group-publication.json'); }
function groupedBackup(root, name) { return path.join(root, `.${name}.group-rollback`); }

function recoverGroupedPublication(root) {
  const markerPath = groupedMarker(root);
  if (!assertOwnedRegular(markerPath, true)) {
    for (const name of groupedPublicationFiles) {
      const backup = groupedBackup(root, name);
      if (assertOwnedRegular(backup, true)) unlinkSync(backup);
    }
    return;
  }
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { throw sourceError('projection-unavailable', 'Grouped projection publication record is unreadable.'); }
  if (marker?.schemaVersion !== 1 || !Array.isArray(marker.existing) || marker.existing.some((name) => !groupedPublicationFiles.includes(name))) throw sourceError('projection-unavailable', 'Grouped projection publication record is incompatible.');
  const existing = new Set(marker.existing);
  for (const name of groupedPublicationFiles) {
    const target = path.join(root, name);
    const backup = groupedBackup(root, name);
    if (assertOwnedRegular(target, true)) unlinkSync(target);
    if (existing.has(name)) {
      if (!assertOwnedRegular(backup, true)) throw sourceError('projection-unavailable', 'Grouped projection rollback is incomplete.');
      renameSync(backup, target);
    } else if (assertOwnedRegular(backup, true)) unlinkSync(backup);
  }
  unlinkSync(markerPath);
}

export async function withGroupedProjectionPublication({ stateDir }, publish) {
  if (typeof publish !== 'function') throw new TypeError('publish must be a function');
  const root = resolveCommandCenterProjectionRoot(stateDir);
  const previous = groupedPublicationQueues.get(root) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => turn);
  groupedPublicationQueues.set(root, tail);
  await previous.catch(() => {});
  const publicationLease = Object.freeze({ root });
  activeGroupedPublications.set(root, publicationLease);
  try {
    recoverGroupedPublication(root);
    const existing = [];
    for (const name of groupedPublicationFiles) {
      const target = path.join(root, name);
      const backup = groupedBackup(root, name);
      if (assertOwnedRegular(target, true)) {
        copyFileSync(target, backup);
        syncFile(backup);
        existing.push(name);
      }
    }
    const markerPath = groupedMarker(root);
    writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 1, existing })}\n`, { mode: 0o600 });
    syncFile(markerPath);
    try {
      const result = await publish(publicationLease);
      unlinkSync(markerPath);
      for (const name of groupedPublicationFiles) {
        const backup = groupedBackup(root, name);
        if (assertOwnedRegular(backup, true)) unlinkSync(backup);
      }
      return result;
    } catch (error) {
      recoverGroupedPublication(root);
      throw error;
    }
  } finally {
    activeGroupedPublications.delete(root);
    release();
    if (groupedPublicationQueues.get(root) === tail) groupedPublicationQueues.delete(root);
  }
}

function readCommit(commitPath) {
  if (!assertOwnedRegular(commitPath, true)) throw sourceError('projection-unavailable', 'Projection commit record is unavailable.');
  let value;
  try { value = JSON.parse(readFileSync(commitPath, 'utf8')); } catch { throw sourceError('projection-unavailable', 'Projection commit record is unreadable.'); }
  if (value.schemaVersion !== 1 || typeof value.databaseDigest !== 'string' || typeof value.generation !== 'string') throw sourceError('projection-unavailable', 'Projection commit record is incompatible.');
  return value;
}

function recoverProjectionPublication(root, config, databasePath, commitPath, manifestPath) {
  const rollbackDatabase = readdirSync(root).filter((name) => name.startsWith(`.${config.databaseFile}.rollback-`)).sort().at(-1);
  const rollbackCommit = readdirSync(root).filter((name) => name.startsWith(`.${config.commitFile}.rollback-`)).sort().at(-1);
  if (!rollbackDatabase && !rollbackCommit) return;
  let completedPublication = false;
  try {
    const commit = readCommit(commitPath);
    const currentDigestMatches = commit.databaseDigest === fileDigest(databasePath);
    let matchingManifest = false;
    try { matchingManifest = JSON.parse(readFileSync(manifestPath, 'utf8')).generation === commit.generation; } catch { matchingManifest = false; }
    let completedDeletion = false;
    if (currentDigestMatches && commit.operation === 'delete' && typeof commit.projectionId === 'string') {
      const current = new DatabaseSync(databasePath, { readOnly: true });
      try { completedDeletion = current.prepare('SELECT 1 FROM projection_generations WHERE projection_id = ?').get(commit.projectionId) === undefined; }
      finally { current.close(); }
    }
    completedPublication = currentDigestMatches && (matchingManifest || completedDeletion);
  } catch { completedPublication = false; }
  if (completedPublication) {
    for (const name of [rollbackDatabase, rollbackCommit, ...readdirSync(root).filter((entry) => entry.startsWith(`.${config.manifestFile}.rollback-`))].filter(Boolean)) {
      try { unlinkSync(path.join(root, name)); } catch { /* a valid current publication remains authoritative */ }
    }
    return;
  }
  if (assertOwnedRegular(databasePath, true)) unlinkSync(databasePath);
  if (rollbackCommit && assertOwnedRegular(commitPath, true)) unlinkSync(commitPath);
  if (rollbackDatabase) renameSync(path.join(root, rollbackDatabase), databasePath);
  if (rollbackCommit) renameSync(path.join(root, rollbackCommit), commitPath);
}

function inputDigest(rows) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex')}`;
}

function committedRowsDigest(database, config) {
  const rows = database.prepare(`SELECT topic_id, source_reference_json, folder_reference_id, path, heading, revision, session_key, message_id, name, date, closed, primary_state, role, history_provenance, provenance, imported_from, text, context_before, context_after FROM ${config.table}`).all();
  rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return inputDigest(rows);
}

function crashAt(point) {
  const configured = process.env.COMMAND_CENTER_SEARCH_PROJECTION_CRASH_AT;
  if (configured === point || configured === 'publication' && ['database-publication', 'manifest-publication'].includes(point)) process.kill(process.pid, 'SIGKILL');
}

function cleanupRollback(file, point) {
  try {
    if (process.env.COMMAND_CENTER_SEARCH_PROJECTION_FAIL_CLEANUP_AT === point) throw new Error('injected rollback cleanup failure');
    unlinkSync(file);
  } catch { /* cleanup cannot invalidate a fully published generation */ }
}

function readManifest(manifestPath, config) {
  if (!assertOwnedRegular(manifestPath, true)) throw sourceError('projection-unavailable', `${config.projectionId} is unavailable.`);
  let value;
  try { value = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { throw sourceError('projection-unavailable', 'Projection manifest is unreadable.'); }
  if (value.projectionId !== config.projectionId || value.schemaVersion !== 1 || value.formatVersion !== 1 || value.tokenizer !== 'unicode61 remove_diacritics=0' || typeof value.databaseDigest !== 'string' || typeof value.inputDigest !== 'string' || typeof value.generation !== 'string' || !Array.isArray(value.topicIds) || value.topicIds.some((topicId) => typeof topicId !== 'string' || !topicId)) throw sourceError('projection-unavailable', 'Projection manifest version is incompatible.');
  return value;
}

function recoverPublication(root, config, databasePath, manifestPath) {
  const backupDatabase = readdirSync(root).filter((name) => name.startsWith(`.${config.databaseFile}.rollback-`)).sort().at(-1);
  const backupManifest = readdirSync(root).filter((name) => name.startsWith(`.${config.manifestFile}.rollback-`)).sort().at(-1);
  if (!backupDatabase && !backupManifest) return;
  const currentValid = (() => {
    try { return assertOwnedRegular(databasePath) && readManifest(manifestPath, config).databaseDigest === fileDigest(databasePath); } catch { return false; }
  })();
  if (currentValid) {
    if (backupDatabase) unlinkSync(path.join(root, backupDatabase));
    if (backupManifest) unlinkSync(path.join(root, backupManifest));
    return;
  }
  if (assertOwnedRegular(databasePath, true)) unlinkSync(databasePath);
  if (assertOwnedRegular(manifestPath, true)) unlinkSync(manifestPath);
  if (backupDatabase) renameSync(path.join(root, backupDatabase), databasePath);
  if (backupManifest) renameSync(path.join(root, backupManifest), manifestPath);
}

function normalizeReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    version: value.version ?? 1,
    referenceId: value.referenceId ?? null,
    topicId: value.topicId ?? null,
    sourceSystem: value.sourceSystem ?? null,
    sourceKind: value.sourceKind ?? null,
    externalSourceId: value.externalSourceId ?? null,
    observedRevision: value.observedRevision ?? null,
    createdAt: value.createdAt ?? null,
    updatedAt: value.updatedAt ?? null
  };
}

function textForRow(row, kind) {
  return row.text;
}

function deterministicRowId(kind, row) {
  const identity = [kind, row.topicId, row.sourceReference.referenceId, row.path ?? '', row.messageId ?? '', row.heading ?? '', row.text].join('\u0000');
  return Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 13), 16) + 1;
}

function validateRows(kind, rows) {
  if (!Array.isArray(rows)) throw sourceError('source-inconsistent', 'Projection rows must be an array.');
  const config = configFor(kind);
  const seen = new Set();
  return rows.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw sourceError('source-inconsistent', `Projection row ${index} is invalid.`);
    const row = { ...raw };
    row.topicId = String(row.topicId ?? '').trim();
    if (!row.topicId) throw sourceError('source-inconsistent', 'Projection rows require topicId.');
    row.sourceReference = normalizeReference(row.sourceReference);
    if (!row.sourceReference || row.sourceReference.topicId !== row.topicId || typeof row.sourceReference.referenceId !== 'string' || row.sourceReference.referenceId.trim() === '') throw sourceError('source-inconsistent', 'Projection rows require an exact Topic-owned Source Reference.');
    row.text = String(row.text ?? '');
    if (row.text.trim() === '') throw sourceError('source-inconsistent', 'Projection rows require searchable text.');
    row.contextBefore = contextText(row.contextBefore ?? '', 600);
    row.contextAfter = contextText(row.contextAfter ?? '', 600);
    row.provenance = row.provenance === 'imported' ? 'imported' : 'native';
    const identity = `${row.topicId}\u0000${row.sourceReference.referenceId}\u0000${row.messageId ?? `${row.path ?? index}\u0000${row.text}`}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    if (kind === 'note') {
      row.path = String(row.path ?? '').trim();
      if (!row.path) throw sourceError('source-inconsistent', 'Note projection rows require path.');
      row.folderReferenceId = String(row.folderReferenceId ?? '').trim();
      if (!row.folderReferenceId) throw sourceError('source-inconsistent', 'Note projection rows require folderReferenceId.');
      row.heading = row.heading === undefined ? null : row.heading;
      row.revision = row.revision ?? null;
    } else {
      row.sessionKey = String(row.sessionKey ?? row.sourceReference.externalSourceId ?? '').trim();
      if (!row.sessionKey) throw sourceError('source-inconsistent', 'Conversation projection rows require sessionKey.');
      row.sessionId = row.sessionId == null ? null : String(row.sessionId).trim();
      row.messageId = row.messageId ?? null;
      row.name = String(row.name ?? row.sessionKey).trim() || row.sessionKey;
      row.date = row.date == null ? null : String(row.date).trim();
      if (row.date === null || !row.date || Number.isNaN(Date.parse(row.date)) || new Date(row.date).toISOString() !== row.date) throw sourceError('source-inconsistent', 'Conversation projection rows require an authoritative ISO date.');
      row.role = String(row.role ?? 'unknown').trim() || 'unknown';
      row.historyProvenance = String(row.historyProvenance ?? (row.provenance === 'imported' ? 'imported-primary' : 'linked-session')).trim();
      row.closed = Boolean(row.closed);
      row.primaryState = row.primaryState ?? 'ordinary';
      row.importedFrom = row.importedFrom ?? null;
      row.originatingTopicId = row.originatingTopicId == null ? null : String(row.originatingTopicId).trim() || null;
    }
    return row;
  }).filter(Boolean).sort((left, right) => {
    const identity = (row) => [row.topicId, row.sourceReference.referenceId, row.path ?? '', row.messageId ?? '', row.text].join('\u0000');
    return identity(left).localeCompare(identity(right));
  });
}

function schemaSql(config) {
  const table = config.table;
  const fts = config.fts;
  return `
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS projection_generations (
      projection_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      generation TEXT NOT NULL,
      source_revision TEXT,
      input_digest TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      covered_topic_ids TEXT NOT NULL,
      committed INTEGER NOT NULL CHECK (committed IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS ${table} (
      row_id INTEGER PRIMARY KEY,
      topic_id TEXT NOT NULL,
      source_reference_json TEXT NOT NULL,
      folder_reference_id TEXT,
      path TEXT,
      heading TEXT,
      revision TEXT,
      session_key TEXT,
      session_id TEXT,
      message_id TEXT,
      name TEXT,
      date TEXT,
      closed INTEGER,
      primary_state TEXT,
      role TEXT,
      history_provenance TEXT,
      provenance TEXT NOT NULL,
      imported_from TEXT,
      originating_topic_id TEXT,
      text TEXT NOT NULL,
      content TEXT NOT NULL,
      context_before TEXT NOT NULL,
      context_after TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(
      topic_id, content, tokenize='unicode61 remove_diacritics 0', content='${table}', content_rowid='row_id'
    );
    CREATE INDEX IF NOT EXISTS ${table}_topic_idx ON ${table}(topic_id);
  `;
}

function ensureCoverageColumn(db) {
  const columns = db.prepare('PRAGMA table_info(projection_generations)').all();
  if (!columns.some((column) => column.name === 'covered_topic_ids')) {
    // Migrate only the disposable staging copy. Unknown legacy coverage stays
    // empty until this authoritative rebuild publishes successfully.
    db.exec("ALTER TABLE projection_generations ADD COLUMN covered_topic_ids TEXT NOT NULL DEFAULT '[]'");
  }
}

function ensureDocumentColumns(db, config) {
  const columns = db.prepare(`PRAGMA table_info(${config.table})`).all();
  if (!columns.some((column) => column.name === 'session_id')) db.exec(`ALTER TABLE ${config.table} ADD COLUMN session_id TEXT`);
  if (!columns.some((column) => column.name === 'originating_topic_id')) db.exec(`ALTER TABLE ${config.table} ADD COLUMN originating_topic_id TEXT`);
}

function queryParagraphContext(text, query) {
  const paragraphs = String(text ?? '').split(/\n\s*\n/gu).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length === 0) return { before: '', after: '' };
  const terms = String(query ?? '').replaceAll('"', '').match(/[\p{L}\p{N}_]+/gu)?.map((term) => term.toLocaleLowerCase()) ?? [];
  const index = paragraphs.findIndex((paragraph) => terms.every((term) => paragraph.toLocaleLowerCase().includes(term)));
  const selected = index < 0 ? 0 : index;
  return { before: paragraphs[selected - 1] ?? '', after: paragraphs[selected + 1] ?? '' };
}

const MATCH_START = '\uE000';
const MATCH_END = '\uE001';

function highlightedSnippet(value, fallback) {
  const raw = String(value || fallback || '');
  let text = '';
  let start = null;
  const spans = [];
  for (const character of raw) {
    if (character === MATCH_START) { if (start === null) start = text.length; continue; }
    if (character === MATCH_END) {
      if (start !== null && text.length > start) spans.push({ start, end: text.length });
      start = null;
      continue;
    }
    if (/\s/u.test(character)) {
      if (text && !text.endsWith(' ')) text += ' ';
    } else {
      text += character;
    }
  }
  if (start !== null && text.length > start) spans.push({ start, end: text.length });
  text = text.trimEnd();
  const wordList = text.split(' ');
  const omittedWords = wordList.length > 32;
  let snippet = wordList.slice(0, 32).join(' ');
  if (omittedWords && !snippet.endsWith('…')) snippet += '…';
  const codePoints = Array.from(snippet);
  if (codePoints.length > 240) snippet = `${codePoints.slice(0, 239).join('')}…`;
  const highlightLimit = snippet.endsWith('…') ? snippet.length - 1 : snippet.length;
  const highlights = spans
    .map((span) => ({ start: Math.min(span.start, highlightLimit), end: Math.min(span.end, highlightLimit) }))
    .filter((span) => span.end > span.start);
  return { snippet, highlights: Object.freeze(highlights.map((span) => Object.freeze(span))) };
}

function rowResult(row, kind, rank, snippet, query) {
  const reference = JSON.parse(row.source_reference_json);
  const context = queryParagraphContext(row.text, query);
  const highlighted = highlightedSnippet(snippet, row.text);
  const remaining = Math.max(0, 600 - Array.from(highlighted.snippet).length);
  const beforeBudget = Math.floor(remaining / 2);
  const contextBefore = contextText(context.before || row.context_before, beforeBudget);
  const contextAfter = contextText(context.after || row.context_after, remaining - Array.from(contextBefore).length);
  const common = {
    schemaVersion: 1, topicId: row.topic_id, referenceId: reference.referenceId, sourceReference: reference,
    score: Number(rank),
    sourceRevision: row.revision ?? reference.observedRevision ?? null, snippet: highlighted.snippet, snippetHighlights: highlighted.highlights,
    contextBefore, contextAfter, context: Object.freeze({ before: contextBefore, after: contextAfter }), provenance: row.provenance
  };
  if (kind === 'note') return {
    ...common, kind: 'note', folderReferenceId: row.folder_reference_id, path: row.path, heading: row.heading ?? null, revision: row.revision ?? null,
    navigation: { kind: 'note', topicId: row.topic_id, path: row.path, sourceReference: reference }
  };
  return {
    ...common, kind: 'conversation', sessionKey: row.session_key, sessionId: row.session_id ?? null, messageId: row.message_id ?? null, name: row.name || row.session_key,
    date: row.date, originatingTopicId: row.originating_topic_id ?? null, role: row.role, historyProvenance: row.history_provenance, status: row.closed === 1 ? 'closed' : 'open', closed: row.closed === 1, primaryState: row.primary_state ?? 'ordinary', importedFrom: row.imported_from ?? null,
    navigation: { kind: 'conversation', topicId: row.topic_id, sessionKey: row.session_key, sourceReference: reference, messageId: row.message_id ?? null }
  };
}

export async function openProjectionStore({ stateDir, root: suppliedRoot, projectionRoot: suppliedProjectionRoot, kind, digestFile = fileDigest } = {}) {
  const config = configFor(kind);
  if (typeof digestFile !== 'function') throw new TypeError('digestFile must be a function');
  if ((suppliedRoot || suppliedProjectionRoot) && typeof (suppliedRoot || suppliedProjectionRoot) === 'string') {
    const supplied = suppliedRoot || suppliedProjectionRoot;
    const stat = lstatSync(supplied);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('unsafe-path', 'Projection root must be an owned directory.');
  }
  if (!suppliedRoot && !suppliedProjectionRoot && (typeof stateDir !== 'string' || stateDir.trim() === '')) throw new TypeError('stateDir must be a non-empty string');
  const root = suppliedRoot || suppliedProjectionRoot || resolveCommandCenterProjectionRoot(stateDir);
  const databasePath = path.join(root, config.databaseFile);
  const manifestPath = path.join(root, config.manifestFile);
  const commitPath = path.join(root, config.commitFile);
  if (!activeGroupedPublications.has(root)) recoverGroupedPublication(root);
  recoverProjectionPublication(root, config, databasePath, commitPath, manifestPath);
  const staleManifestRollback = readdirSync(root).filter((name) => name.startsWith(`.${config.manifestFile}.rollback-`)).sort().at(-1);
  if (staleManifestRollback) {
    const currentPublicationComplete = (() => {
      try {
        const commit = readCommit(commitPath);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        return commit.databaseDigest === digestFile(databasePath) && manifest.generation === commit.generation;
      } catch { return false; }
    })();
    if (currentPublicationComplete) unlinkSync(path.join(root, staleManifestRollback));
    else {
      if (assertOwnedRegular(manifestPath, true)) unlinkSync(manifestPath);
      renameSync(path.join(root, staleManifestRollback), manifestPath);
    }
  }
  let database;
  let openedFingerprint;

  const artifactFingerprint = () => [databasePath, commitPath, manifestPath].map((file) => {
    const stat = lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) throw sourceError('projection-unavailable', 'A projection artifact is not an owned regular file.');
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }).join('|');

  const generationRow = (db) => db.prepare('SELECT * FROM projection_generations WHERE projection_id = ? AND schema_version = 1 AND committed = 1').get(config.projectionId);
  const mapManifest = (row) => row ? Object.freeze({ schemaVersion: row.schema_version, formatVersion: 1, projectionId: config.projectionId, tokenizer: 'unicode61 remove_diacritics=0', sourceRevision: row.source_revision, inputDigest: row.input_digest, rowCount: row.row_count, topicIds: Object.freeze(JSON.parse(row.covered_topic_ids)), generation: row.generation, committed: true, databaseDigest: row.input_digest }) : null;
  const manifestFor = (row) => {
    const manifest = readManifest(manifestPath, config);
    if (manifest.databaseDigest !== row?.input_digest || manifest.generation !== row?.generation || manifest.inputDigest !== row?.input_digest || manifest.rowCount !== row?.row_count || manifest.sourceRevision !== row?.source_revision || JSON.stringify(manifest.topicIds) !== row?.covered_topic_ids || manifest.committed !== true) throw sourceError('projection-unavailable', `${config.projectionId} bookkeeping does not match its committed generation.`);
    return manifest;
  };
  const ensureDatabase = () => {
    if (activeGroupedPublications.has(root)) throw sourceError('projection-unavailable', 'A grouped projection publication is not yet committed.');
    if (database) return database;
    if (!assertOwnedRegular(databasePath, true)) throw sourceError('projection-unavailable', `${config.projectionId} is unavailable.`);
    const commit = readCommit(commitPath);
    if (digestFile(databasePath) !== commit.databaseDigest) throw sourceError('projection-unavailable', 'Projection database does not match its committed digest.');
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = generationRow(database);
      if (database.prepare('PRAGMA user_version').get().user_version !== 1 || !row) throw sourceError('projection-unavailable', `${config.projectionId} has no committed generation.`);
      manifestFor(row);
    } catch (error) {
      database.close(); database = undefined;
      if (error?.code === 'projection-unavailable') throw error;
      throw sourceError('projection-unavailable', `${config.projectionId} is incompatible.`);
    }
    openedFingerprint = artifactFingerprint();
    return database;
  };
  const assertOpenIntegrity = () => {
    const db = ensureDatabase();
    const fingerprint = artifactFingerprint();
    if (fingerprint !== openedFingerprint) {
      database.close(); database = undefined; openedFingerprint = undefined;
      return ensureDatabase();
    }
    return db;
  };
  const querySql = `SELECT d.*, bm25(${config.fts}) AS rank, snippet(${config.fts}, 1, '${MATCH_START}', '${MATCH_END}', ' … ', 32) AS matched_snippet FROM ${config.fts} JOIN ${config.table} d INDEXED BY ${config.table}_topic_idx ON d.row_id = ${config.fts}.rowid WHERE ${config.fts} MATCH ? AND d.topic_id = ? ORDER BY rank, d.row_id LIMIT ?`;
  const scopedMatch = (request) => `topic_id : "${request.topicId.replaceAll('"', '""')}" AND content : (${buildFtsQuery(request.tokens)})`;

  const store = {
    kind, projectionId: config.projectionId, databasePath, manifestPath, commitPath,
    exists() {
      if (activeGroupedPublications.has(root)) return false;
      if (!assertOwnedRegular(databasePath, true) || !assertOwnedRegular(commitPath, true) || !assertOwnedRegular(manifestPath, true)) return false;
      try { const db = assertOpenIntegrity(); return Boolean(generationRow(db)); } catch { return false; }
    },
    manifest() {
      if (activeGroupedPublications.has(root)) return null;
      if (!assertOwnedRegular(databasePath, true) || !assertOwnedRegular(commitPath, true) || !assertOwnedRegular(manifestPath, true)) return null;
      try { const db = assertOpenIntegrity(); const row = generationRow(db); return row ? manifestFor(row) : null; } catch { return null; }
    },
    hasTopic(topicId) {
      if (typeof topicId !== 'string' || !topicId) return false;
      const db = assertOpenIntegrity();
      return manifestFor(generationRow(db)).topicIds.includes(topicId);
    },
    async rebuild({ topicId = null, topicIds = [], rows = [], documents = undefined, sourceRevision = null, _groupLease } = {}) {
      const activeGroup = activeGroupedPublications.get(root);
      if (activeGroup && activeGroup !== _groupLease) throw sourceError('projection-unavailable', 'A grouped projection publication is already active.');
      if (documents !== undefined && rows.length === 0) rows = documents;
      if (topicId !== null && (typeof topicId !== 'string' || topicId.trim() === '')) throw sourceError('invalid-request', 'topicId must be a non-blank string.');
      const normalizedRows = validateRows(kind, rows);
      if (topicId !== null && normalizedRows.some((row) => row.topicId !== topicId)) throw sourceError('source-inconsistent', 'A Topic rebuild contained a foreign row.');
      if (!Array.isArray(topicIds) || topicIds.some((id) => typeof id !== 'string' || !id)) throw sourceError('source-inconsistent', 'Projection Topic coverage is invalid.');
      if (topicId !== null && topicIds.some((id) => id !== topicId)) throw sourceError('source-inconsistent', 'A Topic rebuild declared foreign Topic coverage.');
      database?.close(); database = undefined; openedFingerprint = undefined;
      const generation = randomUUID();
      const temporaryPath = path.join(root, `.${config.databaseFile}.rebuilding-${generation}`);
      const temporaryCommitPath = path.join(root, `.${config.commitFile}.rebuilding-${generation}`);
      const rollbackDatabasePath = path.join(root, `.${config.databaseFile}.rollback-${generation}`);
      const rollbackCommitPath = path.join(root, `.${config.commitFile}.rollback-${generation}`);
      const temporaryManifestPath = path.join(root, `.${config.manifestFile}.rebuilding-${generation}`);
      const rollbackManifestPath = path.join(root, `.${config.manifestFile}.rollback-${generation}`);
      const currentValid = (() => { try { return readCommit(commitPath).databaseDigest === digestFile(databasePath); } catch { return false; } })();
      if (topicId !== null && assertOwnedRegular(databasePath, true) && !currentValid) throw sourceError('projection-unavailable', 'A Topic-scoped rebuild requires a valid committed projection.');
      if (currentValid) copyFileSync(databasePath, temporaryPath);
      const db = new DatabaseSync(temporaryPath);
      chmodSync(temporaryPath, 0o600);
      let oldDatabaseMoved = false;
      let oldCommitMoved = false;
      let oldManifestMoved = false;
      try {
        db.exec(schemaSql(config));
        ensureCoverageColumn(db);
        ensureDocumentColumns(db, config);
        db.exec('BEGIN IMMEDIATE');
        const oldIds = topicId === null
          ? db.prepare(`SELECT row_id FROM ${config.table}`).all()
          : db.prepare(`SELECT row_id FROM ${config.table} WHERE topic_id = ?`).all(topicId);
        const deleteFts = db.prepare(`DELETE FROM ${config.fts} WHERE rowid = ?`);
        for (const row of oldIds) deleteFts.run(row.row_id);
        if (topicId === null) db.prepare(`DELETE FROM ${config.table}`).run();
        else db.prepare(`DELETE FROM ${config.table} WHERE topic_id = ?`).run(topicId);
        const insert = db.prepare(`INSERT INTO ${config.table} (row_id, topic_id, source_reference_json, folder_reference_id, path, heading, revision, session_key, session_id, message_id, name, date, closed, primary_state, role, history_provenance, provenance, imported_from, originating_topic_id, text, content, context_before, context_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertFts = db.prepare(`INSERT INTO ${config.fts} (rowid, topic_id, content) VALUES (?, ?, ?)`);
        for (const row of normalizedRows) {
          const content = textForRow(row, kind).normalize('NFC');
          const rowId = deterministicRowId(kind, row);
          insert.run(rowId, row.topicId, JSON.stringify(row.sourceReference), row.folderReferenceId ?? null, row.path ?? null, row.heading ?? null, row.revision ?? null, row.sessionKey ?? null, row.sessionId ?? null, row.messageId ?? null, row.name ?? null, row.date ?? null, row.closed ? 1 : 0, row.primaryState ?? null, row.role ?? null, row.historyProvenance ?? null, row.provenance, row.importedFrom ?? null, row.originatingTopicId ?? null, row.text, content, row.contextBefore, row.contextAfter);
          insertFts.run(rowId, row.topicId, content);
        }
        const rowCount = db.prepare(`SELECT count(*) AS count FROM ${config.table}`).get().count;
        const digest = committedRowsDigest(db, config);
        const priorCoverage = topicId === null ? [] : (() => { try { return JSON.parse(generationRow(db)?.covered_topic_ids ?? '[]'); } catch { return []; } })();
        const coveredTopicIds = [...new Set([...priorCoverage, ...topicIds, ...normalizedRows.map((row) => row.topicId)])].sort((left, right) => left.localeCompare(right));
        db.prepare('INSERT INTO projection_generations (projection_id, schema_version, generation, source_revision, input_digest, row_count, covered_topic_ids, committed) VALUES (?, 1, ?, ?, ?, ?, ?, 1) ON CONFLICT(projection_id) DO UPDATE SET schema_version=1, generation=excluded.generation, source_revision=excluded.source_revision, input_digest=excluded.input_digest, row_count=excluded.row_count, covered_topic_ids=excluded.covered_topic_ids, committed=1').run(config.projectionId, generation, sourceRevision, digest, rowCount, JSON.stringify(coveredTopicIds));
        crashAt('write');
        db.exec('COMMIT');
        const row = generationRow(db);
        db.close();
        syncFile(temporaryPath);
        const databaseDigest = digestFile(temporaryPath);
        const commit = { schemaVersion: 1, generation, databaseDigest };
        const manifest = mapManifest(row);
        writeFileSync(temporaryCommitPath, `${JSON.stringify(commit)}\n`, { mode: 0o600 });
        syncFile(temporaryCommitPath);
        writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
        syncFile(temporaryManifestPath);
        if (currentValid) {
          renameSync(databasePath, rollbackDatabasePath); oldDatabaseMoved = true;
          renameSync(commitPath, rollbackCommitPath); oldCommitMoved = true;
        } else {
          if (assertOwnedRegular(databasePath, true)) unlinkSync(databasePath);
          if (assertOwnedRegular(commitPath, true)) unlinkSync(commitPath);
        }
        renameSync(temporaryPath, databasePath);
        crashAt('database-publication');
        renameSync(temporaryCommitPath, commitPath);
        crashAt('manifest-publication');
        if (assertOwnedRegular(manifestPath, true)) { renameSync(manifestPath, rollbackManifestPath); oldManifestMoved = true; }
        crashAt('manifest-write');
        renameSync(temporaryManifestPath, manifestPath);
        if (oldDatabaseMoved) cleanupRollback(rollbackDatabasePath, 'database');
        if (oldCommitMoved) cleanupRollback(rollbackCommitPath, 'commit');
        if (oldManifestMoved) cleanupRollback(rollbackManifestPath, 'manifest');
        return manifest;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
        try { db.close(); } catch {}
        try { if (assertOwnedRegular(databasePath, true) && oldDatabaseMoved) unlinkSync(databasePath); } catch {}
        try { if (assertOwnedRegular(commitPath, true) && oldCommitMoved) unlinkSync(commitPath); } catch {}
        try { if (oldDatabaseMoved && assertOwnedRegular(rollbackDatabasePath, true)) renameSync(rollbackDatabasePath, databasePath); } catch {}
        try { if (oldCommitMoved && assertOwnedRegular(rollbackCommitPath, true)) renameSync(rollbackCommitPath, commitPath); } catch {}
        try { if (assertOwnedRegular(manifestPath, true) && oldManifestMoved) unlinkSync(manifestPath); } catch {}
        try { if (oldManifestMoved && assertOwnedRegular(rollbackManifestPath, true)) renameSync(rollbackManifestPath, manifestPath); } catch {}
        try { if (assertOwnedRegular(temporaryPath, true)) unlinkSync(temporaryPath); } catch {}
        try { if (assertOwnedRegular(temporaryCommitPath, true)) unlinkSync(temporaryCommitPath); } catch {}
        try { if (assertOwnedRegular(temporaryManifestPath, true)) unlinkSync(temporaryManifestPath); } catch {}
        throw error;
      } finally { try { db.close(); } catch {} }
    },
    query(input = {}, { includeOverflow = false } = {}) {
      const request = validateSearchRequest({ schemaVersion: 1, ...input });
      const sqlLimit = includeOverflow ? request.limit + 1 : request.limit;
      return assertOpenIntegrity().prepare(querySql).all(scopedMatch(request), request.topicId, sqlLimit)
        .map((row) => Object.freeze(rowResult(row, kind, row.rank, row.matched_snippet, request.query)));
    },
    queryWithOverflow(input = {}) { return this.query(input, { includeOverflow: true }); },
    resolveNoteTarget(descriptor = {}) {
      if (config.kind !== 'note') return null;
      const rows = assertOpenIntegrity().prepare(`SELECT source_reference_json, heading, revision, text FROM ${config.table} INDEXED BY ${config.table}_topic_idx WHERE topic_id = ? AND path = ? AND heading IS ? AND revision IS ? LIMIT 3`).all(descriptor.topicId, descriptor.path, descriptor.heading ?? null, descriptor.observedRevision ?? null);
      const matches = rows.filter((row) => {
        try { return JSON.parse(row.source_reference_json).referenceId === descriptor.referenceId; } catch { return false; }
      });
      return matches.length === 1 ? Object.freeze({ heading: matches[0].heading, revision: matches[0].revision, text: matches[0].text }) : null;
    },
    explainQueryPlan(input = {}) {
      const request = validateSearchRequest({ schemaVersion: 1, ...input });
      return assertOpenIntegrity().prepare(`EXPLAIN QUERY PLAN ${querySql}`).all(scopedMatch(request), request.topicId, request.limit);
    },
    search(input = {}) { return this.query(input); },
    queryResults(input = {}) { return this.query(input); },
    delete() {
      if (activeGroupedPublications.has(root)) throw sourceError('projection-unavailable', 'A grouped projection publication is already active.');
      if (!assertOwnedRegular(databasePath, true)) return false;
      database?.close(); database = undefined; openedFingerprint = undefined;
      if (readCommit(commitPath).databaseDigest !== digestFile(databasePath)) throw sourceError('projection-unavailable', 'Projection database is not a valid committed generation.');
      const generation = randomUUID();
      const temporaryPath = path.join(root, `.${config.databaseFile}.deleting-${generation}`);
      const temporaryCommitPath = path.join(root, `.${config.commitFile}.deleting-${generation}`);
      const rollbackDatabasePath = path.join(root, `.${config.databaseFile}.rollback-${generation}`);
      const rollbackCommitPath = path.join(root, `.${config.commitFile}.rollback-${generation}`);
      copyFileSync(databasePath, temporaryPath);
      const db = new DatabaseSync(temporaryPath);
      try {
        db.exec(schemaSql(config)); db.exec('BEGIN IMMEDIATE');
        db.prepare(`DELETE FROM ${config.fts}`).run();
        db.prepare(`DELETE FROM ${config.table}`).run();
        const changed = db.prepare('DELETE FROM projection_generations WHERE projection_id = ?').run(config.projectionId).changes > 0;
        db.exec('COMMIT');
        db.close();
        syncFile(temporaryPath);
        writeFileSync(temporaryCommitPath, `${JSON.stringify({ schemaVersion: 1, generation, databaseDigest: digestFile(temporaryPath), operation: 'delete', projectionId: config.projectionId })}\n`, { mode: 0o600 });
        syncFile(temporaryCommitPath);
        renameSync(databasePath, rollbackDatabasePath);
        renameSync(commitPath, rollbackCommitPath);
        renameSync(temporaryPath, databasePath);
        renameSync(temporaryCommitPath, commitPath);
        if (assertOwnedRegular(manifestPath, true)) unlinkSync(manifestPath);
        cleanupRollback(rollbackDatabasePath, 'database');
        cleanupRollback(rollbackCommitPath, 'commit');
        return changed;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        try { db.close(); } catch {}
        try { if (assertOwnedRegular(databasePath, true) && assertOwnedRegular(rollbackDatabasePath, true)) unlinkSync(databasePath); } catch {}
        try { if (assertOwnedRegular(commitPath, true) && assertOwnedRegular(rollbackCommitPath, true)) unlinkSync(commitPath); } catch {}
        try { if (assertOwnedRegular(rollbackDatabasePath, true)) renameSync(rollbackDatabasePath, databasePath); } catch {}
        try { if (assertOwnedRegular(rollbackCommitPath, true)) renameSync(rollbackCommitPath, commitPath); } catch {}
        try { if (assertOwnedRegular(temporaryPath, true)) unlinkSync(temporaryPath); } catch {}
        try { if (assertOwnedRegular(temporaryCommitPath, true)) unlinkSync(temporaryCommitPath); } catch {}
        throw error;
      } finally { try { db.close(); } catch {} }
    },
    close() { database?.close(); database = undefined; openedFingerprint = undefined; }
  };
  return Object.freeze(store);
}

export const projectionConfigs = CONFIG;
