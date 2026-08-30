import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicContextPolicy } from '../src/search/context.mjs';
import { topicContextToolFactory } from '../src/search/tool.mjs';

const currentTopic = { topicId: 'topic-one', paraCategory: 'project' };
const otherTopic = { topicId: 'topic-two', paraCategory: 'area' };
const currentSession = { referenceId: 'session:one', topicId: 'topic-one', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:one' };
const otherSession = { referenceId: 'session:two', topicId: 'topic-two', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:two' };
const metadata = {
  listSourceReferences: () => [currentSession, otherSession],
  getTopic: (id) => id === currentTopic.topicId ? currentTopic : id === otherTopic.topicId ? otherTopic : null,
  getPresentationPreferences: (id) => ({ displayLabel: id === 'topic-one' ? 'Current Topic' : 'Other Topic' })
};
const searchService = { query: async ({ topicId }) => ({
  notes: { results: [{ topicId, provenance: 'native', sourceReference: { referenceId: `note:${topicId}`, topicId, sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/private/topic-folder/one.md' }, heading: 'Heading', path: 'one.md', snippet: 'note excerpt', navigation: { kind: 'note', topicId, referenceId: `note:${topicId}`, path: 'one.md', heading: 'Heading', observedRevision: 'sha256:one' } }] },
  conversations: { results: [{ topicId, provenance: 'imported', sourceReference: { referenceId: `session:${topicId}` }, conversationName: 'Chat', sessionKey: 'agent:main:one', snippet: 'conversation excerpt' }] }
}) };

test('on-demand context binds only the trusted current Session Topic and stays bounded', async () => {
  const policy = createTopicContextPolicy({ metadata, searchService });
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId });
  assert.deepEqual(result.currentTopic, { topicId: 'topic-one', displayLabel: 'Current Topic', paraCategory: 'project' });
  assert.deepEqual(result.originatingTopic, result.currentTopic);
  assert.equal(result.selectionBasis, 'current-topic');
  assert.deepEqual(result.projectionVersions, {
    notes: { projectionId: 'topic-search-notes', formatVersion: 1 },
    conversations: { projectionId: 'topic-search-conversations', formatVersion: 1 }
  });
  assert.equal('query' in result, false);
  assert.equal(result.groups.notes.length + result.groups.conversations.length, 2);
  assert.deepEqual(result.groups.notes[0].navigation, { kind: 'note', topicId: 'topic-one', referenceId: 'note:topic-one', path: 'one.md', heading: 'Heading', observedRevision: 'sha256:one' });
  assert.doesNotMatch(JSON.stringify(result), /\/fictional\/private\/topic-folder/u);
  assert.ok(result.groups.notes.length + result.groups.conversations.length <= 8);
  assert.ok([...result.groups.notes, ...result.groups.conversations].every((item) => Array.from(item.excerpt).length <= 320));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024);
  await assert.rejects(() => policy.retrieve({ query: 'fictional', sessionKey: 'unlinked-session' }), /exactly one current Topic/i);
  assert.equal('beforePromptBuild' in policy, false);
});

test('cross-Topic context requires a closed basis and bounded rationale and preserves origin labels', async () => {
  const policy = createTopicContextPolicy({ metadata, searchService });
  await assert.rejects(() => policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId, targetTopicId: 'topic-two' }), /Cross-Topic/i);
  await assert.rejects(() => policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId, crossTopicBasis: 'explicit-reference' }), /only for a different Topic/i);
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId, targetTopicId: 'topic-two', crossTopicBasis: 'explicit-reference' });
  assert.deepEqual(result.currentTopic, { topicId: 'topic-one', displayLabel: 'Current Topic', paraCategory: 'project' });
  assert.deepEqual(result.originatingTopic, result.currentTopic);
  assert.deepEqual(result.retrievedTopic, { topicId: 'topic-two', displayLabel: 'Other Topic', paraCategory: 'area' });
  assert.equal(result.crossTopic, true);
  assert.equal(result.selectionBasis, 'explicit-reference');
  assert.equal(result.groups.notes[0].originatingTopic.displayLabel, 'Other Topic');
  const tool = topicContextToolFactory(policy)({ sessionKey: currentSession.externalSourceId });
  assert.equal(tool.name, 'command_center_topic_context');
  assert.deepEqual(Object.keys(tool.parameters.properties), ['query', 'targetTopicId', 'crossTopicBasis', 'limit']);
  assert.equal(tool.parameters.additionalProperties, false);
  const response = await tool.execute('call', { query: 'fictional' });
  assert.match(response.content[0].text, /topic-one/);
  assert.ok(Buffer.byteLength(response.content[0].text) <= 12 * 1024);
  assert.doesNotMatch(response.content[0].text, /\/fictional\/private\/topic-folder/u);
  assert.equal((await tool.execute('call', { query: 'fictional' })).details.groups.notes.length, 1);
  assert.equal((await tool.execute('call', { query: 'fictional', limit: 1 })).details.groups.notes.length + (await tool.execute('call', { query: 'fictional', limit: 1 })).details.groups.conversations.length, 1);
});

