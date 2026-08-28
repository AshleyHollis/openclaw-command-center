import { createHash } from 'node:crypto';

const PRIVATE_CONTENT = /(?:bearer\s+|password\s*[:=]|secret\s*[:=]|token\s*[:=]|cookie\s*[:=]|-----BEGIN|(?:^|\s)\/(?:home|users|workspace|var)\/)/iu;
const INACTIVITY = /\b(?:inactive|inactivity|no activity|elapsed|last active|age)\b/iu;
function canonicalFact(value) { return value.trim().replace(/\s+/gu, ' '); }

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
export function sha256(value) { return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')}`; }

export function sanitizedPublicValue(value, field = 'proposal field', { depth = 0, maxString = 320 } = {}) {
  if (depth > 5) throw new TypeError(`${field} exceeds the public nesting bound.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite.`); return value; }
  if (typeof value === 'string') {
    const text = value.trim().replace(/\s+/gu, ' ');
    if (!text || text.length > maxString || PRIVATE_CONTENT.test(text)) throw new TypeError(`${field} must be bounded and sanitized.`);
    return text;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new TypeError(`${field} exceeds the public item bound.`);
    return value.map((item) => sanitizedPublicValue(item, field, { depth: depth + 1, maxString }));
  }
  if (!value || typeof value !== 'object') throw new TypeError(`${field} is not public JSON data.`);
  const entries = Object.entries(value);
  if (entries.length > 24 || entries.some(([key]) => !key || key.length > 80 || PRIVATE_CONTENT.test(key))) throw new TypeError(`${field} exceeds the public object bound.`);
  return Object.fromEntries(entries.map(([key, item]) => [key, sanitizedPublicValue(item, `${field}.${key}`, { depth: depth + 1, maxString })]));
}

export function canonicalOperationIntent({ operation, before = {}, after = {} } = {}) {
  const target = after?.topic && typeof after.topic === 'object' ? after.topic : after;
  if (operation === 'create') return { name: target?.name ?? null, paraCategory: target?.paraCategory ?? null };
  if (operation === 'restore' || operation === 'recategorize') return { paraCategory: target?.paraCategory ?? null };
  return {};
}

export function normalizeEvidenceFacts(facts = []) {
  if (!Array.isArray(facts) || facts.length > 8) throw new TypeError('A proposal may contain at most eight evidence facts.');
  const normalized = facts.map((fact, index) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) throw new TypeError(`Evidence fact ${index} must be an object.`);
    const keys = Object.keys(fact);
    if (keys.some((key) => !['evidenceId', 'proposalId', 'sourceId', 'sourceRevision', 'fact', 'material', 'observedAt', 'kind'].includes(key))) throw new TypeError('Evidence facts contain an unsupported field.');
    if (fact.evidenceId !== undefined && (typeof fact.evidenceId !== 'string' || !fact.evidenceId.trim() || fact.evidenceId.length > 160)) throw new TypeError('Evidence facts require a bounded identity.');
    if (fact.kind !== undefined && (typeof fact.kind !== 'string' || !fact.kind.trim() || fact.kind.length > 80)) throw new TypeError('Evidence fact kind must be a bounded string.');
    if (typeof fact.sourceId !== 'string' || !fact.sourceId.trim() || typeof fact.sourceRevision !== 'string' || !fact.sourceRevision.trim()) throw new TypeError('Evidence facts require exact source identity and observed revision.');
    const text = typeof fact.fact === 'string' ? canonicalFact(fact.fact) : '';
    if (!text || text.length > 320 || PRIVATE_CONTENT.test(text)) throw new TypeError('Evidence facts must be bounded and sanitized.');
    if (fact.material !== true) throw new TypeError('Only material evidence facts may be retained.');
    if (fact.observedAt !== undefined && (typeof fact.observedAt !== 'string' || !Number.isFinite(Date.parse(fact.observedAt)))) throw new TypeError('Evidence observedAt must be an RFC 3339 instant.');
    return Object.freeze({ evidenceId: fact.evidenceId ?? `evidence:${sha256({ sourceId: fact.sourceId, sourceRevision: fact.sourceRevision, fact: text }).slice(7, 31)}`, sourceId: fact.sourceId, sourceRevision: fact.sourceRevision, fact: text, material: true, ...(fact.kind ? { kind: fact.kind } : {}), ...(fact.observedAt ? { observedAt: fact.observedAt } : {}) });
  });
  const identities = new Set();
  const evidenceIds = new Set();
  for (const fact of normalized) {
    if (evidenceIds.has(fact.evidenceId)) throw new TypeError('Evidence facts must have distinct identities.');
    evidenceIds.add(fact.evidenceId);
    const identity = canonicalJson({ sourceId: fact.sourceId, sourceRevision: fact.sourceRevision, fact: fact.fact, kind: fact.kind ?? null });
    if (identities.has(identity)) throw new TypeError('Evidence facts must be distinct material observations.');
    identities.add(identity);
  }
  return normalized.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

export function materialEvidenceDigest(facts = []) {
  const normalized = normalizeEvidenceFacts(facts).map(({ sourceId, sourceRevision, fact, material, kind }) => ({ sourceId, sourceRevision, fact, material, ...(kind ? { kind } : {}) })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return sha256(normalized);
}

export function proposalIdentity({ operation, affectedTopicIds = [], affectedSourceIds = [], plannedSourceIds = [], before = {}, after = {} } = {}) {
  return sha256({ operation, parameters: canonicalOperationIntent({ operation, before, after }), affectedTopicIds: [...affectedTopicIds].sort(), affectedSourceIds: [...affectedSourceIds].sort(), plannedSourceIds: [...plannedSourceIds].sort() });
}

export function evidenceIsIndependent(facts = []) { return normalizeEvidenceFacts(facts).some((fact) => !INACTIVITY.test(fact.fact) && fact.kind !== 'inactivity'); }

export function evidenceUsesOpaqueScore(value) {
  if (typeof value === 'string') return /\b(?:confidence|probability|risk|score)\b\s*(?:is|was|of|:|=)/iu.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => /^(confidence|probability|risk|score)$/iu.test(key)) || Object.values(value).some((item) => Array.isArray(item) ? item.some(evidenceUsesOpaqueScore) : evidenceUsesOpaqueScore(item));
}

export function evidenceSummary(facts = []) { return Object.freeze({ strength: normalizeEvidenceFacts(facts).length, digest: materialEvidenceDigest(facts) }); }
