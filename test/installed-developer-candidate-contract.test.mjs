import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async name => readFile(new URL('../scripts/' + name, import.meta.url), 'utf8');

test('installed direct transport is per-call; shared acceptance launches retain omitted-selector behavior', async () => {
  const browser = await source('support/installed-developer-browser.mjs');
  const helper = await readFile(new URL('./support/real-host-runtime.mjs', import.meta.url), 'utf8');
  const acceptance = await readFile(new URL('./real-host.acceptance.test.mjs', import.meta.url), 'utf8');
  assert.match(browser, /launchManagedBrowser\(\{ headless: true, timeout: 60_000, executablePath \}, \{ transport: 'direct' \}\)/u);
  assert.doesNotMatch(browser, /process\.env\.COMMAND_CENTER_BROWSER_TRANSPORT/u);
  assert.match(helper, /launchManagedBrowser\(options, \{ transport \} = \{\}\)/u);
  assert.match(helper, /transport === 'direct' \|\| \(transport === undefined && process\.env\.COMMAND_CENTER_BROWSER_TRANSPORT === 'direct'\)/u);
  assert.match(helper, /chromium\.launch\(managedChromiumOptions\(options\)\)/u);
  assert.match(helper, /chromium\.launchServer\(managedChromiumOptions\(options\)\)/u);
  assert.match(acceptance, /launchManagedBrowser\(\{ headless: true, timeout: 60_000 \}\)/u);
  assert.doesNotMatch(acceptance, /launchManagedBrowser\([^\n]*\{ transport:/u);
});

test('fixed candidate smoke executes installed Code-to-Life browser journey before restart without dropping prior checks', async () => {
  const candidate = await source('smoke-candidate-pair.mjs');
  const installed = await source('smoke-dev-live-installed.mjs');
  const browser = await source('support/installed-developer-browser.mjs');
  assert.match(candidate, /import \{ runInstalledDevLiveJourney \} from '\.\/smoke-dev-live-installed\.mjs'/u);
  const invoke = candidate.indexOf('await runInstalledDevLiveJourney({ input, pair, inputTreeReceipt,');
  const restart = candidate.indexOf('run = await restartPinnedHost(run)');
  assert.ok(invoke > 0 && restart > invoke, 'candidate must await the installed journey before original restart');
  assert.match(candidate, /\.\.\.developerJourney\.checks/u);
  for (const original of ['assertCandidatePairEvidence(', 'assertCandidateArchiveBytes(', 'await assertBuiltDigest(',
    'await launchCandidateHost(', "assert.equal(bootstrap.status, 200)", "notificationStatus(world, 'sent')",
    "notificationStatus(world, 'cleared')", 'await restartPinnedHost(run)',
    "kind: 'candidate-pair-isolated-smoke'", "'child-traffic-isolation'"]) assert.ok(candidate.includes(original), original);
  assert.match(installed, /await invoke\('human_input_required'/u);
  assert.match(installed, /await installedBrowserHandoff\(/u);
  assert.match(installed, /assert\.ok\(!final\.attention\.some/u);
  assert.match(browser, /installedChromiumPath = '\/usr\/bin\/chromium'/u);
  assert.match(browser, /await requireInstalledChromium\(\)/u);
  assert.match(browser, /launchManagedBrowser\(\{ headless: true, timeout: 60_000, executablePath \}, \{ transport: 'direct' \}\)/u);
  // Attention and developer-work register native pages, unlike descriptor frames.
  assert.ok(browser.includes("page.locator('openclaw-plugin-page')"));
  assert.ok(browser.includes("page.locator('iframe.plugin-tab-embed__frame').count(), 0"));
  assert.ok(browser.includes('const route = await plugin(page);'));
  assert.ok(browser.includes("route.locator('openclaw-plugin-view [data-plugin-view-root]')"));
  assert.ok(browser.includes("root.waitFor({ state: 'attached'"));
  assert.doesNotMatch(browser, /contentFrame\(|getAttribute\('srcdoc'\)|getAttribute\('sandbox'\)/u);
  assert.ok(browser.includes("(await nativePlugin(lifePage)).getByRole('link'"));
  assert.ok(browser.includes("(await nativePlugin(codePage)).getByRole('button'"));
  assert.ok(browser.includes("(await nativePlugin(stalePage)).getByRole('button'"));
  assert.ok(browser.includes("(await nativePlugin(stalePage)).getByRole('heading'"));
  for (const page of ['codePage', 'wrongPage']) {
    assert.ok(browser.includes('(await plugin(' + page + ")).getByRole('button'"), page);
  }
  assert.match(browser, /await invoke\('request_resolved'/u);
  assert.match(browser, /method: 'sessions.delete'/u);
  assert.match(browser, /openclaw-chat-pane\[aria-hidden/u);
});
