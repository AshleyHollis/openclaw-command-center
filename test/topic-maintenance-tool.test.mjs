import assert from 'node:assert/strict';
import test from 'node:test';
import { topicNoteMaintenanceToolFactory } from '../src/maintenance/tool.mjs';
import { isCanonicalUuid } from '../src/sources/operation-journal.mjs';

test('native maintenance tool derives the exact Topic and Note from its active Conversation', async () => {
  const reference = { version: 1, referenceId: 'note:working', topicId: 'topic-a', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/working.md', observedRevision: 'sha256:before' };
  const calls = [];
  const sourceService = {
    sessionTopicContext: async () => ({ status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' }),
    notesBrowse: async () => ({ notes: [{ path: 'working.md', revision: 'sha256:before', sourceReference: reference }] }),
    notesRead: async () => ({ path: 'working.md', revision: 'sha256:before', sourceReference: reference }),
    notesEdit: async input => (calls.push(input), { status: 'applied', value: { revision: 'sha256:after' } })
  };
  const metadata = { getSourceReference: id => id === reference.referenceId ? reference : null, recordActivity: value => value };
  const tool = topicNoteMaintenanceToolFactory({ getOwners: () => ({ sourceService, metadata }) })({ sessionKey: 'agent:main:a', sessionId: 'native-a' });
  const result = await tool.execute('f05b97c0-307a-48d8-a704-6b9f71ac86d0', { path: 'working.md', text: 'Updated working facts' });
  assert.equal(calls.length, 1); assert.equal(calls[0].topicId, 'topic-a'); assert.equal(calls[0].referenceId, 'note:working'); assert.equal(calls[0].expectedRevision, 'sha256:before'); assert.equal(result.details.status, 'applied');
});

test('native maintenance tool delegates a missing working Note to the exact Topic absence-precondition owner', async () => {
  const calls = [];
  const sourceService = {
    sessionTopicContext: async () => ({ status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' }),
    notesBrowse: async () => ({ notes: [] }),
    notesCreate: async input => (calls.push(input), { status: 'applied', value: { note: { revision: 'sha256:created' } } })
  };
  const tool = topicNoteMaintenanceToolFactory({ getOwners: () => ({ sourceService, metadata: { recordActivity: value => value } }) })({ sessionKey: 'agent:main:a', sessionId: 'native-a' });
  const result = await tool.execute('3c6aa381-810b-4528-af3d-603f48814f34', { path: 'working.md', text: 'new facts' });
  assert.equal(calls.length, 1); assert.equal(calls[0].topicId, 'topic-a'); assert.equal(calls[0].path, 'working.md'); assert.equal(calls[0].sourceKind, 'note'); assert.equal(result.details.status, 'applied');
});

test('native maintenance separates an opaque host tool-call ID from its stable durable operation ID', async () => {
  const calls = [];
  const sourceService = {
    sessionTopicContext: async () => ({ status: 'bound', topicId: 'topic-a', referenceId: 'session:a', sessionKey: 'agent:main:a', sessionId: 'native-a' }),
    notesBrowse: async () => ({ notes: [] }),
    notesCreate: async input => (calls.push(input), { status: 'applied', value: { note: { revision: 'sha256:created' } } })
  };
  const tool = topicNoteMaintenanceToolFactory({ getOwners: () => ({ sourceService, metadata: { recordActivity: value => value } }) })({ sessionKey: 'agent:main:a', sessionId: 'native-a' });
  await tool.execute('callfixturefictional2', { path: 'working.md', text: 'new facts' });
  await tool.execute('callfixturefictional2', { path: 'working.md', text: 'new facts' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, 'callfixturefictional2');
  assert.ok(isCanonicalUuid(calls[0].logicalOperationId));
  assert.equal(calls[1].logicalOperationId, calls[0].logicalOperationId, 'a replay of one native tool call must retain its durable operation identity');
});

test('model maintenance tool permits the host scoped-tool proxy to wrap execution', () => {
  const tool = topicNoteMaintenanceToolFactory({ getOwners: () => ({ sourceService: {}, metadata: {} }) })({ sessionKey: 'agent:main:fictional' });
  const scoped = new Proxy(tool, { get(target, property, receiver) {
    if (property === 'execute') return (...input) => Reflect.apply(target.execute, target, input);
    return Reflect.get(target, property, receiver);
  } });
  assert.equal(Object.getOwnPropertyDescriptor(tool, 'execute')?.configurable, true);
  assert.equal(typeof scoped.execute, 'function');
});
