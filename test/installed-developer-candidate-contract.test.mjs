import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async name => readFile(new URL('../scripts/' + name, import.meta.url), 'utf8');

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
  assert.match(browser, /launchManagedBrowser\(\{ headless: true, timeout: 60_000, executablePath \}\)/u);
  assert.match(browser, /await invoke\('request_resolved'/u);
  assert.match(browser, /method: 'sessions.delete'/u);
  assert.match(browser, /openclaw-chat-pane\[aria-hidden/u);
});
