import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { TopicRecoveryService } from '../src/topics/recovery.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';
import { readConversationSourceSnapshot } from '../src/search/source-snapshot.mjs';
import { createTopicSearchService } from '../src/search/service.mjs';
import { rebuildTopicSearchProjections } from '../src/search/rebuild.mjs';

test('relink commits binding and recovery together, replays after restart, and search navigates the effective Session', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-relink-owner-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true, notes: true } });
  const topicId = 'fictional-topic'; const referenceId = 'fictional-session';
  const sessionKey = 'agent:main:fictional-relinked'; const sessionId = 'fictional-relinked-id';
  const gateway = { async request(method, input) {
    if (method === 'sessions.list') return { sessions: [{ key: sessionKey, sessionId }] };
    if (method === 'sessions.describe') { assert.equal(input.key, sessionKey); return { session: { key: sessionKey, sessionId, displayName: 'Fictional' } }; }
    if (method === 'chat.history') { assert.equal(input.sessionKey, sessionKey); return { sessionKey, sessionId, messages: [{ id: 'fictional-message', role: 'user', content: 'alpha', createdAt: '2026-09-01T00:00:00.000Z' }], hasMore: false }; }
    throw new Error(`Unexpected fixture method ${method}`);
  } };
  try {
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, topicId, referenceId: 'fictional-folder', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: path.join(stateDir, 'fictional-notes'), observedRevision: null });
    metadata.createSourceReference({ version: 1, topicId, referenceId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-original', observedRevision: 'fictional-original-id' });
    metadata.setSessionState({ referenceId, sessionId: 'fictional-original-id', status: 'open', isPrimary: true });
    metadata.setSourceLocator({ referenceId, locator: 'agent:main:fictional-original', observedRevision: 'fictional-original-id', ownership: 'external' });
    const input = { topicId, referenceId, sessionKey, sessionId, expectedRevision: metadata.getTopic(topicId).revision, expectedSourceRevision: 'fictional-original-id', logicalOperationId: '99999999-1111-4111-8111-111111111111' };
    const before = metadata.getSourceLocator(referenceId);
    const interrupted = { ...metadata, completeTopicRecoveryMutation() { throw new Error('fixture completion interruption'); } };
    await assert.rejects(new TopicRecoveryService({ metadata: interrupted, gateway }).relink(input), /fixture completion interruption/);
    assert.deepEqual(metadata.getSourceLocator(referenceId), before, 'completion failure must not commit a detached binding');
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true, notes: true } });
    const recovery = new TopicRecoveryService({ metadata, gateway });
    const result = await recovery.relink(input);
    assert.deepEqual(await recovery.relink(input), result);
    assert.equal(metadata.getSourceReference(referenceId).externalSourceId, 'agent:main:fictional-original', 'identity must not be rewritten to a locator');
    assert.equal(metadata.getSourceLocator(referenceId).locator, sessionKey);
    const adapter = createSessionAdapter({ topicId, metadata, gateway });
    assert.equal((await adapter.navigate({ referenceId })).sessionKey, sessionKey);
    for (const useReader of [false, true]) {
      const snapshot = await readConversationSourceSnapshot({ topicId, metadata, gateway, ...(useReader ? { transcriptReader: async input => {
        assert.equal(input.sessionKey, sessionKey); assert.equal(input.sessionId, sessionId);
        return [{ entryId: 'fictional-message', createdAt: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'alpha' } }];
      } } : {}) });
      const row = snapshot.conversations[0];
      assert.equal(row.sessionKey, sessionKey); assert.equal(row.sourceReference.referenceId, referenceId);
      await rebuildTopicSearchProjections({ stateDir, metadata, topicId, authoritativeSources: { readTopicSnapshot: async () => ({ ...snapshot, notes: [] }) } });
      const search = createTopicSearchService({ stateDir, metadata, sourceService: { sessionsNavigate: input => adapter.navigate({ referenceId: input.referenceId }) } });
      const results = await search.query({ schemaVersion: 1, topicId, query: 'alpha', limit: 10 });
      assert.equal(results.conversations.results.length, 1);
      assert.equal((await search.navigate(results.conversations.results[0].navigation)).navigation.sessionKey, sessionKey);
      await assert.rejects(search.navigate({ ...results.conversations.results[0].navigation, sessionKey: 'agent:main:fictional-original' }), /stale|foreign/);
      search.close?.();
    }
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
