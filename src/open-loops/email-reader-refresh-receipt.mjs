import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';

const fail = () => { throw sourceError('invalid-request', 'Email reader refresh receipt is invalid.'); };
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const uuid = value => {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
};

export function normalizeEmailReaderRefreshReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['schemaVersion', 'sourceNamespace', 'captureRunId', 'batchId', 'attemptId', 'status', 'observedAt', 'selectedCount', 'linkedCount', 'unavailableCount', 'failureCode'].includes(key)) || input.schemaVersion !== 1) fail();
  if (typeof input.captureRunId !== 'string' || !input.captureRunId.trim() || input.captureRunId.length > 300) fail();
  if (typeof input.sourceNamespace !== 'string' || !/^microsoft-graph:sha256:[a-f0-9]{64}$/u.test(input.sourceNamespace) || typeof input.batchId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.batchId) || typeof input.attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.attemptId)) fail();
  if (!['pending', 'completed', 'failed'].includes(input.status) || typeof input.observedAt !== 'string' || input.observedAt.length > 64 || !Number.isFinite(Date.parse(input.observedAt))) fail();
  for (const key of ['selectedCount', 'linkedCount', 'unavailableCount']) if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 50) fail();
  if (input.linkedCount + input.unavailableCount > input.selectedCount || input.status === 'completed' && input.linkedCount + input.unavailableCount !== input.selectedCount || input.status === 'pending' && (input.linkedCount || input.unavailableCount)) fail();
  if (input.status === 'failed' ? !['source-read-failed', 'provider-read-failed', 'reader-plan-invalid', 'reader-apply-failed', 'reader-refresh-failed'].includes(input.failureCode) : input.failureCode !== undefined) fail();
  return Object.freeze({ schemaVersion: 1, sourceNamespace: input.sourceNamespace, captureRunId: input.captureRunId.trim(), batchId: input.batchId, attemptId: input.attemptId.toLowerCase(), status: input.status, observedAt: new Date(input.observedAt).toISOString(), selectedCount: input.selectedCount, linkedCount: input.linkedCount, unavailableCount: input.unavailableCount, ...(input.failureCode ? { failureCode: input.failureCode } : {}) });
}

export function emailReaderRefreshOperationId(receipt) {
  return uuid(`command-center:email-reader-refresh:${receipt.sourceNamespace}:${receipt.captureRunId}:${receipt.batchId}:${receipt.attemptId}`);
}

export function emailReaderRefreshIntentDigest(receipt) {
  return sha(JSON.stringify([receipt.sourceNamespace, receipt.captureRunId, receipt.batchId, receipt.attemptId]));
}

export function recordEmailReaderRefreshReceipt(metadata, input) {
  if (!metadata?.commitEmailReaderRefreshOperation) throw new TypeError('Email reader refresh receipts require metadata ownership.');
  const receipt = normalizeEmailReaderRefreshReceipt(input);
  const logicalOperationId = emailReaderRefreshOperationId(receipt);
  const committed = metadata.commitEmailReaderRefreshOperation({
    logicalOperationId, intentDigest: emailReaderRefreshIntentDigest(receipt), operationKind: 'email-reader.refresh.v1',
    state: receipt.status === 'pending' ? 'pending' : receipt.status === 'completed' ? 'applied' : 'not-applied',
    resultStatus: receipt.status, resultIdentity: JSON.stringify(receipt), observedRevision: receipt.batchId,
    createdAt: receipt.observedAt, updatedAt: receipt.observedAt
  });
  let durableReceipt;
  try { durableReceipt = JSON.parse(committed.operation.resultIdentity); }
  catch { throw sourceError('conflict', 'The durable email reader refresh receipt is unavailable.'); }
  return Object.freeze({ schemaVersion: 1, disposition: committed.disposition, logicalOperationId, receipt: Object.freeze(durableReceipt) });
}
