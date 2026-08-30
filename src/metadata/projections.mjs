import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveCommandCenterProjectionRoot } from './path.mjs';

export const projectionId = 'command-center-core-v1';
export const projectionFormatVersion = 1;
export const projectionPhases = Object.freeze(['validate', 'build', 'publish', 'complete', 'failed']);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const generationName = 'committed.json';
const sourceKinds = Object.freeze([
  Object.freeze({ field: 'noteFolders', sourceSystem: 'obsidian', sourceKind: 'note_folder' }),
  Object.freeze({ field: 'sessions', sourceSystem: 'openclaw', sourceKind: 'session' }),
  Object.freeze({ field: 'reminderSchedules', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule' }),
  Object.freeze({ field: 'importedHistory', sourceSystem: 'openclaw', sourceKind: 'imported_history' })
]);

export class CommandCenterProjectionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'CommandCenterProjectionError'; this.code = code; Object.assign(this, details); }
}

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  return value;
}
function sha256(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function resultsDigest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function projectionError(code, message, remediation) { return new CommandCenterProjectionError(code, message, { remediation }); }
function sourceFailure(code, message) { return projectionError(code, message, 'Restore or verify the authoritative source and retry the projection rebuild.'); }
function diagnostic(error) {
  const code = ['source-unavailable', 'missing-source'].includes(error?.code) ? 'projection-source-unavailable'
    : ['source-inconsistent', 'metadata-inconsistent'].includes(error?.code) ? 'projection-source-inconsistent' : 'projection-rebuild-failure';
  const safe = String(error?.message || 'Projection rebuild failed.').replace(/[\\/][^\s]*/gu, 'source').slice(0, 300);
  return Object.freeze({ code, mode: 'recovery-only', capability: null, summary: safe, explanation: safe, remediation: String(error?.remediation || 'Verify authoritative source availability and retry.').slice(0, 300) });
}
function state(mode, progress, diagnostics = [], observations = []) { return Object.freeze({ mode, progress: Object.freeze({ ...progress }), diagnostics: Object.freeze(diagnostics.slice(0, 1)), observations: Object.freeze(observations.slice(-5).map((item) => Object.freeze({ ...item }))) }); }
function validProgress(phase, completed) { return Object.freeze({ phase, completed: Math.max(0, Math.min(3, completed)), total: 3 }); }
function sourceKey(sourceSystem, sourceKind, externalSourceId) { return `${sourceSystem}\u0000${sourceKind}\u0000${externalSourceId}`; }

function normalizeSources(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw sourceFailure('source-inconsistent', 'The authoritative source manifest is malformed.');
  if (snapshot.sourceRevision !== undefined && !nonBlank(snapshot.sourceRevision)) throw sourceFailure('source-inconsistent', 'The authoritative source revision is inconsistent.');
  const records = [];
  const revisions = [];
  const identities = new Set();
  for (const definition of sourceKinds) {
    if (!Object.hasOwn(snapshot, definition.field)) throw sourceFailure('missing-source', `The required ${definition.field} source is unavailable.`);
    const collection = snapshot[definition.field];
    const suppliedRecords = Array.isArray(collection) ? collection : collection?.records;
    const revision = Array.isArray(collection) ? snapshot.sourceRevision : collection?.sourceRevision;
    if (!Array.isArray(suppliedRecords) || !nonBlank(revision)) throw sourceFailure('source-inconsistent', `The ${definition.field} source declaration is inconsistent.`);
    if (!Array.isArray(collection) && snapshot.sourceRevision !== undefined && snapshot.sourceRevision !== revision) throw sourceFailure('source-inconsistent', `The ${definition.field} source revision is inconsistent.`);
    revisions.push({ source: definition.field, revision });
    for (const record of suppliedRecords) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !nonBlank(record.identity) || !nonBlank(record.contentDigest) || !digestPattern.test(record.contentDigest)) throw sourceFailure('source-inconsistent', `The ${definition.field} source facts are inconsistent.`);
      if (record.sourceRevision !== undefined && record.sourceRevision !== revision) throw sourceFailure('source-inconsistent', `The ${definition.field} source revision is inconsistent.`);
      if ((record.sourceSystem !== undefined && record.sourceSystem !== definition.sourceSystem) || (record.sourceKind !== undefined && record.sourceKind !== definition.sourceKind)) throw sourceFailure('source-inconsistent', `The ${definition.field} source kind is inconsistent.`);
      const identityMapping = sourceKey(definition.sourceSystem, definition.sourceKind, record.identity);
      if (identities.has(identityMapping)) throw sourceFailure('source-inconsistent', `The ${definition.field} source identity is conflicting.`);
      identities.add(identityMapping);
      records.push(Object.freeze({ ...definition, externalSourceId: record.identity, contentDigest: record.contentDigest, sourceRevision: revision }));
    }
  }
  const sourceRevision = revisions.sort((left, right) => compare(left.source, right.source)).map(({ source, revision }) => `${source}:${revision}`).join('|');
  return Object.freeze({ sourceRevision, records: Object.freeze(records.sort((left, right) => compare(sourceKey(left.sourceSystem, left.sourceKind, left.externalSourceId), sourceKey(right.sourceSystem, right.sourceKind, right.externalSourceId)))) });
}