test('conversation excerpts preserve an authoritative originating Topic label', async () => {
  const policy = createTopicContextPolicy({ metadata, searchService: { query: async () => ({
    notes: { results: [] },
    conversations: { results: [{ sourceReference: { referenceId: 'session:imported' }, conversationName: 'Imported', snippet: 'imported excerpt', originatingTopicId: otherTopic.topicId }] }
  }) } });
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId });
  assert.equal(result.groups.conversations[0].originatingTopic.topicId, otherTopic.topicId);
  assert.equal(result.groups.conversations[0].originatingTopic.displayLabel, 'Other Topic');
});

test('query bounds count UTF-16 code units', async () => {
  const query = '😀'.repeat(128);
  const policy = createTopicContextPolicy({ metadata, searchService });
  await assert.doesNotReject(policy.retrieve({ query, sessionKey: currentSession.externalSourceId }));
  await assert.rejects(policy.retrieve({ query: `${query}😀`, sessionKey: currentSession.externalSourceId }), /256/);
});

test('context returns at most eight results, 320 code points each, and 2,560 total', async () => {
  const many = Array.from({ length: 4 }, (_, index) => ({ topicId: 'topic-one', provenance: 'native', sourceReference: { referenceId: `note:${index}` }, heading: `Note ${index}`, path: `${index}.md`, snippet: `${'n'.repeat(700)} ${index}` }));
  const policy = createTopicContextPolicy({ metadata, searchService: { query: async () => ({ notes: { results: many }, conversations: { results: many.map((item, index) => ({ ...item, sourceReference: { referenceId: `session:${index}` }, conversationName: `Conversation ${index}` })) } }) } });
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId });
  assert.equal(result.groups.notes.length + result.groups.conversations.length, 8);
  assert.ok([...result.groups.notes, ...result.groups.conversations].every((item) => Array.from(item.excerpt).length <= 320));
  assert.ok([...result.groups.notes, ...result.groups.conversations].reduce((total, item) => total + Array.from(item.excerpt).length, 0) <= 2_560);
  assert.deepEqual(result.truncation, { notes: false, conversations: false });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024);
});

test('context redacts credential-shaped values from every excerpt field', async () => {
  const raw = {
    authorization: ['fictional', 'access', 'credential'].join('.'),
    provider: ['ghp', 'fictionalCredential12345'].join('_'),
    json: ['fictional', 'json', 'secret', '123'].join('-'),
    cookie: ['fictional', 'cookie', 'value'].join('-'),
    url: ['fictional', 'url', 'password'].join('-'),
    label: ['fictional', 'label', 'secret'].join('-')
  };
  const fixtures = {
    contextBefore: `Authorization: ${['Bear', 'er'].join('')} ${raw.authorization}\nGITHUB_${['TO', 'KEN'].join('')}=${raw.provider}`,
    snippet: `{${JSON.stringify(['client', 'secret'].join('_'))}:${JSON.stringify(raw.json)}}`,
    contextAfter: `${['Cook', 'ie'].join('')}: session=${raw.cookie}\n{${JSON.stringify('cookie')}:${JSON.stringify(raw.cookie)}}`
  };
  const policy = createTopicContextPolicy({ metadata, searchService: { query: async () => ({
    notes: { results: [{ sourceReference: { referenceId: 'note:redacted' }, heading: `${['pass', 'word'].join('')}=${raw.label}`, path: 'sanitized.md', navigation: { kind: 'note', topicId: 'topic-one', referenceId: 'note:redacted', path: 'sanitized.md', heading: `${['pass', 'word'].join('')}=${raw.label}`, observedRevision: null }, ...fixtures }] },
    conversations: { results: [{ sourceReference: { referenceId: 'session:redacted' }, conversationName: 'Sanitized conversation', provenance: 'native', snippet: `https://fictional:${raw.url}@example.invalid/private` }] }
  }) } });
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId });
  const toolResult = await topicContextToolFactory(policy)({ sessionKey: currentSession.externalSourceId }).execute('redaction-check', { query: 'fictional' });
  const serialized = JSON.stringify({ result, content: toolResult.content, details: toolResult.details });
  for (const value of Object.values(raw)) assert.equal(serialized.includes(value), false);
  assert.ok([...result.groups.notes, ...result.groups.conversations].every((item) => item.excerpt.includes('[REDACTED CREDENTIAL]')));
});

