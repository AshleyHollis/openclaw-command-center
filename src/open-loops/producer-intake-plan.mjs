import { createHash } from 'node:crypto';
import { normalizeAcceptedExtraction } from './intake-accounting.mjs';

const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  : value;
function text(value, maximum, code = 'producer-plan-invalid') {
  if (!nonBlank(value) || value !== value.trim() || value.length > maximum) fail(code);
  return value;
}
function instant(value) {
  const selected = text(value, 64);
  if (!Number.isFinite(Date.parse(selected))) fail('producer-plan-invalid');
  return new Date(selected).toISOString();
}
function count(value) { if (!Number.isSafeInteger(value) || value < 0) fail('producer-plan-invalid'); return value; }
function boundedScope(value, recordCount) {
  const keys = ['accountBinding', 'folders', 'sinceUtc', 'beforeUtc', 'maxMessages', 'batchKind'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || !Array.isArray(value.folders) || value.folders.length < 1 || value.folders.length > 10 || !['canary', 'bounded'].includes(value.batchKind)) fail('producer-plan-invalid');
  const folders = value.folders.map(folder => text(folder, 200));
  const maxMessages = count(value.maxMessages);
  const sinceUtc = instant(value.sinceUtc); const beforeUtc = instant(value.beforeUtc);
  if (new Set(folders).size !== folders.length || maxMessages < 1 || maxMessages > 50 || value.batchKind === 'canary' && maxMessages > 5 || recordCount > maxMessages || Date.parse(sinceUtc) >= Date.parse(beforeUtc)) fail('producer-plan-invalid');
  return Object.freeze({ accountBinding: text(value.accountBinding, 300), folders: Object.freeze(folders), sinceUtc, beforeUtc, maxMessages, batchKind: value.batchKind });
}
function enumeration(value, recordCount, maxMessages) {
  const selected = value ?? { scope: 'complete', scannedCount: recordCount, remainingCount: 0, failedReadCount: 0, scanCapReached: false };
  const keys = ['scope', 'scannedCount', 'remainingCount', 'failedReadCount', 'scanCapReached', 'scopeId', 'resumeCursor'];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected) || Object.keys(selected).some(key => !keys.includes(key)) || !['complete', 'bounded', 'partial'].includes(selected.scope) || typeof selected.scanCapReached !== 'boolean') fail('producer-plan-invalid');
  const result = { scope: selected.scope, scannedCount: count(selected.scannedCount), remainingCount: count(selected.remainingCount), failedReadCount: count(selected.failedReadCount), scanCapReached: selected.scanCapReached };
  if (result.scannedCount < recordCount || result.scannedCount > maxMessages) fail('producer-plan-invalid');
  const incomplete = result.scope !== 'complete' || result.remainingCount > 0 || result.failedReadCount > 0 || result.scanCapReached;
  if (incomplete) { result.scopeId = text(selected.scopeId, 500); result.resumeCursor = text(selected.resumeCursor, 1000); }
  else if (selected.scopeId !== undefined || selected.resumeCursor !== undefined) fail('producer-plan-invalid');
  return Object.freeze(result);
}

export function normalizeProducerIntakePlan(input) {
  const keys = ['schemaVersion', 'purpose', 'runId', 'sourceKind', 'sourceNamespace', 'scope', 'processorVersion', 'nextExpectedAt', 'enumeration', 'records'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || input.schemaVersion !== 1 || input.purpose !== 'command-center-producer-intake' || input.sourceKind !== 'email' || !Array.isArray(input.records) || input.records.length > 50) fail('producer-plan-invalid');
  const records = input.records.map(record => {
    const recordKeys = ['schemaVersion', 'sourceExternalId', 'sourceVersion', 'checkpoint', 'retainedNoteRevision', 'acceptedExtraction'];
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !recordKeys.includes(key)) || record.schemaVersion !== 1) fail('producer-plan-invalid');
    try {
      const acceptedExtraction = normalizeAcceptedExtraction(record.acceptedExtraction);
      const retainedNoteRevision = record.retainedNoteRevision === undefined ? undefined : text(record.retainedNoteRevision, 100);
      if (acceptedExtraction.notePath && !/^sha256:[a-f0-9]{64}$/u.test(retainedNoteRevision ?? '')) fail('producer-plan-invalid');
      return Object.freeze({ schemaVersion: 1, sourceExternalId: text(record.sourceExternalId, 1000), sourceVersion: text(record.sourceVersion, 300), checkpoint: text(record.checkpoint, 1000), ...(retainedNoteRevision ? { retainedNoteRevision } : {}), acceptedExtraction });
    } catch (error) { if (error?.code === 'producer-plan-invalid') throw error; fail('producer-plan-invalid'); }
  });
  if (new Set(records.map(record => `${record.sourceExternalId}\0${record.sourceVersion}`)).size !== records.length) fail('producer-plan-invalid');
  const scope = boundedScope(input.scope, records.length);
  return Object.freeze({ schemaVersion: 1, purpose: input.purpose, runId: text(input.runId, 300), sourceKind: input.sourceKind, sourceNamespace: text(input.sourceNamespace, 300), scope,
    processorVersion: text(input.processorVersion, 300), nextExpectedAt: instant(input.nextExpectedAt), enumeration: enumeration(input.enumeration, records.length, scope.maxMessages), records: Object.freeze(records) });
}

export function producerIntakePlanDigest(input) {
  const plan = normalizeProducerIntakePlan(input);
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex')}`;
}