function metadataFacts(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.topics) || !Array.isArray(snapshot.sourceReferences) || !Array.isArray(snapshot.presentationPreferences) || !Array.isArray(snapshot.attentionActivityLinks) || !Array.isArray(snapshot.proposalStates) || !Array.isArray(snapshot.policyVersions)) throw projectionError('metadata-inconsistent', 'Owned metadata is unavailable for projection.');
  return {
    topics: snapshot.topics.map(({ topicId, paraCategory, lifecycle }) => ({ topicId, paraCategory, lifecycle })),
    sourceReferences: snapshot.sourceReferences.map(({ referenceId, topicId, sourceSystem, sourceKind, externalSourceId }) => ({ referenceId, topicId, sourceSystem, sourceKind, externalSourceId })),
    presentationPreferences: snapshot.presentationPreferences.map(({ topicId, displayLabel }) => ({ topicId, displayLabel })),
    attentionActivityLinks: snapshot.attentionActivityLinks.map(({ topicId }) => ({ topicId })),
    proposalStates: snapshot.proposalStates.map(({ topicId }) => ({ topicId })),
    policyVersions: snapshot.policyVersions.map(({ policyId, version, digest }) => ({ policyId, version, digest }))
  };
}

function buildResults(metadata, sources) {
  const sourceByKey = new Map(sources.records.map((record) => [sourceKey(record.sourceSystem, record.sourceKind, record.externalSourceId), record]));
  const mapped = new Set();
  const index = [];
  for (const reference of metadata.sourceReferences) {
    const mappingIdentity = sourceKey(reference.sourceSystem, reference.sourceKind, reference.externalSourceId);
    const source = sourceByKey.get(mappingIdentity);
    if (!source) throw sourceFailure('source-unavailable', 'A declared authoritative source is unavailable.');
    if (mapped.has(mappingIdentity)) throw sourceFailure('source-inconsistent', 'An authoritative source maps to conflicting metadata.');
    mapped.add(mappingIdentity);
    index.push({ referenceId: reference.referenceId, topicId: reference.topicId, sourceSystem: source.sourceSystem, sourceKind: source.sourceKind, externalSourceId: source.externalSourceId, contentDigest: source.contentDigest, sourceRevision: source.sourceRevision });
  }
  const labels = new Map(metadata.presentationPreferences.map((item) => [item.topicId, item.displayLabel]));
  const sourceCount = new Map(index.map((item) => [item.topicId, 0]));
  for (const item of index) sourceCount.set(item.topicId, (sourceCount.get(item.topicId) || 0) + 1);
  const cache = metadata.topics.map((topic) => ({ topicId: topic.topicId, displayLabel: labels.get(topic.topicId) || '', paraCategory: topic.paraCategory, lifecycle: topic.lifecycle, sourceCount: sourceCount.get(topic.topicId) || 0 })).sort((left, right) => compare(left.topicId, right.topicId));
  index.sort((left, right) => compare(sourceKey(left.sourceSystem, left.sourceKind, left.externalSourceId), sourceKey(right.sourceSystem, right.sourceKind, right.externalSourceId)));
  const summary = Object.freeze({ cacheCount: cache.length, indexCount: index.length, summaryCount: 3 });
  return Object.freeze({ cache: Object.freeze(cache), index: Object.freeze(index), summary });
}

