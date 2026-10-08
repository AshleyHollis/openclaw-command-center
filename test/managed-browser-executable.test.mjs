import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// A fresh process makes Playwright resolve its managed cache after the owner
// supplied an empty cache and an existing explicit Chromium executable.
// Both actual launch APIs must use that executable, without downloading one.
for (const transport of ['direct', 'server']) {
  test(`managed ${transport} browser honors the owner's explicit executable with no managed browser installed`, { timeout: 60000 }, async t => {
    const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
    assert.equal((await stat(executable)).isFile(), true, 'Reuse an existing browser executable.');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-browser-binding-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'empty-browser-cache'); await mkdir(cache);
    const config = path.join(root, 'openclaw.json'); await writeFile(config, '{}\n');
    const runtime = new URL('./support/real-host-runtime.mjs', import.meta.url).href;
    const script = `import assert from 'node:assert/strict';
      const { launchManagedBrowser } = await import(process.argv[1]);
      const managed = await launchManagedBrowser({ headless: true, timeout: 30000 });
      try { const page = await managed.browser.newPage();
        await page.goto('data:text/html,<title>Fictional explicit browser</title>');
        assert.equal(await page.title(), 'Fictional explicit browser');
        console.log('explicit-existing-browser-pass');
      } finally { await managed.close(); }`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, runtime], {
      timeout: 50000, windowsHide: true,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache,
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: executable,
        COMMAND_CENTER_BROWSER_TRANSPORT: transport === 'direct' ? 'direct' : '',
        OPENCLAW_STATE_DIR: path.join(root, 'state'), OPENCLAW_CONFIG_PATH: config }
    });
    assert.match(result.stdout, /explicit-existing-browser-pass/);
  });
}

test('managed browser supplies real Chrome 200% layout zoom in a disposable private context', { timeout: 60000 }, async t => {
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  assert.equal((await stat(executable)).isFile(), true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-browser-zoom-owner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'empty-browser-cache'); await mkdir(cache);
  const config = path.join(root, 'openclaw.json'); await writeFile(config, '{}\n');
  const runtime = new URL('./support/real-host-runtime.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    import { readdir } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    const { launchManagedBrowser } = await import(process.argv[1]);
    await assert.rejects(launchManagedBrowser({ browserUiZoom: 1 }), /Only the selected browser 200%/);
    const managed = await launchManagedBrowser({ headless: true, timeout: 30000, browserUiZoom: 2 });
    try {
      assert.ok(managed.context); assert.equal(managed.browserUiZoom, 2);
      const page = await managed.context.newPage(); await page.setViewportSize({ width: 1200, height: 900 });
      await page.setContent('<!doctype html><style>body{font:16px sans-serif}</style><p>Fictional native browser zoom.</p>');
      const actual = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, font: getComputedStyle(document.body).fontSize, scale: visualViewport.scale }));
      assert.deepEqual(actual, { width: 600, ratio: 2, font: '16px', scale: 1 });
      const settings = await managed.context.newPage(); await settings.goto('chrome://settings/appearance');
      const zoom = settings.locator('settings-appearance-page #zoomLevel'); await zoom.waitFor({ state: 'attached', timeout: 10000 });
      assert.equal(await zoom.inputValue(), '2');
      assert.equal(await zoom.evaluate(select => select.selectedOptions[0].textContent.trim()), '200%');
    } finally { await managed.close(); }
    assert.equal((await readdir(tmpdir())).filter(name => name.startsWith('cc-native-browser-zoom-')).length, 0,
      'The managed owner must remove its disposable browser profile.');
    console.log('real-managed-browser-zoom-pass');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, runtime], {
    timeout: 50000, windowsHide: true,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: executable,
      COMMAND_CENTER_BROWSER_TRANSPORT: '', TMPDIR: root, TMP: root, TEMP: root,
      OPENCLAW_STATE_DIR: path.join(root, 'state'), OPENCLAW_CONFIG_PATH: config }
  });
  assert.match(result.stdout, /real-managed-browser-zoom-pass/);
});
