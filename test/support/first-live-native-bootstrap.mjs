import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { retainPreparedMigrationFixtureEvidence, verifiedMigrationStatusReady } from '../../src/acceptance-migration.mjs';
import { waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { readNativeNote } from '../../src/native-ui/note-read.mjs';
import { NOTE_FOLDER_IDENTITY_FILE, readNoteFolderIdentity } from '../../src/sources/note-folder-identity.mjs';
import { readAuthenticatedHistory, requestAuthenticatedGateway } from './real-host-runtime.mjs';

async function originalNoteIdentity(file) {
  const stat = await lstat(file, { bigint: true });
  assert.equal(stat.isFile(), true);
  // Reads may advance atime. Neither bootstrap nor retained reading may replace
  // the original inode, change its content, or touch its write timestamps.
  return Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
}

// Prepare only the user's configured input in the issued fictional world. The
// real default startup owns all metadata, Folder enrollment and native imports.
export async function prepareNativeLegacyBootstrap({ world, signal, scale = false }) {
  signal.throwIfAborted();
  const topicId = '44444444-4444-4444-8444-444444444444';
  const name = scale ? 'Fictional Native Scale' : 'Fictional Native Journey';
  const notePath = scale ? '00000-Large.md' : 'Overview.md';
  const noteText = scale ? 'L'.repeat(8_388_609) : '# Fictional Native Journey\nExisting authoritative Note — read only.\n';
  const requestedFolder = path.join(world.paths.vault, 'Projects', name);
  await mkdir(requestedFolder, { recursive: true });
  const folder = await realpath(requestedFolder);
  await writeFile(path.join(folder, notePath), noteText, { flag: 'wx' });
  await assert.rejects(lstat(path.join(folder, NOTE_FOLDER_IDENTITY_FILE)), error => error.code === 'ENOENT');
  const noteIdentity = await originalNoteIdentity(path.join(folder, notePath));
  const scaleNotes = [];
  if (scale) {
    for (let index = 1; index < 5_000; index += 1) {
      signal.throwIfAborted();
      const file = `Note-${String(index).padStart(5, '0')}.md`;
      const text = `# Fictional scale Note ${index}\nRead-only acceptance source.\n`;
      await writeFile(path.join(folder, file), text, { flag: 'wx' });
      scaleNotes.push({ path: file, text, identity: await originalNoteIdentity(path.join(folder, file)) });
    }
  }
  const sourceExport = JSON.parse(await readFile(new URL('../fixtures/legacy-discord-export.v1.json', import.meta.url), 'utf8'));
  assert.equal(sourceExport.channels.length, 1);
  assert.equal(sourceExport.channels[0].messages.length, 2);
  if (scale) sourceExport.channels[0].messages = Array.from({ length: 5_000 }, (_, index) => ({
    messageId: `fictional-scale-message-${String(index).padStart(5, '0')}`, displayOrder: index,
    author: { id: 'fictional-scale-author', displayName: 'Fictional Scale Author' },
    timestamp: new Date(Date.UTC(2026, 7, 20) + index * 1_000).toISOString(), text: `Fictional immutable scale occurrence ${index}.`,
    edits: [], replyToMessageId: null, thread: null, reactions: [], attachments: []
  }));
  sourceExport.channels[0].channelId = 'fictional-native-bootstrap-channel';
  sourceExport.channels[0].displayName = name;
  const prepared = retainPreparedMigrationFixtureEvidence(sourceExport);
  const exportPath = path.join(world.tempRoot, 'native-existing-data-export.json');
  const exportBytes = `${JSON.stringify(sourceExport)}\n`;
  await writeFile(exportPath, exportBytes, { flag: 'wx' });
  const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
  config.plugins.entries['command-center'].config.legacyDiscordMigration = {
    schemaVersion: 1, exportPath,
    channels: [{ channelId: sourceExport.channels[0].channelId, topicId, paraCategory: 'project', noteFolderPath: folder }]
  };
  await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
  signal.throwIfAborted();
  return Object.freeze({ topicId, name, notePath, noteText, folder, noteIdentity, prepared, exportPath, exportBytes,
    ...(scale ? { scale: true, scaleNotes: Object.freeze(scaleNotes) } : {}) });
}

// All destination identities come from authenticated, current public readbacks;
// there is no database seeding, SQL binding lookup or manual recovery fallback.
export async function readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount = 1, onReady }) {
  const request = async (method, params = {}, requestSignal = signal, scopes = ['operator.read']) => {
    const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
      method: `command-center.v1.${method}`, params: { schemaVersion: 1, ...params }, scopes, signal: requestSignal });
    return response?.result ?? response;
  };
  let status;
  await waitForConsecutiveReadiness(async (probeSignal) => {
    try { status = await request('migration.status', {}, probeSignal); }
    catch (error) {
      probeSignal.throwIfAborted();
      // The catalog can register before the startup service is available. Only
      // that admission state is retryable here; migration refusals stay fatal.
      if (error.message.includes('Command Center source service is not ready.')) return false;
      throw error;
    }
    return verifiedMigrationStatusReady(status, bootstrap.prepared);
  }, host.earlyExit, { deadlineMs: 60_000, delayMs: 100, signal });
  onReady?.();
  assert.deepEqual(status.actions, []);
  assert.deepEqual(status.failures, []);
  assert.match(status.completion.configDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(status.completion.sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  const { topic } = await request('topics.get', { topicId: bootstrap.topicId });
  assert.equal(topic.topicId, bootstrap.topicId);
  assert.equal(topic.name, bootstrap.name);
  assert.equal(topic.paraCategory, 'project');
  assert.equal(topic.lifecycle, 'active');
  assert.equal(topic.usable, true);
  const folders = topic.sourceReferences.filter(row => row.sourceSystem === 'obsidian' && row.sourceKind === 'note_folder');
  assert.equal(folders.length, 1);
  assert.equal(folders[0].topicId, bootstrap.topicId);
  assert.equal(folders[0].externalSourceId, undefined, 'Topic projection must not expose the private absolute Folder path');
  const locators = topic.locators.filter(row => row.referenceId === folders[0].referenceId);
  assert.equal(locators.length, 1);
  assert.equal(locators[0].locator, undefined);
  assert.equal(locators[0].ownership, 'external');
  assert.ok(Number.isSafeInteger(locators[0].locatorVersion) && locators[0].locatorVersion > 0);
  assert.equal(locators[0].observedRevision, await readNoteFolderIdentity(bootstrap.folder), 'Default bootstrap must enroll and bind the actual existing Folder');
  const catalog = await request('sessions.browse', { topicId: bootstrap.topicId, includeClosed: false });
  assert.equal(catalog.topicId, bootstrap.topicId);
  assert.equal(catalog.conversations.length, expectedConversationCount);
  const primary = catalog.conversations.filter(row => row.isPrimary === true);
  assert.equal(primary.length, 1);
  assert.equal(primary[0].status, 'open');
  assert.equal(primary[0].availability, undefined);
  const target = await request('sessions.navigate', { topicId: bootstrap.topicId, referenceId: primary[0].referenceId, nativeChat: true }, signal, ['operator.read', 'operator.write']);
  assert.equal(target.sourceReference.topicId, bootstrap.topicId);
  assert.equal(target.sourceReference.referenceId, primary[0].referenceId);
  assert.equal(target.sessionId, primary[0].sessionId);
  assert.ok(typeof target.sessionId === 'string' && target.sessionId.length > 0);
  assert.equal(target.sessionKey, `agent:main:command-center:legacy-discord:${bootstrap.prepared.migrationExport.channels[0].channelId}`);
  const notes = await request('notes.browse', { topicId: bootstrap.topicId, ...(bootstrap.scale ? { limit: 50, offset: 0 } : {}) });
  assert.equal(notes.total, bootstrap.scale ? 5_000 : 1);
  assert.equal(notes.notes.length, bootstrap.scale ? 50 : 1);
  assert.equal(notes.hasMore, !!bootstrap.scale);
  const note = notes.notes[0];
  assert.equal(note.path, bootstrap.notePath);
  assert.equal(note.sourceReference.topicId, bootstrap.topicId);
  assert.equal(note.revision, `sha256:${createHash('sha256').update(bootstrap.noteText).digest('hex')}`);
  const read = await readNativeNote({ signal, request: (method, params) => requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method, params, signal }) },
    { topicId: bootstrap.topicId, referenceId: note.sourceReference.referenceId, path: note.path, observedRevision: note.revision });
  assert.equal(read.text, bootstrap.noteText);
  assert.equal(await readFile(path.join(bootstrap.folder, bootstrap.notePath), 'utf8'), bootstrap.noteText);
  assert.deepEqual(await originalNoteIdentity(path.join(bootstrap.folder, bootstrap.notePath)), bootstrap.noteIdentity);
  assert.equal(await readFile(bootstrap.exportPath, 'utf8'), bootstrap.exportBytes);
  const history = bootstrap.scale
    ? await readNativeScaleHistory({ world, target, signal })
    : await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: target.sessionKey, signal }).then(response => response?.result ?? response);
  assert.equal(history.sessionKey, target.sessionKey);
  assert.equal(history.sessionId, target.sessionId);
  const channel = bootstrap.prepared.migrationExport.channels[0];
  const imported = history.messages.filter(message => message?.__openclaw?.legacyDiscordV1?.immutable === true);
  const occurrenceCount = bootstrap.prepared.occurrenceCount;
  assert.equal(imported.length, occurrenceCount, 'The actual import must retain exactly the original occurrences, without duplicates');
  assert.deepEqual(history.messages.slice(0, occurrenceCount), imported, 'Imported history must remain the immutable Primary prefix');
  const occurrenceIds = new Set();
  for (const [index, message] of imported.entries()) {
    const original = channel.messages[index];
    assert.equal(message.role, 'user');
    assert.equal(message.text, original.text);
    assert.equal(message.content, original.text);
    assert.equal(message.timestamp, original.timestamp);
    assert.equal(message.__openclaw.senderId, original.author.id);
    assert.equal(message.__openclaw.senderName, original.author.displayName);
    const provenance = message.__openclaw.legacyDiscordV1;
    assert.equal(provenance.schemaVersion, 1);
    assert.equal(provenance.sourceChannelId, channel.channelId);
    assert.equal(provenance.sourceMessageId, original.messageId);
    for (const field of ['displayOrder', 'author', 'timestamp', 'edits', 'replyToMessageId', 'thread', 'reactions', 'attachments']) assert.deepEqual(provenance[field], original[field]);
    assert.match(provenance.occurrenceId, /^command-center:legacy-discord:v1:[a-f0-9]{64}$/u);
    assert.match(provenance.occurrenceDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(message.idempotencyKey, provenance.occurrenceId);
    occurrenceIds.add(provenance.occurrenceId);
  }
  assert.equal(occurrenceIds.size, occurrenceCount);
  return Object.freeze({
    fixture: Object.freeze({ topicId: bootstrap.topicId, name: bootstrap.name, sessionReferenceId: target.sourceReference.referenceId,
      sessionKey: target.sessionKey, sessionId: target.sessionId, notePath: bootstrap.notePath, noteText: bootstrap.noteText, folder: bootstrap.folder }),
    completion: status.completion, folderReferenceId: folders[0].referenceId, folderLocator: locators[0],
    noteReferenceId: note.sourceReference.referenceId, importedMessages: imported
  });
}