function validateGeneration(value, expectedResults = undefined) {
  if (!value || typeof value !== 'object' || value.formatVersion !== projectionFormatVersion || value.projectionId !== projectionId || !nonBlank(value.sourceRevision) || !digestPattern.test(value.inputDigest) || !value.results || typeof value.results !== 'object' || Array.isArray(value.results) || JSON.stringify(Object.keys(value.results).sort(compare)) !== JSON.stringify(['cache', 'index', 'summary'])) throw projectionError('generation-invalid', 'The committed projection generation is invalid.');
  if (!Array.isArray(value.results.cache) || !Array.isArray(value.results.index) || !value.results.summary || typeof value.results.summary !== 'object' || Array.isArray(value.results.summary)) throw projectionError('generation-invalid', 'The committed projection generation is invalid.');
  const generation = Object.freeze({ formatVersion: value.formatVersion, projectionId: value.projectionId, sourceRevision: value.sourceRevision, inputDigest: value.inputDigest, results: Object.freeze({ cache: Object.freeze(value.results.cache.map((row) => Object.freeze({ ...row }))), index: Object.freeze(value.results.index.map((row) => Object.freeze({ ...row }))), summary: Object.freeze({ ...value.results.summary }) }) });
  if (expectedResults !== undefined && JSON.stringify(generation.results) !== JSON.stringify(expectedResults)) throw projectionError('generation-invalid', 'The committed projection results do not match current inputs.');
  return generation;
}
function sync(file) { const descriptor = openSync(file, 'r'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
function crash(point, hooks) { if (process.env.COMMAND_CENTER_PROJECTION_CRASH_AT === point) process.kill(process.pid, 'SIGKILL'); if (typeof hooks?.[point] === 'function') hooks[point](); }
function readGeneration(root, expectedResults = undefined) {
  const filename = path.join(root, generationName);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw projectionError('generation-invalid', 'The committed projection generation is not an owned regular file.');
  return validateGeneration(JSON.parse(readFileSync(filename, 'utf8')), expectedResults);
}

export function openCommandCenterProjectionService({ stateDir, metadataService, authoritativeSources, hooks = {} } = {}) {
  if (!metadataService || typeof metadataService.readProjectionSnapshot !== 'function') throw new TypeError('metadataService must provide owned projection metadata');
  let root = resolveCommandCenterProjectionRoot(stateDir);
  let closed = false;
  let active;
  let committedResultsDigest;
  let current = state('idle', validProgress('validate', 0));
  const generationPath = () => path.join(root, generationName);
  const cleanStaging = () => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (/^\.generation-[0-9a-f-]{8,}\.json$/u.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) unlinkSync(path.join(root, entry.name));
    }
  };
  cleanStaging();
  const emit = (phase, completed, onProgress, observations) => { const observation = validProgress(phase, completed); observations.push(observation); current = state('rebuilding', observation, [], observations); onProgress?.({ ...observation }); };
  const checkpoint = () => metadataService.getProjectionBookkeeping(projectionId);
  const query = () => {
    if (current.mode !== 'ready') throw new CommandCenterProjectionError('projection-unavailable', 'Projections are unavailable until a committed rebuild succeeds.', { mode: 'recovery-only' });
    let generation;
    try { generation = readGeneration(root); } catch {
      current = state('recovery-only', current.progress, [diagnostic(projectionError('generation-invalid', 'The projection generation is not committed.'))]);
      throw new CommandCenterProjectionError('projection-unavailable', 'The projection generation is not committed.', { mode: 'recovery-only' });
    }
    const committed = checkpoint();
    if (!committed || committed.sourceRevision !== generation.sourceRevision || committed.inputDigest !== generation.inputDigest || committedResultsDigest !== resultsDigest(generation.results)) {
      current = state('recovery-only', current.progress, [diagnostic(projectionError('generation-invalid', 'The projection generation is not committed.'))]);
      throw new CommandCenterProjectionError('projection-unavailable', 'The projection generation is not committed.', { mode: 'recovery-only' });
    }
    return Object.freeze({ cache: generation.results.cache.map((row) => ({ ...row })), index: generation.results.index.map((row) => ({ ...row })), summary: { ...generation.results.summary } });
  };
  const service = {
    get root() { return root; },
    get databasePath() { return generationPath(); },
    async rebuild({ authoritativeSources: suppliedSources = authoritativeSources, onProgress } = {}) {
      if (closed) throw new CommandCenterProjectionError('service-closed', 'Projection service is closed.');
      if (active) return active;
      active = (async () => {
        const observations = [];
        let staging;
        try {
          root = resolveCommandCenterProjectionRoot(stateDir); cleanStaging();
          emit('validate', 0, onProgress, observations); crash('validation', hooks);
          let metadataSnapshot;
          try { metadataSnapshot = metadataService.readProjectionSnapshot(); }
          catch { throw projectionError('metadata-inconsistent', 'Owned metadata is unavailable for projection.'); }
          const metadata = metadataFacts(metadataSnapshot);
          if (!suppliedSources || typeof suppliedSources.readSnapshot !== 'function') throw sourceFailure('source-unavailable', 'The authoritative source provider is unavailable.');
          let snapshot; try { snapshot = await suppliedSources.readSnapshot(); } catch { throw sourceFailure('source-unavailable', 'The authoritative source provider is unavailable.'); }
          const sources = normalizeSources(snapshot);
          const inputDigest = sha256({ projectionId, metadata, sources: { sourceRevision: sources.sourceRevision, records: sources.records } });
          const existing = checkpoint();
          if (existing?.sourceRevision === sources.sourceRevision && existing.inputDigest === inputDigest) {
            try { const expectedResults = buildResults(metadata, sources); const generation = readGeneration(root, expectedResults); if (generation.sourceRevision === existing.sourceRevision && generation.inputDigest === existing.inputDigest) { committedResultsDigest = resultsDigest(generation.results); emit('complete', 3, onProgress, observations); current = state('ready', validProgress('complete', 3), [], observations); return existing; } } catch { /* rebuild missing or stale derived material */ }
          }
          emit('build', 1, onProgress, observations); crash('write', hooks);
          const results = buildResults(metadata, sources);
          const generation = validateGeneration({ formatVersion: projectionFormatVersion, projectionId, sourceRevision: sources.sourceRevision, inputDigest, results });
          root = resolveCommandCenterProjectionRoot(stateDir);
          staging = path.join(root, `.generation-${randomUUID()}.json`);
          writeFileSync(staging, JSON.stringify(generation)); sync(staging); crash('publication', hooks);
          emit('publish', 2, onProgress, observations);
          renameSync(staging, generationPath()); staging = undefined; sync(root); crash('bookkeeping', hooks);
          const unchangedCheckpoint = existing?.sourceRevision === generation.sourceRevision && existing.inputDigest === generation.inputDigest;
          const committed = unchangedCheckpoint
            ? existing
            : metadataService.setProjectionBookkeeping({ projectionId, sourceRevision: generation.sourceRevision, inputDigest: generation.inputDigest, ...(existing ? { updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString() } : {}) });
          committedResultsDigest = resultsDigest(generation.results);
          emit('complete', 3, onProgress, observations); current = state('ready', validProgress('complete', 3), [], observations);
          return committed;
        } catch (error) {
          if (staging) try { unlinkSync(staging); } catch { /* staging is disposable */ }
          const observation = validProgress('failed', Math.min(current.progress.completed, 3)); observations.push(observation); onProgress?.({ ...observation }); current = state('recovery-only', observation, [diagnostic(error)], observations);
          throw error;
        }
      })().finally(() => { active = undefined; });
      return active;
    },
    delete() { if (closed) throw new CommandCenterProjectionError('service-closed', 'Projection service is closed.'); root = resolveCommandCenterProjectionRoot(stateDir); rmSync(root, { recursive: true, force: true }); committedResultsDigest = undefined; current = state('idle', validProgress('validate', 0)); return true; },
    discard() { return this.delete(); },
    getStatus() { return { mode: current.mode, progress: { ...current.progress }, diagnostics: current.diagnostics.map((item) => ({ ...item })), observations: current.observations.map((item) => ({ ...item })) }; },
    getProjectionStatus() { return this.getStatus(); },
    queryProjections: query,
    listTopicCache() { return query().cache; },
    lookupSourceReference(identity) { const input = identity && typeof identity === 'object' ? identity : { externalSourceId: identity }; const matches = query().index.filter((row) => row.externalSourceId === input.externalSourceId && (input.sourceSystem === undefined || row.sourceSystem === input.sourceSystem) && (input.sourceKind === undefined || row.sourceKind === input.sourceKind)); return matches.length === 1 ? matches[0] : null; },
    getSummary() { return query().summary; },
    close() { closed = true; }
  };
  return Object.freeze(service);
}
