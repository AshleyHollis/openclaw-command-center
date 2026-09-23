import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';
import { normalizeProducerIntakeScope } from './producer-intake-plan.mjs';

const sourceKinds = new Set(['email', 'chat', 'note']);
const statuses = new Set(['healthy-empty', 'healthy-processed', 'incomplete', 'pending', 'failed', 'never-connected']);

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  : value;
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
function stableUuid(value) { const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split(''); hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]; return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`; }
function text(value, name, limit = 300) { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw sourceError('invalid-request', `${name} is invalid.`); return value.trim(); }
function instant(value, name) { const result = text(value, name, 64); if (!Number.isFinite(Date.parse(result))) throw sourceError('invalid-request', `${name} is invalid.`); return new Date(result).toISOString(); }
function count(value, name) { if (!Number.isSafeInteger(value) || value < 0) throw sourceError('invalid-request', `${name} is invalid.`); return value; }

export function normalizeIntakeReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw sourceError('invalid-request', 'Intake receipt is invalid.');
  const allowed = ['schemaVersion', 'sourceKind', 'runId', 'checkpoint', 'status', 'observedAt', 'lastSuccessfulAt', 'nextExpectedAt', 'processedCount', 'actionableCount', 'noteCount', 'continuation', 'scope', 'enumeration', 'purpose', 'retryOfRunId', 'planDigest', 'unadmittedSourceCount'];
  if (input.schemaVersion !== 1 || Object.keys(input).some(key => !allowed.includes(key)) || !sourceKinds.has(input.sourceKind) || !statuses.has(input.status)) throw sourceError('invalid-request', 'Intake receipt is invalid.');
  const purpose = input.purpose ?? 'producer';
  if (!['producer', 'admitted-retry'].includes(purpose) || purpose === 'admitted-retry' && (input.sourceKind !== 'email' || input.retryOfRunId === undefined || input.planDigest === undefined || input.enumeration !== undefined || input.continuation !== undefined) || purpose === 'producer' && (input.retryOfRunId !== undefined || input.unadmittedSourceCount !== undefined) || input.planDigest !== undefined && (input.sourceKind !== 'email' || !/^sha256:[a-f0-9]{64}$/u.test(input.planDigest))) throw sourceError('invalid-request', 'Intake receipt purpose is invalid.');
  const healthy = input.status === 'healthy-empty' || input.status === 'healthy-processed';
  if (healthy && input.lastSuccessfulAt === undefined) throw sourceError('invalid-request', 'A healthy intake receipt requires lastSuccessfulAt.');
  const continuation = input.continuation;
  if (continuation !== undefined && (!continuation || typeof continuation !== 'object' || Array.isArray(continuation) || Object.keys(continuation).some(key => !['scopeId', 'cursor', 'remainingCount', 'failedReadCount', 'scanCapReached'].includes(key)) || typeof continuation.scanCapReached !== 'boolean')) throw sourceError('invalid-request', 'Intake continuation is invalid.');
  if (input.status === 'incomplete' && continuation === undefined) throw sourceError('invalid-request', 'Incomplete intake requires an exact continuation.');
  if (healthy && continuation !== undefined) throw sourceError('invalid-request', 'Healthy intake cannot retain a continuation.');
  if (purpose === 'producer' && input.sourceKind !== 'chat' && !['failed', 'never-connected'].includes(input.status) && input.nextExpectedAt === undefined) throw sourceError('invalid-request', 'A scheduled intake receipt requires nextExpectedAt.');
  const scope = input.scope;
  let normalizedScope;
  if (scope !== undefined) {
    if (input.sourceKind !== 'email') throw sourceError('invalid-request', 'Intake scope is invalid.');
    try { normalizedScope = normalizeProducerIntakeScope(scope); }
    catch { throw sourceError('invalid-request', 'Intake scope is invalid.'); }
  }
  const enumeration = input.enumeration;
  if (enumeration !== undefined && (!enumeration || typeof enumeration !== 'object' || Array.isArray(enumeration) || Object.keys(enumeration).some(key => !['scope', 'scannedCount', 'remainingCount', 'failedReadCount', 'scanCapReached'].includes(key)) || !['complete', 'bounded', 'partial'].includes(enumeration.scope) || typeof enumeration.scanCapReached !== 'boolean')) throw sourceError('invalid-request', 'Intake enumeration is invalid.');
  if (enumeration !== undefined && (enumeration.scope === 'complete' && (enumeration.remainingCount !== 0 || enumeration.failedReadCount !== 0 || enumeration.scanCapReached) || scope && enumeration.scannedCount > scope.maxMessages)) throw sourceError('invalid-request', 'Intake enumeration conflicts with its declared scope.');
  return Object.freeze({
    schemaVersion: 1, sourceKind: input.sourceKind, runId: text(input.runId, 'runId'), checkpoint: text(input.checkpoint, 'checkpoint'), status: input.status,
    ...(purpose === 'admitted-retry' ? { purpose, retryOfRunId: text(input.retryOfRunId, 'retryOfRunId'), ...(input.unadmittedSourceCount === undefined ? {} : { unadmittedSourceCount: count(input.unadmittedSourceCount, 'unadmittedSourceCount') }) } : {}),
    ...(input.planDigest === undefined ? {} : { planDigest: input.planDigest }),
    observedAt: instant(input.observedAt, 'observedAt'),
    ...(input.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: instant(input.lastSuccessfulAt, 'lastSuccessfulAt') }),
    ...(input.nextExpectedAt === undefined ? {} : { nextExpectedAt: instant(input.nextExpectedAt, 'nextExpectedAt') }),
    processedCount: count(input.processedCount, 'processedCount'), actionableCount: count(input.actionableCount, 'actionableCount'), noteCount: count(input.noteCount, 'noteCount'),
    ...(continuation === undefined ? {} : { continuation: Object.freeze({ scopeId: text(continuation.scopeId, 'continuation.scopeId'), cursor: text(continuation.cursor, 'continuation.cursor'), remainingCount: count(continuation.remainingCount, 'continuation.remainingCount'), failedReadCount: count(continuation.failedReadCount, 'continuation.failedReadCount'), scanCapReached: continuation.scanCapReached }) }),
    ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
    ...(enumeration === undefined ? {} : { enumeration: Object.freeze({ scope: enumeration.scope, scannedCount: count(enumeration.scannedCount, 'enumeration.scannedCount'), remainingCount: count(enumeration.remainingCount, 'enumeration.remainingCount'), failedReadCount: count(enumeration.failedReadCount, 'enumeration.failedReadCount'), scanCapReached: enumeration.scanCapReached }) })
  });
}

function parsedReceipt(operation) { try { return JSON.parse(operation?.resultIdentity ?? 'null'); } catch { return null; } }

export function findIntakeContinuation(metadata, sourceKind) {
  if (!sourceKinds.has(sourceKind)) throw sourceError('invalid-request', 'sourceKind is invalid.');
  const operations = (metadata?.listOperations?.() ?? []).filter(item => item.operationKind === `intake-receipt.${sourceKind}.v1` && item.resultStatus !== 'superseded').reverse();
  for (const operation of operations) {
    const receipt = parsedReceipt(operation);
    if (!receipt || receipt.sourceKind !== sourceKind || receipt.purpose === 'admitted-retry') continue;
    if (['healthy-empty', 'healthy-processed', 'never-connected'].includes(receipt.status)) return null;
    if (['incomplete', 'failed'].includes(receipt.status) && receipt.continuation) return Object.freeze({ ...receipt.continuation });
  }
  return null;
}

export function recordIntakeReceipt(metadata, input) {
  if (!metadata?.commitIntakeReceiptOperation) throw new TypeError('Intake receipts require metadata ownership.');
  const receipt = normalizeIntakeReceipt(input);
  const identity = { schemaVersion: 1, sourceKind: receipt.sourceKind, runId: receipt.runId, ...(receipt.planDigest ? { planDigest: receipt.planDigest } : {}) };
  const logicalOperationId = stableUuid(`command-center:intake-receipt:${receipt.sourceKind}:${receipt.runId}`);
  const committed = metadata.commitIntakeReceiptOperation({
    logicalOperationId, transportRequestId: logicalOperationId, intentDigest: digest(identity), operationKind: `intake-receipt.${receipt.sourceKind}.v1`,
    state: receipt.status === 'pending' ? 'pending' : receipt.status === 'failed' ? 'not-applied' : 'applied', resultStatus: receipt.status,
    resultIdentity: JSON.stringify(receipt), observedRevision: `${receipt.runId}:${receipt.checkpoint}`, createdAt: receipt.observedAt, updatedAt: receipt.observedAt
  });
  let durableReceipt;
  try { durableReceipt = JSON.parse(committed.operation.resultIdentity); } catch { throw sourceError('conflict', 'The durable intake receipt is unavailable.'); }
  return Object.freeze({ schemaVersion: 1, disposition: committed.disposition, logicalOperationId, receipt: Object.freeze(durableReceipt) });
}
