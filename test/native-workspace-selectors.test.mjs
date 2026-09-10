import test from 'node:test';
import { chromium } from 'playwright';
import { organizeNativeTopicConversations } from './support/native-topic-workspace.mjs';

test('native grouping journey selects a Topic row relative to its shadow-root page', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent('<openclaw-plugin-page></openclaw-plugin-page><section data-session-section="category:Sample"><button aria-expanded="true">Sample</button><div data-session-key="agent:main:sample">Overview</div></section>');
    await page.evaluate(() => {
      const root = document.querySelector('openclaw-plugin-page').attachShadow({ mode: 'open' });
      root.innerHTML = '<ul><li><button>View Notes for Sample</button><button id="organize">Organize Conversations in native group</button><p role="status"></p></li></ul>';
      root.querySelector('#organize').onclick = () => { root.querySelector('[role="status"]').textContent = '1 Conversations organized. 0 left unchanged.'; };
    });
    await organizeNativeTopicConversations({ page, nativePage: page.locator('openclaw-plugin-page'), fixture: { name: 'Sample', sessionKey: 'agent:main:sample' } });
  } finally { await browser.close(); }
});
