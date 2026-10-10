import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, lstat, realpath, mkdtemp, rm, cp, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readBuiltReceipt, distRoot } from '../../src/build.mjs';
import { verifyPluginArtifact } from '../../src/plugin-artifact.mjs';
import { parseHostDescriptor, verifyHost, launchPinnedHost, restartPinnedHost, stopPinnedHost, waitForConsecutiveReadiness, assertRecordedChildTraffic } from '../../src/host-harness.mjs';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { prepareTopicSearchSnapshot, publishTopicSearchSnapshot } from '../../src/search/rebuild.mjs';
import { readNativeNote } from '../../src/native-ui/note-read.mjs';
import { loadTopicCatalog } from '../../src/native-ui/topic-catalog.mjs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { TrafficGuard } from '../../src/isolation.mjs';
import { assertFastHostAdmission, assertCandidatePluginPermissions } from './isolated-acceptance-preflight.mjs';
import { seedNativeExistingTopic, seedNativeResourceTopic } from './first-live-native-journey.mjs';
import { readAttentionStartupReadiness, readAttentionControlUiBuildId } from './attention-startup-readiness.mjs';
import { createGatewayDeviceIdentity, requestAuthenticatedGateway, launchManagedBrowser, closeManagedBrowser, configureEvidencePage } from './real-host-runtime.mjs';
import { runInstalledNoteProposalRpcJourney, verifyInstalledRecallEvidence, assertNotesQualificationReceipt, runInstalledNoteProposalNegatives } from './notes-installed-journey.mjs';
import { startFictionalOpenAiModel } from './fictional-openai-model.mjs';
import { configureNotesRecallModel, collectRecallDiagnostics, recordRecallNativeEvent, waitForRecallObservation, summarizeRecallFailure } from './notes-recall-diagnostics.mjs';

