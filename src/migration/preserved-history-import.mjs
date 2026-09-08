import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withPreservedHistoryDestination } from './preserved-history-destination.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function assertPrepared(intent, prepared) {
  if (!prepared || !Array.isArray(prepared.entries) || intent.sourceDigest !== prepared.sourceDigest
      || intent.expectedCount !== prepared.expectedCount || prepared.entries.length !== prepared.expectedCount) fail('history-source-conflict');
  if (intent.schemaVersion === 2) {
    const source = prepared.source;
    if (prepared.sourceKind !== 'native-jsonl-history-v1' || intent.sourceKind !== prepared.sourceKind
        || intent.sourceInventorySha256 !== prepared.sourceInventorySha256 || intent.originalAgentId !== prepared.originalAgentId
        || intent.originalSessionId !== prepared.originalSessionId || !isDeepStrictEqual(intent.sourceFile, prepared.sourceFile)
        || source?.kind !== prepared.sourceKind || source.inventorySha256 !== intent.sourceInventorySha256
        || source.originalAgentId !== intent.originalAgentId || source.originalSessionId !== intent.originalSessionId
        || source.header?.id !== intent.originalSessionId || !isDeepStrictEqual(source.file, intent.sourceFile)
        || intent.sourceDigest !== digest({ source, entries: prepared.entries })) fail('history-source-conflict');
  } else if (intent.schemaVersion !== 1 || prepared.sourceChannel?.id !== prepared.sourceChannelId
      || intent.sourceChannelId !== prepared.sourceChannelId || intent.sourceDigest !== digest({ channel: prepared.sourceChannel, entries: prepared.entries })) fail('history-source-conflict');
}

// Internal execution owner: caller supplies a source-owner-admitted, frozen
// conversion and a previously reserved intent. No transport may manufacture it.
// Creation requires a durable not-yet-dispatched reservation and a winning CAS.
// A dispatched operation with missing native evidence cannot recreate a target.
export async function runPreservedHistoryImport(options) {
  return run(options, false);
}

// A read can verify a completed operation but can never enter its execution or
// recovery transitions. Return the exact native content checked under exclusion.
export async function readVerifiedPreservedHistory(options) {
  return run(options, true);
}

async function run(options, readOnly) {
  const { metadata, historyId, assertCurrent } = options;
  let prepared;
  try { prepared = freeze(structuredClone(options.prepared)); } catch { fail('history-source-conflict'); }
  let row = metadata.getImportedHistory(historyId);
  if (readOnly && row?.phase !== 'verified') fail('history-incomplete');
  if (!row) fail('history-source-conflict');
  assertPrepared(row.intent, prepared);
  // Refuse an unsupported host before reserving the external creation effect;
  // a dispatched-but-missing destination cannot safely be recreated on resume.
  if (typeof options.transcripts?.redactSessionTranscriptMessage !== 'function') fail('history-redaction-unavailable');
  const originalIntent = row.intent;
  const logicalOperationId = row.logicalOperationId;
  const assertOperation = () => {
    if (typeof assertCurrent !== 'function' || assertCurrent()?.then) fail('history-authority-unavailable');
    const current = metadata.getImportedHistory(historyId);
    if (!current || current.logicalOperationId !== logicalOperationId || current.revision !== row.revision || !isDeepStrictEqual(current.intent, originalIntent)) fail('stale-revision');
    // A completed replay makes no source/publication effect. Current access is
    // still required above; a later legitimate rename is not an old write retry.
    if (row.phase !== 'verified' && originalIntent.topicId !== null) {
      const topic = metadata.getTopic(originalIntent.topicId);
      if (!topic || topic.lifecycle !== 'active' || topic.revision !== originalIntent.expectedTopicRevision) fail('stale-revision');
    }
  };
  assertOperation();
  let allowCreate = false;
  if (!readOnly && options.allowCreate === true && row.phase === 'reserved') {
    row = metadata.dispatchImportedHistoryCreation({ historyId, logicalOperationId, expectedRevision: row.revision }, assertOperation);
    allowCreate = true;
  }
  return withPreservedHistoryDestination({ ...options, allowCreate, reservation: row, assertCurrent: assertOperation }, async destination => {
    const anchors = [];
    function proof(count = anchors.length) {
      const selected = anchors.slice(0, count);
      return { sessionLifecycleRevision: logicalOperationId, transcriptGeneration: selected[0]?.generation ?? null,
        anchorDigest: digest({ target: row.target, sessionLifecycleRevision: logicalOperationId, anchors: selected }), verifiedCount: count };
    }
    function addAnchor(anchor, index) {
      if (anchor.activeMessagePosition !== index || (anchors.length && anchor.generation !== anchors[0].generation)) fail('history-anchor-conflict');
      anchors.push(anchor);
    }
    function checkpoint() {
      destination.assertOwner();
      row = metadata.checkpointImportedHistory({ historyId, logicalOperationId, expectedRevision: row.revision, proof: proof() }, () => { assertOperation(); destination.assertOwner(); });
    }
    const prefix = await destination.read();
    if (prefix.length < row.verifiedCount || prefix.length > prepared.expectedCount) fail('history-prefix-conflict');
    for (let index = 0; index < prefix.length; index++) {
      const actual = prefix[index];
      const expected = prepared.entries[index];
      if (actual.entryId !== expected.eventId || actual.parentId !== expected.parentId || !destination.matchesMessage(actual.message, expected)) fail('history-prefix-conflict');
      addAnchor(await destination.verifyExisting(expected), index);
    }
    if (row.phase !== 'creating') {
      const previousProof = proof(row.verifiedCount);
      if (previousProof.anchorDigest !== row.anchorDigest || previousProof.transcriptGeneration !== row.transcriptGeneration || previousProof.sessionLifecycleRevision !== row.sessionLifecycleRevision) fail('history-proof-conflict');
    }
    if (row.phase === 'verified') {
      if (prefix.length !== prepared.expectedCount) fail('history-prefix-conflict');
      destination.assertOwner();
      return readOnly ? freeze({ receipt: row, entries: prefix }) : row;
    }
    if (row.phase === 'creating' || row.verifiedCount !== anchors.length) checkpoint();
    for (let index = anchors.length; index < prepared.entries.length; index++) {
      addAnchor(await destination.appendFresh(prepared.entries[index]), index);
      await options.afterNativeAppend?.({ historyId, index });
      checkpoint();
    }
    // Re-read the whole visible prefix and re-obtain authoritative anchors while
    // still under native exclusion. Similar text is not generation evidence.
    const final = await destination.read();
    if (final.length !== prepared.expectedCount) fail('history-prefix-conflict');
    for (let index = 0; index < final.length; index++) {
      const expected = prepared.entries[index];
      if (final[index].entryId !== expected.eventId || final[index].parentId !== expected.parentId || !destination.matchesMessage(final[index].message, expected) || !isDeepStrictEqual(await destination.verifyExisting(expected), anchors[index])) fail('history-prefix-conflict');
    }
    row = metadata.completeImportedHistory({ historyId, logicalOperationId, expectedRevision: row.revision, proof: proof() }, () => { assertOperation(); destination.assertOwner(); });
    return row;
  });
}
