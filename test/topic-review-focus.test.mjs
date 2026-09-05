import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';

test('review rerenders retain keyboard focus through decisions without stealing outside focus', async () => {
  const browser = await launchPinnedChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    page.setDefaultTimeout(5_000);
    const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    await page.setContent(index.replace('<script defer src="/plugins/command-center/app.js"></script>', '').replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${styles}</style>`));
    await page.addScriptTag({ content: app });
    await page.evaluate(() => {
      applyOperatingState({ mode: 'ready', unavailableCapabilities: [] });
      const proposal = (id, state = 'pending') => ({ proposalId: id, revision: 1, operation: 'archive', state, affectedTopicIds: ['fictional-topic'], affectedSourceIds: ['fictional-source'], plannedSourceIds: [], before: { lifecycle: 'active' }, after: { lifecycle: 'archived' }, rationale: 'Fictional explicit archive request.', evidenceFacts: [], provenance: { source: 'fictional' }, searchRetrievalConsequences: {}, blockers: [], reversibility: { reversible: true } });
      globalThis.focusFixture = (entries) => {
        const proposals = entries.map(([id, state]) => proposal(id, state));
        renderTopicReview({ state: proposals.length ? 'Active' : 'Resolved', proposals, groups: proposals.length ? [{ topicId: 'fictional-topic', operation: 'archive', proposals }] : [] });
      };
      focusFixture([['fictional-first', 'pending'], ['fictional-second', 'pending']]);
    });
    const first = page.locator('[data-proposal-id="fictional-first"]').getByRole('button', { name: 'Approve', exact: true });
    await first.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.evaluate(() => focusFixture([['fictional-first', 'pending'], ['fictional-second', 'pending']]));
    assert.equal(await first.evaluate((node) => document.activeElement === node), true, 'same enabled action survives an unrelated refresh');
    await page.evaluate(() => focusFixture([['fictional-first', 'approved'], ['fictional-second', 'pending']]));
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-proposal-id]')?.dataset.proposalId), 'fictional-second');
    const keep = page.locator('[data-proposal-id="fictional-second"]').getByRole('button', { name: 'Keep as-is', exact: true });
    await keep.focus();
    await page.evaluate(() => focusFixture([['fictional-first', 'approved']]));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'topic-review-checkpoint', 'last Keep as-is must leave focus on the newly available checkpoint');
    assert.equal(await page.evaluate(() => { const node = document.activeElement; return node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'; }), true);
    await page.locator('#analysis-run').focus();
    await page.evaluate(() => focusFixture([['fictional-first', 'pending']]));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'analysis-run', 'response must not steal focus from outside the proposal list');
    await page.locator('[data-proposal-id="fictional-first"]').getByRole('button', { name: 'Keep as-is', exact: true }).focus();
    await page.evaluate(() => focusFixture([]));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'topic-review-heading', 'empty review retains a stable focus destination');
  } finally { await browser.close(); }
});
