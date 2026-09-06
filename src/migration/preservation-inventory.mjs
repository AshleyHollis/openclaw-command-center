import { readDiscordPreservationBundle } from './preservation-bundle.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

function fail(code = 'preservation-inventory-invalid') { throw Object.assign(new Error(code), { code }); }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sourceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  return value;
}
function json(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function reactionKey(messageId, emoji) {
  if (!emoji || (emoji.id == null && (typeof emoji.name !== 'string' || !emoji.name))) fail('preservation-reaction-mismatch');
  return JSON.stringify([sourceId(messageId), emoji.id == null ? ['unicode', emoji.name] : ['custom', sourceId(emoji.id)]]);
}
function reconcileReactions(messages, reactions) {
  const expected = new Map();
  for (const message of messages) {
    if (message.reactions !== undefined && !Array.isArray(message.reactions)) fail('preservation-reaction-mismatch');
    for (const reaction of message.reactions ?? []) {
      const key = reactionKey(message.id, reaction.emoji);
      if (expected.has(key) || !Number.isSafeInteger(reaction.count) || reaction.count < 0) fail('preservation-reaction-mismatch');
      expected.set(key, reaction);
    }
  }
  for (const reaction of reactions) {
    const key = reactionKey(reaction.messageId, reaction.emoji);
    const original = expected.get(key);
    if (!original || reaction.summary?.count !== original.count || reactionKey(reaction.messageId, reaction.summary.emoji) !== key || !Array.isArray(reaction.users)) fail('preservation-reaction-mismatch');
    const users = new Set();
    for (const user of reaction.users) {
      const id = sourceId(user?.id);
      if (users.has(id)) fail('preservation-reaction-mismatch');
      users.add(id);
    }
    expected.delete(key);
  }
  if (expected.size) fail('preservation-reaction-mismatch');
}

// Reconciles source accounting only. It neither chooses destination ownership
// nor proves that an import, historical UI read, or live cutover has succeeded.
export async function readDiscordPreservationInventory(options) {
  const captured = structuredClone(options);
  const inventory = await inspectDiscordPreservationInventory(captured);
  const dispositions = captured.attachmentDispositions ?? [];
  if (!Array.isArray(dispositions) || dispositions.length > inventory.attachmentDiscrepancies.length) fail('preservation-disposition-mismatch');
  const remaining = new Map(inventory.attachmentDiscrepancies.map(row => [row.path, row]));
  for (const disposition of dispositions) {
    const expected = remaining.get(disposition?.path);
    if (!expected || !isDeepStrictEqual(disposition, expected)) fail('preservation-disposition-mismatch');
    remaining.delete(disposition.path);
  }
  if (remaining.size) fail('preservation-attachment-incomplete');
  const byPath = new Map(dispositions.map(row => [row.path, row]));
  const attachments = inventory.attachments.map(row => byPath.has(row.path) ? { ...row, preservationDisposition: byPath.get(row.path) } : row);
  return Object.freeze({ ...inventory, admissible: true, attachments: freeze(attachments) });
}

// Read-only diagnosis retains usable, authenticated export bytes even when a
// declared source representation cannot be verified. This does not grant
// admission to the importer; that continues to use the strict reader above.
export async function inspectDiscordPreservationInventory(options) {
  try {
    const bundle = await readDiscordPreservationBundle(options);
    const sourceChannels = json(bundle.readFile('channels.json'));
    if (!Array.isArray(sourceChannels)) fail();
    const threadExport = json(bundle.readFile('threads.json'));
    if (!Array.isArray(threadExport?.threads) || !Array.isArray(threadExport.endpointReceipts)) fail();
    // This inventory represents guild text channels. A discovered thread needs
    // its own destination accounting before this source can be admitted.
    if (threadExport.threads.length || bundle.summary.discoveredThreadCount !== 0) fail('preservation-threads-unrepresented');
    const channelIds = new Set();
    for (const channel of sourceChannels) {
      sourceId(channel?.id);
      if (channelIds.has(channel.id)) fail('preservation-identity-conflict');
      channelIds.add(channel.id);
    }
    const messageIds = new Set();
    if (!Array.isArray(bundle.summary.channelReceipts)) fail();
    const receipts = new Map();
    for (const receipt of bundle.summary.channelReceipts) {
      sourceId(receipt?.id);
      if (receipts.has(receipt.id)) fail('preservation-identity-conflict');
      receipts.set(receipt.id, receipt);
    }
    const channels = sourceChannels.filter((channel) => channel.type === 0 || channel.type === 5).map((channel) => {
      const channelId = sourceId(channel.id);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bundle.readFile(`messages/${channelId}.jsonl`));
      const messages = content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      for (const message of messages) {
        sourceId(message?.id);
        if (messageIds.has(message.id)) fail('preservation-identity-conflict');
        messageIds.add(message.id);
        if (message.channel_id !== channelId) fail('preservation-identity-conflict');
      }
      const receipt = receipts.get(channelId);
      if (!receipt || receipt.messageCount !== messages.length || receipt.firstMessageId !== (messages[0]?.id ?? null) || receipt.lastMessageId !== (messages.at(-1)?.id ?? null)) fail('preservation-channel-mismatch');
      const reactions = json(bundle.readFile(`messages/${channelId}.reactions.json`));
      if (!Array.isArray(reactions)) fail('preservation-reaction-mismatch');
      reconcileReactions(messages, reactions);
      return { channel, messages, reactions, reactionUserCoverage: 'unverified' };
    });
    if (receipts.size !== channels.length) fail('preservation-channel-mismatch');
    const representedMessageFiles = new Set(channels.map(({ channel }) => `messages/${channel.id}.jsonl`));
    if (bundle.filePaths.some((filename) => filename.endsWith('.jsonl') && !representedMessageFiles.has(filename))) fail('preservation-channel-mismatch');
    const attachments = bundle.summary.attachments;
    if (!Array.isArray(attachments)) fail();
    const files = new Map(bundle.manifest.discordRest.files.map((item) => [item.path, item]));
    const attachmentReferences = new Map();
    for (const row of channels) for (const message of row.messages) {
      if (!Array.isArray(message.attachments)) fail();
      for (const attachment of message.attachments) {
        const key = JSON.stringify([row.channel.id, message.id, sourceId(attachment?.id)]);
        if (attachmentReferences.has(key)) fail('preservation-identity-conflict');
        attachmentReferences.set(key, attachment);
      }
    }
    const attachmentFiles = new Set();
    const attachmentDiscrepancies = [];
    for (const attachment of attachments) {
      if (attachmentFiles.has(attachment.path)) fail('preservation-attachment-mismatch');
      const file = files.get(attachment.path);
      if (!file || file.bytes !== attachment.bytes || file.sha256 !== attachment.sha256) fail('preservation-attachment-mismatch');
      const key = JSON.stringify([sourceId(attachment.channelId), sourceId(attachment.messageId), sourceId(attachment.id)]);
      const original = attachmentReferences.get(key);
      if (!original) fail('preservation-attachment-mismatch');
      if (!Number.isSafeInteger(original.size) || original.size < 0 || attachment.declaredBytes !== original.size || attachment.sizeMatches !== (original.size === file.bytes)) fail('preservation-attachment-mismatch');
      if (original.size !== file.bytes) {
        attachmentDiscrepancies.push({ schemaVersion: 1, disposition: 'preserved-export-bytes', status: 'declared-representation-unverified',
          sourceManifestSha256: bundle.manifestSha256, trustedPublicKeySha256: bundle.publicKeySha256,
          channelId: attachment.channelId, messageId: attachment.messageId, attachmentId: attachment.id,
          path: attachment.path, storedBytes: file.bytes, storedSha256: file.sha256, declaredBytes: original.size,
          declaredAttachmentSha256: createHash('sha256').update(JSON.stringify(original)).digest('hex') });
      }
      if (!attachmentReferences.delete(key)) fail('preservation-attachment-mismatch');
      attachmentFiles.add(attachment.path);
    }
    if (attachmentReferences.size || bundle.filePaths.some((filename) => filename.startsWith('attachments/') && !attachmentFiles.has(filename))) fail('preservation-attachment-mismatch');
    const counts = { guildObjects: sourceChannels.length, channels: channels.length, messages: channels.reduce((sum, row) => sum + row.messages.length, 0), attachments: attachments.length };
    for (const [field, sourceField] of Object.entries({ guildObjects: 'guildStructureCount', channels: 'guildTextChannelCount', messages: 'messageCount', attachments: 'attachmentCount' })) {
      if (bundle.baseline?.[sourceField] !== counts[field] || bundle.summary?.[sourceField] !== counts[field]) fail('preservation-count-mismatch');
    }
    const reactionCount = channels.reduce((total, row) => total + row.reactions.reduce((sum, reaction) => sum + reaction.summary.count, 0), 0);
    if (!Number.isSafeInteger(reactionCount) || reactionCount < 0 || bundle.summary.reactionCount !== reactionCount || bundle.manifest.discordRest.reactionCount !== reactionCount) fail('preservation-reaction-mismatch');
    return Object.freeze({ bundle, channels: freeze(channels), attachments, counts: Object.freeze(counts), reactionCount, threadExport: freeze(threadExport),
      attachmentCoverage: Object.freeze({ preservedExportBytesVerified: attachments.length, declaredSizeMatched: attachments.length - attachmentDiscrepancies.length, declaredRepresentationUnverified: attachmentDiscrepancies.length }),
      admissible: attachmentDiscrepancies.length === 0, attachmentDiscrepancies: freeze(attachmentDiscrepancies) });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('preservation-')) throw error;
    fail();
  }
}
