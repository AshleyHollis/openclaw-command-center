import { isDeepStrictEqual } from 'node:util';

const fail = code => { throw Object.assign(new Error(code), { code }); };

// Native effects for the Imported History owner only. Source admission, durable
// intent and checkpoint sequencing belong to that owner, not to UI/transport.
export async function withPreservedHistoryDestination(options, run) {
  const { reservation, sessionStore, transcripts, assertCurrent, config, storePath, env } = options;
  if (typeof transcripts.redactSessionTranscriptMessage !== 'function') fail('history-redaction-unavailable');
  const target = reservation.target;
  const scope = { ...target, ...(storePath ? { storePath } : {}), ...(env ? { env } : {}) };
  const assertAuthority = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('history-authority-unavailable');
  };
  const assertOwner = () => {
    assertAuthority();
    const current = sessionStore.getSessionEntry({ ...scope, readConsistency: 'latest' });
    if (!current && reservation.phase === 'creating') fail('history-creation-unknown');
    if (current?.sessionId !== target.sessionId || current.lifecycleRevision !== reservation.logicalOperationId || current.sendPolicy !== 'deny') fail('history-destination-rebound');
  };
  assertAuthority();
  if (options.allowCreate === true) {
    if (reservation.phase !== 'creating') fail('history-creation-not-allowed');
    await sessionStore.patchSessionEntry({ ...scope,
    fallbackEntry: { sessionId: target.sessionId, lifecycleRevision: reservation.logicalOperationId, updatedAt: Date.now(), sendPolicy: 'deny', label: 'Imported History' },
    skipMaintenance: true, preserveActivity: true, requireWriteSuccess: true,
    update: (entry, context) => context.existingEntry ? null : entry,
    assertCommitAllowed: assertAuthority
    });
  }
  assertOwner();
  return transcripts.withSessionTranscriptWriteLock({ ...scope, ...(config ? { config } : {}) }, async locked => {
    assertOwner();
    if (locked.target.agentId !== target.agentId || locked.target.sessionId !== target.sessionId || locked.target.sessionKey !== target.sessionKey) fail('history-destination-rebound');
    const projections = new WeakMap();
    function expectedMessage(entry) {
      assertOwner();
      // Preserve the original source/intent. Compare stored bytes to one native
      // redacted projection; redacting both sides would hide unrelated changes.
      if (!projections.has(entry)) projections.set(entry, structuredClone(transcripts.redactSessionTranscriptMessage(entry.message, config)));
      return projections.get(entry);
    }
    const matchesMessage = (actual, entry) => isDeepStrictEqual(actual, expectedMessage(entry));
    async function read() {
      assertOwner();
      const entries = [];
      let cursor;
      while (true) {
        const page = await transcripts.readSessionTranscriptVisibleMessageDelta({ ...scope, ...(cursor ? { cursor } : {}), maxMessages: 200, maxBytes: 1_048_576 });
        assertOwner();
        if (page.kind === 'missing' && !cursor) return [];
        if (page.kind !== 'page' || !Array.isArray(page.entries)) fail('history-projection-unavailable');
        entries.push(...page.entries);
        if (entries.length > reservation.intent.expectedCount) fail('history-foreign-entry');
        if (page.requiredBytes) fail('history-message-too-large');
        if (!page.hasMore) return entries;
        if (!page.cursor || page.cursor === cursor) fail('history-projection-unavailable');
        cursor = page.cursor;
      }
    }
    async function append(entry, replayOnly) {
      assertOwner();
      expectedMessage(entry); // Pin the expected projection before the native effect.
      const result = await locked.appendMessage({ message: entry.message, eventId: entry.eventId, parentId: entry.parentId,
        idempotencyLookup: 'scan', now: entry.message.timestamp,
        prepareMessageAfterIdempotencyCheck: message => {
          // The native finalizer is synchronous inside the append transaction.
          // A replay must never turn into a fresh effect if its event vanished.
          if (replayOnly) fail('history-replay-missing');
          assertOwner();
          if (!isDeepStrictEqual(message, entry.message)) fail('history-message-conflict');
          return message;
        }
      });
      assertOwner();
      // Finalizers disable native replay payload comparison. Check the returned
      // persisted message ourselves; never infer success from the key alone.
      const anchor = result?.anchor;
      if (!result || result.messageId !== entry.eventId || !matchesMessage(result.message, entry) || !anchor || anchor.agentId !== target.agentId || anchor.sessionId !== target.sessionId || anchor.sessionKey !== target.sessionKey || anchor.entryId !== entry.eventId || anchor.effectiveParentId !== entry.parentId || anchor.idempotencyKey !== entry.idempotencyKey || typeof anchor.generation !== 'string' || !anchor.generation || !Number.isSafeInteger(anchor.rawSeq) || !Number.isSafeInteger(anchor.activeMessagePosition)) fail('history-anchor-conflict');
      if (!replayOnly && !result.appended) fail('history-existing-entry');
      // Location is not identity. Retain the native generation and ordered anchor
      // facts, without making the current storePath part of durable ownership.
      const { storePath: ignoredPath, ...identity } = anchor;
      return Object.freeze(identity);
    }
    return run(Object.freeze({ read, assertOwner, matchesMessage, appendFresh: entry => append(entry, false), verifyExisting: entry => append(entry, true) }));
  });
}
