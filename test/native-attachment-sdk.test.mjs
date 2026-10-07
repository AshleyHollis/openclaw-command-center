import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNativeAttachmentReader } from '../src/documents/native-attachments.mjs';

// Exercise the hash-verified native26a9 public SDK, not a transcript/media double.
// The accepted message is seeded by the native strict append owner; an actual
// composer upload remains a separately gated installed-host acceptance journey.
test('real pinned native SDK retains scoped accepted media facts through bounded visible pages', { skip: process.platform !== 'linux' }, async t => {
  assert.ok(process.env.COMMAND_CENTER_TEST_SESSION_TRANSCRIPT_RUNTIME, 'The exact pinned native SDK runtime must be supplied.');
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'native-attachment-proof-'));
  const previousState = process.env.OPENCLAW_STATE_DIR;
  const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  t.after(async () => {
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = previousConfig;
    await rm(stateDir, { recursive: true, force: true });
  });
  const nativeStore = await import('openclaw/plugin-sdk/session-store-runtime');
  const nativeTranscript = await import('openclaw/plugin-sdk/session-transcript-runtime');
  const identity = { agentId: 'main', sessionKey: 'agent:main:fictional-attachments', sessionId: 'fictional-attachments-incarnation' };
  await nativeStore.patchSessionEntry({ agentId: identity.agentId, sessionKey: identity.sessionKey,
    fallbackEntry: { sessionId: identity.sessionId, lifecycleRevision: 'fictional-life', updatedAt: 1 }, update: entry => entry });
  const media = { url: 'media://inbound/fictional-native-original', fileName: 'original.pdf', contentType: 'application/pdf', sizeBytes: 123 };
  for (const [eventId, message] of [
    ['fictional-accepted', { role: 'user', content: 'A fictional document', __openclaw: { media: [media] }, timestamp: 1767225600000 }],
    ['fictional-model', { role: 'assistant', content: 'media://inbound/model-guessed', __openclaw: { media: [media] }, timestamp: 1767225600001 }],
    ['fictional-legacy', { role: 'user', content: 'media://inbound/guessed', media: [media], timestamp: 1767225600002 }],
  ]) {
    assert.equal((await nativeTranscript.appendSessionTranscriptMessageByIdentityStrict({ ...identity, config: {}, eventId, message, now: 1767225600000 })).kind, 'result');
  }
  const reader = createNativeAttachmentReader();
  const page = await reader.list(identity);
  assert.equal(page.attachments.length, 1);
  const attachment = page.attachments[0];
  assert.equal(attachment.mediaRef, media.url);
  assert.equal(attachment.fileName, media.fileName);
  assert.equal(attachment.selection.entryId, 'fictional-accepted');
  assert.deepEqual(await reader.resolve(identity, attachment.selection), attachment);
  await assert.rejects(() => reader.resolve({ ...identity, sessionId: 'foreign-incarnation' }, attachment.selection));
  await assert.rejects(() => reader.resolve(identity, { ...attachment.selection, entryId: 'fictional-model' }));
});
