import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';

const sourceKinds = new Set(['email', 'chat', 'note']);
const statuses = new Set(['healthy-empty', 'healthy-processed', 'pending', 'failed', 'never-connected']);

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
  const allowed = ['schemaVersion', 'sourceKind', 'runId', 'checkpoint', 'status', 'observedAt', 'lastSuccessfulAt', 'nextExpectedAt', 'processedCount', 'actionableCount', 'noteCount'];
  if (input.schemaVersion !== 1 || Object.keys(input).some(key => !allowed.includes(key)) || !sourceKinds.has(input.sourceKind) || !statuses.has(input.status)) throw sourceError('invalid-request', 'Intake receipt is invalid.');
  const healthy = input.status === 'healthy-empty' || input.status === 'healthy-processed';
  if (healthy && input.lastSuccessfulAt === undefined) throw sourceError('invalid-request', 'A healthy intake receipt requires lastSuccessfulAt.');
  if (!['failed', 'never-connected'].includes(input.status) && input.nextExpectedAt === undefined) throw sourceError('invalid-request', 'An active intake receipt requires nextExpectedAt.');
  return Object.freeze({
    schemaVersion: 1, sourceKind: input.sourceKind, runId: text(input.runId, 'runId'), checkpoint: text(input.checkpoint, 'checkpoint'), status: input.status,
    observedAt: instant(input.observedAt, 'observedAt'),
    ...(input.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: instant(input.lastSuccessfulAt, 'lastSuccessfulAt') }),
    ...(input.nextExpectedAt === undefined ? {} : { nextExpectedAt: instant(input.nextExpectedAt, 'nextExpectedAt') }),
    processedCount: count(input.processedCount, 'processedCount'), actionableCount: count(input.actionableCount, 'actionableCount'), noteCount: count(input.noteCount, 'noteCount')
  });
}

export function recordIntakeReceipt(metadata, input) {
  if (!metadata?.recordOperation) throw new TypeError('Intake receipts require metadata ownership.');
  const receipt = normalizeIntakeReceipt(input);
  const identity = { schemaVersion: 1, sourceKind: receipt.sourceKind, runId: receipt.runId, checkpoint: receipt.checkpoint };
  const logicalOperationId = stableUuid(`command-center:intake-receipt:${receipt.sourceKind}:${receipt.runId}:${receipt.checkpoint}`);
  const prior = metadata.getOperation?.(logicalOperationId);
  if (prior && prior.intentDigest !== digest(identity)) throw sourceError('intent-mismatch', 'The intake receipt identity changed.');
  metadata.recordOperation({
    logicalOperationId, transportRequestId: logicalOperationId, intentDigest: digest(identity), operationKind: `intake-receipt.${receipt.sourceKind}.v1`,
    state: receipt.status === 'pending' ? 'pending' : receipt.status === 'failed' ? 'not-applied' : 'applied', resultStatus: receipt.status,
    resultIdentity: JSON.stringify(receipt), observedRevision: `${receipt.runId}:${receipt.checkpoint}`, createdAt: prior?.createdAt ?? receipt.observedAt, updatedAt: receipt.observedAt
  });
  return Object.freeze({ schemaVersion: 1, disposition: prior ? 'updated' : 'recorded', logicalOperationId, receipt });
}
