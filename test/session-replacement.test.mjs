import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createTopicService } from '../src/topics/service.mjs';
import { createSessionAdapter } from '../src/sources/sessions.mjs';
import { readConversationSourceSnapshot } from '../src/search/source-snapshot.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

for (const boundary of ['verified Topic', 'browse', 'search']) test(`Session replacement preserves ${boundary} with unavailable former history`, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-replacement-'));
  let metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const topicId = 'fictional-recovery-topic';
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    const old = { version: 1, topicId, referenceId: 'fictional-old-reference', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-old', observedRevision: 'fictional-old-id' };
    metadata.createSourceReference(old);
    metadata.setSessionState({ referenceId: old.referenceId, sessionId: 'fictional-old-id', status: 'open', isPrimary: true });
    const replacementRow = { key: 'agent:main:fictional-replacement', sessionId: 'fictional-new-id' };
    const gateway = { request: async (method) => { assert.equal(method, 'sessions.list'); return { sessions: [replacementRow] }; } };
    const sessionStore = { listSessionEntries: () => [{ sessionKey: replacementRow.key, entry: { sessionId: replacementRow.sessionId } }] };
    let topics = createTopicService({ metadata, gateway });
    const before = await invokeBridgeMethod({ topics }, 'command-center.v1.topics.get', { schemaVersion: 1, topicId });
    assert.equal(before.topic.usable, false);
    assert.equal(before.topic.health, 'source-recovery');
    const replaced = await topics.recoveryReplace({ topicId, referenceId: old.referenceId, sessionKey: replacementRow.key, sessionId: replacementRow.sessionId, expectedRevision: before.topic.revision, expectedSourceRevision: 'fictional-old-id', logicalOperationId: randomUUID() });
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
    topics = createTopicService({ metadata, gateway });
    if (boundary === 'verified Topic') {
      const after = await invokeBridgeMethod({ topics }, 'command-center.v1.topics.get', { schemaVersion: 1, topicId });
      assert.equal(after.topic.usable, true);
      assert.equal(after.topic.recovery[0].state, 'replaced');
    } else if (boundary === 'browse') {
      const adapter = createSessionAdapter({ metadata, topicId, gateway, sessionStore });
      const listed = await adapter.list();
      assert.equal(listed.conversations.find((row) => row.referenceId === old.referenceId).availability, 'replaced-unavailable');
      assert.equal(listed.conversations.find((row) => row.isPrimary).referenceId, replaced.replacementReferenceId);
      const unproven = createSessionAdapter({ metadata: { ...metadata, listTopicOperations: () => [] }, topicId, gateway, sessionStore });
      await assert.rejects(unproven.list(), /missing or replaced/, 'missing authority without an applied replacement remains fatal');
      const publicRows = await invokeBridgeMethod({ sessionsList: async () => listed }, 'command-center.v1.sessions.browse', { schemaVersion: 1, topicId });
      assert.equal(publicRows.conversations.find((row) => row.referenceId === old.referenceId).availability, 'replaced-unavailable');
      await assert.rejects(adapter.navigate({ referenceId: old.referenceId }), /missing or replaced/);
      await assert.rejects(adapter.history({ referenceId: old.referenceId }), /missing or replaced/);
      await assert.rejects(adapter.send({ referenceId: old.referenceId, logicalOperationId: randomUUID(), message: 'must not dispatch' }), /missing or replaced/);
      sessionStore.listSessionEntries = () => [
        ...Array.from({ length: 120 }, (_, index) => ({ sessionKey: `unlinked-${index}`, entry: { sessionId: `unlinked-id-${index}` } })),
        { sessionKey: replacementRow.key, entry: { sessionId: replacementRow.sessionId } },
        { sessionKey: old.externalSourceId, entry: { sessionId: 'fictional-old-id', archived: true } }
      ];
      const restored = await adapter.list();
      assert.equal(restored.conversations.find((row) => row.referenceId === old.referenceId).availability, undefined, 'exact restored history after 100 catalog rows is not falsely unavailable');
    } else {
      const snapshot = await readConversationSourceSnapshot({ metadata, topicId, gateway, api: { runtime: { agent: { session: sessionStore } } }, transcriptReader: async ({ sessionKey }) => {
        assert.equal(sessionKey, replacementRow.key, 'never synthesize empty history for a deleted Session');
        return [];
      } });
      assert.deepEqual(snapshot.conversations.map((row) => row.sourceReference.referenceId), [replaced.replacementReferenceId]);
      const fallback = await readConversationSourceSnapshot({ metadata, topicId, gateway, transcriptReader: async () => [] });
      assert.equal(fallback.conversations.length, 2, 'without a complete catalog, a filtered Gateway listing cannot suppress restored history');
    }
    assert.equal(metadata.getSourceReference(old.referenceId).externalSourceId, old.externalSourceId);
    assert.equal(metadata.getSessionState(old.referenceId).isPrimary, false);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});
