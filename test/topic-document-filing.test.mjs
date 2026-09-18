import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTopicDocumentFilingService } from '../src/documents/filing.mjs';
import { topicDocumentFileToolFactory } from '../src/documents/tool.mjs';

function fixture({ loader } = {}) {
  const topicId = 'fictional-sample-records';
  const sessionKey = 'agent:main:fictional-case-2025-26';
  const sessionId = 'fictional-session-2025-26';
  const references = new Map();
  const notes = {
    async create(input) {
      return { note: { path: input.path, revision: `sha256:${createHash('sha256').update(input.content).digest('hex')}`, sourceReference: { referenceId: `document:${input.path}`, topicId, sourceSystem: 'obsidian', sourceKind: 'document' } } };
    },
    async read() { throw Object.assign(new Error('missing'), { code: 'not-found' }); },
  };
  const sourceService = {
    coordinator: { async mutate(input) { return { schemaVersion: 1, status: 'applied', logicalOperationId: input.logicalOperationId, value: await input.execute() }; } },
    async sessionTopicContext({ sessionKey: input }) { return input === sessionKey ? { status: 'bound', topicId, referenceId: 'session:fictional', sessionKey, sessionId } : { status: 'unbound', sessionKey: input }; },
    requireTopicService() { return { notes }; },
    listTopicSourceReferences() { return [{ referenceId: 'folder:fictional', topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder' }]; },
  };
  const metadata = {
    getSourceReference(id) { return references.get(id) ?? null; },
    createSourceReference(value) { references.set(value.referenceId, value); return value; },
    observeSourceReference(value) { references.set(value.referenceId, value); return value; },
  };
  return { topicId, sessionKey, sessionId, sourceService, metadata, service: createTopicDocumentFilingService({ sourceService, metadata, mediaLoader: loader ?? (async () => ({ buffer: Buffer.from('fictional receipt bytes'), contentType: 'application/pdf', fileName: 'receipt.pdf' })) }) };
}

test('files only a managed current-Conversation attachment to a deterministic safe Topic document receipt', async () => {
  const f = fixture();
  const result = await f.service.file({ sessionKey: f.sessionKey, sessionId: f.sessionId, mediaRef: 'media://inbound/fictional-receipt.pdf', subfolder: 'Case 2025-26' });
  assert.equal(result.status, 'applied');
  assert.equal(result.value.status, 'filed');
  assert.match(result.value.document.path, /^Documents\/Case 2025-26\/receipt--[a-f0-9]{12}\.pdf$/u);
  assert.equal(result.value.document.contentType, 'application/pdf');
  assert.equal(result.value.source.mediaRef, 'media://inbound/fictional-receipt.pdf');
  assert.equal(result.value.topicId, f.topicId);
});

test('collision-safe source identity gives same-name distinct managed attachments distinct stable destinations', async () => {
  const f = fixture();
  const first = await f.service.file({ sessionKey: f.sessionKey, sessionId: f.sessionId, mediaRef: 'media://inbound/receipt-one.pdf' });
  const second = await f.service.file({ sessionKey: f.sessionKey, sessionId: f.sessionId, mediaRef: 'media://inbound/receipt-two.pdf' });
  assert.notEqual(first.logicalOperationId, second.logicalOperationId);
  assert.notEqual(first.value.document.path, second.value.document.path);
  assert.match(first.value.document.path, /^Documents\/receipt--[a-f0-9]{12}\.pdf$/u);
});

test('refuses arbitrary, foreign, malformed, or changed attachment sources before a document effect', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.file({ sessionKey: f.sessionKey, sessionId: f.sessionId, mediaRef: 'https://fictional.invalid/receipt.pdf' }), { code: 'invalid-request' });
  await assert.rejects(() => f.service.file({ sessionKey: 'agent:main:unbound', mediaRef: 'media://inbound/receipt.pdf' }), { code: 'source-recovery' });
  await assert.rejects(() => f.service.file({ sessionKey: f.sessionKey, sessionId: 'replaced-session', mediaRef: 'media://inbound/receipt.pdf' }), { code: 'source-recovery' });
  let reads = 0;
  const changed = fixture({ loader: async () => ({ buffer: Buffer.from(reads++ === 0 ? 'before' : 'after'), contentType: 'application/pdf', fileName: 'receipt.pdf' }) });
  await assert.rejects(() => changed.service.file({ sessionKey: changed.sessionKey, sessionId: changed.sessionId, mediaRef: 'media://inbound/receipt.pdf' }), { code: 'conflict' });
});

test('actual model tool derives its authority from the host turn instead of model-supplied session fields', async () => {
  const calls = [];
  const tool = topicDocumentFileToolFactory({ file: async (input) => { calls.push(input); return { status: 'applied', value: { schemaVersion: 1, status: 'filed' } }; } })({ sessionKey: 'agent:main:fictional-case', sessionId: 'fictional-session' });
  const result = await tool.execute('fictional-tool-call', { mediaRef: 'media://inbound/receipt.pdf', subfolder: 'Case 2025-26' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { mediaRef: 'media://inbound/receipt.pdf', subfolder: 'Case 2025-26', sessionKey: 'agent:main:fictional-case', sessionId: 'fictional-session', requestId: 'fictional-tool-call' });
  assert.equal(result.details.status, 'filed');
});

test('model filing tool permits the host scoped-tool proxy to wrap execution', () => {
  const tool = topicDocumentFileToolFactory({ file: async () => ({ value: { status: 'applied' } }) })({ sessionKey: 'agent:main:fictional' });
  const scoped = new Proxy(tool, { get(target, property, receiver) {
    if (property === 'execute') return (...input) => Reflect.apply(target.execute, target, input);
    return Reflect.get(target, property, receiver);
  } });
  assert.equal(Object.getOwnPropertyDescriptor(tool, 'execute')?.configurable, true);
  assert.equal(typeof scoped.execute, 'function');
});
