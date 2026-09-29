import assert from 'node:assert/strict';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { controlUiPluginUrl } from '../../src/acceptance-readiness.mjs';
import { runCandidateSmokeCleanup } from '../../src/candidate-smoke-stages.mjs';
import { runtimeCapability } from '../../src/runtime-capability.mjs';
import { TrafficGuard, assertWebSocketDestination } from '../../src/isolation.mjs';
import { closeManagedBrowser, configureEvidencePage, launchManagedBrowser, requestAuthenticatedGateway } from '../../test/support/real-host-runtime.mjs';

// Candidate Jobs use this source-reviewed executable, not the cc-focused-tests broker override.
export const installedChromiumPath = '/usr/bin/chromium';
export async function requireInstalledChromium(path = installedChromiumPath) {
  assert.equal(path, installedChromiumPath);
  assert.ok((await lstat(path)).isFile(), 'Installed Chromium is not a regular file');
  await access(path, constants.X_OK);
  return path;
}
const unwrap = value => value?.result ?? value;
// These routes are native registerPage contributions in the host's light DOM,
// not descriptor tabs. Denied authentication may leave the page without a mount.
const plugin = async page => {
  const route = page.locator('openclaw-plugin-page');
  assert.equal(await page.locator('iframe.plugin-tab-embed__frame').count(), 0, 'Unexpected descriptor iframe on native plugin route');
  return route;
};
const nativePlugin = async page => {
  const route = await plugin(page);
  await route.waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(await route.count(), 1, 'Expected one current native plugin page');
  const root = route.locator('openclaw-plugin-view [data-plugin-view-root]');
  await root.waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(await root.count(), 1, 'Expected one mounted native plugin view');
  return root;
};
const noChat = async page => assert.equal(await page.locator('openclaw-chat-pane[aria-hidden="false"]').count(), 0);
const uiUrl = (world, routeId) => controlUiPluginUrl({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
  pluginId: 'command-center', routeId, fragmentParameter: runtimeCapability.authentication.urlFragmentParameter });

