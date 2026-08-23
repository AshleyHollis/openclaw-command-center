import { createHash } from 'node:crypto';
function hex(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
export function sourceOccurrenceId(channelId, messageId) { if (typeof channelId !== 'string' || channelId === '' || typeof messageId !== 'string' || messageId === '') throw new TypeError('channelId and messageId are required'); return `command-center:legacy-discord:v1:${hex(JSON.stringify([channelId, messageId]))}`; }
export const occurrenceId = sourceOccurrenceId;
export function occurrencePayloadDigest(occurrence) { return `sha256:${hex(JSON.stringify(canonical(occurrence)))}`; }
export function occurrenceIdentity(channelId, occurrence) { const id = sourceOccurrenceId(channelId, occurrence.messageId); const occurrenceDigest = occurrencePayloadDigest(occurrence); return Object.freeze({ occurrenceId: id, sourceOccurrenceId: id, occurrenceDigest, payloadDigest: occurrenceDigest, eventId: id, idempotencyKey: id }); }
