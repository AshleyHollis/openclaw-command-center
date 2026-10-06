import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readBuiltReceipt, assertBuiltDigest } from '../../src/build.mjs';
import { verifyPluginArtifact } from '../../src/plugin-artifact.mjs';
import { compatibilityTuple } from '../../src/compatibility.mjs';
import { FIRST_LIVE_COMMANDS, FIRST_LIVE_FEATURES } from '../../src/release-scope.mjs';
import { withIsolatedWorld, fixtureEnvironment } from '../../src/fixtures.mjs';
import { TrafficGuard } from '../../src/isolation.mjs';
import { parseHostDescriptor, verifyHost, launchPinnedHost, restartPinnedHost, stopPinnedHost,
  waitForConsecutiveReadiness, assertRecordedChildTraffic, assertNoFatalHostOutput } from '../../src/host-harness.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { loadIntakeSourceAccount } from '../../src/open-loops/intake-accounting.mjs';
import { producerSourceExternalId } from '../../src/open-loops/intake-retry.mjs';
import { producerIntakePlanDigest } from '../../src/open-loops/producer-intake-plan.mjs';
import { captureAttentionAdmissionFailure, persistAttentionAdmissionFailure } from './attention-admission-failure.mjs';
import { assertFastHostAdmission, assertCandidatePluginPermissions } from './isolated-acceptance-preflight.mjs';
import { seedNativeExistingTopic } from './first-live-native-journey.mjs';
import { readAttentionStartupReadiness, readAttentionControlUiBuildId } from './attention-startup-readiness.mjs';
import { createGatewayDeviceIdentity, requestAuthenticatedGateway, withDeadline,
  launchManagedBrowser, closeManagedBrowser, configureEvidencePage } from './real-host-runtime.mjs';

const execFileAsync = promisify(execFile);
const unwrap = response => response?.result ?? response;
const sourceNamespace = 'fictional-attention-account';
const closedMethods = ['list', 'read', 'admit', 'handle', 'defer', 'reconcile'].map(name => `command-center.v1.bill-actions.${name}`);

