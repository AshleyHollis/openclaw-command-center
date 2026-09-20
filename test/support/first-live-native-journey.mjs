import assert from 'node:assert/strict';
import { assertNativeFormattedNote, assertNativeNoteSource, openNativeTopicConversation, organizeNativeTopicConversations, selectNativeCategoryGrouping, verifyNativeTopicNotesPane } from './native-topic-workspace.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finalizeAcceptanceJourney } from '../../src/acceptance-finalization.mjs';
import { hasSuccessfulBrowserResponse, observeBrowserResponse, recordBounded } from '../../src/browser-evidence.mjs';
import { assertBuiltDigest } from '../../src/build.mjs';
import { withIsolatedWorld } from '../../src/fixtures.mjs';
import { assertNoFatalHostOutput, assertRecordedChildTraffic, fetchJsonWithDeadline, launchPinnedHost, restartPinnedHost, stopPinnedHost, waitForConsecutiveReadiness } from '../../src/host-harness.mjs';
import { assertWebSocketDestination, TrafficGuard } from '../../src/isolation.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { resolveCommandCenterDatabasePath } from '../../src/metadata/path.mjs';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { readNativeHistoryInventory } from '../../src/migration/native-history-source.mjs';
import { runPreservedHistoryImport } from '../../src/migration/preserved-history-import.mjs';
import { NOTE_FOLDER_IDENTITY_FILE, readNoteFolderIdentity, setHostFilesystemIdentityReader } from '../../src/sources/note-folder-identity.mjs';
import { controlUiPluginUrl, isCommandCenterMetadataReady, isCommandCenterMigrationReady, readCommandCenterMigrationProgress, recordStartupObservation } from '../../src/acceptance-readiness.mjs';
import { scanPublicEvidence } from '../../src/safety.mjs';
import { withDeadline, stopHostOnAbort, launchManagedBrowser, closeManagedBrowser, redactBrowserEvidence, boundedHostEvidence, configureEvidencePage, requestAuthenticatedGateway, readAuthenticatedHistory, isGatewayStartupPending } from './real-host-runtime.mjs';
import { exerciseNativeKeyboardStates } from './first-live-native-keyboard.mjs';
import { tabTo } from './keyboard-navigation.mjs';
import { prepareNativeLegacyBootstrap, readNativeLegacyBootstrap } from './first-live-native-bootstrap.mjs';
import { prepareNativeScaleConversations, exerciseNativeScaleStates, openNativeSessionRoster } from './first-live-native-scale.mjs';
import { startFictionalOpenAiModel } from './fictional-openai-model.mjs';

// Bounded fictional fixture bytes. These enter only the isolated world and
// let the native Files replacement exercise its real document owner without
// an upload, a network fetch, or a filing/maintenance automation.
function fictionalTwoPagePdfBytes() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 25 >>\nstream\n0 0 1 rg 10 10 50 50 re f\nendstream',
    '<< /Length 25 >>\nstream\n1 0 0 rg 10 10 50 50 re f\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function fictionalPngBytes() {
  const width = 480; const height = 300;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1); pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = Math.round(45 + (210 * x / width));
      pixels[offset + 1] = Math.round(80 + (120 * y / height));
      pixels[offset + 2] = 190;
      pixels[offset + 3] = 255;
    }
  }
  const crc = value => {
    let state = 0xffffffff;
    for (const byte of value) { state ^= byte; for (let bit = 0; bit < 8; bit += 1) state = (state >>> 1) ^ (state & 1 ? 0xedb88320 : 0); }
    return (state ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, value) => {
    const kind = Buffer.from(type, 'ascii'); const body = Buffer.from(value);
    const result = Buffer.alloc(12 + body.length); result.writeUInt32BE(body.length, 0); kind.copy(result, 4); body.copy(result, 8);
    result.writeUInt32BE(crc(Buffer.concat([kind, body])), 8 + body.length); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const fictionalJpegBytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64');
const fictionalWebpBytes = Buffer.from('UklGRigCAABXRUJQVlA4WAoAAAAgAAAAHwAAFwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggOgAAAFADAJ0BKiAAGAA+bTSWR6QjIiEoCACADYllAHYA/AAAjX+wAP7i4L//5miY5j9q///zsGxLteAAAAA=', 'base64');

async function retainTopicNotesScreenshot(page, name) {
  const directory = process.env.COMMAND_CENTER_NATIVE_CHAT_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, timeout: 5_000 });
}

async function retainNativeJourneyStage(stage) {
  const directory = process.env.COMMAND_CENTER_NATIVE_CHAT_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'journey-stage.json'), `${JSON.stringify({ schemaVersion: 1, stage })}\n`);
}

function nativeCatalogPageText(page) {
  const first = page.total === 0 ? 0 : page.offset + 1;
  return page.total === 0 ? 'No Notes.' : `Notes ${first}–${page.offset + page.notes.length} of ${page.total}.`;
}

async function readNativeCatalogPagesToPath({ gatewayUrl, credential, topicId, path: targetPath, signal }) {
  const pages = [];
  let offset = 0;
  let cursor;
  let total;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const response = await requestAuthenticatedGateway({ gatewayUrl, credential,
      method: 'command-center.v1.notes.browse',
      params: { schemaVersion: 1, topicId, offset, limit: 50, includeDocuments: true, ...(cursor ? { cursor } : {}) }, signal });
    const page = response?.result ?? response;
    if (!Array.isArray(page?.notes) || page.offset !== offset || !Number.isSafeInteger(page.total) || page.total < 0 ||
        typeof page.hasMore !== 'boolean' || typeof page.cursor !== 'string' ||
        (page.hasMore && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset >= page.total)) ||
        (!page.hasMore && page.nextOffset !== null) || page.notes.length > 50 || offset + page.notes.length > page.total) {
      throw new Error(`The authoritative Note page is invalid: ${JSON.stringify({ pageIndex, offset, total: page?.total, count: page?.notes?.length, nextOffset: page?.nextOffset, hasMore: page?.hasMore }).slice(0, 500)}`);
    }
    if (total === undefined) { total = page.total; cursor = page.cursor; }
    else if (page.total !== total || page.cursor !== cursor) throw new Error('The authoritative Note catalogue changed while locating the exact fixture file.');
    const bounded = { notes: page.notes.map(note => ({ path: note.path })), total: page.total, offset: page.offset,
      nextOffset: page.hasMore ? page.nextOffset : null };
    pages.push(bounded);
    if (page.notes.some(note => note.path === targetPath)) return Object.freeze(pages);
    if (!page.hasMore) break;
    offset = page.nextOffset;
  }
  throw new Error(`The exact fixture file was not found in the bounded authoritative Note pages: ${JSON.stringify({ targetPath, pages: pages.map(page => ({ offset: page.offset, count: page.notes.length, total: page.total })) }).slice(0, 800)}`);
}

async function openNativeCatalogPageForPath({ workspace, pages, path: targetPath }) {
  try {
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      await workspace.getByText(nativeCatalogPageText(page), { exact: true }).waitFor({ timeout: 30_000 });
      await workspace.getByText(`${page.notes.length} Topic files available.`, { exact: true }).waitFor({ timeout: 30_000 });
      if (page.notes.some(note => note.path === targetPath)) return page;
      await workspace.getByRole('button', { name: 'Next Notes', exact: true }).click();
    }
  } catch (error) {
    const diagnostics = await workspace.evaluate((element) => ({
      text: element.innerText.slice(0, 2_000),
      statuses: [...element.querySelectorAll('[role="status"]')].map(node => node.textContent?.trim()).filter(Boolean).slice(0, 12),
      pageControls: [...element.querySelectorAll('button')].filter(node => /^(Previous|Next) Notes$/u.test(node.textContent?.trim() ?? ''))
        .map(node => ({ label: node.textContent?.trim(), disabled: node.disabled, visible: node.checkVisibility?.() ?? null }))
    })).catch(diagnosticError => ({ diagnosticError: String(diagnosticError?.message ?? diagnosticError).slice(0, 500) }));
    throw new Error(`The native Note page did not reconcile with the authoritative cursor-pinned catalogue: ${JSON.stringify(diagnostics).slice(0, 2_500)}`, { cause: error });
  }
  throw new Error(`The exact fixture file was not present after ${pages.length} bounded native Note pages.`);
}