export async function installedBrowserHandoff({ live, dev, handoff, card, sessionKey, created, workId, requestId, dashboard, invoke,
  onStage = () => {}, onFailure = () => {}, onCleanupFailure = () => {} }) {
  onStage('browser-preflight');
  const executablePath = await requireInstalledChromium();
  const guard = new TrafficGuard();
  const evidence = { requests: [], responses: [], console: [], errors: [] };
  let managed;
  let primaryFailed = false;
  try {
    onStage('browser-launch');
    managed = await launchManagedBrowser({ headless: true, timeout: 60_000, executablePath });
    const browser = managed.browser;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route('**/*', route => {
      try { guard.assert(new URL(route.request().url()).hostname, 'browser-popup'); return route.continue(); }
      catch { return route.abort(); }
    });
    await context.routeWebSocket('**/*', socket => {
      try { assertWebSocketDestination(guard, socket.url()); socket.connectToServer(); }
      catch { socket.close(); }
    });
    const lifePage = await context.newPage();
    const routes = [await configureEvidencePage(lifePage, guard, evidence)];
    const attention = new URL(uiUrl(live, 'attention'));
    attention.searchParams.set('p.attentionRecord', card.attentionRecordId);
    await lifePage.goto(attention.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    onStage('browser-attention-link');
    const link = (await nativePlugin(lifePage)).getByRole('link', { name: 'Open DEV Session', exact: true });
    await link.waitFor({ timeout: 30_000 });
    const href = new URL(await link.getAttribute('href'));
    assert.equal(href.href, card.evidence.devHandoffUrl);
    assert.equal(href.origin, handoff.url);
    assert.equal(href.hash, ''); assert.equal(href.username, ''); assert.equal(href.password, '');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    const popup = context.waitForEvent('page', { timeout: 30_000 });
    onStage('browser-unauthenticated');
    await link.click();
    const codePage = await popup;
    routes.push(await configureEvidencePage(codePage, guard, evidence));
    await codePage.waitForLoadState('domcontentloaded');
    assert.equal(new URL(codePage.url()).origin, handoff.url);
    assert.equal(new URL(codePage.url()).hash, '');
    await codePage.waitForTimeout(1200);
    assert.equal(await (await plugin(codePage)).getByRole('button', { name: 'Open exact Code session' }).count(), 0);
    await noChat(codePage);
    for (const credential of ['', live.gatewayCredential]) await assert.rejects(() => requestAuthenticatedGateway({
      gatewayUrl: dev.gateway.url, credential, method: 'command-center.v1.developer-work.resolve',
      params: { schemaVersion: 1, workId, requestId } }));
    const wrongContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const wrongPage = await wrongContext.newPage();
    routes.push(await configureEvidencePage(wrongPage, guard, evidence));
    const wrongUrl = new URL(href);
    wrongUrl.hash = runtimeCapability.authentication.urlFragmentParameter + '=' + encodeURIComponent(live.gatewayCredential);
    await wrongPage.goto(wrongUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await wrongPage.waitForTimeout(1200);
    assert.equal(await (await plugin(wrongPage)).getByRole('button', { name: 'Open exact Code session' }).count(), 0);
    await noChat(wrongPage);
    await wrongContext.close();
    assert.ok((await dashboard()).attention.some(row => row.episodeId === card.episodeId), 'Navigation resolved Life Attention');
    const authenticated = new URL(href);
    authenticated.hash = runtimeCapability.authentication.urlFragmentParameter + '=' + encodeURIComponent(dev.gatewayCredential);
    await codePage.goto(authenticated.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    onStage('browser-authenticated-chat');
    const open = (await nativePlugin(codePage)).getByRole('button', { name: 'Open exact Code session', exact: true });
    await open.waitFor({ timeout: 30_000 });
    await open.click();
    await codePage.waitForFunction(key => document.querySelector('openclaw-chat-pane[aria-hidden="false"]')?.sessionKey === key,
      sessionKey, { timeout: 30_000 });
    assert.equal(created.key, sessionKey);
    assert.ok((await dashboard()).attention.some(row => row.episodeId === card.episodeId), 'Chat resolved Life Attention');
    const stalePage = await context.newPage();
    onStage('browser-stale');
    routes.push(await configureEvidencePage(stalePage, guard, evidence));
    await stalePage.goto(authenticated.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const staleOpen = (await nativePlugin(stalePage)).getByRole('button', { name: 'Open exact Code session', exact: true });
    await staleOpen.waitFor({ timeout: 30_000 });
    await requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url, credential: dev.gatewayCredential,
      method: 'sessions.delete', params: { key: sessionKey, expectedSessionId: created.sessionId, deleteTranscript: true },
      scopes: ['operator.read', 'operator.write', 'operator.admin'] });
    const stale = unwrap(await requestAuthenticatedGateway({ gatewayUrl: dev.gateway.url, credential: dev.gatewayCredential,
      method: 'command-center.v1.developer-work.resolve', params: { schemaVersion: 1, workId, requestId } }));
    assert.equal(stale.status, 'stale'); assert.equal(stale.reason, 'session-replaced');
    await staleOpen.click();
    await (await nativePlugin(stalePage)).getByRole('heading', { name: 'This handoff is stale' }).waitFor({ timeout: 30_000 });
    await noChat(stalePage);
    onStage('browser-resolve');
    assert.ok((await dashboard()).attention.some(row => row.episodeId === card.episodeId), 'Session deletion resolved Life Attention');
    await invoke('request_resolved', { requestId, kind: 'input', expectedRequestRevision: 1 }, { code: 'answered', requestId });
    assert.ok(!(await dashboard()).attention.some(row => row.episodeId === card.episodeId), 'Explicit resolution left Life Attention active');
    for (const route of routes) { await route.drain(); route.assertClean(); }
    guard.assertClean();
    return ['live-attention-browser-link', 'cross-origin-code-authentication', 'installed-exact-code-chat',
      'navigation-keeps-attention', 'deleted-session-stale-browser', 'explicit-producer-resolution'];
  } catch (error) {
    primaryFailed = true;
    onFailure();
    throw error;
  } finally {
    await runCandidateSmokeCleanup([
      () => closeManagedBrowser(managed), () => guard.assertClean()
    ], primaryFailed, { stage: onStage, cleanupFailure: onCleanupFailure });
  }
}
