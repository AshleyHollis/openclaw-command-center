import { opaqueNotificationId, notificationPreview, sensitivePreviewSafe } from './preview.mjs';

export const NOTIFICATION_CANDIDATE_VERSION = 1;
export const NOTIFICATION_MAX_BYTES = 2048;
export const NOTIFICATION_MAX_AGE_MS = 86_400_000;
export const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function snapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = {
    version: value.version,
    emissionId: value.emissionId,
    logicalOperationId: value.logicalOperationId,
    attentionClass: value.attentionClass,
    preview: value.preview && { title: value.preview.title, body: value.preview.body },
    deepLink: value.deepLink && { kind: value.deepLink.kind, destinationId: value.deepLink.destinationId, recordId: value.deepLink.recordId },
    expiresAtMs: value.expiresAtMs
  };
  if (Object.keys(value).length !== 7 || !candidate.preview || !candidate.deepLink) return null;
  if (Object.keys(value.preview).length !== 2 || Object.keys(value.deepLink).length !== 3) return null;
  return candidate;
}

export function createNotificationCandidate({ episodeId, severity, kind = 'attention', epochId, nowMs = Date.now(), genericPreview = false, destinationId = 'attention-card', summaryCount = 0 } = {}) {
  if (typeof episodeId !== 'string' || episodeId.trim() === '') throw new TypeError('episodeId is required');
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs must be a safe integer');
  const recordId = opaqueNotificationId({ version: 1, episodeId }, 'record');
  const logicalOperationId = opaqueNotificationId({ version: 1, episodeId, epochId, kind }, 'operation');
  const emissionId = opaqueNotificationId({ version: 1, episodeId, epochId, kind, emission: 1 }, 'emission');
  const preview = notificationPreview({ severity, kind, genericPreview, summaryCount });
  return Object.freeze({
    version: NOTIFICATION_CANDIDATE_VERSION,
    emissionId,
    logicalOperationId,
    attentionClass: severity === 'Critical' ? 'time-sensitive' : 'active',
    preview,
    deepLink: Object.freeze({ kind: 'plugin-detail', destinationId, recordId }),
    expiresAtMs: nowMs + NOTIFICATION_MAX_AGE_MS
  });
}

export function validateNotificationCandidate(value, { nowMs = Date.now(), destinationId = 'attention-card' } = {}) {
  const candidate = snapshot(value);
  if (!candidate || candidate.version !== 1 || !NOTIFICATION_ID_PATTERN.test(candidate.emissionId) || !NOTIFICATION_ID_PATTERN.test(candidate.logicalOperationId)) return false;
  if (!['active', 'time-sensitive'].includes(candidate.attentionClass)) return false;
  if (!sensitivePreviewSafe(candidate.preview) || !NOTIFICATION_ID_PATTERN.test(candidate.deepLink.destinationId) || candidate.deepLink.kind !== 'plugin-detail' || !NOTIFICATION_ID_PATTERN.test(candidate.deepLink.recordId) || candidate.deepLink.destinationId !== destinationId) return false;
  if (!Number.isSafeInteger(candidate.expiresAtMs) || candidate.expiresAtMs <= nowMs || candidate.expiresAtMs > nowMs + NOTIFICATION_MAX_AGE_MS) return false;
  return Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= NOTIFICATION_MAX_BYTES;
}

export function candidateRecordId(candidate) { return candidate?.deepLink?.recordId ?? null; }