// The isolated history source is pinned by an inventory digest before the
// plugin starts. Its fixture transcript never overlaps an active Chat and is
// imported through the same durable, read-only owner used by production.
async function prepareNativeHistorySource({ world }) {
  const root = path.join(world.tempRoot, 'native-history-source');
  await mkdir(root, { recursive: true });
  const records = [
    { type: 'session', id: 'fictional-imported-history', version: 1, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: 'fictional-history-message', parentId: null, timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', content: 'Fictional preserved imported history.' } },
    { type: 'compaction', id: 'fictional-history-event', parentId: 'fictional-history-message', timestamp: '2026-01-01T00:02:00.000Z', summary: 'Fictional preserved event.' }
  ];
  const fileName = 'fictional-imported-history.jsonl.bak-001';
  const fileBytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const file = { name: fileName, sizeBytes: fileBytes.length, sha256: sha256(fileBytes) };
  const inventory = { snapshot: '/fictional/immutable-backup', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fictional/agents/main/sessions', files: [file] };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  const expectedInventorySha256 = sha256(inventoryBytes);
  await writeFile(path.join(root, fileName), fileBytes, { flag: 'wx' });
  await writeFile(path.join(root, 'inventory.json'), inventoryBytes, { flag: 'wx' });
  const config = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
  config.plugins.entries['command-center'].config.nativeHistorySource = { root, expectedInventorySha256, originalAgentId: 'main' };
  await writeFile(world.manifest.configPath, `${JSON.stringify(config)}\n`);
  return Object.freeze({ root, expectedInventorySha256 });
}

async function importNativeHistory({ world, topicId, source, hostRuntimeWrapper }) {
  const sdkRoot = path.dirname(hostRuntimeWrapper ?? '');
  if (!sdkRoot || !path.isAbsolute(sdkRoot)) throw new Error('verified-host-sdk-unavailable');
  const prepared = (await readNativeHistoryInventory({ root: source.root, expectedInventorySha256: source.expectedInventorySha256, originalAgentId: 'main' })).histories[0];
  const stateDir = path.join(world.root, '.openclaw');
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  try {
    const reservation = metadata.reserveImportedHistory({ logicalOperationId: randomUUID(), intent: {
      schemaVersion: 2, sourceKind: prepared.sourceKind, sourceInventorySha256: prepared.sourceInventorySha256,
      originalAgentId: prepared.originalAgentId, originalSessionId: prepared.originalSessionId, sourceFile: prepared.sourceFile,
      sourceDigest: prepared.sourceDigest, expectedCount: prepared.expectedCount, agentId: 'main', topicId, expectedTopicRevision: metadata.getTopic(topicId).revision
    } }, () => {});
    const [sessionStore, transcripts] = await Promise.all([
      import(pathToFileURL(path.join(sdkRoot, 'dist', 'plugin-sdk', 'session-store-runtime.js')).href),
      import(pathToFileURL(path.join(sdkRoot, 'dist', 'plugin-sdk', 'session-transcript-runtime.js')).href)
    ]);
    const receipt = await runPreservedHistoryImport({ metadata, historyId: reservation.historyId, prepared, sessionStore, transcripts,
      storePath: path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'), config: {}, allowCreate: true, assertCurrent: () => {} });
    assert.equal(receipt.phase, 'verified');
    return Object.freeze({ historyId: receipt.historyId, title: 'Preserved conversation — 2026-01-01T00:00:00.000Z' });
  } finally { metadata.close(); }
}

// The host intentionally gives plugin-owned jobs a generated, namespaced Cron
// name.  The request's friendly name is only its collision-safe suffix; it is
// not the public Cron identity.  Match the durable host contract instead of
// asserting a synthetic `sessionKey` field that Cron jobs do not expose.
function isCommandCenterMaintenanceJob(job, sessionKey) {
  return typeof job?.name === 'string'
    && job.name.startsWith('plugin:command-center:tag:command-center-note-maintenance-')
    && job.name.endsWith(`:${sessionKey}:Command Center Note maintenance`)
    && job.sessionTarget === `session:${sessionKey}`
    && job.deleteAfterRun === true
    && job.delivery?.mode === 'none';
}

// The receipt wrapper and future retained variants share this actual native
// journey. Host admission, exact source proofs and finalization stay mandatory.
export async function seedNativeExistingTopic({ world, host, signal, catalog = false }) {
  const stateDir = path.join(world.root, '.openclaw');
  await waitForConsecutiveReadiness(async () => isCommandCenterMetadataReady(resolveCommandCenterDatabasePath(stateDir)), host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
  const topicId = '44444444-4444-4444-8444-444444444444';
  const name = 'Fictional Native Journey';
  const paraCategory = 'area';
  const folderReferenceId = 'fictional-native-journey-folder';
  const sessionReferenceId = 'fictional-native-journey-primary';
  const notePath = 'Overview.md';
  const noteText = '# Fictional Native Journey\nExisting authoritative Note — read only.\n';
  const sessionKey = `agent:main:command-center:acceptance-native:${topicId}`;
  // Fixture setup uses the real Session owner, not a fabricated catalog row or
  // the deferred Topic-provisioning/legacy authoritativeSession escape hatch.
  const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: 'sessions.create', params: { agentId: 'main', key: sessionKey, label: name }, scopes: ['operator.read', 'operator.write'], signal });
  const created = response?.result ?? response;
  assert.equal(created?.key, sessionKey);
  assert.equal(typeof created?.sessionId, 'string');
  assert.ok(created.sessionId.length > 0);
  assert.equal(created.runStarted, false, 'Fixture setup must not start an agent run');
  const folder = path.join(world.paths.vault, 'Projects', name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, notePath), noteText, { flag: 'wx' });
  const catalogNotes = [];
  if (catalog) {
    // This uses an already-existing Topic fixture rather than the legacy
    // import path. Its 144 user files deliberately model the observed Area
    // shape: a depth-three Markdown hierarchy with ordinary documents and
    // previews. The reader proof never uses a broad vault listing.
    for (let index = 1; index <= 111; index += 1) {
      signal?.throwIfAborted();
      const branch = index % 3 === 0 ? 'Z Projects/Alpha/Planning'
        : index % 3 === 1 ? 'Z Projects/Beta/Planning'
          : 'Z Reference/Archive/2026';
      const leaf = index <= 3 ? 'Plan.md' : `Fictional-Document-${String(index).padStart(3, '0')}.md`;
      const relative = `${branch}/${leaf}`;
      const file = path.join(folder, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      const text = `# Fictional document ${index}\nNested catalogue fixture — read only.\n`;
      await writeFile(file, text, { flag: 'wx' });
      catalogNotes.push(Object.freeze({ path: relative, text }));
    }
    const documents = [
      ...Array.from({ length: 17 }, (_, index) => [`Evidence/PDF/receipt-${String(index + 1).padStart(2, '0')}.pdf`, fictionalTwoPagePdfBytes()]),
      ...Array.from({ length: 5 }, (_, index) => [`Evidence/Office/letter-${String(index + 1).padStart(2, '0')}.docx`, Buffer.from('fictional DOCX fallback attachment', 'utf8')]),
      ...Array.from({ length: 5 }, (_, index) => [`Evidence/Email/message-${String(index + 1).padStart(2, '0')}.eml`, Buffer.from('From: fictional@example.invalid\nSubject: Fictional attachment\n\nRead-only fixture.\n', 'utf8')]),
      ['Evidence/Images/photo-01.png', fictionalPngBytes()],
      ['Evidence/Images/photo-02.png', fictionalPngBytes()],
      ['Evidence/Images/preview.jpg', fictionalJpegBytes],
      ['Evidence/Images/preview.webp', fictionalWebpBytes],
      ['Evidence/unavailable.bin', Buffer.from('fictional unsupported attachment', 'utf8')]
    ];
    for (const [relative, bytes] of documents) {
      const file = path.join(folder, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: 'wx' });
    }
  }
  // This external harness is not the host process and therefore must not
  // impersonate the host-only durable enrollment capability. Its pre-existing
  // fixture marker is safely created before binding; actual enrollment is
  // exercised by the host-owned recovery path.
  await writeFile(path.join(folder, NOTE_FOLDER_IDENTITY_FILE), `${JSON.stringify({ version: 1, id: randomUUID() })}\n`, { flag: 'wx', mode: 0o600 });
  // The external acceptance owner reads the witness through the exact pinned
  // host runtime helper. This preserves parity with the Gateway process while
  // keeping fixture setup outside the plugin's activation-scoped setters.
  const fileAccess = await import('openclaw/plugin-sdk/file-access-runtime');
  const releaseIdentityReader = setHostFilesystemIdentityReader(fileAccess.readDurableFilesystemIdentity);
  let identity;
  try { identity = await readNoteFolderIdentity(folder); }
  finally { releaseIdentityReader(); }
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
  try {
    metadata.createTopic({ topicId, name, paraCategory, lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: folderReferenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
    metadata.setSourceLocator({ referenceId: folderReferenceId, locator: folder, ownership: 'external', observedRevision: identity });
    metadata.createSourceReference({ version: 1, referenceId: sessionReferenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
    metadata.setSessionState({ referenceId: sessionReferenceId, sessionId: created.sessionId, status: 'open', isPrimary: true, displayName: name });
  } finally { metadata.close(); }
  return Object.freeze({ topicId, name, paraCategory, sessionReferenceId, sessionKey, sessionId: created.sessionId, notePath, noteText, folder,
    ...(catalog ? { catalog: true, catalogNotes: Object.freeze(catalogNotes), documents: Object.freeze({ pdfPath: 'Evidence/PDF/receipt-01.pdf', pngPath: 'Evidence/Images/photo-01.png', unsupportedPath: 'Evidence/unavailable.bin' }) } : {}) });
}

// A second realistic, shallow Resource fixture. It is deliberately separate
// from the first Topic so the acceptance journey can prove that changing an
// exact Conversation changes the visible Files root, rather than carrying
// over a browser state from the prior Topic.
async function seedNativeResourceTopic({ world, signal }) {
  const stateDir = path.join(world.root, '.openclaw');
  const topicId = '55555555-5555-4555-8555-555555555555';
  const name = 'Fictional Resource Workspace';
  const folderReferenceId = 'fictional-resource-folder';
  const sessionReferenceId = 'fictional-resource-primary';
  const sessionKey = `agent:main:command-center:acceptance-native:${topicId}`;
  const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: 'sessions.create', params: { agentId: 'main', key: sessionKey, label: name }, scopes: ['operator.read', 'operator.write'], signal });
  const created = response?.result ?? response;
  assert.equal(created?.key, sessionKey); assert.ok(typeof created?.sessionId === 'string' && created.sessionId.length > 0);
  const folder = path.join(world.paths.vault, 'Resources', name);
  await mkdir(folder, { recursive: true });
  for (let index = 1; index <= 95; index += 1) {
    const relative = index <= 4 ? `Guides/Resource-${String(index).padStart(2, '0')}.md` : `Resource-${String(index).padStart(2, '0')}.md`;
    const file = path.join(folder, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `# Fictional Resource ${index}\nRead-only fixture content.\n`, { flag: 'wx' });
  }
  await writeFile(path.join(folder, 'resource-index.json'), '{"fixture":true}\n', { flag: 'wx' });
  await writeFile(path.join(folder, NOTE_FOLDER_IDENTITY_FILE), `${JSON.stringify({ version: 1, id: randomUUID() })}\n`, { flag: 'wx', mode: 0o600 });
  const identity = await readNoteFolderIdentity(folder);
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true, sessions: true, activity: true } });
  try {
    metadata.createTopic({ topicId, name, paraCategory: 'resource', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: folderReferenceId, topicId, sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: folder });
    metadata.setSourceLocator({ referenceId: folderReferenceId, locator: folder, ownership: 'external', observedRevision: identity });
    metadata.createSourceReference({ version: 1, referenceId: sessionReferenceId, topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey });
    metadata.setSessionState({ referenceId: sessionReferenceId, sessionId: created.sessionId, status: 'open', isPrimary: true, displayName: name });
  } finally { metadata.close(); }
  return Object.freeze({ topicId, name, sessionReferenceId, sessionKey, sessionId: created.sessionId, folder, notePath: 'Resource-05.md', noteText: '# Fictional Resource 5\nRead-only fixture content.\n' });
}

async function seedNativeUnassignedConversation({ world, signal }) {
  const sessionKey = 'agent:main:command-center:acceptance-native:unassigned';
  const label = 'Fictional unassigned Conversation';
  const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
    method: 'sessions.create', params: { agentId: 'main', key: sessionKey, label }, scopes: ['operator.read', 'operator.write'], signal });
  const created = response?.result ?? response;
  assert.equal(created?.key, sessionKey);
  assert.ok(typeof created?.sessionId === 'string' && created.sessionId.length > 0);
  return Object.freeze({ sessionKey, sessionId: created.sessionId, label });
}

export async function readNativeControlUiReadiness({ world, signal }) {
  try {
    const catalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url,
      credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
    return !!catalog?.plugins?.find(entry => entry.pluginId === 'command-center')?.revision;
  } catch (error) {
    signal?.throwIfAborted();
    if (isGatewayStartupPending(error)) return false;
    throw error;
  }
}

async function waitForNativeControlUiReadiness({ world, host, signal, scale, observations }) {
  const startedAt = Date.now();
  const record = value => {
    if (!observations) return;
    recordStartupObservation(observations, { elapsedMs: Date.now() - startedAt, ...value });
  };
  if (scale) {
    // The scale import deliberately keeps the plugin startup owner busy before
    // the Control UI route can serve a complete response. Wait on that owner's
    // durable completion marker first so an accepted HTTP request cannot sit
    // behind the migration and consume the entire transport deadline.
    const stateDir = path.join(world.root, '.openclaw');
    await waitForConsecutiveReadiness(
      async () => {
        const databasePath = resolveCommandCenterDatabasePath(stateDir);
        if (observations) record({ stage: 'migration', ...readCommandCenterMigrationProgress(databasePath) });
        return isCommandCenterMigrationReady(databasePath);
      },
      host.earlyExit,
      { deadlineMs: 180_000, delayMs: 250, signal }
    );
  }
  let attempt = 0;
  await waitForConsecutiveReadiness(async (probeSignal) => {
    const observation = { stage: 'http', attempt: ++attempt, url: `${world.gateway.url}${runtimeCapability.bootstrap.path}`, status: null, error: null, bodyKeys: [] };
    try {
      const { response, body, parseError } = await fetchJsonWithDeadline(observation.url, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal: probeSignal }, { label: 'native Control UI readiness', timeoutMs: 10_000 });
      observation.status = response.status;
      observation.bodyKeys = body && typeof body === 'object' ? Object.keys(body).sort().slice(0, 24) : [];
      observation.error = parseError ? redactBrowserEvidence(parseError.message) : null;
      return response.ok && !parseError;
    } catch (error) {
      observation.error = redactBrowserEvidence(`${error?.category ?? error?.cause?.code ?? error?.code ?? 'transport'}: ${error?.message ?? 'readiness failed'}`);
      // The Gateway can accept bootstrap HTTP before plugin startup releases
      // the request. Treat only that bounded transport timeout as pending; the
      // outer readiness deadline and early-exit owner remain authoritative.
      if (error?.category === 'transport-timeout') return false;
      throw error;
    } finally {
      record(observation);
    }
  }, host.earlyExit, { required: 2, deadlineMs: scale ? 180_000 : 120_000, delayMs: 250, signal });
  // Static bootstrap HTTP can be available before authenticated Gateway
  // admission opens. Probe the read-only route before issuing any mutations.
  await waitForConsecutiveReadiness(probeSignal => readNativeControlUiReadiness({ world, signal: probeSignal }),
    host.earlyExit, { required: 1, deadlineMs: 30_000, delayMs: 250, signal });
}

export async function exerciseNativeControlUiActivation({ descriptor, buildReceipt, signal, onFinalization, onScaleProgress }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, onScaleProgress, keyboard: false });
}

// A bounded document-workspace fixture is separate from scale/performance
// qualification. It proves the usable 120-file reader at real host boundaries.
export async function exerciseNativeTopicNotesVisualJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, catalog: true });
}

// The reader workspace has a separate bounded real-host proof. It exercises
// only browsing, filtering, formatted/source reading and native pane
// composition; it deliberately stops before Conversation mutations, restart
// or performance qualification.
export async function exerciseNativeTopicNotesWorkspaceJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, catalog: true, notesWorkspaceOnly: true });
}

// The current delivery replaces the host's native Files surface.  Keep this
// isolated from the legacy Topic page journey so a pass proves the slot that
// users actually open next to native Chat.
export async function exerciseNativeTopicFilesWorkspaceJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, nativeFilesWorkspace: true });
}

// A deliberately small real-host reproduction of the Topic button path. It
// uses the authenticated native plugin, the exact Topic resolver and the
// host-owned Chat pane, but stops before unrelated Conversation, restart or
// performance work can obscure a navigation failure.
export async function exerciseNativeTopicChatHandoffJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, chatHandoffOnly: true });
}

