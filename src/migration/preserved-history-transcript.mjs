import { createHash } from 'node:crypto';

const fail = () => { throw Object.assign(new Error('history-source-invalid'), { code: 'history-source-invalid' }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Conversion only: the import owner must obtain this channel through the signed
// inventory reader. This function grants neither source admission nor writes.
export function preparePreservedHistoryMessages(input) {
  try {
    const { sourceManifestSha256, channel, attachments } = JSON.parse(JSON.stringify(input));
    if (!/^[a-f0-9]{64}$/.test(sourceManifestSha256) || !id(channel?.channel?.id) || !Array.isArray(channel.messages) || !Array.isArray(channel.reactions) || !Array.isArray(attachments)) fail();
    const sourceChannelId = channel.channel.id;
    const seen = new Set();
    let parentId = null;
    const entries = channel.messages.map(rawMessage => {
      if (!id(rawMessage.id) || seen.has(rawMessage.id) || rawMessage.channel_id !== sourceChannelId || !id(rawMessage.author?.id) || typeof rawMessage.content !== 'string' || typeof rawMessage.timestamp !== 'string') fail();
      seen.add(rawMessage.id);
      const timestamp = Date.parse(rawMessage.timestamp);
      if (!Number.isSafeInteger(timestamp)) fail();
      const identity = digest(['discord-preserved-history-v1', sourceManifestSha256, sourceChannelId, rawMessage.id]);
      const eventId = `cc-history-${identity}`;
      const idempotencyKey = `command-center:history:v1:${identity}`;
      const provenance = {
        schemaVersion: 1, disposition: 'historical', sourceManifestSha256, sourceChannelId,
        rawMessage,
        reactions: channel.reactions.filter(item => item.messageId === rawMessage.id),
        attachments: attachments.filter(item => item.channelId === sourceChannelId && item.messageId === rawMessage.id)
      };
      // Bot authors remain imported source authors, never native assistant turns
      // or executable tool calls. Read-only presentation uses retained provenance.
      const message = { role: 'user', content: rawMessage.content, timestamp, idempotencyKey,
        __openclaw: { senderId: rawMessage.author.id, senderName: rawMessage.author.global_name ?? rawMessage.author.username ?? rawMessage.author.id, importedHistoryV1: provenance } };
      const entry = { eventId, parentId, idempotencyKey, message };
      parentId = eventId;
      return entry;
    });
    return freeze({ sourceChannelId, sourceChannel: channel.channel, expectedCount: entries.length, sourceDigest: digest({ channel: channel.channel, entries }), entries });
  } catch (error) {
    if (error?.code === 'history-source-invalid') throw error;
    fail();
  }
}
