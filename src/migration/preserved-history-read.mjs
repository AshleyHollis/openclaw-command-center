import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readDiscordPreservationInventory } from './preservation-inventory.mjs';
import { preparePreservedHistoryMessages } from './preserved-history-transcript.mjs';
import { readVerifiedPreservedHistory } from './preserved-history-import.mjs';
import { readNativeHistoryInventory } from './native-history-source.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authority = check => { if (typeof check !== 'function' || check()?.then) fail('history-authority-unavailable'); };
function request(input, keys) {
  if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !['schemaVersion', ...keys].includes(key))) fail('history-request-invalid');
}
function offsetOf(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0) fail('history-request-invalid');
  return value;
}

// Activation-scoped, authenticated source snapshot. Client selectors never
// supply source paths, URLs, native Session keys or ownership/provenance facts.
export async function createPreservedHistoryReader(options) {
  const { metadata, sessionStore, transcripts, storePath, config, env } = options;
  const sourceOptions = structuredClone(options.sourceOptions);
  const nativeSourceOptions = structuredClone(options.nativeSourceOptions);
  if (!sourceOptions && !nativeSourceOptions) fail('history-source-conflict');
  const inventory = sourceOptions ? await readDiscordPreservationInventory(sourceOptions) : null;
  const nativeInventory = nativeSourceOptions ? await readNativeHistoryInventory(nativeSourceOptions) : null;
  const nativePrepared = new Map(nativeInventory?.histories.map(item => [item.sourceFile.name, item]) ?? []);
  const prepared = new Map((inventory?.channels ?? []).map(channel => [channel.channel.id,
    preparePreservedHistoryMessages({ sourceManifestSha256: inventory.bundle.manifestSha256, channel, attachments: inventory.attachments })]));
  function selected(historyId) {
    if (!id(historyId)) fail('history-request-invalid');
    const receipt = metadata.getImportedHistory(historyId);
    if (!receipt || receipt.phase !== 'verified') fail('history-incomplete');
    if (receipt.intent.schemaVersion === 2) {
      const source = nativePrepared.get(receipt.intent.sourceFile.name);
      if (!source || receipt.intent.sourceInventorySha256 !== nativeInventory.sourceInventorySha256
          || receipt.intent.originalAgentId !== source.originalAgentId || receipt.intent.originalSessionId !== source.originalSessionId
          || !isDeepStrictEqual(receipt.intent.sourceFile, source.sourceFile) || receipt.intent.sourceDigest !== source.sourceDigest
          || receipt.intent.expectedCount !== source.expectedCount) fail('history-source-conflict');
      return { receipt, source };
    }
    const source = prepared.get(receipt.intent.sourceChannelId);
    if (!source || receipt.intent.sourceManifestSha256 !== inventory?.bundle.manifestSha256 || receipt.intent.trustedPublicKeySha256 !== inventory.bundle.publicKeySha256 || receipt.intent.sourceDigest !== source.sourceDigest || receipt.intent.expectedCount !== source.expectedCount) fail('history-source-conflict');
    return { receipt, source };
  }
  function assertOwner(receipt, check) {
    authority(check);
    if (!isDeepStrictEqual(metadata.getImportedHistory(receipt.historyId), receipt)) fail('history-source-conflict');
    const current = sessionStore.getSessionEntry({ ...receipt.target, ...(storePath ? { storePath } : {}), ...(env ? { env } : {}), readConsistency: 'latest' });
    if (current?.sessionId !== receipt.target.sessionId || current.lifecycleRevision !== receipt.logicalOperationId || current.sendPolicy !== 'deny') fail('history-destination-rebound');
  }
  async function verified(historyId, check) {
    authority(check);
    const { receipt, source } = selected(historyId);
    const result = await readVerifiedPreservedHistory({ metadata, historyId, prepared: source, sessionStore, transcripts, storePath, config, env,
      assertCurrent: () => assertOwner(receipt, check) });
    assertOwner(receipt, check);
    return result;
  }
  const descriptor = (receipt, source) => ({ historyId: receipt.historyId, topicId: receipt.intent.topicId,
    title: source.sourceKind === 'native-jsonl-history-v1' ? `Imported Session ${source.originalSessionId}` : source.sourceChannel.name ?? 'Imported History', totalMessages: receipt.verifiedCount, readOnly: true });
  const attachmentId = (historyId, messageId, originalId) => hash(['history-attachment-v1', historyId, messageId, originalId]);
  function filesFor(historyId, entry) {
    if (entry.message.__openclaw.importedNativeHistoryV1) return [];
    const provenance = entry.message.__openclaw.importedHistoryV1;
    return provenance.attachments.map(file => ({ file,
      descriptor: { attachmentId: attachmentId(historyId, entry.entryId, file.id),
        filename: provenance.rawMessage.attachments.find(original => original.id === file.id)?.filename ?? 'attachment',
        totalBytes: file.bytes, revision: file.sha256, declaredBytes: file.declaredBytes,
        preservationStatus: file.preservationDisposition ? 'declared-representation-unverified' : 'declared-size-matched' } }));
  }
  return Object.freeze({
    async list(input, check) {
      request(input, ['topicId']); authority(check);
      if (input.topicId !== undefined && (typeof input.topicId !== 'string' || !input.topicId.trim())) fail('history-request-invalid');
      const histories = [];
      for (const row of metadata.listImportedHistories()) {
        const matchesSource = row.intent.schemaVersion === 2
          ? nativeInventory && row.intent.sourceInventorySha256 === nativeInventory.sourceInventorySha256
          : inventory && row.intent.sourceManifestSha256 === inventory.bundle.manifestSha256;
        if (row.phase !== 'verified' || !matchesSource || (input.topicId !== undefined && row.intent.topicId !== input.topicId)) continue;
        const { receipt, source } = selected(row.historyId);
        assertOwner(receipt, check);
        histories.push(descriptor(receipt, source));
      }
      authority(check);
      return { schemaVersion: 1, histories };
    },
    async read(input, check) {
      input = { ...input };
      request(input, ['historyId', 'offset', 'limit']);
      const offset = offsetOf(input.offset); const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('history-request-invalid');
      const { receipt, entries } = await verified(input.historyId, check);
      if (offset > entries.length) fail('history-request-invalid');
      const messages = [];
      let bytes = 0;
      for (const entry of entries.slice(offset, offset + limit)) {
        const provenance = entry.message.__openclaw.importedHistoryV1;
        const native = entry.message.__openclaw.importedNativeHistoryV1;
        const original = provenance?.rawMessage;
        const message = native ? { messageId: entry.entryId, author: entry.message.__openclaw.senderName,
          bot: native.rawEntry.type === 'message' && native.rawEntry.message.role !== 'user',
          timestamp: native.rawEntry.timestamp, text: entry.message.content,
          detailsJson: JSON.stringify({ session: native.source.header, entry: native.rawEntry }, null, 2), attachments: [] }
          : { messageId: entry.entryId, author: entry.message.__openclaw.senderName, bot: original.author.bot === true,
          timestamp: original.timestamp, text: original.content, detailsJson: JSON.stringify({ message: original, reactions: provenance.reactions }, null, 2),
          attachments: filesFor(input.historyId, entry).map(item => item.descriptor) };
        const size = Buffer.byteLength(JSON.stringify(message));
        if (bytes + size > 524_288) { if (!messages.length) fail('history-message-too-large'); break; }
        messages.push(message); bytes += size;
      }
      assertOwner(receipt, check);
      const nextOffset = offset + messages.length;
      return { schemaVersion: 1, ...descriptor(receipt, selected(receipt.historyId).source), messages, offset,
        nextOffset: nextOffset < entries.length ? nextOffset : null, hasMore: nextOffset < entries.length };
    },
    async attachmentRead(input, check) {
      input = { ...input };
      request(input, ['historyId', 'messageId', 'attachmentId', 'offset', 'observedRevision']);
      const offset = offsetOf(input.offset);
      if (typeof input.messageId !== 'string' || !id(input.attachmentId)) fail('history-request-invalid');
      const { receipt, entries } = await verified(input.historyId, check);
      const entry = entries.find(item => item.entryId === input.messageId);
      const match = entry && filesFor(input.historyId, entry).find(item => item.descriptor.attachmentId === input.attachmentId);
      if (!match) fail('history-attachment-unavailable');
      const { file, descriptor: attachment } = match;
      if ((offset > 0 || input.observedRevision !== undefined) && input.observedRevision !== attachment.revision) fail('history-source-conflict');
      const bytes = inventory.bundle.readFile(file.path);
      if (offset > bytes.length) fail('history-request-invalid');
      const chunk = bytes.subarray(offset, offset + 262_144);
      assertOwner(receipt, check);
      return { schemaVersion: 1, historyId: input.historyId, messageId: input.messageId, ...attachment,
        byteOffset: offset, contentBase64: chunk.toString('base64'), nextOffset: offset + chunk.length, complete: offset + chunk.length === bytes.length };
    }
  });
}