// This is intentionally separate from the Reader journey: it proves that an
// actual native primary Chat can invoke our two narrow model tools without
// coupling that proof to Conversation-creation recovery.
export async function exerciseNativeTopicToolsJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  let fictionalModel;
  let providerEvidence = { ingress: [], actions: [], tools: [] };
  let nativeEventEvidence = [];
  try {
    return await withIsolatedWorld(async (world) => {
    fictionalModel = await startFictionalOpenAiModel({ firstTurnFinal: true });
    const configured = JSON.parse(await readFile(world.manifest.configPath, 'utf8'));
    configured.models.providers.fixture.baseUrl = fictionalModel.baseUrl;
    configured.models.providers.fixture.api = 'openai-completions';
    configured.models.providers.fixture.models[0].api = 'openai-completions';
    configured.models.providers.fixture.models[0].compat = { supportsTools: true };
    // The fictional provider is bound to this isolated world's loopback
    // endpoint. The host correctly blocks private destinations unless the
    // configured provider declares this narrow test-only allowance.
    configured.models.providers.fixture.request = { allowPrivateNetwork: true };
    configured.agents.entries = { ...(configured.agents.entries ?? {}), main: { model: 'fixture/fixture-model', modelPolicy: { allow: ['fixture/fixture-model'] } } };
    // Both Command Center model tools are deliberately optional in production.
    // The disposable fixture must opt into exactly these two capabilities to
    // exercise the native agent route; it does not alter release permissions.
    configured.tools = { ...(configured.tools ?? {}), alsoAllow: [...new Set([...(configured.tools?.alsoAllow ?? []), 'command_center_file_topic_attachment', 'command_center_update_working_note'])] };
    await writeFile(world.manifest.configPath, `${JSON.stringify(configured)}\n`);
    let host = await withDeadline('native tool host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    let removeAbortCleanup = stopHostOnAbort(signal, host);
    const browserGuard = new TrafficGuard();
    const evidence = { requests: [], responses: [], console: [], errors: [] };
    let managedBrowser;
    const abortBrowser = () => { void managedBrowser?.server.kill().catch(() => {}); };
    signal.addEventListener('abort', abortBrowser, { once: true });
    let failure;
    let result;
    try {
      await waitForNativeControlUiReadiness({ world, host, signal, scale: false });
      const fixture = await seedNativeExistingTopic({ world, host, signal });
      managedBrowser = await withDeadline('native tool browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }), 60_000, signal);
      const page = await managedBrowser.browser.newPage({ viewport: { width: 1366, height: 768 } });
      await configureEvidencePage(page, browserGuard, evidence);
      // Observe, but never modify, the native event stream. This test-only
      // evidence intentionally retains only structural lifecycle fields.
      await page.routeWebSocket('**/*', (socket) => {
        try { assertWebSocketDestination(browserGuard, socket.url()); }
        catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); void socket.close(); return; }
        const server = socket.connectToServer();
        socket.onMessage((payload) => server.send(payload));
        server.onMessage((payload) => {
          socket.send(payload);
          let message; try { message = JSON.parse(String(payload)); } catch { return; }
          const event = message?.payload ?? message?.event ?? message;
          const data = event?.data ?? event?.payload?.data ?? {};
          const stream = event?.stream ?? event?.payload?.stream;
          if ((message?.event === 'agent' || message?.type === 'event') && typeof stream === 'string' && nativeEventEvidence.length < 32) {
            nativeEventEvidence.push({ messageType: message?.type ?? null, eventName: message?.event ?? null, stream, phase: typeof data?.phase === 'string' ? data.phase : null,
              executionSettled: data?.executionSettled === true, toolName: stream === 'tool' && typeof data?.name === 'string' ? data.name : null,
              toolResultStatus: stream === 'tool' && typeof data?.result?.details?.status === 'string' ? data.result.details.status : null,
              filedDocumentPath: stream === 'tool' && typeof data?.result?.details?.document?.path === 'string' ? data.result.details.document.path : null,
              filedTopicIdPresent: stream === 'tool' && typeof data?.result?.details?.topicId === 'string',
              toolError: stream === 'tool' ? data?.isError === true : false,
              toolErrorCode: stream === 'tool' && typeof (data?.error?.code ?? data?.result?.details?.error?.code) === 'string'
                ? (data.error?.code ?? data.result.details.error.code) : null,
              hasRunId: typeof (event?.runId ?? event?.payload?.runId) === 'string', hasSessionKey: typeof (event?.sessionKey ?? event?.payload?.sessionKey) === 'string', hasSessionId: typeof (event?.sessionId ?? event?.payload?.sessionId) === 'string' });
          }
        });
      });
      await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const nativePage = page.locator('openclaw-plugin-page');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor({ timeout: 30_000 });
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey);
      // A settled native turn without a working-Note result must schedule the
      // durable catch-up. Verify that host boundary before the following turn
      // exercises the successful tool path, which correctly suppresses only
      // its own redundant catch-up.
      await chatPane.locator('.agent-chat__composer-combobox textarea').fill('[fixture:no-note] Acknowledge this turn without changing a Note.');
      await chatPane.getByRole('button', { name: 'Send message', exact: true }).press('Enter');
      await waitForConsecutiveReadiness(async () => fictionalModel.requests.some(entry => entry.action === 'final' && entry.currentRole === 'user'), host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      let jobs;
      await waitForConsecutiveReadiness(async () => {
        // Observe scheduling through the authenticated host boundary. The host
        // owns the SQLite coordinator while it is live, so this test must not
        // open a competing metadata reader merely to collect diagnostics.
        const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'cron.list', params: { includeDisabled: true }, scopes: ['operator.read', 'operator.write'], signal });
        jobs = response?.jobs ?? response?.result?.jobs ?? [];
        return jobs.some(job => isCommandCenterMaintenanceJob(job, fixture.sessionKey));
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const maintainedNote = '# Fictional Native Journey\n- Native working Note update from an isolated fictional model.\n';
      await chatPane.locator('.agent-chat__composer-combobox textarea').fill('Record this fictional working Note update.');
      await chatPane.getByRole('button', { name: 'Send message', exact: true }).press('Enter');
      await waitForConsecutiveReadiness(async () => fictionalModel.requests.some(entry => entry.action === 'maintain'), host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const maintenance = fictionalModel.requests.find(entry => entry.action === 'maintain');
      assert.ok(maintenance.tools.includes('command_center_update_working_note'), `The exact fixture model must receive both granted native tools: ${JSON.stringify({ ingress: fictionalModel.ingress, actions: fictionalModel.requests.map(entry => entry.action), tools: fictionalModel.requests.map(entry => entry.tools) })}`);
      await waitForConsecutiveReadiness(async () => (await readFile(path.join(fixture.folder, fixture.notePath), 'utf8')) === maintainedNote, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      // This compact but structurally valid PDF is a fictional original. The
      // journey verifies its exact stored bytes rather than treating an
      // extension or a requested tool call as filing evidence.
      const attachment = fictionalPdfBytes();
      await chatPane.locator('.agent-chat__file-input').setInputFiles({ name: 'fictional-topic-document.pdf', mimeType: 'application/pdf', buffer: attachment });
      await chatPane.locator('.chat-attachment-thumb').waitFor({ timeout: 30_000 });
      await chatPane.locator('.agent-chat__composer-combobox textarea').fill('File this fictional attachment in this Topic.');
      await chatPane.getByRole('button', { name: 'Send message', exact: true }).press('Enter');
      await waitForConsecutiveReadiness(async () => fictionalModel.requests.some(entry => entry.action === 'file'), host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const filing = fictionalModel.requests.find(entry => entry.action === 'file');
      assert.match(filing.mediaRef, /^media:\/\/inbound\//u);
      // The isolated host owns the exact durable source descriptor.  Verify
      // publication through that authenticated owner rather than treating a
      // harness pathname as authoritative: the latter can refer to a stale
      // fixture view after the host has enrolled its own descriptor.
      let filedDocument;
      await waitForConsecutiveReadiness(async () => {
        const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
          method: 'command-center.v1.notes.browse', params: { schemaVersion: 1, topicId: fixture.topicId, offset: 0, limit: 100, includeDocuments: true }, signal });
        const catalog = response?.result ?? response;
        const matches = catalog?.notes?.filter(note => note?.sourceKind === 'document'
          && /^Documents\/fictional-topic-document--[a-f0-9]{12}\.pdf$/u.test(note.path)
          && note.sourceReference?.topicId === fixture.topicId) ?? [];
        if (matches.length !== 1) return false;
        filedDocument = matches[0];
        return filedDocument.revision === `sha256:${createHash('sha256').update(attachment).digest('hex')}`;
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const readResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.notes.read', params: { schemaVersion: 1, topicId: fixture.topicId, referenceId: filedDocument.sourceReference.referenceId,
          path: filedDocument.path, observedRevision: filedDocument.revision, sourceKind: 'document', offset: 0 }, signal });
      const filedRead = readResponse?.result ?? readResponse;
      assert.equal(filedRead?.sourceReference?.topicId, fixture.topicId);
      assert.equal(filedRead?.revision, filedDocument.revision);
      assert.deepEqual(Buffer.from(filedRead?.contentBase64 ?? '', 'base64'), attachment, 'The exact native Topic source must return the original fictional PDF bytes.');
       result = Object.freeze({ workingNoteTool: true, attachmentFilingTool: true, maintenanceCatchUpScheduled: true, filedMediaRef: filing.mediaRef, maintenanceJobs: jobs.filter(job => isCommandCenterMaintenanceJob(job, fixture.sessionKey)).length });
    } catch (error) { failure = error; }
    finally {
      providerEvidence = Object.freeze({
        ingress: fictionalModel.ingress.slice(0, 8).map(entry => entry),
        actions: fictionalModel.requests.slice(0, 8).map(entry => ({ action: entry.action, currentRole: entry.currentRole, currentToolResultId: entry.currentToolResultId, currentToolStatus: entry.currentToolStatus, completedCurrentTool: entry.completedCurrentTool, transcriptShape: entry.transcriptShape })),
        tools: fictionalModel.requests.slice(0, 2).map(entry => entry.tools)
      });
      const cleanup = await finalizeAcceptanceJourney({
        closeBrowser: cleanupSignal => closeManagedBrowser(managedBrowser, cleanupSignal),
        stopHost: async () => { for (const generation of [...host.generations].reverse()) { await stopPinnedHost(generation.child); await generation.outputDrained; } },
        assertBrowserTraffic: () => browserGuard.assertClean(),
        assertHostTraffic: () => { for (const generation of host.generations) { generation.diagnostics.guard.assertClean(); assertNoFatalHostOutput(generation.diagnostics); } },
        assertChildTraffic: () => assertRecordedChildTraffic(world),
        assertBuildDigest: () => assertBuiltDigest(buildReceipt),
        onProgress: onFinalization
      });
      removeAbortCleanup();
      signal.removeEventListener('abort', abortBrowser);
      await fictionalModel.close(); fictionalModel = undefined;
      if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map(entry => entry.error)], 'Native tool journey finalization failed');
    }
    scanPublicEvidence([JSON.stringify(evidence)]);
    if (failure) throw new AggregateError([failure], `Native topic tool journey failed: ${JSON.stringify({ providerIngress: providerEvidence.ingress, completionActions: providerEvidence.actions, completionTools: providerEvidence.tools, nativeEventEvidence, host: host.generations.map(generation => boundedHostEvidence(generation.diagnostics)) })}`);
    return result;
    }, { candidateRoot: process.cwd() });
  } finally {
    await fictionalModel?.close();
  }
}

function fictionalPdfBytes() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(value, 'utf8')); value += object; }
  const xref = Buffer.byteLength(value, 'utf8');
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value, 'utf8');
}

export async function exerciseNativeScaleStartup({ descriptor, buildReceipt, signal, onFinalization, onDiagnostic }) {
  // Qualify the complete preparation/restart transition before measurement.
  return exerciseNativeStartup({ descriptor, buildReceipt, signal, onFinalization, onDiagnostic }, { scale: true, conversations: true, restart: true });
}

// Non-measuring reproduction of the preparation boundary. It shares startup,
// authenticated source reads and finalization, but never restarts for timing or
// launches the measured browser journey.
export async function exerciseNativeConversationPreparation(options, { scale = true } = {}) {
  return exerciseNativeStartup(options, { scale, conversations: true });
}

export async function exerciseNativeRetainedStartup(options, { scale = true, conversations = true } = {}) {
  return exerciseNativeStartup(options, { scale, conversations, restart: true });
}

export async function readRetainedNativeBootstrap(options, { waitForReady = waitForNativeControlUiReadiness, readBootstrap = readNativeLegacyBootstrap } = {}) {
  // A spawned successor is not yet an authenticated, listening Gateway.
  // This wait remains inside the caller's startup measurement and deadline.
  await waitForReady({ ...options, scale: options.scale === true });
  return readBootstrap(options);
}

async function exerciseNativeStartup({ descriptor, buildReceipt, signal, onFinalization, onDiagnostic }, { scale, conversations, restart = false }) {
  return withIsolatedWorld(async (world) => {
    const bootstrap = await prepareNativeLegacyBootstrap({ world, signal, scale });
    let host = await withDeadline('native scale host launch', launchSignal => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    let removeAbortCleanup = stopHostOnAbort(signal, host);
    const stages = [];
    const readinessAttempts = [];
    let failure;
    let result;
    try {
      await waitForNativeControlUiReadiness({ world, host, signal, scale, observations: readinessAttempts });
      const catalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
      const plugin = catalog?.plugins?.find(entry => entry.pluginId === 'command-center');
      assert.ok(plugin?.revision);
      const imported = await readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 1 });
      if (conversations) await prepareNativeScaleConversations({ world, host, signal, fixture: imported.fixture });
      stages.push('initial-readback-passed');
      if (restart) {
        await stopPinnedHost(host.child);
        await host.outputDrained;
        stages.push('predecessor-stopped');
        host = await withDeadline('native retained diagnostic restart', restartSignal => restartPinnedHost(host, { signal: restartSignal }), 120_000, signal);
        removeAbortCleanup();
        removeAbortCleanup = stopHostOnAbort(signal, host);
        stages.push('successor-launched');
        await readRetainedNativeBootstrap({ world, host, signal, bootstrap, expectedConversationCount: conversations ? 100 : 1, scale });
        stages.push('retained-readback-passed');
      }
      result = Object.freeze({ schemaVersion: 1, pluginId: 'command-center', revision: plugin.revision, fixtureCounts: Object.freeze({ noteBytes: Buffer.byteLength(bootstrap.noteText), noteFiles: (bootstrap.scaleNotes?.length ?? 0) + 1, conversationMessages: bootstrap.prepared.occurrenceCount, conversations: conversations ? 100 : 1 }), readinessAttempts: Object.freeze([...readinessAttempts]), migrationReady: Boolean(imported.completion), retainedRestartVerified: restart });
    } catch (error) { failure = error; }
    finally {
      const cleanup = await finalizeAcceptanceJourney({
        closeBrowser: async () => {},
        stopHost: async () => { for (const generation of [...host.generations].reverse()) { await stopPinnedHost(generation.child); await generation.outputDrained; } },
        assertBrowserTraffic: () => {},
        assertHostTraffic: () => { for (const generation of host.generations) { generation.diagnostics.guard.assertClean(); assertNoFatalHostOutput(generation.diagnostics); if (generation.diagnostics.cleanupError) throw generation.diagnostics.cleanupError; } },
        assertChildTraffic: () => assertRecordedChildTraffic(world),
        assertBuildDigest: () => assertBuiltDigest(buildReceipt),
        onProgress: onFinalization
      });
      removeAbortCleanup();
      if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map(entry => entry.error)], 'Native scale startup finalization failed');
    }
    const diagnostic = Object.freeze({ schemaVersion: 1, scenario: restart ? 'diagnostic-retained-startup' : conversations ? 'diagnostic-conversation-preparation' : 'diagnostic-scale-startup', outcome: failure ? 'failed' : 'passed',
      stages: Object.freeze(stages), readinessAttempts: Object.freeze([...readinessAttempts]), host: boundedHostEvidence(host.diagnostics) });
    scanPublicEvidence([JSON.stringify(diagnostic)]);
    // Publish after cleanup and privacy checks, including on failure. The outer
    // slice may replace a timeout error, so error properties alone lose evidence.
    onDiagnostic?.(diagnostic);
    if (failure) throw failure;
    return result;
  }, { candidateRoot: process.cwd() });
}

