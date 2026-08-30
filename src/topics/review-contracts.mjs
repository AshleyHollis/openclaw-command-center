import { canonicalJson, evidenceIsIndependent, evidenceUsesOpaqueScore, materialEvidenceDigest, normalizeEvidenceFacts, proposalIdentity, sanitizedPublicValue } from './analysis-evidence.mjs';

export const TOPIC_ANALYSIS_SCHEMA_VERSION = 1;
export const ALLOWED_PROPOSAL_OPERATIONS = Object.freeze(['create', 'archive', 'restore', 'recategorize']);
const OPERATION_ALIASES = Object.freeze({ 'topic.create': 'create', 'topics.create': 'create', 'create-topic': 'create', 'topic.archive': 'archive', 'topics.archive': 'archive', 'archive-topic': 'archive', 'topic.restore': 'restore', 'topics.restore': 'restore', 'restore-topic': 'restore', 'topic.recategorize': 'recategorize', 'topics.recategorize': 'recategorize', 'recategorize-topic': 'recategorize' });

function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`); return value; }
function strings(value, field) { if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160) || [...new Set(value)].length !== value.length) throw new TypeError(`${field} must be a bounded unique string array.`); return sanitizedPublicValue([...value].sort(), field, { maxString: 160 }); }
function exactState(value, field) { object(value, field); return sanitizedPublicValue(value, field); }

export function normalizeOperation(value) { const operation = OPERATION_ALIASES[value] ?? value; if (!ALLOWED_PROPOSAL_OPERATIONS.includes(operation)) throw new TypeError(`Operation ${String(value)} is not allowlisted.`); return operation; }

export function validateProposalContract(input = {}, { requireReady = true } = {}) {
  const value = object(input, 'proposal');
  const allowed = ['schemaVersion', 'proposalId', 'revision', 'predecessorId', 'successorId', 'operation', 'affectedTopicIds', 'affectedSourceIds', 'plannedSourceIds', 'before', 'after', 'rationale', 'evidenceFacts', 'materialEvidenceDigest', 'provenance', 'searchRetrievalConsequences', 'dependencies', 'blockers', 'reversibility'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError('Proposal contains unsupported fields.');
  if (value.schemaVersion !== TOPIC_ANALYSIS_SCHEMA_VERSION) throw new TypeError('Proposal schemaVersion must be 1.');
  const operation = normalizeOperation(value.operation);
  const affectedTopicIds = strings(value.affectedTopicIds, 'affectedTopicIds');
  const affectedSourceIds = strings(value.affectedSourceIds, 'affectedSourceIds');
  const plannedSourceIds = strings(value.plannedSourceIds ?? [], 'plannedSourceIds');
  const evidenceFacts = normalizeEvidenceFacts(value.evidenceFacts ?? []);
  const before = exactState(value.before, 'before'); const after = exactState(value.after, 'after');
  if (typeof value.proposalId !== 'string' || value.proposalId !== proposalIdentity({ operation, affectedTopicIds, affectedSourceIds, plannedSourceIds, before, after })) throw new TypeError('Proposal identity is not canonical.');
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('Proposal revision must be positive.');
  const rationale = sanitizedPublicValue(value.rationale, 'rationale', { maxString: 2000 });
  const provenance = sanitizedPublicValue(object(value.provenance, 'provenance'), 'provenance');
  const searchRetrievalConsequences = sanitizedPublicValue(object(value.searchRetrievalConsequences, 'searchRetrievalConsequences'), 'searchRetrievalConsequences');
  if (!Object.keys(before).length || !Object.keys(after).length || !Object.keys(provenance).length || !Object.keys(searchRetrievalConsequences).length) throw new TypeError('Proposal state, provenance, and consequences must be inspectable.');
  const evidenceSources = new Set([...affectedSourceIds, ...plannedSourceIds]);
  if (evidenceFacts.some((fact) => !evidenceSources.has(fact.sourceId))) throw new TypeError('Evidence Source identity is outside the proposal scope.');
  const dependencies = strings(value.dependencies, 'dependencies');
  const blockers = strings(value.blockers, 'blockers');
  const reversibility = sanitizedPublicValue(object(value.reversibility, 'reversibility'), 'reversibility');
  if (typeof reversibility.reversible !== 'boolean' || typeof reversibility.irreversible !== 'boolean' || (reversibility.ambiguity !== null && typeof reversibility.ambiguity !== 'string')) throw new TypeError('Proposal reversibility disclosure is incomplete.');
  if (evidenceUsesOpaqueScore(value) || (requireReady && (!evidenceIsIndependent(evidenceFacts) || evidenceFacts.length === 0 || blockers.length > 0))) throw new TypeError('Proposal does not satisfy the inspectable evidence gate.');
  const digest = materialEvidenceDigest(evidenceFacts);
  if (value.materialEvidenceDigest !== undefined && value.materialEvidenceDigest !== digest) throw new TypeError('materialEvidenceDigest is not canonical.');
  const normalized = { ...value, schemaVersion: 1, proposalId: value.proposalId, revision: value.revision, operation, affectedTopicIds, affectedSourceIds, plannedSourceIds, before, after, rationale, evidenceFacts: Object.freeze(evidenceFacts), materialEvidenceDigest: digest, provenance, searchRetrievalConsequences, dependencies: Object.freeze(dependencies), blockers: Object.freeze(blockers), reversibility };
  if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > 12 * 1024) throw new TypeError('Proposal exceeds the public serialized bound.');
  return Object.freeze(normalized);
}

export function proposalMaterialChanged(previous, next) { return previous?.materialEvidenceDigest !== next?.materialEvidenceDigest; }
