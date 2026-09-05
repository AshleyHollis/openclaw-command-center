import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSearchProjectionEvidence, COMMITTED_SEARCH_PROJECTION_FILES, verifyCommittedSearchProjectionSet, verifyMissingSearchProjectionSet } from '../src/acceptance-search-projections.mjs';
import { resolveCommandCenterDatabasePath, resolveCommandCenterProjectionRoot } from '../src/metadata/path.mjs';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { publishTopicSearchSnapshot } from '../src/search/rebuild.mjs';

const topicId = '11111111-1111-4111-8111-111111111111';

test('committed projection evidence verifies artifacts, bookkeeping, and Topic coverage', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-acceptance-search-'));
  const metadata = openCommandCenterMetadataService({ stateDir });
  try {
    metadata.createTopic({ topicId, paraCategory: 'project', lifecycle: 'active' });
    await publishTopicSearchSnapshot({
      stateDir,
      metadata,
      prepared: {
        topicIds: [topicId],
        notes: [],
        conversations: [
          { topicId, sourceReference: { version: 1, referenceId: 'fictional-message-session', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-message-session', observedRevision: null }, sessionKey: 'agent:main:fictional-message-session', sessionId: 'fictional-message-session', messageId: 'fictional-message', name: 'Fictional message Conversation', date: '2026-08-22T00:00:00.000Z', role: 'user', text: 'Fictional message content', primaryState: 'ordinary', closed: false, provenance: 'native' },
          { topicId, sourceReference: { version: 1, referenceId: 'fictional-empty-session', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-empty-session', observedRevision: null }, sessionKey: 'agent:main:fictional-empty-session', sessionId: 'fictional-empty-session', messageId: null, name: 'Fictional empty Conversation', date: '2026-08-22T00:00:00.000Z', role: 'metadata', text: 'Fictional empty Conversation', primaryState: 'ordinary', closed: false, provenance: 'native' }
        ],
        noteSourceRevision: 'fictional-notes-v1',
        conversationSourceRevision: 'fictional-conversations-v1'
      }
    });

    const options = {
      projectionRoot: resolveCommandCenterProjectionRoot(stateDir),
      metadataDatabasePath: resolveCommandCenterDatabasePath(stateDir),
      requiredTopicIds: [topicId]
    };
    const verified = verifyCommittedSearchProjectionSet(options);
    assert.deepEqual(verified.topicIds, [topicId]);
    assert.deepEqual(verified.rowCounts, { notes: 0, conversations: 2, conversationMessages: 1, conversationMetadata: 1 });
    assert.deepEqual(verified.topicRowCounts, { notes: { [topicId]: 0 }, conversations: { [topicId]: 2 }, conversationMessages: { [topicId]: 1 }, conversationMetadata: { [topicId]: 1 } });
    const captured = captureSearchProjectionEvidence(options);
    assert.equal(Object.keys(captured.artifacts).length, 6);
    assert.equal(captured.bookkeeping.length, 2);

    const publicationMarker = path.join(options.projectionRoot, '.projections.group-publication.json');
    await writeFile(publicationMarker, `${JSON.stringify({ schemaVersion: 1, existing: [] })}\n`);
    assert.throws(() => verifyCommittedSearchProjectionSet(options), /grouped publication/iu);
    await unlink(publicationMarker);

    const manifestPath = path.join(options.projectionRoot, 'topic-search-notes.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, generation: 'fictional-corrupt-generation' })}\n`);
    assert.throws(() => verifyCommittedSearchProjectionSet(options), /generation|committed projection/iu);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    const commitPath = path.join(options.projectionRoot, 'topic-search-notes.commit.json');
    const commit = JSON.parse(await readFile(commitPath, 'utf8'));
    await writeFile(commitPath, `${JSON.stringify({ ...commit, databaseDigest: `sha256:${'0'.repeat(64)}` })}\n`);
    assert.throws(() => verifyCommittedSearchProjectionSet(options), /digest|committed projection/iu);
    await writeFile(commitPath, `${JSON.stringify(commit)}\n`);

    metadata.setProjectionBookkeeping({ projectionId: 'topic-search-notes', sourceRevision: 'invalidated', inputDigest: 'invalidated' });
    assert.throws(() => verifyCommittedSearchProjectionSet(options), /bookkeeping|committed projection/iu);

    const retainedReceipt = path.join(options.projectionRoot, 'rebuild-operation-fictional.json');
    await writeFile(retainedReceipt, '{"state":"applied"}\n');
    await writeFile(path.join(options.projectionRoot, '.topic-search.invalidated.json'), '{"state":"invalidated"}\n');
    const beforeMissing = captureSearchProjectionEvidence(options);
    assert.throws(() => verifyMissingSearchProjectionSet(options, beforeMissing), /must all be absent/);
    for (const name of COMMITTED_SEARCH_PROJECTION_FILES) await unlink(path.join(options.projectionRoot, name));
    assert.equal(Object.keys(verifyMissingSearchProjectionSet(options, beforeMissing).artifacts).length, 2);
    await writeFile(retainedReceipt, '{"state":"changed"}\n');
    assert.throws(() => verifyMissingSearchProjectionSet(options, beforeMissing), /preserve durable records/);
  } finally {
    metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