// This is a separate retained row, not additional work inside the activation
// diagnostic's deadline. The dispatcher owns its total row budget; stage and
// resource deadlines remain bounded here. Runtime duration is not yet measured.
export async function exerciseNativeKeyboardJourney({ descriptor, buildReceipt, signal, onFinalization }) {
  return exerciseNativeJourney({ descriptor, buildReceipt, signal, onFinalization, keyboard: true });
}

export async function exerciseNativeJourney({ descriptor, buildReceipt, signal, keyboard = false, scale = false, catalog: catalogJourney = false, chatHandoffOnly = false, notesWorkspaceOnly = false, nativeFilesWorkspace = false, onFinalization, scaleDiagnostic = false, onScaleProgress, diagnosticBoundary }) {
  if (scaleDiagnostic) assert.equal(process.env.COMMAND_CENTER_CAPTURE_PERFORMANCE_BASELINE, undefined);
  const scaleNow = scaleDiagnostic ? () => 0 : () => performance.now();
  const progressStarted = performance.now();
  const progress = stage => { onScaleProgress?.({ stage, elapsedMs: Math.round(performance.now() - progressStarted) }); };
  assert.equal(keyboard && scale, false, 'Performance qualification cannot share a keyboard diagnostic');
  return withIsolatedWorld(async (world) => {
    const bootstrap = keyboard || nativeFilesWorkspace ? null : await prepareNativeLegacyBootstrap({ world, signal, scale, catalog: catalogJourney });
    const historySource = nativeFilesWorkspace ? await prepareNativeHistorySource({ world }) : null;
    let host = await withDeadline('native pinned host launch', (launchSignal) => launchPinnedHost({ descriptor, world, buildReceipt, signal: launchSignal }), 120_000, signal);
    let removeAbortCleanup = stopHostOnAbort(signal, host);
    const browserGuard = new TrafficGuard();
    const evidence = { requests: [], responses: [], console: [], errors: [] };
    let managedBrowser;
    let evidencePage;
    const abortBrowser = () => { void managedBrowser?.server.kill().catch(() => {}); };
    signal.addEventListener('abort', abortBrowser, { once: true });
    let failure;
    let result;
    const restartHost = async () => {
      const predecessor = host;
      await withDeadline('native retained host restart', async (restartSignal) => {
        host = await restartPinnedHost(predecessor, { signal: restartSignal });
        return host;
      }, 120_000, signal);
      removeAbortCleanup();
      removeAbortCleanup = stopHostOnAbort(signal, host);
      assert.notEqual(host.child, predecessor.child);
      assert.equal(host.endpoint, predecessor.endpoint);
      assert.equal(host.generations.length, predecessor.generations.length + 1);
      assert.ok(predecessor.child.exitCode !== null || predecessor.child.signalCode !== null);
      return host;
    };
    try {
      let pluginCatalog;
      progress('initial-readiness');
      // Startup-only diagnosis and measured scale use this exact owner.
      await waitForNativeControlUiReadiness({ world, host, signal, scale });
      await waitForConsecutiveReadiness(async () => {
        try {
          pluginCatalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.list', signal });
          return Array.isArray(pluginCatalog?.plugins) && pluginCatalog.plugins.some((plugin) => plugin.pluginId === 'command-center');
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
      const matches = pluginCatalog.plugins.filter((plugin) => plugin.pluginId === 'command-center');
      assert.equal(matches.length, 1);
      const native = matches[0];
      assert.match(native.revision, /^[a-f0-9]{64}$/u);
      const grantPrefix = '/__openclaw__/plugins/control-ui/command-center/';
      const entryUrl = new URL(native.entryUrl, world.gateway.url);
      assert.equal(entryUrl.origin, new URL(world.gateway.url).origin);
      assert.equal(entryUrl.pathname, `${grantPrefix}${native.revision}/entry.mjs`);
      assert.equal(entryUrl.search, '');
      assert.equal(entryUrl.hash, '');
      const { response, body, parseError } = await fetchJsonWithDeadline(`${world.gateway.url}${runtimeCapability.bootstrap.path}`, { headers: { authorization: `Bearer ${world.gatewayCredential}` }, signal }, { label: 'native authenticated bootstrap', timeoutMs: 10_000 });
      assert.equal(response.ok, true);
      assert.equal(parseError, undefined);
      assert.equal(body?.pluginAssetsRequireAuth, true);
      assert.equal(body?.pluginFrameGrants?.some((grant) => grant.pluginId === 'command-center' && grant.match === 'prefix' && grant.path === grantPrefix), true);
      assert.equal(JSON.stringify(body).includes(world.gatewayCredential), false);

      let bootstrapped = keyboard || nativeFilesWorkspace ? null : await readNativeLegacyBootstrap({ world, host, signal, bootstrap });
      let startupReadinessMs;
      if (scale) {
        progress('conversation-preparation');
        await prepareNativeScaleConversations({ world, host, signal, fixture: bootstrapped.fixture });
        // Corpus preparation is not timed. Stop the setup generation before the
        // measured restart; reuse the issued owner, state and reserved endpoint.
        await stopPinnedHost(host.child);
        await host.outputDrained;
        progress('retained-restart');
        const started = scaleNow();
        await restartHost();
        bootstrapped = await readRetainedNativeBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 100, scale: true,
          onReady: () => { startupReadinessMs = scaleNow() - started; } });
      }
      const fixture = keyboard || nativeFilesWorkspace
        ? await seedNativeExistingTopic({ world, host, signal, catalog: nativeFilesWorkspace })
        : bootstrapped.fixture;
      const resourceFixture = nativeFilesWorkspace ? await seedNativeResourceTopic({ world, signal }) : null;
      const unassignedFixture = nativeFilesWorkspace ? await seedNativeUnassignedConversation({ world, signal }) : null;
      let importedHistory;
      if (nativeFilesWorkspace) {
        // The host must not share its SQLite connection with fixture setup.
        // Persist the deliberate read-only import while it is stopped, then
        // restart the same configured host for the public reader journey.
        await stopPinnedHost(host.child); await host.outputDrained; removeAbortCleanup();
        importedHistory = await importNativeHistory({ world, topicId: fixture.topicId, source: historySource, hostRuntimeWrapper: host.host.wrapper });
        await restartHost();
        await waitForNativeControlUiReadiness({ world, host, signal, scale: false });
      }
      progress('browser-launch');
      managedBrowser = await withDeadline('native browser launch', () => launchManagedBrowser({ headless: true, timeout: 60_000 }), 60_000, signal);
      const page = await managedBrowser.browser.newPage({ viewport: { width: 1440, height: 900 } });
      if (keyboard) await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      evidencePage = await configureEvidencePage(page, browserGuard, evidence);
      if (scaleDiagnostic) page.setDefaultTimeout(10_000);
      let browserTopics;
      let browserNavigation;
      let browserNote;
      let browserChatSend;
      let browserChatAcknowledgement;
      const scaleResponses = { notes: undefined, rosters: [], rosterOverflow: false };
      const conversationLabel = scale ? 'Fictional Native Scale 100' : 'Fictional Native Follow-up';
      const messageText = 'Fictional native Conversation message for exact Session readback.';
      const attachmentMessageText = 'File this fictional native attachment into the exact Topic Documents folder.';
      // Observe the existing real-server WebSocket route without substituting
      // any request, response, authentication or activation report.
      await page.routeWebSocket('**/*', (socket) => {
        try { assertWebSocketDestination(browserGuard, socket.url()); }
        catch (error) { recordBounded(evidence.errors, redactBrowserEvidence(error.message)); void socket.close(); return; }
        const server = socket.connectToServer();
        const requests = new Map();
        socket.onMessage((payload) => {
          server.send(payload);
          let message; try { message = JSON.parse(String(payload)); } catch { return; }
          if (message?.type === 'req' && (['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.notes.read', 'command-center.v1.sessions.resolve-native', ...(scale ? ['command-center.v1.notes.browse', 'command-center.v1.sessions.browse'] : [])].includes(message.method) && message.params?.schemaVersion === 1 || message.method === 'sessions.list') && requests.size < 32) {
            requests.set(message.id, { method: message.method, params: message.params });
            if (scale && ['command-center.v1.sessions.browse', 'command-center.v1.sessions.resolve-native'].includes(message.method)) progress(`browser-rpc-request:${message.method}`);
          }
          if (message?.type === 'req' && message.method === 'chat.send' && [messageText, attachmentMessageText].includes(message.params?.message)) {
            browserChatSend = message;
          }
        });
        server.onMessage((payload) => {
          socket.send(payload);
          let message; try { message = JSON.parse(String(payload)); } catch { return; }
          if (message?.type !== 'res') return;
          if (browserChatSend?.id === message.id) browserChatAcknowledgement = message;
          const request = requests.get(message.id);
          requests.delete(message.id);
          if (!request || message.ok !== true) return;
          if (scale && ['command-center.v1.sessions.browse', 'command-center.v1.sessions.resolve-native'].includes(request.method)) progress(`browser-rpc-response:${request.method}`);
          const value = message.payload?.result ?? message.payload;
          if (request.method === 'command-center.v1.topics.list') browserTopics = value;
          if (request.method === 'command-center.v1.notes.read') browserNote = { input: request.params, value };
          if (request.method === 'command-center.v1.sessions.resolve-native') browserNavigation = { input: request.params, value };
          if (scale && request.method === 'command-center.v1.notes.browse') scaleResponses.notes = { input: request.params, value };
          if (request.method === 'sessions.list') {
            if (scaleResponses.rosters.length < 256) scaleResponses.rosters.push({ input: request.params, value });
            else scaleResponses.rosterOverflow = true;
          }
        });
      });
      const entryResponse = observeBrowserResponse(page.waitForResponse((candidate) => candidate.request().method() === 'GET' && candidate.url() === entryUrl.href, { timeout: 60_000 }), (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      // Navigate only through the real host router; its native loader imports
      // the revisioned entry and reports activation on its own live connection.
      progress('native-page-load');
      const topicsStarted = scaleNow();
      await page.goto(controlUiPluginUrl({ gatewayUrl: world.gateway.url, pluginId: 'command-center', routeId: 'topics', fragmentParameter: runtimeCapability.authentication.urlFragmentParameter, credential: world.gatewayCredential }), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const loadedEntry = await entryResponse;
      assert.equal(hasSuccessfulBrowserResponse(loadedEntry), true, `The actual native loader must fetch its granted revisioned asset: ${JSON.stringify({ expectedEntryPath: entryUrl.pathname, observed: loadedEntry.observed, responses: evidence.responses, errors: evidence.errors })}`);
      assert.deepEqual(await loadedEntry.value.body(), await readFile(path.join(process.cwd(), 'dist/native-ui/entry.mjs')), 'Native entry bytes must belong to the sealed candidate');
      const nativePage = page.locator('openclaw-plugin-page');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
      assert.equal(await nativePage.locator('iframe').count(), 0, 'Native activation must not fall back to the legacy iframe');
      if (scaleDiagnostic && diagnosticBoundary === 'roster-navigation') {
        progress('native-roster');
        await openNativeSessionRoster(page);
        result = { performanceQualified: false, rosterNavigation: true };
      } else if (nativeFilesWorkspace) {
      // Open the exact linked Conversation through the public Topic resolver.
      // The host then mounts the selected `session-files` replacement, which is
      // the only Files surface this delivery claims to qualify.
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const fixtureTopic = browserTopics.activeGroups.area.find((topic) => topic.topicId === fixture.topicId);
      assert.ok(fixtureTopic?.usable, 'The native Files journey must start from an exact usable Topic.');
      await nativePage.getByRole('button', { name: `Open ${fixture.name} in Chat`, exact: true }).press('Enter');
      const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      try {
        await chatPane.waitFor({ timeout: 30_000 });
      } catch (error) {
        const diagnostic = await page.locator('body').innerText().then((text) => text.slice(0, 4_000)).catch(() => 'unavailable');
        throw new Error(`Exact Topic navigation did not present native Chat: ${JSON.stringify(diagnostic)}`, { cause: error });
      }
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey, { timeout: 30_000 });
      await retainNativeJourneyStage('native-chat-open');

      // The native sidebar is initially collapsed. Open its public control
      // and invoke this exact Topic's visible Files action; the test must not
      // reach into the host session menu's private action objects.
      const expandSidebar = page.getByRole('button', { name: 'Expand sidebar', exact: true });
      if (await expandSidebar.count()) await expandSidebar.press('Enter');
      const topicSidebar = page.getByRole('navigation', { name: 'Topics and Conversations', exact: true });
      await topicSidebar.waitFor({ state: 'visible', timeout: 30_000 });
      // Global New remains native and unassigned; assignment is a separate,
      // visible Inbox action that must use the exact current Session identity.
      const globalNew = page.locator('openclaw-app-sidebar').getByRole('link', { name: 'New session', exact: true }).first();
      await globalNew.waitFor({ state: 'visible', timeout: 30_000 });
      const inbox = topicSidebar.getByRole('heading', { name: 'Inbox / Unassigned', exact: true }).locator('xpath=..');
      const inboxRow = inbox.getByRole('listitem').filter({ hasText: unassignedFixture.label });
      await inboxRow.waitFor({ state: 'visible', timeout: 30_000 });
      await inboxRow.getByRole('button', { name: 'Open Chat', exact: true }).press('Enter');
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, unassignedFixture.sessionKey, { timeout: 30_000 });
      const assignmentTopicSummary = topicSidebar.locator('summary').filter({ hasText: fixture.name });
      await assignmentTopicSummary.click({ timeout: 5_000 });
      const assignmentDetails = assignmentTopicSummary.locator('xpath=..');
      await assignmentDetails.getByRole('button', { name: 'Primary Conversation', exact: true }).press('Enter');
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey, { timeout: 30_000 });
      const currentInboxRow = inbox.getByRole('listitem').filter({ hasText: unassignedFixture.label });
      await currentInboxRow.locator('select').selectOption(fixture.topicId);
      await currentInboxRow.getByRole('button', { name: 'Assign to Topic', exact: true }).press('Enter');
      await waitForConsecutiveReadiness(async () => {
        const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
          method: 'command-center.v1.sessions.topic-context', params: { schemaVersion: 1, sessionKey: unassignedFixture.sessionKey }, signal });
        const context = response?.result ?? response;
        return context?.status === 'bound' && context.topicId === fixture.topicId && context.sessionId === unassignedFixture.sessionId;
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      await currentInboxRow.waitFor({ state: 'hidden', timeout: 30_000 });
      const assignedBrowseResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false }, signal });
      const assignedConversation = (assignedBrowseResponse?.result ?? assignedBrowseResponse)?.conversations?.find((row) => row?.sessionId === unassignedFixture.sessionId);
      assert.ok(assignedConversation, 'The authoritative Topic roster must contain the exact assigned Conversation.');
      const assignedLabel = assignedConversation.displayName || 'Linked Conversation';
      const assignedSummary = topicSidebar.locator('summary').filter({ hasText: fixture.name });
      const assignedDetails = assignedSummary.locator('xpath=..');
      if (!await assignedDetails.evaluate((element) => element instanceof HTMLDetailsElement && element.open)) await assignedSummary.click({ timeout: 5_000 });
      await assignedDetails.getByRole('button', { name: assignedLabel, exact: true }).waitFor({ timeout: 30_000 });
      await retainNativeJourneyStage('native-sidebar-assignment');
      const fixtureSummary = topicSidebar.locator('summary').filter({ hasText: fixture.name });
      await fixtureSummary.waitFor({ timeout: 30_000 });
      const fixtureDetails = fixtureSummary.locator('xpath=..');
      if (!await fixtureDetails.evaluate((element) => element instanceof HTMLDetailsElement && element.open)) {
        await fixtureSummary.click({ timeout: 5_000 });
        await page.waitForFunction((element) => element instanceof HTMLDetailsElement && element.open, await fixtureDetails.elementHandle(), { timeout: 5_000 });
      }
      await fixtureDetails.getByRole('button', { name: 'Open Topic Files', exact: true }).press('Enter');
      const reader = page.locator('[data-topic-reader-page="panel"]');
      try {
        await reader.waitFor({ state: 'visible', timeout: 30_000 });
      } catch (error) {
        const diagnostic = await page.locator('body').innerText().then((text) => text.slice(0, 4_000)).catch(() => 'unavailable');
        const selection = await page.evaluate(() => {
          const views = () => [...document.querySelectorAll('openclaw-plugin-view')].map((view) => ({
            surface: view.surface ?? null,
            text: view.textContent?.slice(0, 200) ?? '',
          }));
          for (const element of document.querySelectorAll('*')) {
            const plugins = element.context?.plugins;
            if (plugins && typeof plugins.selectedReplacement === 'function') {
              const selected = plugins.selectedReplacement('session-files');
              return {
                owner: element.tagName.toLowerCase(),
                selectedKey: selected?.key ?? null,
                registrations: plugins.registrations?.('replacements')?.map((entry) => ({
                  key: entry.key,
                  surface: entry.value?.surface,
                  aborted: entry.signal?.aborted === true,
                })) ?? [],
                views: views(),
                assets: performance.getEntriesByType('resource')
                  .map((entry) => entry.name)
                  .filter((name) => name.includes('control-ui-boot') || name.includes('control-ui-loader')),
              };
            }
          }
          return {
            owner: null,
            selectedKey: null,
            registrations: [],
            views: views(),
            assets: performance.getEntriesByType('resource')
              .map((entry) => entry.name)
              .filter((name) => name.includes('control-ui-boot') || name.includes('control-ui-loader')),
          };
        }).catch(() => ({ owner: 'unavailable', selectedKey: null, registrations: [] }));
        throw new Error(`Native Chat did not present its selected Files replacement: ${JSON.stringify({ diagnostic, selection })}`, { cause: error });
      }
      const explorer = reader.locator('.control-ui-file-explorer');
      await explorer.waitFor({ state: 'visible', timeout: 30_000 });
      await explorer.getByText(fixture.name, { exact: true }).waitFor({ timeout: 30_000 });
      // The host, not this replacement, owns pane movement.  Keep a bounded
      // inventory of the controls it actually presents in this real browser
      // so the subsequent visual acceptance uses a public control rather than
      // guessing from host internals or coordinates.
      const nativePaneControls = await chatPane.getByRole('button').evaluateAll((buttons) => buttons
        .filter((button) => {
          const style = getComputedStyle(button);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((button) => ({
          label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
          title: button.getAttribute('title') ?? '',
        }))
        .filter(({ label, title }) => label || title)
        .slice(0, 40));
      await retainNativeJourneyStage('native-files-root');
      // This delivery owns the Files replacement, not the retired flat Topics
      // page. Start at its real filter, then follow the browser's sequential
      // order to a file and activate it. This proves the keyboard path users
      // take inside the mounted native Files workspace without attributing
      // unrelated app-sidebar traversal to this replacement.
      const filter = explorer.getByRole('searchbox', { name: 'Filter files by name or path', exact: true });
      const overview = explorer.getByRole('button', { name: 'Overview.md', exact: true });
      await filter.focus();
      await tabTo(overview);
      await page.keyboard.press('Enter');
      // The first selection promotes the exact same Files contribution into
      // the main pane.  Its compact native tree remains mounted with the
      // reader, rather than returning to a flat Topic page.
      const noteContent = page.getByRole('region', { name: 'Note content', exact: true });
      await assertNativeFormattedNote(noteContent, fixture);
      assert.equal(browserNote?.input.topicId, fixture.topicId);
      assert.equal(browserNote?.input.path, fixture.notePath);
      assert.equal(browserNote?.value.sourceReference?.topicId, fixture.topicId);
      await retainNativeJourneyStage('native-files-overview');

      // Discover the live native composer shape before driving a draft through
      // the host-owned swap action. The synthetic fixture can render a
      // contenteditable composer rather than the textarea used by older
      // panes, so a selector must come from the mounted host—not a legacy
      // assumption that can leave the bounded journey waiting indefinitely.
      const nativeComposerControls = await chatPane.evaluate((pane) => [...pane.querySelectorAll('textarea, input, [contenteditable="true"]')]
        .filter((control) => {
          const style = getComputedStyle(control);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((control) => ({
          tag: control.tagName.toLowerCase(),
          type: control.getAttribute('type') ?? '',
          ariaLabel: control.getAttribute('aria-label') ?? '',
          placeholder: control.getAttribute('placeholder') ?? '',
          className: typeof control.className === 'string' ? control.className : '',
        }))
        .slice(0, 20));
      const composer = chatPane.locator('textarea[aria-label="Chat composer"]');
      await composer.waitFor({ state: 'visible', timeout: 5_000 });
      const [explorerHandle, composerHandle] = await Promise.all([explorer.elementHandle(), composer.elementHandle()]);
      assert.ok(explorerHandle && composerHandle, 'The mounted Files explorer and native Chat composer must have stable elements.');
      const explorerScroll = explorer.locator('.chat-workspace-rail__scroll');
      await explorerScroll.waitFor({ state: 'visible', timeout: 5_000 });
      // The full catalog is intentionally folded at launch. Use the native
      // disclosure controls to reveal the representative depth-three folder
      // before proving scroll retention. Keyboard selection remains exercised
      // on the host's real filter, file rows, Reading/Source and media controls
      // below; native summary disclosure is pointer-operated in this host.
      const expandFolder = async (folder) => {
        const details = folder.locator('xpath=..');
        await folder.waitFor({ state: 'visible', timeout: 5_000 });
        const open = await details.evaluate((element) => element instanceof HTMLDetailsElement && element.open);
        if (!open) await folder.click({ timeout: 5_000 });
        await page.waitForFunction((element) => element instanceof HTMLDetailsElement && element.open, await details.elementHandle(), { timeout: 5_000 });
        return details;
      };
      // The native component uses the Topic name as a path label, not as a
      // synthetic folder. Traverse only its documented relative-path tree:
      // root tree → Z Projects → Alpha → Planning.
      let folderLevel = explorer.locator('.chat-workspace-rail__scroll > ul[role="tree"]');
      for (const folderName of ['Z Projects', 'Alpha', 'Planning']) {
        const folder = folderLevel.locator(':scope > li[role="treeitem"] > details > summary')
          .filter({ has: page.getByText(folderName, { exact: true }) });
        assert.equal(await folder.count(), 1, `Native Files must expose one exact ${folderName} disclosure at this path.`);
        const details = await expandFolder(folder);
        folderLevel = details.locator(':scope > ul[role="group"]');
      }
      // Each native disclosure update preserves its old scroll in the next
      // animation frame. Let the host finish that supported paint cycle before
      // measuring a subsequent user PageDown; otherwise this synthetic burst
      // can let an older restore overwrite the test's own scroll input.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const scrollHandle = await explorerScroll.elementHandle();
      assert.ok(scrollHandle, 'Native Files must expose its keyboard-focusable scroll container.');
      await explorerScroll.evaluate((element) => {
        if (element.scrollHeight <= element.clientHeight) throw new Error('Expanded Files tree did not overflow.');
      });
      await explorerScroll.focus({ timeout: 5_000 });
      await page.keyboard.press('PageDown');
      await page.waitForFunction((element) => element.scrollTop > 0, scrollHandle, { timeout: 5_000 });
      // Chromium completes keyboard scrolling over successive animation frames.
      // Capture the user's settled position, not an arbitrary in-flight offset,
      // before proving that native pane promotion retains it.
      await page.evaluate(async (element) => {
        let previous = element.scrollTop;
        let stableFrames = 0;
        for (let frame = 0; frame < 24; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const next = element.scrollTop;
          stableFrames = next === previous ? stableFrames + 1 : 0;
          if (stableFrames >= 3) return;
          previous = next;
        }
        throw new Error("Native Files PageDown did not settle before pane swap.");
      }, scrollHandle);
      const snapshotNativeFilesScroll = () => explorerScroll.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const visible = [...element.querySelectorAll('[role="treeitem"]')].find((item) => {
          const itemRect = item.getBoundingClientRect();
          return itemRect.bottom > rect.top && itemRect.top < rect.bottom;
        });
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          maxScrollTop: element.scrollHeight - element.clientHeight,
          firstVisible: visible?.textContent?.trim() ?? null,
          firstVisibleOffset: visible ? Math.round(visible.getBoundingClientRect().top - rect.top) : null,
          expanded: [...element.querySelectorAll('details[open] > summary')].map((summary) => summary.textContent?.trim() ?? '')
        };
      });
      const explorerScrollAfterPageDown = await snapshotNativeFilesScroll();
      assert.ok(explorerScrollAfterPageDown.scrollTop > 0, 'The complete native Files tree must support a nonzero retained scroll position.');
      const unsentDraft = 'Fictional native Chat draft retained through Files swap.';
      await composer.fill(unsentDraft, { timeout: 5_000 });
      const explorerScrollBeforeLayout = await snapshotNativeFilesScroll();
      await retainNativeJourneyStage('native-files-draft-ready');
      const swap = chatPane.locator('.chat-panel-swap');
      await swap.click({ timeout: 5_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey, { timeout: 5_000 });
      await reader.waitFor({ state: 'visible', timeout: 5_000 });
      assert.equal(await composer.inputValue(), unsentDraft, 'Swapping native Chat and Files must retain the unsent Chat draft.');
      assert.equal(await reader.evaluate((element) => element.closest('[data-region]')?.getAttribute('data-region')), 'side', 'Files must move to the native side region after swap.');
      assert.equal(await explorer.evaluate((element, original) => element === original, explorerHandle), true, 'Swap must retain the same mounted Files explorer.');
      assert.equal(await composer.evaluate((element, original) => element === original, composerHandle), true, 'Swap must retain the same native Chat composer.');
      const explorerScrollAfterSwap = await snapshotNativeFilesScroll();
      assert.equal(explorerScrollAfterSwap.scrollTop, explorerScrollBeforeLayout.scrollTop, `Swap must retain the Files scroll position: ${JSON.stringify({ afterPageDown: explorerScrollAfterPageDown, beforeSwap: explorerScrollBeforeLayout, afterSwap: explorerScrollAfterSwap })}`);
      await retainNativeJourneyStage('native-files-swapped-draft');
      await retainTopicNotesScreenshot(page, 'native-files-swapped-draft-1530');
      const layoutMenu = chatPane.locator('.chat-panel-layout-menu');
      await layoutMenu.getByRole('button', { name: 'Layout', exact: true }).click({ timeout: 5_000 });
      const nativeLayoutControls = await layoutMenu.locator('wa-dropdown-item').evaluateAll((items) => items
        .filter((item) => {
          const style = getComputedStyle(item);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')
        .filter(Boolean)
        .slice(0, 30));
      await layoutMenu.locator('wa-dropdown-item[value="left"]').click({ timeout: 5_000 });
      await chatPane.locator('.sidebar-region--left').waitFor({ state: 'visible', timeout: 5_000 });
      await reader.waitFor({ state: 'visible', timeout: 5_000 });
      assert.equal(await composer.inputValue(), unsentDraft, 'Docking native Files must retain the unsent Chat draft.');
      const sideRegion = chatPane.locator('[data-region="side"]').first();
      const mainRegion = chatPane.locator('[data-region="main"]').first();
      const [sideBeforeResize, mainBeforeResize] = await Promise.all([sideRegion.boundingBox(), mainRegion.boundingBox()]);
      assert.ok(sideBeforeResize && mainBeforeResize && sideBeforeResize.width > 0 && mainBeforeResize.width > 0, 'Docked Files and Chat must remain visible.');
      const divider = chatPane.getByRole('separator', { name: 'Resize side panel', exact: true });
      await divider.focus({ timeout: 5_000 });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(100);
      const [sideAfterResize, mainAfterResize] = await Promise.all([sideRegion.boundingBox(), mainRegion.boundingBox()]);
      assert.ok(sideAfterResize && mainAfterResize && sideAfterResize.width > sideBeforeResize.width && mainAfterResize.width < mainBeforeResize.width, 'Keyboard resize must change the native docked panel dimensions.');
      assert.equal(await explorer.evaluate((element, original) => element === original, explorerHandle), true, 'Dock/resize must retain the same mounted Files explorer.');
      assert.equal(await composer.evaluate((element, original) => element === original, composerHandle), true, 'Dock/resize must retain the same native Chat composer.');
      assert.equal(await explorerScroll.evaluate((element) => element.scrollTop), explorerScrollBeforeLayout.scrollTop, 'Dock/resize must retain the Files scroll position.');
      await retainNativeJourneyStage('native-files-docked-resized-draft');
      await retainTopicNotesScreenshot(page, 'native-files-docked-draft-1530');

      // Verify a nested item beyond the first browse page via the host's
      // native quick filter.  This intentionally drives the component's
      // public keyboard-accessible control, never an unbounded filesystem API.
      await filter.focus();
      await page.keyboard.type('Fictional-Document-111');
      const nested = explorer.getByRole('button', { name: 'Fictional-Document-111.md', exact: true });
      await tabTo(nested);
      await page.keyboard.press('Enter');
      const nestedFixture = fixture.catalogNotes.find((entry) => entry.path.endsWith('Fictional-Document-111.md'));
      assert.ok(nestedFixture, 'The native Files fixture must contain the selected nested document.');
      await assertNativeFormattedNote(page.getByRole('region', { name: 'Note content', exact: true }), { noteText: nestedFixture.text });
      await retainNativeJourneyStage('native-files-filtered-selection');

      const sourceToggle = page.getByRole('button', { name: 'Source', exact: true });
      await sourceToggle.focus();
      await page.keyboard.press('Enter');
      const source = page.getByRole('region', { name: 'Note source', exact: true });
      await source.filter({ hasText: nestedFixture.text.trim() }).waitFor({ timeout: 30_000 });
      assert.equal(await source.textContent(), nestedFixture.text);
      const readingToggle = page.getByRole('button', { name: 'Reading', exact: true });
      await readingToggle.focus();
      await page.keyboard.press('Enter');
      await filter.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await explorer.getByRole('button', { name: 'Overview.md', exact: true }).waitFor({ timeout: 30_000 });

      // Documents are pre-existing, fictional Topic files. Opening them
      // proves the same exact browse/read owner used by Notes; it never
      // exercises upload filing or a remote preview URL.
      const pdfName = path.basename(fixture.documents.pdfPath);
      const pngName = path.basename(fixture.documents.pngPath);
      await filter.focus();
      await page.keyboard.type(pdfName);
      const pdf = explorer.getByRole('button', { name: pdfName, exact: true });
      await tabTo(pdf);
      await page.keyboard.press('Enter');
      const preview = page.getByRole('region', { name: 'Original attachment preview', exact: true });
      await preview.getByRole('status').filter({ hasText: 'Page 1 of 2' }).waitFor({ timeout: 30_000 });
      await preview.getByRole('button', { name: 'Next page', exact: true }).press('Enter');
      await preview.getByRole('status').filter({ hasText: 'Page 2 of 2' }).waitFor({ timeout: 30_000 });
      const pdfWidth = await preview.locator('canvas').evaluate(canvas => canvas.width);
      await preview.getByRole('button', { name: 'Zoom in', exact: true }).press('Enter');
      await page.waitForFunction(width => (document.querySelector('[aria-label="Original attachment preview"] canvas')?.width ?? 0) > width, pdfWidth, { timeout: 30_000 });
      await preview.getByRole('status').filter({ hasText: 'Page 2 of 2' }).waitFor({ timeout: 30_000 });
      const download = page.waitForEvent('download', { timeout: 30_000 });
      await page.getByRole('button', { name: 'Download original attachment', exact: true }).press('Enter');
      assert.equal((await download).suggestedFilename(), pdfName);
      await retainTopicNotesScreenshot(page, 'native-files-pdf-1530');
      await retainNativeJourneyStage('native-files-pdf');

      await filter.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(pngName);
      const image = explorer.getByRole('button', { name: pngName, exact: true });
      await tabTo(image);
      await page.keyboard.press('Enter');
      await preview.getByRole('img', { name: pngName, exact: true }).waitFor({ timeout: 30_000 });
      await preview.getByRole('button', { name: 'Zoom in', exact: true }).press('Enter');
      await retainTopicNotesScreenshot(page, 'native-files-image-1530');
      await retainNativeJourneyStage('native-files-image');

      for (const extension of ['jpg', 'webp']) {
        await filter.focus();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type(`preview.${extension}`);
        const alternative = explorer.getByRole('button', { name: `preview.${extension}`, exact: true });
        await tabTo(alternative);
        await page.keyboard.press('Enter');
        await preview.getByRole('img', { name: `preview.${extension}`, exact: true }).waitFor({ timeout: 30_000 });
      }

      await filter.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('unavailable.bin');
      const unavailable = explorer.getByRole('button', { name: 'unavailable.bin', exact: true });
      await tabTo(unavailable);
      await page.keyboard.press('Enter');
      await page.getByText(/Preview unavailable:/u).waitFor({ timeout: 30_000 });
      // A prior unsupported document cannot poison a later exact preview.
      await filter.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(pngName);
      await tabTo(image);
      await page.keyboard.press('Enter');
      await preview.getByRole('img', { name: pngName, exact: true }).waitFor({ timeout: 30_000 });
      await retainNativeJourneyStage('native-files-fallback');
      await filter.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await retainTopicNotesScreenshot(page, 'native-files-reader-1440');

      assert.equal(browserNavigation?.input.topicId, fixture.topicId);
      assert.equal(browserNavigation?.input.referenceId, fixture.sessionReferenceId);
      // The versioned bridge retains its result envelope, while the host-native
      // resolver intentionally exposes a flat `{ sessionKey }` target. Observe
      // the exact key in either legitimate transport shape; the assertions above
      // already prove the request used this Topic's persisted reference.
      assert.equal(browserNavigation?.value?.sessionKey ?? browserNavigation?.value?.result?.sessionKey, fixture.sessionKey);
      // Refresh the presentation-only sidebar after the second exact Topic has
      // been admitted. The public Topic Files action performs the atomic,
      // resolver-authorized handoff to that Topic's Primary Chat and Files
      // surface; do not chain a stale sidebar locator through an intervening
      // host-owned session selection.
      await page.getByRole('button', { name: 'Refresh Topic workspace', exact: true }).press('Enter');
      const workspaceSidebar = page.getByRole('navigation', { name: 'Topics and Conversations', exact: true });
      const resourceSummary = workspaceSidebar.locator('summary').filter({ hasText: resourceFixture.name });
      await resourceSummary.waitFor({ timeout: 30_000 });
      const resourceDetails = resourceSummary.locator('xpath=..');
      if (!await resourceDetails.evaluate((element) => element instanceof HTMLDetailsElement && element.open)) {
        await resourceSummary.click({ timeout: 5_000 });
        await page.waitForFunction((element) => element instanceof HTMLDetailsElement && element.open, await resourceDetails.elementHandle(), { timeout: 5_000 });
      }
      await resourceDetails.getByRole('button', { name: 'Open Topic Files', exact: true }).press('Enter');
      await page.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, resourceFixture.sessionKey, { timeout: 30_000 });
      const resourceChatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      try {
        await resourceChatPane.locator('.control-ui-file-explorer').getByText(resourceFixture.name, { exact: true }).waitFor({ timeout: 30_000 });
      } catch (error) {
        const diagnostic = await page.evaluate(() => [...document.querySelectorAll('openclaw-plugin-view')].map((view) => ({
          surface: view.surface ?? null,
          props: view.props ?? null,
          text: view.textContent?.slice(0, 400) ?? '',
        }))).catch(() => []);
        throw new Error(`The native Files replacement did not follow the selected Conversation: ${JSON.stringify(diagnostic)}`, { cause: error });
      }
      const resourceExplorer = resourceChatPane.locator('.control-ui-file-explorer');
      const resourceFilter = resourceExplorer.getByRole('searchbox', { name: 'Filter files by name or path', exact: true });
      await resourceFilter.focus();
      await page.keyboard.type(resourceFixture.notePath);
      const resourceNote = resourceExplorer.getByRole('button', { name: resourceFixture.notePath, exact: true });
      await tabTo(resourceNote);
      await page.keyboard.press('Enter');
      await assertNativeFormattedNote(page.getByRole('region', { name: 'Note content', exact: true }), resourceFixture);
      await retainTopicNotesScreenshot(page, 'native-files-resource-1440');
      await retainNativeJourneyStage('native-files-second-topic');
      // Imported history is a distinct, configured read-only source. It is
      // deliberately opened only through the Topic sidebar entry; no native
      // Chat composer or active-session resolver is involved. Reopen the
      // exact original Topic via its visible disclosure before choosing it.
      const originalTopicSummary = workspaceSidebar.locator('summary').filter({ hasText: fixture.name });
      await originalTopicSummary.waitFor({ timeout: 30_000 });
      const originalTopicDetails = originalTopicSummary.locator('xpath=..');
      if (!await originalTopicDetails.evaluate((element) => element instanceof HTMLDetailsElement && element.open)) {
        await originalTopicSummary.click({ timeout: 5_000 });
        await page.waitForFunction((element) => element instanceof HTMLDetailsElement && element.open, await originalTopicDetails.elementHandle(), { timeout: 5_000 });
      }
      await originalTopicDetails.getByRole('button', { name: /Imported History \(read-only\)/u }).press('Enter');
      await page.getByText('Read-only preserved history. Continue ongoing conversations in native Chat.', { exact: true }).waitFor({ timeout: 30_000 });
      await page.getByText('Fictional preserved imported history.', { exact: true }).waitFor({ timeout: 30_000 });
      await retainTopicNotesScreenshot(page, 'native-files-imported-history-1440');
      await retainNativeJourneyStage('native-files-imported-history');
      result = { existingTopicVerified: true, nativeFilesReplacement: true, nestedTreeBrowsing: true,
        filenameFiltering: true, authoritativeFormattedRead: true, sourceToggle: true,
        keyboardNativeFilesSelection: true, pdfPreview: true, verifiedOriginalDownload: true, imagePreview: true, jpegPreview: true, webpPreview: true, previewFallback: true,
        exactNativeChatHandoff: true, nativeChatVisible: true, secondTopicExactFilesRoot: true, configuredReadOnlyHistory: importedHistory?.historyId != null,
        nativePaneControls, nativeLayoutControls, nativeComposerControls, nativeChatDraftRetainedThroughSwap: true, nativeChatDraftRetainedThroughDock: true };
      } else if (notesWorkspaceOnly) {
      await retainNativeJourneyStage('topics-loaded');
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const fixtureTopic = browserTopics.activeGroups[fixture.paraCategory].find((topic) => topic.topicId === fixture.topicId);
      assert.ok(fixtureTopic?.usable, 'The Notes workspace must start from a usable existing Topic.');
      const planned = { path: 'Z Projects/Alpha/Planning/Plan.md',
        text: await readFile(path.join(fixture.folder, 'Z Projects', 'Alpha', 'Planning', 'Plan.md'), 'utf8') };
      const catalogPages = await readNativeCatalogPagesToPath({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        topicId: fixture.topicId, path: planned.path, signal });
      await retainNativeJourneyStage('open-topic-notes');
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor({ timeout: 30_000 });
      const workspace = nativePage.locator('[data-topic-notes-workspace]');
      const filter = workspace.getByRole('searchbox', { name: 'Filter filenames', exact: true });
      await workspace.getByText(nativeCatalogPageText(catalogPages[0]), { exact: true }).waitFor({ timeout: 30_000 });
      await workspace.getByText(`${catalogPages[0].notes.length} Topic files available.`, { exact: true }).waitFor({ timeout: 30_000 });
      await retainNativeJourneyStage('read-overview');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      const noteContent = nativePage.getByRole('region', { name: 'Note content', exact: true });
      await assertNativeFormattedNote(noteContent, fixture);
      await retainNativeJourneyStage('source-toggle');
      await assertNativeNoteSource(nativePage, fixture);
      assert.equal(browserNote?.input.topicId, fixture.topicId);
      assert.equal(browserNote?.input.path, fixture.notePath);
      assert.equal(browserNote?.value.sourceReference?.topicId, fixture.topicId);
      await retainNativeJourneyStage('filename-filter');
      const plannedPage = await openNativeCatalogPageForPath({ workspace, pages: catalogPages, path: planned.path });
      await filter.fill('Plan.md');
      const plannedMatches = plannedPage.notes.filter(note => note.path.toLocaleLowerCase().includes('plan.md')).length;
      await workspace.getByText(`${plannedMatches} of ${plannedPage.notes.length} Topic files match “Plan.md”.`, { exact: true }).waitFor({ timeout: 30_000 });
      const plannedButton = workspace.getByRole('button', { name: `Read ${planned.path}`, exact: true });
      await tabTo(plannedButton);
      await plannedButton.press('Enter');
      await assertNativeFormattedNote(noteContent, { noteText: planned.text });
      // The isolated fixture contains only fictional text. Retain one
      // representative pre-Chat view for inspected visual acceptance.
      await retainTopicNotesScreenshot(page, 'topic-notes-reader-1440');
      await retainNativeJourneyStage('open-native-chat');
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey, { timeout: 30_000 });
      await retainNativeJourneyStage('promote-and-swap-pane');
      await verifyNativeTopicNotesPane({ page, fixture,
        onStage: stage => retainNativeJourneyStage(`pane:${stage}`),
        onPromoted: async () => await retainTopicNotesScreenshot(page, 'topic-notes-pane-promoted-1440')
      });
      await retainNativeJourneyStage('complete');
      result = { existingTopicVerified: true, treeBrowsing: true, filenameFiltering: true, authoritativeFormattedRead: true,
        sourceToggle: true, keyboardFileSelection: true, centrePanePromotion: true, paneSwap: true,
        nativeChatDraftRetained: true, exactNativeChatHandoff: true };
      } else if (chatHandoffOnly) {
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const fixtureTopic = browserTopics.activeGroups[fixture.paraCategory].find((topic) => topic.topicId === fixture.topicId);
      assert.ok(fixtureTopic?.usable, 'The exact native Chat handoff must start from a usable existing Topic.');
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor({ timeout: 30_000 });
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await assertNativeFormattedNote(nativePage.getByRole('region', { name: 'Note content', exact: true }), fixture);
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey, { timeout: 30_000 });
      assert.equal(browserNavigation?.input.topicId, fixture.topicId);
      assert.equal(browserNavigation?.input.referenceId, fixture.sessionReferenceId);
      assert.equal(browserNavigation?.input.expectedSessionId, fixture.sessionId);
      assert.equal(browserNavigation?.value.sessionKey, fixture.sessionKey);
      assert.deepEqual(Object.keys(browserNavigation?.value ?? {}), ['sessionKey']);
      result = { existingTopicVerified: true, authoritativeNoteRead: true, exactNativeChatHandoff: true,
        sessionKey: fixture.sessionKey, sessionId: fixture.sessionId, referenceId: fixture.sessionReferenceId };
      } else if (keyboard) {
        result = await exerciseNativeKeyboardStates({ page, world, host, fixture, native, signal, restartHost, browserGuard });
      } else if (scale) {
        result = await exerciseNativeScaleStates({ page, world, host, signal, fixture, bootstrap, conversationLabel, messageText,
          startupReadinessMs, topicsStarted, measure: !scaleDiagnostic, onProgress: progress,
          observed: () => ({ topics: browserTopics, navigation: browserNavigation, chatSend: browserChatSend, chatAcknowledgement: browserChatAcknowledgement, ...scaleResponses }) });
        const playwrightPackage = JSON.parse(await readFile(new URL(import.meta.resolve('playwright-core/package.json')), 'utf8'));
        result = { ...result, browser: { engine: 'chromium', playwrightVersion: playwrightPackage.version, version: managedBrowser.browser.version() }, viewport: page.viewportSize() };
      } else {
      progress('primary-topics-readback');
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const authoritative = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
      const topics = authoritative?.result ?? authoritative;
      const authoritativeCategories = Object.keys(topics?.activeGroups ?? {}).sort();
      const visibleTopicCount = Object.values(topics?.activeGroups ?? {}).flat().length + (topics?.archived?.length ?? 0);
      assert.ok(visibleTopicCount > 0 || (topics?.recovery?.length ?? 0) === 0, 'Post-startup Topic discoverability failed: every existing Topic requires Source Recovery');
      assert.ok(authoritativeCategories.includes(fixture.paraCategory));
      assert.deepEqual(Object.keys(browserTopics.activeGroups).sort(), authoritativeCategories);
      for (const category of authoritativeCategories) {
        assert.ok(Array.isArray(topics.activeGroups[category]));
        assert.deepEqual(browserTopics.activeGroups[category], topics.activeGroups[category]);
      }
      await nativePage.getByRole('button', { name: 'Refresh Topics', exact: true }).waitFor();
      const fixtureTopic = topics.activeGroups[fixture.paraCategory].find((topic) => topic.name === fixture.name);
      assert.ok(fixtureTopic, 'The native journey must exercise an existing Topic, not an empty Topics diagnostic');
      assert.equal(fixtureTopic.usable, true, 'The existing Topic must have verified source bindings');
      assert.equal(fixtureTopic.topicId, fixture.topicId);
      progress('primary-sidebar-grouping');
      await selectNativeCategoryGrouping(page);
      progress('primary-sidebar-roster');
      await organizeNativeTopicConversations({ page, nativePage, fixture, observedRosters: () => scaleResponses.rosters });
      const planned = catalogJourney ? { path: 'Z Projects/Alpha/Planning/Plan.md',
        text: await readFile(path.join(fixture.folder, 'Z Projects', 'Alpha', 'Planning', 'Plan.md'), 'utf8') } : undefined;
      const catalogPages = catalogJourney ? await readNativeCatalogPagesToPath({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        topicId: fixture.topicId, path: planned.path, signal }) : undefined;
      progress('primary-note-read');
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      const noteContent = nativePage.getByRole('region', { name: 'Note content', exact: true });
      await assertNativeFormattedNote(noteContent, fixture);
      await assertNativeNoteSource(nativePage, fixture);
      assert.equal(browserNote?.input.topicId, fixture.topicId);
      assert.equal(browserNote?.input.path, fixture.notePath);
      assert.equal(browserNote?.value.sourceReference.topicId, fixture.topicId);
      assert.equal(browserNote?.value.sourceReference.referenceId, browserNote.input.referenceId);
      assert.equal(browserNote?.value.revision, `sha256:${createHash('sha256').update(fixture.noteText).digest('hex')}`);
      const originalNoteRead = structuredClone(browserNote);
      if (catalogJourney) {
        const workspace = nativePage.locator('[data-topic-notes-workspace]');
        const filter = workspace.getByRole('searchbox', { name: 'Filter filenames', exact: true });
        await workspace.getByText(nativeCatalogPageText(catalogPages[0]), { exact: true }).waitFor();
        await workspace.getByText(`${catalogPages[0].notes.length} Topic files available.`, { exact: true }).waitFor();
        const plannedPage = await openNativeCatalogPageForPath({ workspace, pages: catalogPages, path: planned.path });
        await filter.fill('Plan.md');
        const plannedMatches = plannedPage.notes.filter(note => note.path.toLocaleLowerCase().includes('plan.md')).length;
        await workspace.getByText(`${plannedMatches} of ${plannedPage.notes.length} Topic files match “Plan.md”.`, { exact: true }).waitFor();
        const plannedButton = workspace.getByRole('button', { name: `Read ${planned.path}`, exact: true });
        await tabTo(plannedButton);
        await plannedButton.press('Enter');
        await assertNativeFormattedNote(noteContent, { noteText: planned.text });
        await retainTopicNotesScreenshot(page, 'topic-notes-1440');
        await page.setViewportSize({ width: 1366, height: 768 });
        await nativePage.getByRole('region', { name: 'Note content', exact: true }).waitFor();
        await retainTopicNotesScreenshot(page, 'topic-notes-1366');
        await filter.fill('');
        await workspace.getByText(`${plannedPage.notes.length} Topic files available.`, { exact: true }).waitFor();
      }
      assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      const chatPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey, { timeout: 30_000 });
      assert.equal(browserNavigation?.input.topicId, fixture.topicId);
      assert.equal(browserNavigation?.input.referenceId, fixture.sessionReferenceId);
      assert.equal(browserNavigation?.input.expectedSessionId, fixture.sessionId);
      assert.equal(browserNavigation?.value.sessionKey, fixture.sessionKey);
      assert.deepEqual(Object.keys(browserNavigation?.value ?? {}), ['sessionKey']);
      if (!keyboard) await verifyNativeTopicNotesPane({ page, fixture,
        onPromoted: catalogJourney ? async () => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await retainTopicNotesScreenshot(page, 'topic-notes-pane-promoted-1440');
          await page.setViewportSize({ width: 1366, height: 768 });
          await retainTopicNotesScreenshot(page, 'topic-notes-pane-promoted-1366');
        } : undefined
      });
      // Return through the host's native navigation contribution, not a new
      // page.goto/document or a synthetic plugin activation.
      await page.locator('openclaw-app-sidebar [data-sidebar-entry="plugin:command-center/topics"]').getByRole('link', { name: 'Manage Topics', exact: true }).press('Enter');
      progress('primary-native-return');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await assertNativeFormattedNote(noteContent, fixture);
      assert.equal(await readFile(path.join(fixture.folder, fixture.notePath), 'utf8'), fixture.noteText, 'Native reading and Chat handoff must preserve the authoritative Note');
      const creationResponse = observeBrowserResponse(page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).origin === new URL(world.gateway.url).origin
        && new URL(response.url()).pathname === '/plugins/command-center/api/topic/actions'
        && response.request().postDataJSON()?.action === 'conversations.create', { timeout: 30_000 }),
      (error) => recordBounded(evidence.errors, redactBrowserEvidence(error.message)));
      browserNavigation = undefined;
      progress('primary-conversation-create');
      await nativePage.getByRole('textbox', { name: 'Conversation label', exact: true }).fill(conversationLabel);
      await nativePage.getByRole('button', { name: 'Create Conversation', exact: true }).press('Enter');
      const observedCreation = await creationResponse;
      assert.equal(hasSuccessfulBrowserResponse(observedCreation), true);
      const creationInput = observedCreation.value.request().postDataJSON();
      assert.deepEqual(Object.keys(creationInput).sort(), ['action', 'expectedRevision', 'label', 'logicalOperationId', 'schemaVersion', 'topicId']);
      assert.equal(creationInput.topicId, fixture.topicId);
      assert.equal(creationInput.label, conversationLabel);
      assert.equal(creationInput.schemaVersion, 1);
      assert.match(creationInput.logicalOperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      const creationReceipt = await observedCreation.value.json();
      assert.equal(creationReceipt.status, 'applied');
      assert.equal(creationReceipt.logicalOperationId, creationInput.logicalOperationId);
      assert.equal(creationReceipt.result?.action, 'conversations.create');
      assert.equal(creationReceipt.result?.topicId, fixture.topicId);
      const newReferenceId = creationReceipt.result?.referenceId;
      assert.equal(typeof newReferenceId, 'string');
      assert.notEqual(newReferenceId, fixture.sessionReferenceId, 'Creating a Conversation must not reuse the existing Primary');
      // Replay the exact captured intent through the same declared authenticated
      // HTTP boundary. In particular, do not refresh its original Topic revision.
      const requestHeaders = observedCreation.value.request().headers();
      assert.equal(requestHeaders.authorization === `Bearer ${world.gatewayCredential}`, true);
      assert.equal(requestHeaders['x-openclaw-control-ui-relay'], undefined);
      const replay = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify(creationInput)
      }, { label: 'native Conversation exact-intent replay', timeoutMs: 30_000 });
      assert.equal(replay.response.ok, true);
      assert.equal(replay.parseError, undefined);
      assert.deepEqual(replay.body, creationReceipt, 'Completed replay must preserve the original receipt, not create or rebind a Conversation');
      const catalogResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false }, signal });
      const conversations = catalogResponse?.result ?? catalogResponse;
      assert.equal(conversations.topicId, fixture.topicId);
      assert.equal(conversations.conversations.length, 2, 'The existing Primary and one new Conversation must remain the complete Topic catalog after replay');
      assert.equal(conversations.conversations.find((row) => row.isPrimary)?.referenceId, fixture.sessionReferenceId);
      const createdConversations = conversations.conversations.filter((row) => row.referenceId === newReferenceId);
      assert.equal(createdConversations.length, 1, 'The exact created Conversation must belong to the original Topic');
      const createdConversation = createdConversations[0];
      assert.equal(createdConversation.status, 'open');
      assert.equal(createdConversation.isPrimary, false);
      assert.notEqual(createdConversation.sessionId, fixture.sessionId);
      await openNativeTopicConversation({ page, fixture, referenceId: newReferenceId });
      await waitForConsecutiveReadiness(async () => browserNavigation?.input?.referenceId === newReferenceId
        && typeof browserNavigation?.value?.sessionKey === 'string',
        host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const createdTarget = { sessionKey: browserNavigation.value.sessionKey, sessionId: browserNavigation.input.expectedSessionId };
      assert.equal(browserNavigation.input.topicId, fixture.topicId);
      assert.equal(browserNavigation.input.referenceId, newReferenceId);
      assert.deepEqual(Object.keys(browserNavigation.value), ['sessionKey']);
      assert.equal(createdTarget.sessionId, createdConversation.sessionId);
      assert.notEqual(createdTarget.sessionKey, fixture.sessionKey);
      assert.match(createdTarget.sessionKey, /^agent:main:.+$/u);
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, createdTarget.sessionKey, { timeout: 30_000 });
      await chatPane.locator('.agent-chat__composer-combobox textarea').fill(messageText);
      await chatPane.getByRole('button', { name: 'Send message', exact: true }).press('Enter');
      await waitForConsecutiveReadiness(async () => !!browserChatAcknowledgement,
        host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      progress('primary-chat-send');
      assert.equal(browserChatSend.params.sessionKey, createdTarget.sessionKey, 'The actual native composer must send to the newly linked Session');
      assert.equal(browserChatAcknowledgement.ok, true, 'The real host must acknowledge the native send');
      if (catalogJourney) {
        const attached = Buffer.from('%PDF-1.4\n% Fictional attachment used only by the isolated acceptance journey.\n');
        await chatPane.locator('.agent-chat__file-input').setInputFiles({ name: 'fictional-topic-document.pdf', mimeType: 'application/pdf', buffer: attached });
        await chatPane.locator('.chat-attachment-thumb').waitFor({ timeout: 30_000 });
        browserChatSend = undefined; browserChatAcknowledgement = undefined;
        await chatPane.locator('.agent-chat__composer-combobox textarea').fill(attachmentMessageText);
        await chatPane.getByRole('button', { name: 'Send message', exact: true }).press('Enter');
        await waitForConsecutiveReadiness(async () => !!browserChatAcknowledgement,
          host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
        assert.equal(browserChatSend.params.sessionKey, createdTarget.sessionKey, 'An attachment must remain bound to the exact linked native Chat Session.');
        assert.ok(Array.isArray(browserChatSend.params.attachments) && browserChatSend.params.attachments.length === 1, 'The real native composer must attach exactly one managed file.');
        assert.equal(browserChatAcknowledgement.ok, true, 'The real host must acknowledge the native attachment send.');
      }
      const containsUserMessage = (history) => history?.messages?.some((message) => message.role === 'user'
        && (message.text === messageText || message.content === messageText || Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && part.text === messageText)));
      let newHistory;
      await waitForConsecutiveReadiness(async () => {
        const response = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: createdTarget.sessionKey, signal });
        newHistory = response?.result ?? response;
        assert.equal(newHistory.sessionKey, createdTarget.sessionKey);
        assert.equal(newHistory.sessionId, createdTarget.sessionId);
        return containsUserMessage(newHistory);
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const primaryHistoryResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: fixture.sessionKey, signal });
      const primaryHistory = primaryHistoryResponse?.result ?? primaryHistoryResponse;
      assert.equal(primaryHistory.sessionId, fixture.sessionId);
      assert.equal(containsUserMessage(primaryHistory), false, 'New Conversation input must not leak into the existing Primary');
      await page.locator('openclaw-app-sidebar [data-sidebar-entry="plugin:command-center/topics"]').getByRole('link', { name: 'Manage Topics', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: 'Refresh Topics', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
      await nativePage.getByRole('button', { name: 'Refresh Notes', exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await assertNativeFormattedNote(noteContent, fixture);
      // Restart the issued host into this same world. No state copy, new
      // descriptor, source rebinding or fixture reseeding is permitted here.
      await nativePage.getByRole('button', { name: 'All Topics', exact: true }).press('Enter');
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor();
      progress('primary-retained-restart');
      const predecessor = host;
      await restartHost();
      assert.notEqual(host.child, predecessor.child);
      assert.equal(host.endpoint, predecessor.endpoint);
      assert.equal(host.generations.length, 2);
      assert.equal(host.generations[0].diagnostics, predecessor.diagnostics);
      assert.ok(predecessor.child.exitCode !== null || predecessor.child.signalCode !== null);
      let restartedCatalog;
      await waitForConsecutiveReadiness(async () => {
        try {
          restartedCatalog = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
            method: 'plugins.controlUi.list', signal });
          return restartedCatalog?.plugins?.some((plugin) => plugin.pluginId === 'command-center');
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 120_000, delayMs: 250, signal });
      const restartedNative = restartedCatalog.plugins.filter((plugin) => plugin.pluginId === 'command-center');
      assert.equal(restartedNative.length, 1);
      assert.equal(restartedNative[0].revision, native.revision);
      assert.equal(restartedNative[0].entryUrl, native.entryUrl);
      const restartedBootstrap = await readNativeLegacyBootstrap({ world, host, signal, bootstrap, expectedConversationCount: 2 });
      assert.deepEqual(restartedBootstrap, bootstrapped, 'Default startup must retain the exact bootstrap completion, source bindings and immutable imported prefix after restart');
      await waitForConsecutiveReadiness(async () => {
        try {
          const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
            method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
          const topics = response?.result ?? response;
          return topics?.activeGroups?.project?.some((topic) => topic.topicId === fixture.topicId && topic.usable === true);
        } catch (error) { signal.throwIfAborted(); recordBounded(evidence.errors, redactBrowserEvidence(error.message)); return false; }
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const restartedReplay = await fetchJsonWithDeadline(`${world.gateway.url}/plugins/command-center/api/topic/actions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${world.gatewayCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify(creationInput)
      }, { label: 'native Conversation original-intent replay after restart', timeoutMs: 30_000 });
      assert.equal(restartedReplay.response.ok, true);
      assert.equal(restartedReplay.parseError, undefined);
      assert.deepEqual(restartedReplay.body, creationReceipt, 'Restart must preserve the original creation receipt and stale original Topic revision');
      const restartedConversationsResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.sessions.browse', params: { schemaVersion: 1, topicId: fixture.topicId, includeClosed: false }, signal });
      const restartedConversations = restartedConversationsResponse?.result ?? restartedConversationsResponse;
      const catalogIdentities = (catalog) => catalog.conversations.map(({ referenceId, sessionId, isPrimary, status }) => ({ referenceId, sessionId, isPrimary, status }))
        .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
      assert.equal(restartedConversations.topicId, fixture.topicId);
      assert.equal(restartedConversations.conversations.length, 2);
      assert.deepEqual(catalogIdentities(restartedConversations), catalogIdentities(conversations), 'Both exact Session identities and the original Primary must survive restart/replay');
      const restartedHistoryResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: createdTarget.sessionKey, signal });
      const restartedHistory = restartedHistoryResponse?.result ?? restartedHistoryResponse;
      assert.equal(restartedHistory.sessionKey, createdTarget.sessionKey);
      assert.equal(restartedHistory.sessionId, createdTarget.sessionId);
      assert.equal(containsUserMessage(restartedHistory), true, 'The native user message must remain authoritative after host restart');
      const restartedPrimaryResponse = await readAuthenticatedHistory({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, sessionKey: fixture.sessionKey, signal });
      const restartedPrimary = restartedPrimaryResponse?.result ?? restartedPrimaryResponse;
      assert.equal(restartedPrimary.sessionKey, fixture.sessionKey);
      assert.equal(restartedPrimary.sessionId, fixture.sessionId);
      assert.equal(containsUserMessage(restartedPrimary), false);
      // Use a real document reload and native loader reconnect, discarding all
      // earlier observed values so a cached pre-restart projection cannot pass.
      browserTopics = undefined;
      browserNote = undefined;
      browserNavigation = undefined;
      progress('primary-reload-after-restart');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await nativePage.getByRole('heading', { name: 'Topics', exact: true }).waitFor({ timeout: 30_000 });
      await waitForConsecutiveReadiness(async () => !!browserTopics?.activeGroups, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      const restartedTopicResponse = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
        method: 'command-center.v1.topics.list', params: { schemaVersion: 1 }, signal });
      const restartedTopics = restartedTopicResponse?.result ?? restartedTopicResponse;
      assert.deepEqual(Object.keys(browserTopics.activeGroups).sort(), Object.keys(restartedTopics.activeGroups).sort());
      for (const category of Object.keys(restartedTopics.activeGroups)) assert.deepEqual(browserTopics.activeGroups[category], restartedTopics.activeGroups[category]);
      const restartedTopic = restartedTopics.activeGroups[fixture.paraCategory].filter((topic) => topic.topicId === fixture.topicId);
      assert.equal(restartedTopic.length, 1);
      assert.equal(restartedTopic[0].name, fixture.name);
      assert.equal(restartedTopic[0].usable, true);
      await nativePage.getByRole('button', { name: `View Notes for ${fixture.name}`, exact: true }).press('Enter');
      await nativePage.getByRole('button', { name: `Read ${fixture.notePath}`, exact: true }).press('Enter');
      await assertNativeFormattedNote(noteContent, fixture);
      assert.deepEqual(browserNote?.input, originalNoteRead.input);
      assert.equal(browserNote?.value.path, fixture.notePath);
      assert.equal(browserNote?.value.revision, originalNoteRead.value.revision);
      // Observation timestamps can advance on reads; durable identity and
      // content revision must not. Do not confuse metadata freshness with loss.
      for (const field of ['version', 'referenceId', 'topicId', 'sourceSystem', 'sourceKind', 'externalSourceId', 'observedRevision', 'createdAt']) {
        assert.deepEqual(browserNote?.value.sourceReference[field], originalNoteRead.value.sourceReference[field]);
      }
      assert.equal(await readFile(path.join(fixture.folder, fixture.notePath), 'utf8'), fixture.noteText);
      assert.equal(await nativePage.getByRole('textbox', { name: 'Note draft', exact: true }).count(), 0);
      assert.equal(await nativePage.getByRole('button', { name: 'Save Note', exact: true }).count(), 0);
      await nativePage.getByRole('button', { name: 'Open Topic in Chat', exact: true }).press('Enter');
      await chatPane.waitFor({ timeout: 30_000 });
      await page.waitForFunction((key) => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key, fixture.sessionKey);
      assert.equal(browserNavigation?.input.topicId, fixture.topicId);
      assert.equal(browserNavigation?.input.referenceId, fixture.sessionReferenceId);
      assert.equal(browserNavigation?.input.expectedSessionId, fixture.sessionId);
      assert.equal(browserNavigation?.value.sessionKey, fixture.sessionKey);
      assert.deepEqual(Object.keys(browserNavigation?.value ?? {}), ['sessionKey']);
      let activation;
      progress('primary-activation-readback');
      await waitForConsecutiveReadiness(async () => {
        // Admin is restricted to this diagnostic read; no synthetic activation
        // report or browser authority is supplied by the harness.
        const status = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential, method: 'plugins.controlUi.status', params: { pluginId: 'command-center' }, scopes: ['operator.admin'], signal });
        const activations = status?.clients?.flatMap((client) => client.activations ?? []) ?? [];
        activation = activations.find((entry) => entry.pluginId === 'command-center' && entry.revision === native.revision && entry.status === 'activated');
        return !!activation;
      }, host.earlyExit, { deadlineMs: 30_000, delayMs: 100, signal });
      progress('primary-complete');
      result = { pluginId: 'command-center', revision: native.revision, entryPath: entryUrl.pathname, grantPrefix, activationStatus: activation.status, topicsResponseObserved: true, nativeTopicsRendered: true,
        existingTopicVerified: true, authoritativeNoteRead: true, exactNativeChatHandoff: true, nativeReturnNoteRead: true,
        conversationCreationExercised: true, conversationExactReplayExercised: true, nativeChatSendExercised: true, authoritativeNewConversationMessageRead: true,
        retainedHostRestartExercised: true, nativeReloadAfterRestartExercised: true, originalCreationReplayAfterRestartExercised: true,
        assistantCompletionExercised: false,
        // These facts are emitted only after the actual native actions, exact
        // authoritative readbacks and retained host restart above all succeed.
        primary: { schemaVersion: 2, topicId: fixture.topicId,
          authoritativeReadback: { existingTopics: true, primarySession: true, conversation: true, note: true, chatSend: true, conversationAfterRestart: true },
          actions: ['existing-topic-open', 'note-read', 'native-chat-open', 'native-chat-send', 'conversation-create', 'conversation-replay', 'conversation-refresh', 'native-return'] },
        startup: { hostReceipt: { schemaVersion: descriptor.schemaVersion ?? 1, commit: host.host.commit, ...descriptor.integrity }, startupMigrationVerified: !!bootstrapped.completion, routeGrantObserved: true,
          nativeUi: { pluginId: 'command-center', revision: native.revision, activationObserved: activation.status === 'activated', authenticatedHttpObserved: true } } };
      }
    } catch (error) { failure = error; }
    finally {
      // Keep failure reporting inside the enclosing bounded slice: cleanup is
      // diagnostic evidence, never authority to consume its entire deadline.
      const cleanup = await finalizeAcceptanceJourney({
        closeBrowser: async (cleanupSignal) => {
          await closeManagedBrowser(managedBrowser, cleanupSignal);
          await evidencePage?.drain();
        },
        stopHost: async () => {
          for (const generation of [...host.generations].reverse()) {
            await stopPinnedHost(generation.child);
            await generation.outputDrained;
          }
        },
        assertBrowserTraffic: () => {
          evidencePage?.assertClean();
          browserGuard.assertClean();
        },
        assertHostTraffic: () => {
          for (const generation of host.generations) {
            generation.diagnostics.guard.assertClean();
            assertNoFatalHostOutput(generation.diagnostics);
            if (generation.diagnostics.cleanupError) throw generation.diagnostics.cleanupError;
          }
        },
        assertChildTraffic: () => assertRecordedChildTraffic(world),
        assertBuildDigest: () => assertBuiltDigest(buildReceipt),
        onProgress: onFinalization,
        timeoutMs: 20_000
      });
      removeAbortCleanup();
      signal.removeEventListener('abort', abortBrowser);
      if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup.map((entry) => entry.error)], 'Native activation finalization failed');
    }
    scanPublicEvidence([JSON.stringify(evidence), JSON.stringify(host.generations.map((generation) => boundedHostEvidence(generation.diagnostics)))]);
    if (failure) {
      // A readiness timeout otherwise loses the launched host's bounded,
      // redacted diagnostic output after fixture cleanup. Keep it on the
      // focused failure only; this is diagnostic evidence, never a pass.
      const hostEvidence = host.generations.map((generation) => boundedHostEvidence(generation.diagnostics));
      throw new AggregateError([failure], `Native activation failed; host=${JSON.stringify(hostEvidence)}`);
    }
    return result;
  }, { candidateRoot: process.cwd() });
}
