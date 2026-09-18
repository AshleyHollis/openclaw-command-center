import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPreservationFixture } from './fixtures/discord-preservation.mjs';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDiscordPreservationBundle } from '../src/migration/preservation-bundle.mjs';
import { inspectDiscordPreservationInventory, readDiscordPreservationInventory } from '../src/migration/preservation-inventory.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const fixture = createPreservationFixture;

test('attachment association refuses two source identities sharing one preserved file', async t => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  const message = JSON.parse(source.files.get(filename));
  message.attachments.push({ ...message.attachments[0], id: 'fictional-second-attachment' });
  await source.replaceFile(filename, JSON.stringify(message) + '\n');
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.attachments.push({ ...summary.attachments[0], id: 'fictional-second-attachment' });
  summary.attachmentCount = 2; source.manifest.baseline.attachmentCount = 2;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  await assert.rejects(inspectDiscordPreservationInventory(await source.seal()), { code: 'preservation-attachment-mismatch' });
});

test('exact attachment disposition admits preserved export bytes without claiming the declared representation', async t => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  const message = JSON.parse(source.files.get(filename));
  message.attachments[0].size = 100;
  await source.replaceFile(filename, JSON.stringify(message) + '\n');
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.attachments[0].declaredBytes = 100; summary.attachments[0].sizeMatches = false;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  const options = await source.seal();
  const disposition = { schemaVersion: 1, disposition: 'preserved-export-bytes', status: 'declared-representation-unverified',
    sourceManifestSha256: options.expectedManifestSha256, trustedPublicKeySha256: options.trustedPublicKeySha256,
    channelId: 'fictional-channel', messageId: 'fictional-message', attachmentId: 'fictional-attachment',
    path: 'attachments/fictional-receipt.txt', storedBytes: 25, storedSha256: sha256('Fictional receipt bytes.\n'),
    declaredBytes: 100, declaredAttachmentSha256: sha256(JSON.stringify(message.attachments[0])) };
  await assert.rejects(readDiscordPreservationInventory(options), { code: 'preservation-attachment-incomplete' });
  assert.deepEqual((await inspectDiscordPreservationInventory(options)).attachmentDiscrepancies[0], disposition);
  const admitted = await readDiscordPreservationInventory({ ...options, attachmentDispositions: [disposition] });
  assert.equal(admitted.admissible, true);
  assert.equal(admitted.attachmentDiscrepancies.length, 1, 'admission must not erase uncertainty');
  assert.deepEqual(admitted.attachments[0].preservationDisposition, disposition);
  assert.deepEqual(admitted.attachmentCoverage, { preservedExportBytesVerified: 1, declaredSizeMatched: 0, declaredRepresentationUnverified: 1 });
  assert.equal(admitted.channels[0].messages[0].attachments[0].size, 100);
  assert.equal(admitted.bundle.readFile(disposition.path).toString(), 'Fictional receipt bytes.\n');
  for (const patch of [{ storedSha256: '0'.repeat(64) }, { declaredBytes: 99 }, { path: 'attachments/other.txt' },
    { sourceManifestSha256: '0'.repeat(64) }, { trustedPublicKeySha256: '0'.repeat(64) }, { declaredAttachmentSha256: '0'.repeat(64) },
    { disposition: 'original-verified' }, { allowAny: true }]) {
    await assert.rejects(readDiscordPreservationInventory({ ...options, attachmentDispositions: [{ ...disposition, ...patch }] }), { code: 'preservation-disposition-mismatch' });
  }
  await assert.rejects(readDiscordPreservationInventory({ ...options, attachmentDispositions: [disposition, disposition] }), { code: 'preservation-disposition-mismatch' });
});

