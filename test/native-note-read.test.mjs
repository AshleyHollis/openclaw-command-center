import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readNativeNote } from '../src/native-ui/note-read.mjs';

const descriptor = { topicId: 'fictional-topic', referenceId: 'fictional-note', path: 'notes.md', observedRevision: 'r1' };
const chunk = (bytes, extra = {}) => ({
  path: 'notes.md', revision: 'r1', contentBase64: Buffer.from(bytes).toString('base64'), contentEncoding: 'identity',
  byteOffset: 0, nextOffset: bytes.length, totalBytes: bytes.length, complete: true,
  sourceReference: { topicId: descriptor.topicId, referenceId: descriptor.referenceId }, ...extra
});

test('native Notes support the host gzip encoding without confusing compressed and Note byte lengths', async () => {
  const text = 'Fictional compressed Note';
  const bytes = Buffer.from(text);
  const response = chunk(bytes, { contentEncoding: 'gzip', contentBase64: gzipSync(bytes).toString('base64') });
  const host = { signal: new AbortController().signal, request: async () => ({ result: response }) };
  assert.equal((await readNativeNote(host, descriptor)).text, text);
});

test('native Note retrieval preserves UTF-8 across authoritative byte chunks', async () => {
  const chunks = [chunk([65, 0xe2], { nextOffset: 2, totalBytes: 4, complete: false }), chunk([0x82, 0xac], { byteOffset: 2, nextOffset: 4, totalBytes: 4 })];
  const host = { signal: new AbortController().signal, request: async (method, params) => {
    assert.equal(method, 'command-center.v1.notes.read');
    assert.equal(params.topicId, 'fictional-topic');
    assert.equal(params.referenceId, 'fictional-note');
    assert.equal(params.observedRevision, 'r1');
    return { result: chunks[params.offset === 0 ? 0 : 1] };
  } };
  assert.deepEqual(await readNativeNote(host, descriptor), { text: 'A€', revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-note' } });
});

test('an empty authoritative Note opens successfully', async () => {
  const host = { signal: new AbortController().signal, request: async () => ({ result: chunk([]) }) };
  assert.equal((await readNativeNote(host, descriptor)).text, '');
});

for (const [name, changed] of [
  ['another Topic', { sourceReference: { topicId: 'other-topic', referenceId: descriptor.referenceId } }],
  ['another Note', { sourceReference: { topicId: descriptor.topicId, referenceId: 'other-note' } }],
  ['changed revision', { revision: 'r2' }],
  ['another path', { path: 'other.md' }],
  ['unbounded content', { totalBytes: 9 * 1024 * 1024 }],
  ['unknown encoding', { contentEncoding: 'unknown' }],
  ['wrong byte offset', { byteOffset: 1 }],
  ['stalled stream', { nextOffset: 0, totalBytes: 2, complete: false }]
]) test(`native Note retrieval refuses ${name}`, async () => {
  const host = { signal: new AbortController().signal, request: async () => ({ result: chunk([65], changed) }) };
  await assert.rejects(readNativeNote(host, descriptor));
});

test('a cancelled Note read cannot return delayed content', async () => {
  const delayed = Promise.withResolvers();
  const lifetime = new AbortController();
  const reading = readNativeNote({ signal: lifetime.signal, request: () => delayed.promise }, descriptor);
  lifetime.abort(); delayed.resolve({ result: chunk([65]) });
  await assert.rejects(reading, { name: 'AbortError' });
});

test('compressed Note content cannot exceed its declared decompressed size', async () => {
  const response = chunk([65], { contentEncoding: 'gzip', contentBase64: gzipSync(Buffer.from('Larger than one byte')).toString('base64') });
  await assert.rejects(readNativeNote({ signal: new AbortController().signal, request: async () => response }, descriptor), /declared length/);
});