async function readNativeScaleHistory({ world, target, signal }) {
  let offset = 0;
  const messages = [];
  const seen = new Set();
  while (true) {
    const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
      method: 'chat.history', params: { sessionKey: target.sessionKey, offset, limit: 200 }, signal });
    const history = response?.result ?? response;
    assert.equal(history.sessionKey, target.sessionKey);
    assert.equal(history.sessionId, target.sessionId);
    assert.equal(history.totalMessages, 5_000);
    assert.equal(history.offset, offset);
    assert.ok(history.messages.length > 0);
    for (const message of history.messages) {
      const id = message?.__openclaw?.legacyDiscordV1?.occurrenceId;
      assert.equal(typeof id, 'string');
      assert.equal(seen.has(id), false, 'Native history pagination must not repeat an occurrence');
      seen.add(id);
    }
    // Native offset pages walk backward from the current tail. Each page is
    // chronological, so prepend whole pages, never sort away ordering defects.
    messages.unshift(...history.messages);
    if (!history.hasMore) break;
    assert.ok(Number.isSafeInteger(history.nextOffset) && history.nextOffset > offset);
    assert.ok(history.nextOffset < 5_000);
    offset = history.nextOffset;
  }
  assert.equal(messages.length, 5_000);
  return { sessionKey: target.sessionKey, sessionId: target.sessionId, messages };
}

export async function assertNativeScaleSourcesUnchanged(bootstrap, signal) {
  for (const note of [{ path: bootstrap.notePath, text: bootstrap.noteText, identity: bootstrap.noteIdentity }, ...bootstrap.scaleNotes]) {
    signal.throwIfAborted();
    assert.equal(await readFile(path.join(bootstrap.folder, note.path), 'utf8'), note.text);
    assert.deepEqual(await originalNoteIdentity(path.join(bootstrap.folder, note.path)), note.identity);
  }
  assert.equal(await readFile(bootstrap.exportPath, 'utf8'), bootstrap.exportBytes);
}
