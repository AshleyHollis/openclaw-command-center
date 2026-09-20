import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { reconciliationPlanDigest } from '../src/migration/reconcile.mjs';
import { runConfiguredNoteFolderRecovery } from '../src/migration/reconcile-cli.mjs';
import { NOTE_FOLDER_IDENTITY_FILE, readNoteFolderIdentity, setHostFilesystemIdentityReader } from '../src/sources/note-folder-identity.mjs';
import { createHostFileAccessFixture } from './support/host-file-access-fixture.mjs';

const linux = process.platform === 'linux';
const physical = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

test('pinned Source Recovery migrates a v1 Folder identity to v2 and resumes an interrupted operation', { skip: !linux }, async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'folder-identity-migration-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const noteRoot = path.join(stateDirectory, 'Notes');
  const folder = path.join(noteRoot, 'Projects', 'Fictional Migration');
  await mkdir(folder, { recursive: true });
  const markerId = randomUUID();
  const markerPath = path.join(folder, NOTE_FOLDER_IDENTITY_FILE);
  await writeFile(markerPath, `${JSON.stringify({ version: 1, id: markerId })}\n`, { mode: 0o600 });
  const [directoryStat, markerStat] = await Promise.all([lstat(folder, { bigint: true }), lstat(markerPath, { bigint: true })]);
  const v1 = `note-folder:1:${markerId}:${createHash('sha256').update(`${physical(directoryStat)}:${physical(markerStat)}`).digest('hex')}`;
  const fileAccess = createHostFileAccessFixture();
  const releaseIdentity = setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  const v2 = await readNoteFolderIdentity(folder);
  releaseIdentity();
  assert.match(v2, /^note-folder:2:/u);

  const topicId = randomUUID(); const referenceId = `folder:${topicId}`; const sessionReferenceId = `session:${topicId}`;
  const metadata = openCommandCenterMetadataService({ stateDir: stateDirectory, capabilities: { notes: true, sessions: true } });
  metadata.createTopic({ topicId, name: 'Fictional Migration', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSourceReference({ version: 1, referenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
  metadata.setSourceLocator({ referenceId, locator: folder, ownership: 'external', observedRevision: v1 });
  metadata.createSourceReference({ version: 1, referenceId: sessionReferenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'agent:main:fictional-migration' });
  metadata.setSessionState({ referenceId: sessionReferenceId, sessionId: 'fictional-session', status: 'open', isPrimary: true });
  metadata.recordSourceRecovery({ recoveryId: `recovery:${referenceId}`, topicId, referenceId, sourceKind: 'note_folder', state: 'required', lastLocator: folder, lastIdentity: v1, failure: 'exact-folder-identity-mismatch', diagnostics: [], updatedAt: new Date().toISOString() });
  const topic = metadata.getTopic(topicId); const locator = metadata.getSourceLocator(referenceId); const logicalOperationId = randomUUID();
  const binding = { topicId, referenceId, mode: 'rebind', expectedRevision: topic.revision, expectedSourceRevision: v1, expectedLocatorVersion: locator.locatorVersion,
    logicalOperationId, replacementLocator: folder, expectedReplacementIdentity: v2 };
  metadata.recordTopicOperation({ logicalOperationId, topicId, operationKind: 'topics.recovery.verify', state: 'pending', currentStep: 'verify-exact-source', intent: {
    topicId, referenceId, expectedRevision: topic.revision, expectedSourceRevision: v1, expectedLocatorVersion: locator.locatorVersion, replacementLocator: folder, expectedReplacementIdentity: v2
  }, updatedAt: new Date().toISOString() });
  metadata.close();

  const plan = { schemaVersion: 1, purpose: 'command-center-note-folder-recovery', stateDirectory, bindings: [binding] };
  const planPath = path.join(stateDirectory, 'private-recovery-plan.json');
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const expectedDigest = reconciliationPlanDigest(plan);
  const config = { plugins: { entries: { 'command-center': { config: { topics: { noteRoot } } } } } };
  const preflight = await runConfiguredNoteFolderRecovery({ mode: 'preflight', planPath, expectedDigest, config, hostFileAccess: fileAccess });
  assert.equal(preflight.accounting.resumeReady, 1);
  const executed = await runConfiguredNoteFolderRecovery({ mode: 'execute', planPath, expectedDigest, config, hostFileAccess: fileAccess });
  assert.equal(executed.accounting.replayed, 1);
  assert.equal((await runConfiguredNoteFolderRecovery({ mode: 'verify', planPath, expectedDigest, config, hostFileAccess: fileAccess })).accounting.verified, 1);

  const verified = openCommandCenterMetadataService({ stateDir: stateDirectory, capabilities: { notes: true, sessions: true }, readOnly: true });
  try {
    assert.equal(verified.getSourceLocator(referenceId).observedRevision, v2);
    assert.equal(verified.getSourceReference(referenceId).topicId, topicId);
    assert.equal(verified.getSessionState(sessionReferenceId).sessionId, 'fictional-session');
    assert.equal(verified.listSourceRecovery(topicId).some(item => item.referenceId === referenceId && item.state === 'required'), false);
  } finally { verified.close(); }
});