test('context redacts natural-language credentials from prompt identity and both result groups', async () => {
  const values = {
    display: 'FictionalHorseBattery77',
    note: '!FictionalNoteCredential88',
    conversation: 'Fictional Conversation Credential 99'
  };
  const qualified = (label, value) => `The deployment ${label} for staging\n${['i', 's:'].join('')} ${value}.`;
  const multiline = (label, value) => `The deployment ${label} ${['i', 's:'].join('')}\n\`${value}\`.`;
  const proseMetadata = {
    ...metadata,
    getPresentationPreferences: (id) => ({ displayLabel: id === currentTopic.topicId ? qualified(['pass', 'word'].join(''), values.display) : 'Other Topic' })
  };
  const policy = createTopicContextPolicy({ metadata: proseMetadata, searchService: { query: async () => ({
    notes: { results: [{ sourceReference: { referenceId: 'note:prose' }, heading: 'Deployment Note', path: 'deployment.md', contextBefore: 'The deployment passcode for staging', snippet: `${['i', 's:'].join('')}\n\`${values.note}\`` }] },
    conversations: { results: [{ sourceReference: { referenceId: 'session:prose' }, conversationName: 'Deployment Conversation', provenance: 'native', snippet: multiline(['secret', 'phrase'].join(' '), values.conversation) }] }
  }) } });
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId });
  const serialized = JSON.stringify({ result });
  for (const value of Object.values(values)) assert.equal(serialized.includes(value), false);
  assert.ok(result.groups.notes[0].excerpt.includes('[REDACTED CREDENTIAL]'));
  assert.ok(result.groups.conversations[0].excerpt.includes('[REDACTED CREDENTIAL]'));
});

test('context never echoes a credential-shaped retrieval query into model-visible tool output', async () => {
  const credential = ['sk', 'fictionalQueryCredential123456'].join('-');
  const query = ['token', credential].join('=');
  const observedQueries = [];
  const policy = createTopicContextPolicy({ metadata, searchService: {
    query: async (input) => {
      observedQueries.push(input.query);
      return { notes: { results: [] }, conversations: { results: [] } };
    }
  } });
  const toolResult = await topicContextToolFactory(policy)({ sessionKey: currentSession.externalSourceId }).execute('credential-query', { query });
  assert.deepEqual(observedQueries, [query]);
  assert.equal(JSON.stringify(toolResult.content).includes(credential), false);
  assert.equal(JSON.stringify(toolResult.details).includes(credential), false);
  assert.equal('query' in toolResult.details, false);
});

test('context size fitting converges for oversized presentation metadata', async () => {
  const oversizedMetadata = {
    ...metadata,
    getPresentationPreferences: () => ({ displayLabel: 'F'.repeat(8_000) })
  };
  const oversizedSearch = {
    query: async ({ topicId }) => ({
      notes: { results: [{ topicId, provenance: 'native', sourceReference: { referenceId: `note:${topicId}` }, heading: 'H'.repeat(8_000), path: 'one.md', snippet: 'S'.repeat(8_000) }] },
      conversations: { results: [] }
    })
  };
  const policy = createTopicContextPolicy({ metadata: oversizedMetadata, searchService: oversizedSearch });
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024);
  assert.ok(result.originatingTopic.displayLabel.length <= 256);
});

test('on-demand context fails closed when its exact Topic projection is unavailable', async () => {
  const policy = createTopicContextPolicy({ metadata, searchService: { query: async () => { throw Object.assign(new Error('missing Topic projection'), { code: 'capability-unavailable' }); } } });
  await assert.rejects(
    policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId, targetTopicId: otherTopic.topicId, crossTopicBasis: 'task-necessity' }),
    (error) => error.code === 'capability-unavailable'
  );
});

test('task-necessity requires a closed observable reason', async () => {
  const policy = createTopicContextPolicy({ metadata, searchService });
  await assert.rejects(
    policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId, targetTopicId: otherTopic.topicId }),
    /basis/i
  );
  await assert.rejects(
    topicContextToolFactory(policy)({ sessionKey: currentSession.externalSourceId }).execute('call', { query: 'fictional', targetTopicId: otherTopic.topicId, crossTopicBasis: 'other' }),
    /unsupported/i
  );
  const result = await policy.retrieve({ query: 'fictional', sessionKey: currentSession.externalSourceId, targetTopicId: otherTopic.topicId, crossTopicBasis: 'task-necessity' });
  assert.equal(result.selectionBasis, 'task-necessity');
});
