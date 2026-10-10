import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicDocumentFilingService } from '../src/documents/filing.mjs';
import { createNativeAttachmentReader } from '../src/documents/native-attachments.mjs';

function fixture() {
  let effects = 0; let current = true;
  const binding = { status: 'bound', topicId: 'fictional-topic', name: 'Fictional project', sessionKey: 'agent:main:fictional', sessionId: 'fictional-session', referenceId: 'fictional-conversation' };
  const attachmentReader = createNativeAttachmentReader({ readPage: async () => ({ kind: 'page', generation: 'fictional-generation', serializedBytes: 256, hasMore: false, entries: [{ entryId: 'fictional-user-message', role: 'user', message: { role: 'user', __openclaw: { media: [{ url: 'media://inbound/fictional-file', fileName: 'original.pdf', contentType: 'application/pdf', sizeBytes: 8 }] } } }] }) });
  const sourceService = { sessionTopicContext: async () => binding, requireTopicService: () => ({ notes: { create: () => { effects++; throw new Error('Review cannot create'); } } }), listTopicSourceReferences: () => [{ referenceId: 'fictional-folder', sourceSystem: 'obsidian', sourceKind: 'note_folder' }] };
  const metadata = { listSourceReferences: () => [{ referenceId: 'fictional-folder', sourceSystem: 'obsidian', sourceKind: 'note_folder' }], getSourceReference: id => id === 'fictional-conversation' ? { referenceId: id, topicId: binding.topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: binding.sessionKey } : id === 'fictional-folder' ? { referenceId: id, topicId: binding.topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'fictional-folder' } : null, getSessionState: () => ({ referenceId: binding.referenceId, sessionId: binding.sessionId, status: 'open' }), getTopic: () => ({ topicId: binding.topicId, revision: 3, name: binding.name }), getSourceLocator: () => ({ locatorVersion: 1, observedRevision: 'fictional-folder-revision' }) };
  const service = createTopicDocumentFilingService({ sourceService, metadata, attachmentReader, mediaLoader: async () => ({ buffer: Buffer.from('original'), fileName: 'original.pdf', contentType: 'application/pdf' }) });
  const input = { sessionKey: binding.sessionKey, sessionId: binding.sessionId };
  const runtime = { assertCurrent: () => { if (!current) throw Object.assign(new Error('Retired'), { code: 'unauthenticated' }); } };
  return { service, input, runtime, binding, metadata, effects: () => effects, retire: () => { current = false; } };
}

test('review selected accepted attachment resolves exact linked Topic and safe original destination without an effect', async () => {
  const f = fixture();
  const page = await f.service.listAttachments(f.input, f.runtime);
  const review = await f.service.reviewAttachment({ ...f.input, selection: page.attachments[0].selection, subfolder: 'Reference' }, f.runtime);
  assert.equal(review.topicId, 'fictional-topic');
  assert.equal(review.topicName, 'Fictional project');
  assert.match(review.document.path, /^Documents\/Reference\/original--[a-f0-9]{12}\.pdf$/u);
  assert.equal(review.document.sizeBytes, 8);
  assert.equal(review.source.entryId, 'fictional-user-message');
  assert.equal(review.source.sessionId, f.input.sessionId);
  assert.equal(f.effects(), 0);
});

test('original review uses the native 5 MiB bound and refuses an oversized managed copy', async () => {
  const f = fixture();
  const page = await f.service.listAttachments(f.input, f.runtime);
  f.service.mediaLoader = async (_ref, options) => {
    assert.equal(options.maxBytes, 5 * 1024 * 1024);
    return { buffer: Buffer.alloc(options.maxBytes + 1) };
  };
  await assert.rejects(() => f.service.reviewAttachment({ ...f.input, selection: page.attachments[0].selection }, f.runtime), { code: 'response-too-large' });
  assert.equal(f.effects(), 0);
});

test('review refuses lost authority, wrong Conversation, unsafe path and stale selection before any file effect', async () => {
  const f = fixture();
  const selection = (await f.service.listAttachments(f.input, f.runtime)).attachments[0].selection;
  await assert.rejects(() => f.service.reviewAttachment({ ...f.input, selection, subfolder: '../outside' }, f.runtime), { code: 'invalid-path' });
  await assert.rejects(() => f.service.reviewAttachment({ ...f.input, sessionId: 'replaced', selection }, f.runtime), { code: 'source-recovery' });
  await assert.rejects(() => f.service.reviewAttachment({ ...f.input, selection: { ...selection, entryId: 'foreign-message' } }, f.runtime), { code: 'source-recovery' });
  f.retire();
  await assert.rejects(() => f.service.listAttachments(f.input, f.runtime), { code: 'unauthenticated' });
  assert.equal(f.effects(), 0);
});

test('review rejects destination revision or locator changes during its final awaited source read', async () => {
  for (const change of ['topic', 'folder', 'binding']) {
    const f = fixture();
    const selection = (await f.service.listAttachments(f.input, f.runtime)).attachments[0].selection;
    const owner = f.service.attachmentReader; let resolutions = 0;
    f.service.attachmentReader = { ...owner, resolve: async (...args) => {
      const result = await owner.resolve(...args);
      if (++resolutions === 2) {
        if (change === 'topic') f.metadata.getTopic = () => ({ topicId: f.binding.topicId, revision: 4, name: f.binding.name });
        if (change === 'folder') f.metadata.getSourceLocator = () => ({ locatorVersion: 2, observedRevision: 'changed-folder' });
        if (change === 'binding') f.binding.topicId = 'another-topic';
      }
      return result;
    } };
    await assert.rejects(() => f.service.reviewAttachment({ ...f.input, selection }, f.runtime), error => ['conflict', 'source-recovery'].includes(error.code));
    assert.equal(f.effects(), 0);
  }
});
