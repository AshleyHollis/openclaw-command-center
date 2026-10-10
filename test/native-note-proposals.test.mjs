import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

test('native staged suggestion is explicit, labelled, keyboard accessible, text-safe and cleared on authority loss', { skip: process.platform !== 'linux' && 'Hosted Linux browser qualification' }, async t => {
  const { chromium } = await import('playwright');
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional Note review</title><main id="mount"></main></html>'); return; }
    if (req.url !== '/note-proposals.mjs') { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../src/native-ui/note-proposals.mjs', import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { mountNoteProposals } = await import('/note-proposals.mjs'); const lifetime = new AbortController(); window.methods = [];
    const target = { referenceId: 'fictional-target', path: 'target.md', revision: 'target-v1' };
    const source = { referenceId: 'fictional-source', path: 'source.md', revision: 'source-v1' };
    window.host = { connection: { canWrite: true }, redact: text => text, async request(method, input) {
      window.methods.push({ method, input });
      if (method.endsWith('.discard')) return { ...input, status: 'discarded' };
      const value = { schemaVersion: 1, logicalOperationId: input.logicalOperationId, topicId: 'fictional-topic', generation: 1, status: 'prepared', basisDigest: 'fictional-basis',
        verifiedAt: '2026-10-06T00:00:00.000Z', snapshot: { target: { ...target, text: '# Original operator edit\n' }, sources: [{ ...source, text: 'Fictional source evidence' }] } };
      if (method.endsWith('.publish')) return { ...value, status: 'review-required', proposedText: input.proposedText,
        comparison: { before: value.snapshot.target.text, after: input.proposedText }, citations: input.citations };
      return value;
    } };
    window.mountReview = () => mountNoteProposals(document.querySelector('#mount'), { host: window.host, signal: lifetime.signal, current: () => true,
      topic: { topicId: 'fictional-topic', revision: 1 }, target, sources: [source], pointers: new Map() });
    window.view = window.mountReview();
  });
  assert.deepEqual(await page.evaluate(() => window.methods), []);
  await page.getByRole('checkbox', { name: 'source.md (source-v1)' }).focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Prepare suggestion', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByLabel('Suggestion Markdown').waitFor();
  await page.getByLabel('Suggestion Markdown').fill('<script>window.injected=true</script>\nKeep my original edit.');
  await page.getByRole('button', { name: 'Review suggestion', exact: true }).click();
  await page.getByRole('heading', { name: 'Proposed', exact: true }).waitFor();
  assert.equal(await page.locator('script').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.deepEqual(await page.evaluate(() => window.methods.map(row => row.method)), ['command-center.v1.notes.proposals.prepare', 'command-center.v1.notes.proposals.publish']);
  assert.match(await page.getByRole('region', { name: 'Suggestion comparison' }).textContent(), /Original operator edit/);
  const savedId = await page.getByLabel('Saved suggestion ID').inputValue();
  await page.evaluate(() => { window.view.dispose(); window.view = window.mountReview(); });
  await page.getByLabel('Saved suggestion ID').fill(savedId); await page.getByRole('button', { name: 'Recover suggestion by ID', exact: true }).click();
  await page.getByLabel('Suggestion Markdown').waitFor();
  assert.equal(await page.evaluate(() => window.methods.at(-1).method), 'command-center.v1.notes.proposals.inspect');
  await page.evaluate(() => { window.host.connection.canWrite = false; window.view.sync(); });
  assert.equal(await page.getByRole('region', { name: 'Suggestion comparison' }).textContent(), '');
  assert.equal(await page.getByLabel('Suggestion Markdown').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Discard', exact: true }).isDisabled(), true);
  await page.evaluate(() => {
    window.host.connection.canWrite = true; window.view.dispose(); window.view = window.mountReview();
    window.host.request = async (method, input) => {
      window.idBeforeRequest = document.querySelector('input[type="text"]').value;
      window.acceptedId = input.logicalOperationId;
      throw new Error('Fictional response lost after prepare admission.');
    };
  });
  await page.getByRole('checkbox', { name: 'source.md (source-v1)' }).check(); await page.getByRole('button', { name: 'Prepare suggestion', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Fictional response lost' }).waitFor();
  const ids = await page.evaluate(() => [window.idBeforeRequest, window.acceptedId]); assert.equal(ids[0], ids[1]); assert.ok(ids[0]);
  assert.equal(await page.getByLabel('Saved suggestion ID').inputValue(), ids[0]);
});
