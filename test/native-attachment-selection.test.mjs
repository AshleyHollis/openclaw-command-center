import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeAttachmentReader } from '../src/documents/native-attachments.mjs';

const identity = { agentId: 'main', sessionKey: 'agent:main:fictional', sessionId: 'fictional-incarnation' };
const media = { url: 'media://inbound/fictional-pdf', fileName: 'original.pdf', contentType: 'application/pdf', sizeBytes: 123 };
const entry = (entryId, role, message) => ({ entryId, role, message: { role, ...message } });
const page = entries => ({ kind: 'page', generation: 'fictional-generation', entries, serializedBytes: 512, totalMessages: entries.length, hasMore: false, cursor: 'fictional-cursor' });

test('attachment selection uses only canonical structured media of accepted user entries and bounded exact scope', async () => {
  const calls = [];
  const reader = createNativeAttachmentReader({ readPage: async input => { calls.push(input); return page([
    entry('accepted', 'user', { __openclaw: { media: [media] }, content: 'A fictional document' }),
    entry('model', 'assistant', { __openclaw: { media: [media] } }),
    entry('legacy', 'user', { media: [media], content: 'media://inbound/guessed' }),
    entry('url', 'user', { __openclaw: { media: [{ url: 'https://fictional.invalid/a.pdf' }] } })
  ]); } });
  const result = await reader.list(identity);
  assert.equal(result.attachments.length, 1);
  assert.deepEqual(result.attachments[0].selection, { entryId: 'accepted', mediaIndex: 0, offset: 0, generation: 'fictional-generation' });
  assert.equal(result.attachments[0].fileName, 'original.pdf');
  assert.deepEqual(calls[0], { ...identity, offset: 0, maxMessages: 50, maxBytes: 1024 * 1024 });
  assert.equal((await reader.resolve(identity, result.attachments[0].selection)).mediaRef, media.url);
});

test('selection refuses another entry, rewritten generation and unavailable or oversized native pages', async () => {
  let value = page([entry('accepted', 'user', { __openclaw: { media: [media] } })]);
  const reader = createNativeAttachmentReader({ readPage: async () => value });
  const selection = (await reader.list(identity)).attachments[0].selection;
  await assert.rejects(() => reader.resolve(identity, { ...selection, entryId: 'other-conversation' }), { code: 'source-recovery' });
  value = { ...value, generation: 'changed' };
  await assert.rejects(() => reader.resolve(identity, selection), { code: 'conflict' });
  for (const unavailable of [{ kind: 'missing' }, { kind: 'reset', reason: 'generation_mismatch' }, { kind: 'unavailable' }, { ...value, entries: [], requiredBytes: 2 * 1024 * 1024 }]) {
    value = unavailable;
    await assert.rejects(() => reader.list(identity));
  }
});

test('closed selection and read bounds reject forged caller scope and unsafe input without native reads', async () => {
  let reads = 0;
  const reader = createNativeAttachmentReader({ readPage: async () => { reads++; return page([]); } });
  await assert.rejects(() => reader.list({ ...identity, agentId: 'another' }), { code: 'invalid-request' });
  await assert.rejects(() => reader.list(identity, { offset: -1 }), { code: 'invalid-request' });
  await assert.rejects(() => reader.resolve(identity, { entryId: 'accepted', mediaIndex: 0, offset: 0, generation: 'g', mediaRef: media.url }), { code: 'invalid-request' });
  assert.equal(reads, 0);
});
