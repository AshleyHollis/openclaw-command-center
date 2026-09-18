import assert from 'node:assert/strict';
import test from 'node:test';

test('preserved messages retain source authors, raw content and provenance without impersonating an assistant', async () => {
  const { preparePreservedHistoryMessages } = await import('../src/migration/preserved-history-transcript.mjs');
  const message = {
    id: 'fictional-message', channel_id: 'fictional-channel', content: 'A report\nwith **formatting**',
    timestamp: '2026-01-01T00:00:00.000Z', edited_timestamp: '2026-01-02T00:00:00.000Z',
    author: { id: 'fictional-bot', username: 'Report Bot', bot: true },
    attachments: [{ id: 'fictional-file', filename: 'receipt.txt', size: 3 }],
    message_reference: { message_id: 'fictional-earlier' }, embeds: [{ title: 'Original report' }]
  };
  const reaction = { messageId: message.id, emoji: { id: null, name: '👍' }, summary: { count: 1 }, users: [{ id: 'fictional-person' }] };
  const attachment = { id: 'fictional-file', channelId: message.channel_id, messageId: message.id, path: 'attachments/fictional-file.txt', bytes: 3, sha256: 'd'.repeat(64) };
  const input = { sourceManifestSha256: 'a'.repeat(64), channel: { channel: { id: message.channel_id, name: 'Fictional channel' }, messages: [message], reactions: [reaction] }, attachments: [attachment] };
  const prepared = preparePreservedHistoryMessages(input);
  assert.equal(prepared.expectedCount, 1);
  const imported = prepared.entries[0];
  assert.equal(imported.message.role, 'user');
  assert.equal(imported.message.timestamp, 1767225600000);
  assert.equal(imported.message.content, 'A report\nwith **formatting**');
  assert.equal(imported.message.__openclaw.senderId, 'fictional-bot');
  const provenance = imported.message.__openclaw.importedHistoryV1;
  assert.deepEqual(provenance.rawMessage, message);
  assert.deepEqual(provenance.reactions, [reaction]);
  assert.deepEqual(provenance.attachments, [attachment]);
  assert.equal(provenance.disposition, 'historical');
  assert.equal(imported.message.__openclaw.legacyDiscordV1, undefined);
  assert.equal(imported.parentId, null);
  assert.deepEqual(preparePreservedHistoryMessages(input), prepared);
  message.content = 'Later external mutation';
  assert.equal(provenance.rawMessage.content, 'A report\nwith **formatting**');
  assert.ok(Object.isFrozen(provenance.rawMessage.author));
});
