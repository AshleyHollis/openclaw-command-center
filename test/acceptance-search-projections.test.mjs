import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSearchProjectionEvidence, verifyCommittedSearchProjectionSet } from '../src/acceptance-search-projections.mjs';
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
        conversations: [],
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
    assert.deepEqual(verified.rowCounts, { notes: 0, conversations: 0 });
    assert.deepEqual(verified.topicRowCounts, { notes: { [topicId]: 0 }, conversations: { [topicId]: 0 } });
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
  } finally {
    metadata.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
