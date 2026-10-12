import { effectiveSourceLocator } from '../sources/reference.mjs';
import { sourceError } from '../sources/errors.mjs';
import { planDigest } from './contract.mjs';

const fail = message => { throw sourceError('unavailable', message); };
export function createConversationPlanSource({ metadata, sources, assertCurrent, readEntries, readRecentEntries = readEntries, withTranscriptLock, assertMessageCurrent, assertCreateAdmissionAvailable }) {
  function inspect(source, write = false, { nativeIdentity = true } = {}) {
    assertCurrent();
    const topic = metadata.getTopic(source.topicId);
    sources.requireTopicService({ topicId: source.topicId }, { write, requiredSourceKinds: ['session'] });
    const reference = sources.getTopicSourceReference({ topicId: source.topicId, referenceId: source.referenceId, sourceKind: 'session' });
    const state = metadata.getSessionState(source.referenceId), sessions = sources.forTopic(source.topicId).sessions;
    if (!topic || topic.revision !== source.membershipRevision || !state || state.status !== 'open' || state.sessionId !== source.sessionId || effectiveSourceLocator(metadata, reference) !== source.sessionKey) fail('The original Conversation ownership changed.');
    if (nativeIdentity) {
      const entry = sessions?.sessionStore?.getSessionEntry?.({ agentId: 'main', sessionKey: source.sessionKey, readConsistency: 'latest' });
      if (entry?.then || entry?.sessionId !== source.sessionId) fail('The exact native Conversation was reset or is unavailable.');
    }
    if (write && source.messageId) {
      if (assertCreateAdmissionAvailable) { if (assertCreateAdmissionAvailable(source)?.then) fail('Source capability admission must be synchronous.'); }
      else {
      if (typeof assertMessageCurrent !== 'function') throw sourceError('capability-unavailable', 'Native synchronous exact-message admission is unavailable.');
      if (assertMessageCurrent(source)?.then) fail('Exact message admission must be synchronous.');
      }
    }
    return reference;
  }
  const scope = source => ({ agentId: 'main', sessionId: source.sessionId, sessionKey: source.sessionKey });
  const text = message => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  async function messages({ topicId, referenceId }) {
    assertCurrent();
    const sessions = sources.requireTopicService({ topicId }, { requiredSourceKinds: ['session'] }).sessions;
    const { exact } = await sessions.resolveStableState(referenceId);
    const source = { topicId, referenceId, sessionId: exact.sessionId, sessionKey: exact.sessionKey, membershipRevision: metadata.getTopic(topicId).revision };
    inspect(source);
    const entries = await readRecentEntries(scope(source)); inspect(source);
    if (!Array.isArray(entries)) fail('Authoritative transcript entries are unavailable.');
    return entries.filter(entry => entry.role === 'assistant' && typeof entry.entryId === 'string' && text(entry.message)).slice(-50).map(entry => ({ source: { ...source, messageId: entry.entryId, messageDigest: planDigest(entry.message), ...(entry.nativeAdmission ? { nativeAdmission: structuredClone(entry.nativeAdmission) } : {}) }, text: text(entry.message) }));
  }
  async function readSource(source) {
    inspect(source);
    const entries = await readEntries(scope(source)); inspect(source);
    const matches = Array.isArray(entries) ? entries.filter(entry => entry.entryId === source.messageId && entry.role === 'assistant') : [];
    if (matches.length !== 1 || planDigest(matches[0].message) !== source.messageDigest) fail('The exact accepted source message changed or is unavailable.');
    if (source.nativeAdmission && (!matches[0].nativeAdmission || planDigest(matches[0].nativeAdmission) !== planDigest(source.nativeAdmission))) fail('The exact accepted native message generation or digest changed.');
    return { available: true, source };
  }
  async function withSource(source, operation, { write = true } = {}) {
    inspect(source, write);
    return withTranscriptLock(scope(source), async locked => {
      if (locked.target.sessionId !== source.sessionId || locked.target.sessionKey !== source.sessionKey) fail('Transcript lock resolved another Conversation.');
      await readSource(source);
      return operation();
    });
  }
  return Object.freeze({ inspect, readSource, messages, withSource });
}