test('export admission retains an authenticated byte snapshot, including original bot provenance and attachments', async (t) => {
  const source = await fixture(t);
  const bundle = await readDiscordPreservationBundle(source.options);
  assert.equal(bundle.manifestSha256, source.options.expectedManifestSha256);
  assert.deepEqual(bundle.baseline, { guildTextChannelCount: 1, messageCount: 1, attachmentCount: 1 });
  assert.equal(bundle.readFile('attachments/fictional-receipt.txt').toString(), 'Fictional receipt bytes.\n');
  const message = JSON.parse(bundle.readFile('messages/fictional-channel.jsonl'));
  assert.equal(message.author.bot, true);
  assert.equal(message.content, 'Fictional résumé.');
  await writeFile(path.join(source.root, 'attachments/fictional-receipt.txt'), 'later unrelated content');
  const copy = bundle.readFile('attachments/fictional-receipt.txt');
  copy.fill(0);
  assert.equal(bundle.readFile('attachments/fictional-receipt.txt').toString(), 'Fictional receipt bytes.\n');
  assert.throws(() => bundle.readFile('not-listed.txt'), { code: 'preservation-file-unlisted' });
});

test('export admission refuses signed traversal aliases instead of interpreting them as in-root files', async (t) => {
  const source = await fixture(t);
  source.manifest.discordRest.files[0].path = 'messages/../channels.json';
  await assert.rejects(readDiscordPreservationBundle(await source.seal()), { code: 'preservation-path-unsafe' });
});

