import { sourceError } from '../sources/errors.mjs';

const unavailable = message => { throw sourceError('capability-unavailable', message); };
const stale = message => { throw sourceError('unavailable', message); };

export function assertSameNativePlanProjection(before, after) {
  for (const result of [before, after]) if (result?.kind !== 'page' || typeof result.generation !== 'string' || !result.generation || !Number.isSafeInteger(result.totalMessages) || result.totalMessages < 0 || !Array.isArray(result.entries) || result.activeLeafEntryId !== null && (typeof result.activeLeafEntryId !== 'string' || !result.activeLeafEntryId)) stale('Native visible projection is unavailable.');
  if (before.generation !== after.generation || before.totalMessages !== after.totalMessages || before.activeLeafEntryId !== after.activeLeafEntryId) stale('Native transcript generation, count or active path changed during the source read.');
}

// The generation and digest are native-issued evidence, never a serialized
// authority. Only the native preparer can mint retained source custody.
export function nativePlanSourceSelection(source) {
  const admission = source.nativeAdmission;
  if (!admission || Object.keys(admission).some(key => !['generation', 'digest'].includes(key)) || typeof admission.generation !== 'string' || !admission.generation.trim() || admission.generation.length > 4096 || !/^sha256-public-message-v1:[a-f0-9]{64}$/.test(admission.digest)) unavailable('Exact native source generation and versioned digest are unavailable.');
  if (!source.sessionKey.startsWith('agent:main:')) unavailable('The source does not belong to the supported exact agent.');
  return Object.freeze({ agentId: 'main', sessionKey: source.sessionKey, sessionId: source.sessionId, entryId: source.messageId, generation: admission.generation, digest: admission.digest });
}

export function createNativePlanTranscriptAdapter(sdk) {
  for (const method of ['readSessionTranscriptVisibleMessageDelta', 'readVisibleSessionTranscriptMessageEntries', 'createSessionTranscriptVisibleMessageDigest', 'prepareSessionTranscriptSourceAdmission']) if (typeof sdk?.[method] !== 'function') unavailable(`Native source contract ${method} is unavailable.`);
  const page = async (scope, options = {}) => {
    const result = await sdk.readSessionTranscriptVisibleMessageDelta({ ...scope, maxMessages: 1, maxBytes: 1048576, ...options });
    assertSameNativePlanProjection(result, result);
    return result;
  };
  const decorate = (entries, generation) => entries.map(entry => ({ ...entry, nativeAdmission: { generation, digest: sdk.createSessionTranscriptVisibleMessageDigest(entry) } }));
  return Object.freeze({
    async readEntries(scope) {
      const before = await page(scope);
      const entries = await sdk.readVisibleSessionTranscriptMessageEntries(scope);
      const after = await page(scope);
      assertSameNativePlanProjection(before, after);
      if (!Array.isArray(entries)) stale('Native transcript entries are unavailable.');
      return decorate(entries, after.generation);
    },
    async readRecentEntries(scope) {
      const before = await page(scope);
      const result = await page(scope, { offset: Math.max(0, before.totalMessages - 50), maxMessages: 50 });
      assertSameNativePlanProjection(before, result);
      if (result.hasMore) stale('The reviewed native source window exceeds its byte bound.');
      return decorate(result.entries, result.generation);
    },
    prepare(source, assertCurrent) {
      // Captured guards must check identity/revocation only: the native source
      // worker may be paused under its writer lock when invoking this closure.
      const selection = nativePlanSourceSelection(source);
      return sdk.prepareSessionTranscriptSourceAdmission(selection, { assertCurrent(current) {
        if (!current || Object.keys(current).length !== Object.keys(selection).length || Object.keys(selection).some(key => current[key] !== selection[key])) stale('Native source authority selected another message.');
        if (assertCurrent()?.then) unavailable('Captured source authority must be synchronous.');
      } });
    }
  });
}
