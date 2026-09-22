import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';

const sourceKinds = new Set(['email', 'chat', 'note']);
const outcomeKinds = new Set(['obligation', 'decision', 'information', 'no-action']);
const outcomeStatuses = new Set(['applied', 'pending-decision', 'quiet', 'no-action', 'unresolved-topic', 'failed', 'unknown']);
const unsettledLoopStates = new Set(['suggested', 'decision-needed', 'uncertain']);

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  : value;
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
function stableUuid(value) { const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split(''); hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]; return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`; }
const fail = (code, message = code) => { throw sourceError(code, message); };
function text(value, name, limit = 500) { if (typeof value !== 'string' || !value.trim() || value.length > limit) fail('invalid-request', `${name} is invalid.`); return value.trim(); }
function instant(value, name) { const result = text(value, name, 64); if (!Number.isFinite(Date.parse(result))) fail('invalid-request', `${name} is invalid.`); return new Date(result).toISOString(); }
function count(value, name) { if (!Number.isSafeInteger(value) || value < 0) fail('invalid-request', `${name} is invalid.`); return value; }
function jsonObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-request', `${name} is invalid.`);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('invalid-request', `${name} is invalid.`); }
  if (!encoded || encoded.length > 262_144) fail('invalid-request', `${name} is invalid.`);
  return Object.freeze(JSON.parse(encoded));
}
const extractionKeys = new Set(['schemaVersion', 'proposedTopic', 'notePath', 'knowledgeMarkdown', 'knowledgeOutcomeId', 'knowledgeSummary', 'obligations', 'noAction']);
const obligationKeys = new Set(['obligationId', 'title', 'classification', 'provenance', 'correlationNamespace', 'correlationId', 'confidence', 'dueAt', 'reviewAt', 'plannedAt', 'importance', 'importanceOrigin', 'effortMinutes', 'contexts', 'dependencies']);
export function normalizeAcceptedExtraction(input) {
  const value = jsonObject(input, 'acceptedExtraction');
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => !extractionKeys.has(key)) || !Array.isArray(value.obligations) || value.obligations.length > 100 || typeof value.notePath !== 'string' || value.notePath.length > 1000 || typeof value.knowledgeMarkdown !== 'string' || value.knowledgeMarkdown.length > 262_144) fail('invalid-request', 'acceptedExtraction is invalid.');
  if (value.proposedTopic !== undefined && value.proposedTopic !== null && (typeof value.proposedTopic !== 'string' || !value.proposedTopic.trim() || value.proposedTopic.length > 200)) fail('invalid-request', 'acceptedExtraction.proposedTopic is invalid.');
  for (const field of ['knowledgeOutcomeId', 'knowledgeSummary']) if (value[field] !== undefined) text(value[field], `acceptedExtraction.${field}`, field === 'knowledgeSummary' ? 300 : 500);
  const obligations = value.obligations.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !obligationKeys.has(key))) fail('invalid-request', `acceptedExtraction.obligations[${index}] is invalid.`);
    const normalized = { ...item, obligationId: text(item.obligationId, `acceptedExtraction.obligations[${index}].obligationId`, 300), title: text(item.title, `acceptedExtraction.obligations[${index}].title`, 500), provenance: item.provenance, classification: item.classification ?? 'obligation' };
    if (!['explicit', 'inferred', 'idea', 'quoted'].includes(normalized.provenance) || !['obligation', 'decision'].includes(normalized.classification)) fail('invalid-request', `acceptedExtraction.obligations[${index}] is invalid.`);
    return Object.freeze(normalized);
  });
  if (value.noAction !== undefined && (!value.noAction || typeof value.noAction !== 'object' || Array.isArray(value.noAction) || Object.keys(value.noAction).some(key => !['outcomeId', 'summary'].includes(key)))) fail('invalid-request', 'acceptedExtraction.noAction is invalid.');
  const noAction = value.noAction === undefined ? undefined : Object.freeze({ outcomeId: text(value.noAction.outcomeId, 'acceptedExtraction.noAction.outcomeId', 300), summary: text(value.noAction.summary, 'acceptedExtraction.noAction.summary', 300) });
  return Object.freeze({ schemaVersion: 1, ...(value.proposedTopic !== undefined ? { proposedTopic: value.proposedTopic } : {}), notePath: value.notePath, knowledgeMarkdown: value.knowledgeMarkdown, ...(value.knowledgeOutcomeId !== undefined ? { knowledgeOutcomeId: value.knowledgeOutcomeId.trim() } : {}), ...(value.knowledgeSummary !== undefined ? { knowledgeSummary: value.knowledgeSummary.trim() } : {}), obligations: Object.freeze(obligations), ...(noAction ? { noAction } : {}) });
}
function sourceIdentity(input) {
  return Object.freeze({
    sourceKind: sourceKinds.has(input?.sourceKind) ? input.sourceKind : fail('invalid-request', 'sourceKind is invalid.'),
    sourceExternalId: text(input.sourceExternalId, 'sourceExternalId'),
    sourceVersion: text(input.sourceVersion, 'sourceVersion', 300)
  });
}

export function normalizeIntakeSourcePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-request', 'Intake source plan is invalid.');
  const allowed = ['schemaVersion', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'checkpoint', 'observedAt', 'processorVersion', 'retainedNoteRevision', 'acceptedExtraction', 'outcomes', 'enumeration'];
  if (input.schemaVersion !== 1 || Object.keys(input).some(key => !allowed.includes(key)) || !Array.isArray(input.outcomes) || input.outcomes.length < 1 || input.outcomes.length > 100) fail('invalid-request', 'Intake source plan is invalid.');
  const source = sourceIdentity(input);
  const outcomes = input.outcomes.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['outcomeId', 'kind'].includes(key)) || !outcomeKinds.has(item.kind)) fail('invalid-request', `outcomes[${index}] is invalid.`);
    return Object.freeze({ outcomeId: text(item.outcomeId, `outcomes[${index}].outcomeId`, 300), kind: item.kind });
  });
  if (new Set(outcomes.map(item => item.outcomeId)).size !== outcomes.length) fail('invalid-request', 'Intake outcome identities must be unique.');
  const enumeration = input.enumeration ?? { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false };
  if (!enumeration || typeof enumeration !== 'object' || Array.isArray(enumeration) || Object.keys(enumeration).some(key => !['scope', 'scannedCount', 'remainingCount', 'failedReadCount', 'scanCapReached', 'scopeId', 'resumeCursor'].includes(key)) || !['complete', 'bounded', 'partial'].includes(enumeration.scope) || typeof enumeration.scanCapReached !== 'boolean') fail('invalid-request', 'enumeration is invalid.');
  const incomplete = enumeration.scope !== 'complete' || enumeration.remainingCount > 0 || enumeration.failedReadCount > 0 || enumeration.scanCapReached;
  if (incomplete && (enumeration.scopeId === undefined || enumeration.resumeCursor === undefined)) fail('invalid-request', 'Incomplete enumeration requires an exact resume scope and cursor.');
  const retainedNoteRevision = input.retainedNoteRevision === undefined ? undefined : text(input.retainedNoteRevision, 'retainedNoteRevision', 100);
  return Object.freeze({ schemaVersion: 1, ...source, checkpoint: text(input.checkpoint, 'checkpoint'), observedAt: instant(input.observedAt, 'observedAt'), processorVersion: text(input.processorVersion, 'processorVersion', 300), ...(retainedNoteRevision ? { retainedNoteRevision } : {}), acceptedExtraction: normalizeAcceptedExtraction(input.acceptedExtraction), outcomes: Object.freeze(outcomes), enumeration: Object.freeze({ scope: enumeration.scope, scannedCount: count(enumeration.scannedCount, 'scannedCount'), remainingCount: count(enumeration.remainingCount, 'remainingCount'), failedReadCount: count(enumeration.failedReadCount, 'failedReadCount'), scanCapReached: enumeration.scanCapReached, ...(incomplete ? { scopeId: text(enumeration.scopeId, 'scopeId'), resumeCursor: text(enumeration.resumeCursor, 'resumeCursor') } : {}) }) });
}

export function recordIntakeSourcePlan(metadata, input) {
  if (!metadata?.commitIntakeAccountingOperation) throw new TypeError('Intake accounting requires metadata ownership.');
  const plan = normalizeIntakeSourcePlan(input);
  const identity = { schemaVersion: 1, sourceKind: plan.sourceKind, sourceExternalId: plan.sourceExternalId, sourceVersion: plan.sourceVersion, checkpoint: plan.checkpoint, processorVersion: plan.processorVersion, ...(plan.retainedNoteRevision ? { retainedNoteRevision: plan.retainedNoteRevision } : {}), acceptedExtraction: plan.acceptedExtraction, outcomes: plan.outcomes, enumeration: plan.enumeration };
  const logicalOperationId = stableUuid(`command-center:intake-source:${plan.sourceKind}:${plan.sourceExternalId}:${plan.sourceVersion}`);
  const intentDigest = digest(identity);
  const committed = metadata.commitIntakeAccountingOperation({ logicalOperationId, intentDigest, operationKind: `intake-source.${plan.sourceKind}.v1`, state: 'applied', resultStatus: 'planned', resultIdentity: JSON.stringify(plan), observedRevision: plan.sourceVersion, createdAt: plan.observedAt });
  let durablePlan;
  try { durablePlan = JSON.parse(committed.operation.resultIdentity); } catch { fail('conflict', 'The durable intake source plan is unavailable.'); }
  const account = projectIntakeAccounts(metadata, plan.sourceKind).find(item => item.sourceExternalId === plan.sourceExternalId && item.sourceVersion === plan.sourceVersion);
  return Object.freeze({ schemaVersion: 1, disposition: committed.disposition, logicalOperationId, plan: Object.freeze(durablePlan), account });
}

export function loadIntakeSourceAccount(metadata, input) {
  if (!metadata?.getOperation) throw new TypeError('Intake accounting requires metadata ownership.');
  const source = sourceIdentity(input);
  const logicalOperationId = stableUuid(`command-center:intake-source:${source.sourceKind}:${source.sourceExternalId}:${source.sourceVersion}`);
  const operation = metadata.getOperation(logicalOperationId);
  if (!operation) return null;
  const plan = parsedResult(operation);
  if (!plan || plan.sourceKind !== source.sourceKind || plan.sourceExternalId !== source.sourceExternalId || plan.sourceVersion !== source.sourceVersion) fail('conflict', 'The durable intake source plan is unavailable.');
  const account = projectIntakeAccounts(metadata, source.sourceKind).find(item => item.sourceExternalId === source.sourceExternalId && item.sourceVersion === source.sourceVersion);
  return Object.freeze({ schemaVersion: 1, logicalOperationId, plan: Object.freeze(plan), account });
}

export function normalizeIntakeOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-request', 'Intake outcome is invalid.');
  const allowed = ['schemaVersion', 'sourceKind', 'sourceExternalId', 'sourceVersion', 'outcomeId', 'kind', 'status', 'summary', 'loopId', 'topicId', 'sourceReferenceId', 'sourcePath', 'sourceReferenceVersion', 'recordedAt', 'errorCode'];
  if (input.schemaVersion !== 1 || Object.keys(input).some(key => !allowed.includes(key)) || !outcomeKinds.has(input.kind) || !outcomeStatuses.has(input.status)) fail('invalid-request', 'Intake outcome is invalid.');
  const source = sourceIdentity(input);
  const value = { schemaVersion: 1, ...source, outcomeId: text(input.outcomeId, 'outcomeId', 300), kind: input.kind, status: input.status, summary: text(input.summary, 'summary', 300), recordedAt: instant(input.recordedAt, 'recordedAt') };
  if (input.loopId !== undefined) value.loopId = text(input.loopId, 'loopId', 300);
  if (input.topicId !== undefined) value.topicId = text(input.topicId, 'topicId', 300);
  if (input.sourceReferenceId !== undefined) value.sourceReferenceId = text(input.sourceReferenceId, 'sourceReferenceId', 300);
  if (input.sourcePath !== undefined) value.sourcePath = text(input.sourcePath, 'sourcePath', 1000);
  if (input.sourceReferenceVersion !== undefined) value.sourceReferenceVersion = text(input.sourceReferenceVersion, 'sourceReferenceVersion', 300);
  if (input.errorCode !== undefined) value.errorCode = text(input.errorCode, 'errorCode', 100);
  if (['applied', 'pending-decision'].includes(value.status) && !value.loopId) fail('invalid-request', 'An actionable intake outcome requires loopId.');
  if (value.status === 'quiet' && (!value.topicId || !value.sourceReferenceId || !value.sourcePath || !value.sourceReferenceVersion)) fail('invalid-request', 'A quiet intake outcome requires exact Source Reference evidence.');
  if (value.status === 'pending-decision' && value.kind !== 'decision') fail('invalid-request', 'Only a decision outcome can remain pending.');
  return Object.freeze(value);
}

export function recordIntakeOutcome(metadata, input) {
  if (!metadata?.commitIntakeAccountingOperation) throw new TypeError('Intake accounting requires metadata ownership.');
  const outcome = normalizeIntakeOutcome(input);
  const logicalOperationId = stableUuid(`command-center:intake-outcome:${outcome.sourceKind}:${outcome.sourceExternalId}:${outcome.sourceVersion}:${outcome.outcomeId}`);
  const intent = { schemaVersion: 1, sourceKind: outcome.sourceKind, sourceExternalId: outcome.sourceExternalId, sourceVersion: outcome.sourceVersion, outcomeId: outcome.outcomeId, kind: outcome.kind };
  const { recordedAt: _recordedAt, ...semanticResult } = outcome;
  const intentDigest = digest({ ...intent, result: semanticResult });
  const committed = metadata.commitIntakeAccountingOperation({ logicalOperationId, intentDigest, operationKind: `intake-outcome.${outcome.sourceKind}.v1`, state: ['failed', 'unknown'].includes(outcome.status) ? 'not-applied' : 'applied', resultStatus: outcome.status, resultIdentity: JSON.stringify(outcome), observedRevision: outcome.sourceVersion, createdAt: outcome.recordedAt });
  let durableOutcome;
  try { durableOutcome = JSON.parse(committed.operation.resultIdentity); } catch { fail('conflict', 'The durable intake outcome is unavailable.'); }
  return Object.freeze({ schemaVersion: 1, disposition: committed.disposition, logicalOperationId, outcome: Object.freeze(durableOutcome) });
}

function parsedResult(operation) { try { return JSON.parse(operation?.resultIdentity ?? 'null'); } catch { return null; } }
export function projectIntakeAccounts(metadata, sourceKind, limit) {
  if (!sourceKinds.has(sourceKind) || limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) fail('invalid-request', 'Intake account projection is invalid.');
  const operations = metadata?.listOperations?.() ?? [];
  const allPlans = operations.filter(item => item.operationKind === `intake-source.${sourceKind}.v1`).map(operation => ({ operation, plan: parsedResult(operation) })).filter(item => item.plan).reverse();
  const plans = limit === undefined ? allPlans : allPlans.slice(0, limit);
  const outcomes = operations.filter(item => item.operationKind === `intake-outcome.${sourceKind}.v1`).map(parsedResult).filter(Boolean);
  return Object.freeze(plans.map(({ plan }) => {
    const matching = new Map(outcomes.filter(item => item.sourceExternalId === plan.sourceExternalId && item.sourceVersion === plan.sourceVersion).map(item => [item.outcomeId, item]));
    const projected = plan.outcomes.map(expected => {
      const outcome = matching.get(expected.outcomeId);
      if (!outcome) return Object.freeze({ ...expected, status: 'missing' });
      const loop = outcome.loopId ? metadata.getOpenLoop?.(outcome.loopId) : null;
      const clarified = outcome.status === 'pending-decision' && loop && !unsettledLoopStates.has(loop.state);
      return Object.freeze({ ...outcome, ...(clarified ? { status: 'clarified', loopRevision: loop.revision } : loop ? { loopRevision: loop.revision } : {}) });
    });
    const accounted = projected.every(item => item.status !== 'missing');
    const resolved = accounted && projected.every(item => !['pending-decision', 'unresolved-topic', 'failed', 'unknown'].includes(item.status));
    return Object.freeze({ schemaVersion: 1, sourceKind, sourceExternalId: plan.sourceExternalId, sourceVersion: plan.sourceVersion, checkpoint: plan.checkpoint, observedAt: plan.observedAt, enumeration: plan.enumeration, accounted, resolved, counts: Object.freeze({ expected: projected.length, accounted: projected.filter(item => item.status !== 'missing').length, obligations: projected.filter(item => item.kind === 'obligation').length, decisionsPending: projected.filter(item => item.status === 'pending-decision').length, quiet: projected.filter(item => item.status === 'quiet').length, unresolvedTopics: projected.filter(item => item.status === 'unresolved-topic').length, failed: projected.filter(item => ['failed', 'unknown'].includes(item.status)).length }), outcomes: Object.freeze(projected) });
  }));
}