test('export admission refuses a redirected directory even when the signed bytes still match', async (t) => {
  const source = await fixture(t);
  await rename(path.join(source.root, 'messages'), path.join(source.root, 'redirected'));
  await symlink(path.join(source.root, 'redirected'), path.join(source.root, 'messages'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readDiscordPreservationBundle(source.options), { code: 'preservation-path-unsafe' });
});

test('export admission refuses duplicate signed file identities instead of silently collapsing the inventory', async (t) => {
  const source = await fixture(t);
  source.manifest.discordRest.files.push({ ...source.manifest.discordRest.files[0] });
  await assert.rejects(readDiscordPreservationBundle(await source.seal()), { code: 'preservation-manifest-invalid' });
});

test('export admission rejects an oversized signed file inventory before opening its data', async (t) => {
  const source = await fixture(t);
  source.manifest.discordRest.files[0].bytes = 33 * 1024 * 1024;
  await assert.rejects(readDiscordPreservationBundle(await source.seal()), { code: 'preservation-size-limit' });
});

test('export admission reports a missing source without exposing its private path', async (t) => {
  const source = await fixture(t);
  await rm(path.join(source.root, 'attachments/fictional-receipt.txt'));
  await assert.rejects(readDiscordPreservationBundle(source.options), (error) => {
    assert.equal(error.code, 'preservation-source-unavailable');
    assert.equal(error.message.includes(source.root), false);
    assert.equal(error.path, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('export admission bounds actual source bytes even when the signed inventory claims a small file', async (t) => {
  const source = await fixture(t);
  await truncate(path.join(source.root, 'attachments/fictional-receipt.txt'), 33 * 1024 * 1024);
  await assert.rejects(readDiscordPreservationBundle(source.options), { code: 'preservation-size-limit' });
});

for (const [label, filename, expectedCode] of [
  ['changed manifest', 'manifest.json', 'preservation-trust-mismatch'],
  ['substituted signer', 'signing-public.pem', 'preservation-trust-mismatch'],
  ['invalid signature', 'manifest.json.sig', 'preservation-signature-invalid'],
  ['changed attachment', 'attachments/fictional-receipt.txt', 'preservation-file-mismatch'],
  ['changed summary', 'rest-summary.json', 'preservation-summary-mismatch']
]) {
  test(`export admission rejects ${label} before returning a verified source`, async (t) => {
    const source = await fixture(t);
    const bytes = await readFile(path.join(source.root, filename));
    bytes[0] ^= 1;
    await writeFile(path.join(source.root, filename), bytes);
    await assert.rejects(readDiscordPreservationBundle(source.options), { code: expectedCode });
  });
}

test('an export cannot supply its own trust authority', async (t) => {
  const source = await fixture(t);
  await assert.rejects(readDiscordPreservationBundle({ root: source.root }), { code: 'preservation-trust-required' });
});

async function inventoryFixture(t) {
  const attachment = Buffer.from('Fictional receipt bytes.\n');
  const message = { id: 'fictional-message', channel_id: 'fictional-channel', author: { id: 'fictional-bot', bot: true }, content: 'Fictional report.', timestamp: '2026-01-01T00:00:00.000000+00:00', attachments: [{ id: 'fictional-attachment', size: attachment.length }] };
  const baseline = { guildStructureCount: 2, guildTextChannelCount: 2, messageCount: 1, attachmentCount: 1 };
  const summary = {
    ...baseline, discoveredThreadCount: 0, reactionCount: 0,
    channelReceipts: [{ id: 'fictional-channel', messageCount: 1, firstMessageId: 'fictional-message', lastMessageId: 'fictional-message' }, { id: 'fictional-empty', messageCount: 0, firstMessageId: null, lastMessageId: null }],
    attachments: [{ id: 'fictional-attachment', channelId: 'fictional-channel', messageId: 'fictional-message', path: 'attachments/fictional-receipt.txt', bytes: attachment.length, sha256: sha256(attachment), declaredBytes: attachment.length, sizeMatches: true }]
  };
  const files = new Map([
    ['channels.json', Buffer.from(JSON.stringify([{ id: 'fictional-channel', name: 'Fictional Garden', type: 0 }, { id: 'fictional-empty', name: 'Fictional Empty', type: 0 }]))],
    ['threads.json', Buffer.from('{"threads":[],"endpointReceipts":[]}')],
    ['messages/fictional-channel.jsonl', Buffer.from(JSON.stringify(message) + '\n')],
    ['messages/fictional-empty.jsonl', Buffer.alloc(0)],
    ['messages/fictional-channel.reactions.json', Buffer.from('[]')],
    ['messages/fictional-empty.reactions.json', Buffer.from('[]')],
    ['attachments/fictional-receipt.txt', attachment]
  ]);
  return fixture(t, { files, baseline, summary });
}

test('import inventory independently counts empty channels, messages and verified attachment associations', async (t) => {
  const source = await inventoryFixture(t);
  const inventory = await readDiscordPreservationInventory(source.options);
  assert.deepEqual(inventory.counts, { guildObjects: 2, channels: 2, messages: 1, attachments: 1 });
  assert.equal(inventory.channels.find((row) => row.channel.id === 'fictional-empty').messages.length, 0);
  const message = inventory.channels[0].messages[0];
  assert.equal(message.author.bot, true);
  assert.equal(message.timestamp, '2026-01-01T00:00:00.000000+00:00');
  assert.equal(inventory.attachments[0].messageId, 'fictional-message');
});

test('import inventory rejects repeated message identities even when the signed totals agree', async (t) => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  await source.replaceFile(filename, Buffer.concat([source.files.get(filename), source.files.get(filename)]));
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.messageCount = 2;
  summary.channelReceipts[0].messageCount = 2;
  source.manifest.baseline.messageCount = 2;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-identity-conflict' });
});

test('import inventory reconciles each channel receipt rather than trusting only the grand total', async (t) => {
  const source = await inventoryFixture(t);
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.channelReceipts[0].messageCount = 0;
  summary.channelReceipts[1].messageCount = 1;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-channel-mismatch' });
});

test('import inventory refuses omitted attachment associations even when signed attachment totals agree', async (t) => {
  const source = await inventoryFixture(t);
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.attachments = [];
  summary.attachmentCount = 0;
  source.manifest.baseline.attachmentCount = 0;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-attachment-mismatch' });
});

test('import inventory refuses signed message files absent from its channel accounting', async (t) => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-unaccounted.jsonl';
  const bytes = Buffer.from('{"id":"fictional-unaccounted-message"}\n');
  await writeFile(path.join(source.root, filename), bytes);
  source.manifest.discordRest.files.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-channel-mismatch' });
});

test('import inventory does not silently discard discovered threads even when text-channel totals agree', async (t) => {
  const source = await inventoryFixture(t);
  await source.replaceFile('threads.json', JSON.stringify({ threads: [{ id: 'fictional-thread', type: 11, parent_id: 'fictional-channel' }], endpointReceipts: [] }));
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-threads-unrepresented' });
});

test('import inventory refuses a signed truncated attachment despite a valid downloaded-file hash', async (t) => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  const message = JSON.parse(source.files.get(filename));
  message.attachments[0].size = 100;
  await source.replaceFile(filename, JSON.stringify(message) + '\n');
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.attachments[0].declaredBytes = 100;
  summary.attachments[0].sizeMatches = false;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-attachment-incomplete' });
});

test('import inventory preserves reaction provenance without inventing complete reactor enumeration', async (t) => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  const message = JSON.parse(source.files.get(filename));
  const reaction = { emoji: { id: null, name: '🌱' }, count: 2, count_details: { normal: 1, burst: 1 } };
  message.reactions = [reaction];
  await source.replaceFile(filename, JSON.stringify(message) + '\n');
  await source.replaceFile('messages/fictional-channel.reactions.json', JSON.stringify([{ messageId: message.id, emoji: reaction.emoji, summary: reaction, users: [{ id: 'fictional-reactor', bot: false }] }]));
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.reactionCount = 2;
  source.manifest.discordRest.reactionCount = 2;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  const inventory = await readDiscordPreservationInventory(await source.seal());
  assert.equal(inventory.reactionCount, 2);
  assert.equal(inventory.channels[0].reactions[0].users[0].id, 'fictional-reactor');
  assert.equal(inventory.channels[0].reactionUserCoverage, 'unverified');
});

test('import inventory refuses a reaction sidecar associated with a nonexistent message', async (t) => {
  const source = await inventoryFixture(t);
  const emoji = { id: null, name: '🌱' };
  await source.replaceFile('messages/fictional-channel.reactions.json', JSON.stringify([{ messageId: 'fictional-absent', emoji, summary: { emoji, count: 1 }, users: [] }]));
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.reactionCount = 1;
  source.manifest.discordRest.reactionCount = 1;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-reaction-mismatch' });
});

test('import inventory includes exported announcement channels rather than silently dropping their history', async (t) => {
  const source = await inventoryFixture(t);
  const channels = JSON.parse(source.files.get('channels.json'));
  channels[0].type = 5;
  await source.replaceFile('channels.json', JSON.stringify(channels));
  const inventory = await readDiscordPreservationInventory(await source.seal());
  assert.equal(inventory.channels[0].channel.type, 5);
  assert.equal(inventory.channels[0].messages[0].content, 'Fictional report.');
  assert.equal(inventory.counts.channels, 2);
});

test('import inventory refuses omitted reaction provenance even when summary totals omit it too', async (t) => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  const message = JSON.parse(source.files.get(filename));
  message.reactions = [{ emoji: { id: null, name: '🌱' }, count: 1 }];
  await source.replaceFile(filename, JSON.stringify(message) + '\n');
  await assert.rejects(readDiscordPreservationInventory(await source.seal()), { code: 'preservation-reaction-mismatch' });
});

test('source inspection retains verified attachment bytes and explicit discrepancies without granting import admission', async (t) => {
  const source = await inventoryFixture(t);
  const filename = 'messages/fictional-channel.jsonl';
  const message = JSON.parse(source.files.get(filename));
  message.attachments[0].size = 100;
  await source.replaceFile(filename, JSON.stringify(message) + '\n');
  const summary = JSON.parse(await readFile(path.join(source.root, 'rest-summary.json')));
  summary.attachments[0].declaredBytes = 100;
  summary.attachments[0].sizeMatches = false;
  await source.replaceFile('rest-summary.json', JSON.stringify(summary));
  const options = await source.seal();
  const inventory = await inspectDiscordPreservationInventory(options);
  assert.equal(inventory.admissible, false);
  assert.equal(inventory.counts.messages, 1);
  assert.equal(inventory.attachmentDiscrepancies.length, 1);
  assert.equal(inventory.attachmentDiscrepancies[0].attachmentId, 'fictional-attachment');
  assert.equal(inventory.attachmentDiscrepancies[0].status, 'declared-representation-unverified');
  assert.equal(inventory.bundle.readFile('attachments/fictional-receipt.txt').toString(), 'Fictional receipt bytes.\n');
  await assert.rejects(readDiscordPreservationInventory(options), { code: 'preservation-attachment-incomplete' });
});
