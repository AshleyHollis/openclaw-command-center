import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectTopicDiscoverability } from '../src/topics/discoverability.mjs';

const topics = [
  { topicId: 'fictional-project', lifecycle: 'active', paraCategory: 'project' },
  { topicId: 'fictional-area', lifecycle: 'active', paraCategory: 'area' }
];
const metadata = { listTopics: () => structuredClone(topics) };
const primary = topicId => ({ topicId, conversations: [{ referenceId: `${topicId}-primary`, status: 'open', isPrimary: true }] });

test('post-startup discoverability requires every active PARA Topic and one Primary Conversation', async () => {
  const result = await inspectTopicDiscoverability({ metadata,
    topics: { listDestinationVerified: async () => ({ activeGroups: { project: [topics[0]], area: [topics[1]], resource: [] }, recovery: [] }) },
    sources: { sessionsList: ({ topicId }) => primary(topicId) }
  });
  assert.deepEqual(result, { phase: 'healthy', schemaVersion: 1, activeTopics: 2, visibleTopics: 2, recoveryTopics: 0,
    recoveryBySourceKind: {}, primaryConversationsVerified: 2, primaryConversationsMissing: 0, widespreadIdentityFailure: false });
});

test('post-startup discoverability reports widespread Note identity recovery without hiding Topics', async () => {
  const recovering = topics.map(topic => ({ ...topic, recovery: [{ referenceId: `${topic.topicId}-folder`, sourceKind: 'note_folder', state: 'required' }] }));
  await assert.rejects(inspectTopicDiscoverability({ metadata,
    topics: { listDestinationVerified: async () => ({ activeGroups: { project: [], area: [], resource: [] }, recovery: recovering }) },
    sources: { sessionsList: ({ topicId }) => primary(topicId) }
  }), error => {
    assert.equal(error.code, 'topic-discoverability-unhealthy');
    assert.deepEqual(error.summary, { schemaVersion: 1, activeTopics: 2, visibleTopics: 2, recoveryTopics: 2,
      recoveryBySourceKind: { note_folder: 2 }, primaryConversationsVerified: 2, primaryConversationsMissing: 0, widespreadIdentityFailure: true });
    return true;
  });
});

test('post-startup discoverability treats an empty installation as healthy and ignores Archive recovery', async () => {
  const result = await inspectTopicDiscoverability({ metadata: { listTopics: () => [] },
    topics: { listDestinationVerified: async () => ({ activeGroups: { project: [], area: [], resource: [] }, recovery: [{ topicId: 'fictional-archive', lifecycle: 'active', paraCategory: 'archive', recovery: [{ referenceId: 'archive-folder', sourceKind: 'note_folder', state: 'required' }] }] }) },
    sources: { sessionsList: () => assert.fail('An empty installation has no Session source to inspect') }
  });
  assert.deepEqual(result, { phase: 'healthy', schemaVersion: 1, activeTopics: 0, visibleTopics: 0, recoveryTopics: 0,
    recoveryBySourceKind: {}, primaryConversationsVerified: 0, primaryConversationsMissing: 0, widespreadIdentityFailure: false });
});