// Explicit disposable-host qualification only. No top-level launch or live lookup.
export async function runNotesInstalledPackageJourney({ signal } = {}) {
  const mode = process.env.COMMAND_CENTER_NOTES_INSTALLED_MODE;
  assert.ok(['proposals', 'recall'].includes(mode));
  const descriptor = parseHostDescriptor();
  await assertFastHostAdmission(descriptor); await verifyHost(descriptor);
  const archivePath = process.env.COMMAND_CENTER_NOTES_TEST_ARCHIVE;
  const receiptPath = process.env.COMMAND_CENTER_NOTES_TEST_RECEIPT;
  const admissionRoot = process.env.COMMAND_CENTER_NOTES_ADMISSION_ROOT;
  for (const value of [archivePath, receiptPath, admissionRoot]) assert.ok(value && path.isAbsolute(value));
  assert.equal(await realpath(admissionRoot), path.resolve(admissionRoot));
  const stat = await lstat(admissionRoot);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o700);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const identities = JSON.parse(await readFile(new URL('../fixtures/notes-qualification-artifacts.json', import.meta.url), 'utf8'));
  const expected = identities.candidates[mode]; assertNotesQualificationReceipt(receipt, expected);
  assert.equal(identities.nativeCommit, descriptor.commit);
  const evidencePath = process.env.COMMAND_CENTER_NOTES_EVIDENCE_PATH;
  assert.ok(evidencePath && path.isAbsolute(evidencePath));
  assert.equal(path.dirname(evidencePath), admissionRoot);
  assert.equal(await lstat(evidencePath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
  const declaredFixtureRevision = process.env.COMMAND_CENTER_NOTES_FIXTURE_REVISION;
  assert.match(declaredFixtureRevision ?? '', /^[a-f0-9]{40}$/u);
  const fixtureInputs = {};
  for (const name of ['test/support/notes-installed-package-journey.mjs', 'test/support/notes-installed-journey.mjs',
    'test/support/fictional-openai-model.mjs', 'test/support/notes-recall-diagnostics.mjs', 'test/support/first-live-native-journey.mjs', 'test/support/real-host-runtime.mjs',
    'test/support/attention-startup-readiness.mjs', 'test/support/isolated-acceptance-preflight.mjs',
    'test/fixtures/notes-qualification-artifacts.json', 'src/host-harness.mjs', 'src/fixtures.mjs', 'src/build.mjs',
    'src/plugin-artifact.mjs', 'package-lock.json']) {
    fixtureInputs[name] = createHash('sha256').update(await readFile(new URL(`../../${name}`, import.meta.url))).digest('hex');
  }
  const cases = [];
  const report = { schemaVersion: 1, status: 'failed', mode, candidate: expected, nativeCommit: descriptor.commit,
    hostIntegrity: descriptor.integrity, declaredFixtureRevision, fixtureInputs, cases,
    productionActivationAllowed: false };
  let stagedDist;
  const admission = await mkdtemp(path.join(admissionRoot, 'notes-test-admission-'));
  try {
    const candidateRoot = await verifyPluginArtifact({ archivePath, expectedReceipt: receipt, destinationDirectory: path.join(admission, 'candidate') });
    await assertCandidatePluginPermissions(candidateRoot);
    // Reuse the audited dist; never rebuild or replace an existing checkout tree.
    try {
      await mkdir(distRoot); stagedDist = await lstat(distRoot);
      const candidateDist = path.join(candidateRoot, 'dist');
      for (const name of await readdir(candidateDist)) {
        await cp(path.join(candidateDist, name), path.join(distRoot, name), { recursive: true, force: false, errorOnExist: true });
      }
    } catch (error) { if (error.code !== 'EEXIST' || stagedDist) throw error; }
    const buildReceipt = await readBuiltReceipt(); assert.equal(buildReceipt.digest, expected.buildDigest);
    const { FIRST_LIVE_FEATURES } = await import(pathToFileURL(path.join(candidateRoot, 'dist/release-scope.mjs')).href);
    assert.equal(FIRST_LIVE_FEATURES.noteProposals, true);
    assert.equal(FIRST_LIVE_FEATURES.topicNoteRecall, mode === 'recall');
    for (const flag of ['acceptedChatCapture', 'search', 'noteWrite', 'noteMaintenance']) assert.equal(FIRST_LIVE_FEATURES[flag], false);
    const packagedManifest = JSON.parse(await readFile(path.join(candidateRoot, 'dist/plugin-manifest.json'), 'utf8'));
    assert.equal(packagedManifest.contracts.tools.includes('command_center_recall_topic_notes'), mode === 'recall');
    cases.push('immutable-archive-and-build-verified');

    await withIsolatedWorld(async world => {
      const provider = mode === 'recall' ? await startFictionalOpenAiModel({ noteRecall: true }) : null;
      const nativeEvents = [];
      const progress = { phase: 'gateway-ui-readiness', successfulReadinessChecks: 0 };
      let host, managed, transport, controlUiBuildId;
      const guard = new TrafficGuard(); const evidence = { requests: [], responses: [], console: [], errors: [] };
      const deviceIdentity = createGatewayDeviceIdentity();
      const ready = async () => {
        progress.phase = 'gateway-ui-readiness';
        await waitForConsecutiveReadiness(() => readAttentionStartupReadiness({ world, signal }), host.earlyExit, { deadlineMs: 120_000, delayMs: 100, signal });
        controlUiBuildId = await readAttentionControlUiBuildId({ world, signal });
        progress.successfulReadinessChecks += 1;
      };
      const recallWait = async (phase, observe, deadlineMs = 120_000) => {
        progress.phase = phase;
        await waitForRecallObservation(waitForConsecutiveReadiness, observe, host.earlyExit,
          { phase, deadlineMs, delayMs: 100, signal });
        progress.phase = `${phase}-observed`;
      };
      const request = async (method, params, scopes) => {
        signal.throwIfAborted();
        return requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method, params,
          scopes, deviceIdentity, controlUiBuildId, signal, responseTimeoutMs: 30_000 });
      };
      const rpc = (method, params) => request(method, params, ['operator.read', 'operator.write']);
      const readOnlyRpc = (method, params) => request(method, params, ['operator.read']);
      try {
      if (provider) {
        const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
        configureNotesRecallModel(config, provider.baseUrl);
        await writeFile(world.manifest.configPath, JSON.stringify(config));
      }
        host = await launchPinnedHost({ descriptor, world, buildReceipt, signal }); await ready();
        const topic = await seedNativeExistingTopic({ world, host, signal });
        const foreign = await seedNativeResourceTopic({ world, signal });
        await mkdir(path.join(topic.folder, 'nested'), { recursive: true });
        await writeFile(path.join(topic.folder, 'shared.md'), '# Shared\nalpha fictional shared observation.\n', { flag: 'wx' });
        await writeFile(path.join(topic.folder, 'nested/source.md'), '# Nested\nalpha fictional nested observation.\n', { flag: 'wx' });
        await mkdir(path.join(foreign.folder, 'nested'), { recursive: true });
        await writeFile(path.join(foreign.folder, 'foreign.md'), '# Foreign\nalpha matching foreign root evidence.\n', { flag: 'wx' });
        await writeFile(path.join(foreign.folder, 'nested/foreign.md'), '# Foreign nested\nalpha matching foreign nested evidence.\n', { flag: 'wx' });
        const catalog = await loadTopicCatalog({ request: rpc, topicId: topic.topicId, current: () => !signal.aborted, validate() {}, maxEntries: 300 });
        const pointers = catalog.notes.map(row => ({ referenceId: row.sourceReference.referenceId, path: row.path, revision: row.revision }));
        const target = pointers.find(row => row.path === topic.notePath);
        const sources = pointers.filter(row => ['shared.md', 'nested/source.md'].includes(row.path));
        assert.ok(target); assert.equal(sources.length, 2);
        const reply = await rpc('command-center.v1.topics.get', { schemaVersion: 1, topicId: topic.topicId });
        await runInstalledNoteProposalRpcJourney({ rpc, request: { topicId: topic.topicId, expectedTopicRevision: (reply.result ?? reply).topic.revision, target, sources,
          panel: { sessionKey: topic.sessionKey, sessionId: topic.sessionId, referenceId: topic.sessionReferenceId } },
          proposedText: `${topic.noteText}\nFictional operator-staged comparison only.\n`,
          readNoteBytes: pointer => readFile(path.join(topic.folder, pointer.path)),
          restart: async () => { host = await restartPinnedHost(host, { signal }); await ready(); } });
        cases.push('proposal-prepare-publish-discard-and-three-restarts');
        cases.push(...await runInstalledNoteProposalNegatives({ rpc, readOnlyRpc,
          refreshRequest: async () => {
            const current = await loadTopicCatalog({ request: rpc, topicId: topic.topicId, current: () => !signal.aborted, validate() {}, maxEntries: 300 });
            const exact = pointer => { const row = current.notes.find(row => row.sourceReference.referenceId === pointer.referenceId && row.path === pointer.path); assert.ok(row); return { ...pointer, revision: row.revision }; };
            const latest = await rpc('command-center.v1.topics.get', { schemaVersion: 1, topicId: topic.topicId });
            return { topicId: topic.topicId, expectedTopicRevision: (latest.result ?? latest).topic.revision,
              target: exact(target), sources: sources.map(exact), panel: { sessionKey: topic.sessionKey, sessionId: topic.sessionId, referenceId: topic.sessionReferenceId } };
          }, readNoteBytes: pointer => readFile(path.join(topic.folder, pointer.path)),
          writeFixtureBytes: (pointer, bytes) => writeFile(path.join(topic.folder, pointer.path), bytes),
          setFixtureMode: (pointer, mode) => chmod(path.join(topic.folder, pointer.path), mode),
          restart: async () => { host = await restartPinnedHost(host, { signal }); await ready(); } }));
        managed = await launchManagedBrowser({ headless: true });
        const page = await managed.browser.newPage(); transport = await configureEvidencePage(page, guard, evidence);
        // Passive observation preserves the existing guarded WebSocket route.
        if (provider) page.on('websocket', socket => socket.on('framereceived', frame => recordRecallNativeEvent(nativeEvents, frame.payload)));
        const href = new URL(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topic',
          fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }));
        href.searchParams.set('p.topicId', topic.topicId); href.searchParams.set('p.sourceReferenceId', target.referenceId);
        href.searchParams.set('p.sourcePath', target.path); href.searchParams.set('p.evidenceSourceVersion', target.revision);
        await page.goto(href.href);
        await page.getByRole('button', { name: 'Prepare suggestion', exact: true }).waitFor({ timeout: 30_000 });
        assert.equal(await page.getByRole('button', { name: /Apply|Write Note/, exact: true }).count(), 0);
        const selected = [target, ...sources];
        const before = await Promise.all(selected.map(pointer => readFile(path.join(topic.folder, pointer.path))));
        const unchanged = async () => assert.deepEqual(await Promise.all(selected.map(pointer => readFile(path.join(topic.folder, pointer.path)))), before);
        await page.getByRole('checkbox', { name: `shared.md (${sources.find(row => row.path === 'shared.md').revision})`, exact: true }).check();
        await page.getByRole('button', { name: 'Prepare suggestion', exact: true }).click();
        await page.getByLabel('Suggestion Markdown', { exact: true }).waitFor();
        await unchanged();
        await page.getByLabel('Suggestion Markdown', { exact: true }).fill(`${topic.noteText}\nFictional browser-staged comparison only.\n`);
        await page.getByRole('button', { name: 'Review suggestion', exact: true }).click();
        await page.getByRole('heading', { name: 'Proposed', exact: true }).waitFor();
        await unchanged();
        const savedId = await page.getByLabel('Saved suggestion ID', { exact: true }).inputValue(); assert.ok(savedId);
        await page.reload();
        await page.getByLabel('Saved suggestion ID', { exact: true }).fill(savedId);
        await page.getByRole('button', { name: 'Recover suggestion by ID', exact: true }).click();
        await page.getByRole('heading', { name: 'Proposed', exact: true }).waitFor();
        assert.match(await page.getByRole('region', { name: 'Suggestion comparison', exact: true }).textContent(), /Fictional browser-staged comparison only/);
        assert.equal(await page.getByLabel('Saved suggestion ID', { exact: true }).inputValue(), savedId);
        await unchanged();
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Suggestion: discarded.' }).waitFor();
        await unchanged();
        cases.push('proposal-browser-review-recover-discard');
        if (provider) {
          const texts = new Map(); const indexed = [];
          const foreignCatalog = await loadTopicCatalog({ request: rpc, topicId: foreign.topicId, current: () => !signal.aborted, validate() {}, maxEntries: 300 });
          const foreignPointers = foreignCatalog.notes.filter(row => ['foreign.md', 'nested/foreign.md'].includes(row.path))
            .map(row => ({ referenceId: row.sourceReference.referenceId, path: row.path, revision: row.revision }));
          assert.equal(foreignPointers.length, 2);
          for (const pointer of [...sources, ...foreignPointers]) {
            const ownerTopic = sources.includes(pointer) ? topic : foreign;
            const value = await readNativeNote({ signal, request: rpc }, { ...pointer, topicId: ownerTopic.topicId, observedRevision: pointer.revision });
            texts.set(pointer.referenceId, { text: value.text, revision: pointer.revision, path: pointer.path });
            indexed.push({ kind: 'note', topicId: ownerTopic.topicId, sourceReference: value.sourceReference, path: pointer.path,
              folderReferenceId: sources.includes(pointer) ? 'fictional-native-journey-folder' : 'fictional-resource-folder', heading: value.text.split('\n')[0].replace(/^# /u, ''), text: value.text.trim(), revision: pointer.revision, provenance: 'native' });
          }
          // Snapshot only these fictional files while the host is stopped; no competing metadata owner.
          await stopPinnedHost(host.child); await host.outputDrained;
          const metadata = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw'), capabilities: { notes: true, sessions: true, search: true } });
          try {
            const prepared = await prepareTopicSearchSnapshot({ stateDir: path.join(world.root, '.openclaw'), metadata, authoritativeSources: {
              readTopicSnapshot: async ({ topicId }) => ({ note: { sourceRevision: 'fictional-installed-fixture' }, conversation: { sourceRevision: 'empty' },
                notes: indexed.filter(row => row.topicId === topicId), conversations: [] }) } });
            await publishTopicSearchSnapshot({ stateDir: path.join(world.root, '.openclaw'), metadata, prepared });
          } finally { metadata.close(); }
          host = await restartPinnedHost(host, { signal }); await ready(); await page.reload();
          progress.phase = 'native-chat-submit';
          await page.getByRole('button', { name: 'Open Topic in Chat', exact: true }).click();
          const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]'); await chatPane.waitFor({ timeout: 30_000 });
          await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, topic.sessionKey);
          const composer = chatPane.locator('.agent-chat__composer-combobox textarea');
          await composer.fill('[fixture:notes-recall] Recall alpha from my Topic Notes.');
          await chatPane.getByRole('button', { name: 'Send message', exact: true }).click();
          await recallWait('initial-tool-result', async () => provider.recallResults.length > 0);
          assert.ok(provider.requests.some(row => row.action === 'recall' && row.issuedToolCallId));
          const recalled = verifyInstalledRecallEvidence(provider.recallResults.at(-1), { topicId: topic.topicId, noteTextByReference: texts });
          assert.ok(recalled.every(row => row.originatingTopic.topicId !== foreign.topicId));
          assert.deepEqual(recalled.map(row => row.navigation.path).sort(), ['nested/source.md', 'shared.md']);
          const issued = provider.requests.filter(row => row.action === 'recall');
          assert.ok(issued.every(row => row.tools.includes('command_center_recall_topic_notes')));
          for (const name of ['command_center_topic_context', 'command_center_topic_analysis', 'command_center_update_working_note'])
            assert.ok(issued.every(row => !row.tools.includes(name)));
          cases.push('native-model-registration-and-exact-two-note-recall');
          // Repeat through the actual native tool after an owned host restart.
          host = await restartPinnedHost(host, { signal }); await ready(); await page.reload();
          progress.phase = 'native-chat-submit';
          await page.getByRole('button', { name: 'Open Topic in Chat', exact: true }).click();
          const count = provider.recallResults.length;
          await composer.fill('[fixture:notes-recall] Recall alpha after restart.');
          await chatPane.getByRole('button', { name: 'Send message', exact: true }).click();
          await recallWait('restart-tool-result', async () => provider.recallResults.length > count);
          const restarted = verifyInstalledRecallEvidence(provider.recallResults.at(-1), { topicId: topic.topicId, noteTextByReference: texts });
          assert.deepEqual(restarted.map(row => row.navigation.path).sort(), ['nested/source.md', 'shared.md']);
          assert.equal(new Set(provider.requests.filter(row => row.action === 'recall').map(row => row.issuedToolCallId)).size, 2);
          cases.push('native-recall-after-restart');
          const shared = sources.find(row => row.path === 'shared.md');
          const deniedCount = provider.recallResults.length;
          await chmod(path.join(topic.folder, shared.path), 0o000);
          try {
            await composer.fill('[fixture:notes-recall] Recall alpha with one denied Note.');
            await chatPane.getByRole('button', { name: 'Send message', exact: true }).click();
            await recallWait('permission-loss-tool-result', async () => provider.recallResults.length > deniedCount);
            const denied = provider.recallResults.at(-1);
            assert.equal(denied.status, 'partial');
            const remaining = verifyInstalledRecallEvidence(denied, { topicId: topic.topicId, noteTextByReference: texts });
            assert.deepEqual(remaining.map(row => row.navigation.path), ['nested/source.md']);
          } finally { await chmod(path.join(topic.folder, shared.path), 0o600); }
          cases.push('native-recall-permission-loss-omits-private-source');
          const restoredCount = provider.recallResults.length;
          const priorLinks = await chatPane.getByRole('link', { name: 'Source: shared.md', exact: true }).count();
          await composer.fill('[fixture:notes-recall] Recall alpha after Note permission recovery.');
          await chatPane.getByRole('button', { name: 'Send message', exact: true }).click();
          await recallWait('permission-recovery-tool-result', async () => provider.recallResults.length > restoredCount);
          const restored = verifyInstalledRecallEvidence(provider.recallResults.at(-1), { topicId: topic.topicId, noteTextByReference: texts });
          assert.deepEqual(restored.map(row => row.navigation.path).sort(), ['nested/source.md', 'shared.md']);
          await recallWait('citation-link', async () => await chatPane.getByRole('link', { name: 'Source: shared.md', exact: true }).count() > priorLinks, 30_000);
          cases.push('native-recall-permission-recovery');

          const link = chatPane.getByRole('link', { name: 'Source: shared.md', exact: true }).last(); await link.waitFor({ timeout: 30_000 });
          const draft = 'Fictional unsent draft: retain punctuation and newline.\nSecond line.';
          await composer.fill(draft); await composer.evaluate(element => element.setSelectionRange(7, 19));
          await link.click();
          const nativePage = page.locator('openclaw-plugin-page');
          await nativePage.getByRole('region', { name: 'Note content', exact: true }).getByText('alpha fictional shared observation.', { exact: false }).waitFor({ timeout: 30_000 });
          await nativePage.getByRole('navigation', { name: 'File path', exact: true }).getByText('shared.md', { exact: true }).waitFor();
          const actualLink = new URL(await link.getAttribute('href'), page.url());
          const source = sources.find(row => row.path === 'shared.md');
          for (const [key, value] of Object.entries({ 'p.topicId': topic.topicId, 'p.sourceReferenceId': source.referenceId,
            'p.sourcePath': source.path, 'p.evidenceSourceVersion': source.revision })) assert.equal(actualLink.searchParams.get(key), value);
          assert.equal(await chatPane.evaluate(element => element.sessionKey), topic.sessionKey);
          assert.equal(await composer.inputValue(), draft);
          assert.deepEqual(await composer.evaluate(element => [element.selectionStart, element.selectionEnd]), [7, 19]);
          cases.push('citation-reader-exact-identity-and-mounted-chat-draft-caret');
          await writeFile(path.join(topic.folder, 'shared.md'), '# Shared\nalpha fictional newer revision.\n');
          // A new reader mount is explicit; same-route clicks do not promise a reread.
          await nativePage.getByRole('button', { name: 'All Topics', exact: true }).click();
          await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
          await link.click(); await nativePage.getByText(/It was not opened as the earlier evidence/).waitFor({ timeout: 30_000 });
          await nativePage.getByRole('button', { name: 'Open current Note', exact: true }).waitFor();
          assert.equal(await nativePage.getByText('alpha fictional newer revision.', { exact: false }).count(), 0);
          assert.equal(await nativePage.getByRole('region', { name: 'Note content', exact: true }).textContent(), '');
          assert.equal(await composer.inputValue(), draft);
          assert.deepEqual(await composer.evaluate(element => [element.selectionStart, element.selectionEnd]), [7, 19]);
          cases.push('stale-citation-on-fresh-reader-retains-draft');
        }
        await transport.drain(); transport.assertClean(); guard.assertClean(); await assertRecordedChildTraffic(world);
      } catch (error) {
        if (provider) report.recallFailure = summarizeRecallFailure(error);
        throw error;
      } finally {
        try {
          try { if (provider) report.recallDiagnostics = { ...progress, ...collectRecallDiagnostics(provider, nativeEvents) }; }
          finally { if (managed) await closeManagedBrowser(managed, signal); }
        } finally {
          try { if (host) { await stopPinnedHost(host.child); await host.outputDrained; } }
          finally { if (provider) await provider.close(); }
        }
      }
    }, { candidateRoot });
    report.status = 'passed';
  } finally {
    try {
      await rm(admission, { recursive: true, force: true });
      if (stagedDist) {
        const current = await lstat(distRoot);
        assert.equal(current.dev, stagedDist.dev); assert.equal(current.ino, stagedDist.ino); assert.equal(current.isSymbolicLink(), false);
        await rm(distRoot, { recursive: true, force: false });
      }
    } catch (error) {
      report.status = 'failed'; report.cleanupFailed = true; throw error;
    } finally {
      await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
}