/** Installed public owner journey. Fixture setup never reads or writes native Workboard SQLite. */
export async function exerciseAttentionCompiledJourney({ signal }) {
  assert.equal(process.env.COMMAND_CENTER_ATTENTION_QUALIFICATION, '1');
  assert.equal(FIRST_LIVE_FEATURES.billActions, true, 'The measured successor must enable the build-owned bill policy.');
  assert.equal(FIRST_LIVE_FEATURES.notifications, false);
  for (const method of closedMethods) assert.ok(FIRST_LIVE_COMMANDS.bridge.includes(method));
  const descriptor = parseHostDescriptor();
  await assertFastHostAdmission(descriptor);
  await verifyHost(descriptor);
  assert.equal(compatibilityTuple.host.commit, descriptor.commit);
  const buildReceipt = await readBuiltReceipt();
  await assertBuiltDigest(buildReceipt);
  const archivePath = process.env.COMMAND_CENTER_ATTENTION_CC_ARCHIVE;
  const receiptPath = process.env.COMMAND_CENTER_ATTENTION_PACKAGE_RECEIPT;
  assert.ok(archivePath && path.isAbsolute(archivePath), 'An external CC archive path is mandatory.');
  assert.ok(receiptPath && path.isAbsolute(receiptPath), 'An external CC package receipt path is mandatory.');
  const packageReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.match(packageReceipt.sourceCommit ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(packageReceipt.buildDigest, buildReceipt.digest);
  assert.equal(descriptor.schemaVersion, 2, 'Qualification requires the measured installed native archive.');
  const admissionRoot = process.env.COMMAND_CENTER_ATTENTION_ADMISSION_ROOT;
  assert.ok(admissionRoot && path.isAbsolute(admissionRoot), 'A private writable admission root is mandatory.');
  assert.equal(await realpath(admissionRoot), path.resolve(admissionRoot));
  const admissionStat = await lstat(admissionRoot);
  assert.ok(admissionStat.isDirectory() && !admissionStat.isSymbolicLink());
  assert.equal(admissionStat.uid, process.getuid()); assert.equal(admissionStat.mode & 0o777, 0o700);
  const validationRoot = await mkdtemp(path.join(admissionRoot, 'attention-package-admission-'));
  try {
  const candidateRoot = await verifyPluginArtifact({ archivePath, expectedReceipt: packageReceipt,
    destinationDirectory: path.join(validationRoot, 'candidate') });
  await assertCandidatePluginPermissions(candidateRoot);
  const fixtureFiles = await Promise.all(['attention-compiled-pair.test.mjs', 'support/attention-compiled-journey.mjs', 'support/attention-startup-readiness.mjs', 'support/attention-admission-failure.mjs'].map(async name => ({
    path: `test/${name}`, sha256: createHash('sha256').update(await readFile(new URL(`../${name}`, import.meta.url))).digest('hex')
  })));
  const acceptedPlanDigests = [];
  const evidence = { requests: [], responses: [], console: [], errors: [] };
  const milestones = [];
  return await withIsolatedWorld(async world => {
    const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    config.plugins.allow = [...new Set([...config.plugins.allow, 'workboard'])];
    config.plugins.entries.workboard = { enabled: true };
    config.agents.defaults.userTimezone = 'Australia/Brisbane';
    await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
    let host, browser, controlUiBuildId, admissionFailureObservation;
    const deviceIdentity = createGatewayDeviceIdentity();
    const rpc = async (method, params = {}, scopes = ['operator.read', 'operator.write', 'operator.admin']) => {
      assert.ok(typeof controlUiBuildId === 'string' && controlUiBuildId.trim(), 'Attention RPC requires the current host-issued Control UI build identity.');
      return unwrap(await requestAuthenticatedGateway({
        gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method, params, scopes, deviceIdentity,
        controlUiBuildId, signal, responseTimeoutMs: 30_000
      }));
    };
    const ready = async () => {
      controlUiBuildId = undefined;
      await waitForConsecutiveReadiness(async probeSignal => {
        if (!await readAttentionStartupReadiness({ world, signal: probeSignal })) return false;
        controlUiBuildId = await readAttentionControlUiBuildId({ world, signal: probeSignal });
        return true;
      }, host.earlyExit,
        { required: 1, deadlineMs: 120_000, delayMs: 250, signal });
      await rpc('workboard.cards.list', { boardId: 'default' });
    };
    const cli = async plan => {
      acceptedPlanDigests.push(producerIntakePlanDigest(plan));
      const planPath = path.join(world.tempRoot, `accepted-${plan.runId}.json`);
      await writeFile(planPath, JSON.stringify(plan));
      const wrapper = path.join(descriptor.runtimeRoot, descriptor.executable);
      const output = await withDeadline('installed accepted email intake', deadlineSignal => execFileAsync(process.execPath,
        [wrapper, 'command-center', 'intake', 'apply', '--plan', planPath, '--digest', producerIntakePlanDigest(plan)], {
          cwd: descriptor.checkout, timeout: 60_000, maxBuffer: 1_000_000, signal: deadlineSignal,
          env: { PATH: process.env.PATH, HOME: world.root, [fixtureEnvironment]: world.manifestPath,
            OPENCLAW_CONFIG_PATH: world.manifest.configPath, OPENCLAW_STATE_DIR: path.join(world.root, '.openclaw'),
            TMPDIR: world.tempRoot, TMP: world.tempRoot, TEMP: world.tempRoot,
            NODE_OPTIONS: `--import=${new URL('../../src/isolated-child-guard.mjs', import.meta.url).href}`,
            COMMAND_CENTER_DISABLE_HOSTED_PLUGIN_CATALOG: '1' }
        }), 70_000, signal);
      assert.match(output.stdout, /"status":"healthy-processed"/u);
    };
    const inspectAccepted = (rawId, version, outcomeId) => {
      const metadata = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw'), readOnly: true });
      try {
        const accepted = loadIntakeSourceAccount(metadata, { sourceKind: 'email', sourceExternalId: producerSourceExternalId(sourceNamespace, rawId), sourceVersion: version });
        const outcome = accepted.account.outcomes.find(item => item.outcomeId === outcomeId);
        assert.equal(outcome.status, 'applied');
        const loop = metadata.getOpenLoop(outcome.loopId);
        const observation = loop.evidenceObservationIds.map(id => metadata.getOpenLoopObservation(id)).find(item => item.facts.sourceVersion === version);
        assert.ok(observation);
        return { loop, observation };
      } finally { metadata.close(); }
    };
    const read = loopId => rpc('command-center.v1.bill-actions.read', { schemaVersion: 1, loopId });
    const nativeCard = async row => {
      const result = await rpc('workboard.cards.list', { boardId: row.binding.boardId });
      const matching = result.cards.filter(item => item.metadata?.automation?.tenant === row.binding.tenantId
        && (item.metadata.automation.boardId ?? 'default') === row.binding.boardId
        && item.metadata.automation.idempotencyKey === row.binding.idempotencyKey);
      assert.equal(matching.length, 1, 'Exactly one native card must own the admitted tenant, board and immutable key.');
      const card = matching[0]; assert.equal(card.id, row.binding.cardId);
      return card;
    };
    const state = loopId => rpc('command-center.v1.open-loops.get', { schemaVersion: 1, loopId });
    try {
      host = await withDeadline('following Attention isolated host', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
      await ready();
      const topic = await seedNativeExistingTopic({ world, host, signal });
      await mkdir(path.join(topic.folder, 'Bills'), { recursive: true });
      const noteText = '# Fictional BILL-100\nExplicit request to review and pay 12500 AUD minor units.\n';
      await writeFile(path.join(topic.folder, 'Bills/BILL-100.md'), noteText);
      const noteRevision = `sha256:${createHash('sha256').update(noteText).digest('hex')}`;
      const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const obligation = { obligationId: 'BILL-100', title: 'Review fictional BILL-100', classification: 'obligation', obligationKind: 'payment', provenance: 'explicit',
        correlationNamespace: sourceNamespace, correlationId: 'BILL-100', dueAt, paymentIdentity: { schemaVersion: 1, amountMinorUnits: 12500, currency: 'AUD', invoiceId: 'BILL-100' } };
      const plan = (rawId, version, notePath, revision, acceptedObligation) => ({ schemaVersion: 1, purpose: 'command-center-producer-intake', runId: `${rawId}-${version}`,
        sourceKind: 'email', sourceNamespace, scope: { accountBinding: 'fictional-attention-account', folders: ['inbox'], sinceUtc: '2026-10-01T00:00:00.000Z', beforeUtc: '2026-10-07T00:00:00.000Z', maxMessages: 1, batchKind: 'canary' },
        processorVersion: 'fictional-attention-v1', nextExpectedAt: new Date(Date.now() + 86_400_000).toISOString(), enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false },
        records: [{ schemaVersion: 1, sourceExternalId: rawId, sourceVersion: version, checkpoint: rawId, retainedNoteRevision: revision, acceptedExtraction: { schemaVersion: 1,
          proposedTopic: topic.name, notePath, knowledgeMarkdown: '', obligations: [acceptedObligation] } }] });
      const initialPlan = plan('fictional-message-100', 'v1', 'Bills/BILL-100.md', noteRevision, obligation);
      await cli(initialPlan);
      const firstAccepted = inspectAccepted('fictional-message-100', 'v1', 'BILL-100');
      const firstIntent = { schemaVersion: 1, loopId: firstAccepted.loop.loopId, logicalOperationId: randomUUID(), tenantId: 'fictional-attention', boardId: 'default' };
      let first;
      try { first = await rpc('command-center.v1.bill-actions.admit', firstIntent); }
      catch (failure) {
        try {
          admissionFailureObservation = await captureAttentionAdmissionFailure({
            readBinding() {
              const metadata = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw'), readOnly: true });
              try { return metadata.getBillActionBinding(firstAccepted.loop.loopId); }
              finally { metadata.close(); }
            },
            readNativeCards: async () => (await rpc('workboard.cards.list', { boardId: firstIntent.boardId }, ['operator.read'])).cards,
            diagnostics: host.diagnostics
          });
          console.error(`Attention admission failure observation: ${JSON.stringify(admissionFailureObservation)}`);
        } catch { console.error('Attention admission failure observation unavailable.'); }
        throw failure;
      }
      const duplicate = await rpc('command-center.v1.bill-actions.admit', firstIntent);
      assert.equal(duplicate.binding.cardId, first.binding.cardId);
      assert.equal((await nativeCard(first)).status, 'todo');
      milestones.push('installed-intake-and-native-admission');
      const readOnly = await rpc('command-center.v1.bill-actions.read', { schemaVersion: 1, loopId: first.loopId }, ['operator.read']);
      assert.equal(readOnly.canWrite, false);
      await assert.rejects(rpc('command-center.v1.bill-actions.handle', { schemaVersion: 1, loopId: first.loopId, logicalOperationId: randomUUID(), expectedUpdatedAt: first.native.updatedAt }, ['operator.read']),
        /Authenticated command-center\.v1\.bill-actions\.handle failed: .*\b(?:scope|operator\.write|read.only|write authority)\b/iu);
      const unchangedReadOnly = await nativeCard(first);
      assert.equal(unchangedReadOnly.status, 'todo'); assert.equal(unchangedReadOnly.updatedAt, first.native.updatedAt);
      const stale = await rpc('command-center.v1.bill-actions.handle', { schemaVersion: 1, loopId: first.loopId, logicalOperationId: randomUUID(), expectedUpdatedAt: first.native.updatedAt - 1 });
      assert.equal(stale.outcome, 'conflict');
      const unchangedStale = await nativeCard(first);
      assert.equal(unchangedStale.status, 'todo'); assert.equal(unchangedStale.updatedAt, first.native.updatedAt);
      const laterIntent = { schemaVersion: 1, loopId: first.loopId, logicalOperationId: randomUUID(), expectedEligibilityRevision: first.eligibility.revision,
        reviewAt: new Date(Date.now() + 86_400_000).toISOString(), timeZone: 'Australia/Brisbane', offsetMinutes: 600 };
      assert.equal((await rpc('command-center.v1.bill-actions.defer', laterIntent)).outcome, 'applied');
      assert.equal((await rpc('command-center.v1.bill-actions.defer', laterIntent)).outcome, 'applied');
      first = await read(first.loopId);
      assert.equal(first.eligibility.reviewAt, laterIntent.reviewAt); assert.equal(first.eligibility.eligible, false);
      assert.equal((await nativeCard(first)).status, 'todo');
      milestones.push('read-only-refusal-and-immutable-Later');

      if (process.env.COMMAND_CENTER_ATTENTION_BROWSER !== '0') {
        browser = await launchManagedBrowser({ headless: true, timeout: 60_000 });
        const page = await browser.browser.newPage({ viewport: { width: 1366, height: 768 } });
        await configureEvidencePage(page, new TrafficGuard(), evidence);
        const attentionUrl = controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'attention', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential });
        await page.goto(attentionUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const root = page.locator('openclaw-plugin-page');
        await root.getByRole('heading', { name: 'Bill actions', exact: true }).waitFor({ timeout: 60_000 });
        await root.getByText('Deferred bill actions', { exact: true }).click();
        const card = root.locator('article[data-bill-action-id]').filter({ hasText: obligation.title });
        await card.getByRole('button', { name: 'Review source', exact: true }).click();
        await root.getByRole('region', { name: 'Note content', exact: true }).getByRole('heading', { name: 'Fictional BILL-100', exact: true }).waitFor({ timeout: 30_000 });
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await root.getByRole('heading', { name: 'Bill actions', exact: true }).waitFor({ timeout: 60_000 });
        milestones.push('installed-Note-review-and-return');
        if (!await card.isVisible()) await root.getByText('Deferred bill actions', { exact: true }).click();
        await card.getByRole('button', { name: 'Later', exact: true }).click();
        const localTime = new Date(Date.now() + 2 * 86_400_000 + 600 * 60_000).toISOString().slice(0, 16);
        const expectedReviewAt = new Date(Date.parse(`${localTime}:00.000Z`) - 600 * 60_000).toISOString();
        await card.getByLabel('Timezone (IANA)', { exact: true }).fill('Australia/Brisbane');
        await card.getByLabel('Custom local date and time', { exact: true }).fill(localTime);
        await card.getByRole('button', { name: 'Preview review time', exact: true }).click();
        await card.locator('form[data-bill-later-form]').getByRole('status').filter({ hasText: 'Australia/Brisbane (UTC+10:00)' }).waitFor({ timeout: 5_000 });
        await card.getByRole('button', { name: 'Save Later', exact: true }).click();
        await waitForConsecutiveReadiness(async () => (await read(first.loopId)).eligibility.reviewAt === expectedReviewAt, host.earlyExit,
          { required: 1, deadlineMs: 15_000, delayMs: 250, signal });
        first = await read(first.loopId);
        assert.equal(first.eligibility.timeZone, 'Australia/Brisbane'); assert.equal(first.eligibility.offsetMinutes, 600);
        assert.equal(first.eligibility.eligible, false); assert.equal((await nativeCard(first)).status, 'todo');
        await card.getByText(new RegExp(`Review time:.*${localTime.slice(11)} Australia/Brisbane`, 'u')).waitFor({ state: 'attached', timeout: 15_000 });
        if (!await card.isVisible()) await root.getByText('Deferred bill actions', { exact: true }).click();
        await card.getByRole('button', { name: 'Handled', exact: true }).click();
        await waitForConsecutiveReadiness(async () => (await nativeCard(first)).status === 'done', host.earlyExit,
          { required: 1, deadlineMs: 15_000, delayMs: 250, signal });
        await root.locator('details[data-bill-handled] article[data-bill-action-id]').filter({ hasText: obligation.title }).waitFor({ state: 'attached', timeout: 15_000 });
        if (!await card.isVisible()) await root.getByText('Recent handled', { exact: true }).click();
        await card.getByText('Handled status confirmed. This is manual action status, not payment confirmation.', { exact: true }).waitFor({ timeout: 15_000 });
        await card.getByText('Current native Done is confirmed. Native evidence does not identify who handled it.', { exact: true }).waitFor({ timeout: 5_000 });
        assert.equal((await state(first.loopId)).loop.paymentState, 'unpaid');
        milestones.push('installed-UI-Later-and-Handled');
        if (process.env.COMMAND_CENTER_ATTENTION_EVIDENCE_DIR) {
          const directory = path.resolve(process.env.COMMAND_CENTER_ATTENTION_EVIDENCE_DIR);
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, 'attention-compiled-Recent-handled.png'), fullPage: true });
        }
      }
      const handleIntent = { schemaVersion: 1, loopId: first.loopId, logicalOperationId: randomUUID(), expectedUpdatedAt: first.native.updatedAt };
      assert.equal((await rpc('command-center.v1.bill-actions.handle', handleIntent)).outcome, 'handled-observed');
      assert.equal((await nativeCard(first)).status, 'done');
      assert.equal((await state(first.loopId)).loop.paymentState, 'unpaid');
      host = await restartPinnedHost(host, { signal });
      await ready();
      assert.equal((await rpc('command-center.v1.bill-actions.handle', handleIntent)).outcome, 'handled-observed');
      assert.equal((await rpc('command-center.v1.bill-actions.admit', firstIntent)).binding.cardId, first.binding.cardId);
      assert.equal((await read(first.loopId)).eligibility.eligible, false);
      milestones.push('observed-Done-operation-and-real-host-restart');

      const secondText = '# Fictional BILL-102\nSeparately requested invoice following BILL-100.\n';
      await writeFile(path.join(topic.folder, 'Bills/BILL-102.md'), secondText);
      const secondRevision = `sha256:${createHash('sha256').update(secondText).digest('hex')}`;
      const secondObligation = { ...obligation, obligationId: 'BILL-102', correlationId: 'BILL-102', title: 'Review fictional BILL-102', paymentIdentity: { schemaVersion: 1, amountMinorUnits: 14500,
        currency: 'AUD', invoiceId: 'BILL-102', predecessor: { loopId: first.loopId, observationId: firstAccepted.observation.observationId, explanation: 'Separately requested fictional BILL-102 follows BILL-100.' } } };
      await cli(plan('fictional-message-102', 'v1', 'Bills/BILL-102.md', secondRevision, secondObligation));
      const secondAccepted = inspectAccepted('fictional-message-102', 'v1', 'BILL-102');
      const second = await rpc('command-center.v1.bill-actions.admit', { ...firstIntent, loopId: secondAccepted.loop.loopId, logicalOperationId: randomUUID() });
      assert.notEqual(second.binding.cardId, first.binding.cardId);
      assert.equal(second.predecessor.loopId, first.loopId); assert.equal(second.predecessor.native.status, 'done');
      assert.equal((await nativeCard(second)).status, 'todo');
      await cli(plan('fictional-message-100', 'v2', 'Bills/BILL-100.md', noteRevision, obligation));
      assert.equal((await read(first.loopId)).outcome, 'handled-observed');
      assert.equal((await read(first.loopId)).eligibility.eligible, false);
      const verifyOriginalPredecessor = async () => {
        const previous = (await read(second.loopId)).predecessor;
        assert.equal(previous.observationId, firstAccepted.observation.observationId);
        assert.equal(previous.source.kind, 'note'); assert.equal(previous.source.path, 'Bills/BILL-100.md');
        assert.equal(previous.native.status, 'done');
      };
      await verifyOriginalPredecessor();
      await cli(plan('fictional-message-100', 'v3', 'Bills/BILL-100.md', noteRevision, { ...obligation, paymentIdentity: { ...obligation.paymentIdentity, amountMinorUnits: 14500 } }));
      await assert.rejects(read(first.loopId), /Authenticated command-center\.v1\.bill-actions\.read failed: .*accepted bill meaning changed.*requires review/iu);
      assert.equal((await nativeCard(first)).status, 'done');
      milestones.push('distinct-accepted-cause-and-correction-conflict');
      await verifyOriginalPredecessor();
      await unlink(path.join(topic.folder, 'Bills/BILL-100.md'));
      const independent = await read(second.loopId);
      assert.equal(independent.predecessor, undefined); assert.equal(independent.native.status, 'todo');
      await unlink(path.join(topic.folder, 'Bills/BILL-102.md'));
      const unavailable = await rpc('command-center.v1.bill-actions.list', { schemaVersion: 1 });
      assert.equal(unavailable.rows.length, 0); assert.equal(unavailable.coverage, 'partial');
      milestones.push('exact-Note-revocation-and-partial-coverage');
      assertNoFatalHostOutput(host.diagnostics);
      await assertRecordedChildTraffic(world);
      host.diagnostics.guard.assertClean();
      await assertBuiltDigest(buildReceipt);
      return { schemaVersion: 1, assertionsCompleted: true, hostCommit: descriptor.commit, hostPackageDigest: descriptor.integrity.packageDigest,
        hostSourceDigest: descriptor.integrity.sourceDigest, hostRuntimeDigest: descriptor.integrity.runtimeDigest,
        hostExecutableDigest: descriptor.integrity.executableDigest, hostContractDigest: descriptor.integrity.contractDigest,
        ccSourceCommit: packageReceipt.sourceCommit, ccArchiveSha256: packageReceipt.archive.sha256,
        ccBuildDigest: buildReceipt.digest,
        fixtureDigest: createHash('sha256').update(JSON.stringify({ files: fixtureFiles, acceptedPlanDigests })).digest('hex'),
        fixtureFiles, acceptedPlanDigests, milestones, browserRequested: process.env.COMMAND_CENTER_ATTENTION_BROWSER !== '0',
        lostResponseRace: 'not-run: no controlled accepted-response-loss seam', queuedAuthorityRace: 'native-owner-evidence-only', liveEmailRead: false };
    } finally {
      await closeManagedBrowser(browser, signal).catch(() => {});
      if (host) await stopPinnedHost(host.child);
      if (admissionFailureObservation) {
        try {
          await persistAttentionAdmissionFailure({ observation: admissionFailureObservation, diagnostics: host.diagnostics, outputDrained: host.outputDrained,
            evidenceDirectory: process.env.COMMAND_CENTER_ATTENTION_EVIDENCE_DIR ? path.resolve(process.env.COMMAND_CENTER_ATTENTION_EVIDENCE_DIR) : undefined });
        } catch { console.error('Attention admission failure evidence could not be persisted.'); }
      }
    }
  }, { candidateRoot });
  } finally { await rm(validationRoot, { recursive: true, force: true }); }
}
