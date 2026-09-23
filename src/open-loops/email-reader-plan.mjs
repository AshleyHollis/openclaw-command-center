import { createHash } from 'node:crypto';
import { validatedOutlookWebLink } from './email-reader-locator.mjs';

const fail = () => { throw Object.assign(new Error('email-reader-plan-invalid'), { code: 'email-reader-plan-invalid' }); };
const text = (value, maximum) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum ? value : fail();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;

export function normalizeEmailReaderPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['schemaVersion', 'purpose', 'sourceNamespace', 'records'].includes(key)) || input.schemaVersion !== 1 || input.purpose !== 'command-center-email-reader-locators' || !Array.isArray(input.records) || input.records.length > 50) fail();
  const records = input.records.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !['sourceExternalId', 'sourceVersion', 'messageId', 'webLink', 'observedAt'].includes(key))) fail();
    let webLink;
    try { webLink = validatedOutlookWebLink(record.webLink); } catch { fail(); }
    const observedAt = text(record.observedAt, 64);
    if (!Number.isFinite(Date.parse(observedAt))) fail();
    return Object.freeze({ sourceExternalId: text(record.sourceExternalId, 1000), sourceVersion: text(record.sourceVersion, 300), messageId: text(record.messageId, 1000), webLink, observedAt: new Date(observedAt).toISOString() });
  });
  if (new Set(records.map(record => `${record.sourceExternalId}\0${record.sourceVersion}`)).size !== records.length) fail();
  return Object.freeze({ schemaVersion: 1, purpose: input.purpose, sourceNamespace: text(input.sourceNamespace, 300), records: Object.freeze(records) });
}

export function emailReaderPlanDigest(input) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(normalizeEmailReaderPlan(input)))).digest('hex')}`;
}
