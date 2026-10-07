import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

for (const scenario of ['review and cancel', 'replaced Conversation', 'read-only', 'file and reopen', 'unknown and check']) test(`Topic attachment review: ${scenario}`, { timeout: 30000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional Topic Files</title><style>body{font:16px system-ui;margin:28px;background:#f8fafc;color:#172033}main{max-width:760px}button,input,select{font:inherit;padding:8px;margin:4px}section{border-top:1px solid #cbd5e1}p{line-height:1.6}</style><main><h1>Fictional project Files</h1><div id="mount"></div><p>Existing Topic Files reader</p></main></html>'); return; }
    if (req.url !== '/topic-attachment-review.mjs') { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../src/native-ui/topic-attachment-review.mjs', import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async scenario => {
      const { mountTopicAttachmentReview } = await import('/topic-attachment-review.mjs');
      const lifetime = new AbortController(); window.calls = []; window.current = true;
      const binding = { topicId: 'fictional-topic', name: 'Fictional project', sessionKey: 'agent:main:fictional', sessionId: 'fictional-incarnation', referenceId: 'fictional-conversation' };
      const selection = { entryId: 'fictional-message', mediaIndex: 0, offset: 0, generation: 'fictional-generation' };
      const host = { signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: scenario !== 'read-only' }, redact: text => text, subscribe: () => () => {},
        httpRequest: async ({ body }) => {
          const input = JSON.parse(body); window.calls.push(input);
          if (input.action === 'documents.attachment.prepare' && scenario === 'replaced Conversation') await new Promise(resolve => { window.finishReview = resolve; });
          if (input.action === 'documents.attachment.file' && scenario === 'unknown and check') throw new Error('Fictional lost response');
          if (['documents.attachment.file', 'documents.attachment.check', 'documents.attachment.reopen'].includes(input.action)) {
            const value = { schemaVersion: 2, status: 'filed', logicalOperationId: input.logicalOperationId, topicId: binding.topicId, source: { sessionId: binding.sessionId, entryId: selection.entryId }, document: { referenceId: 'document:fictional', path: 'Documents/Reference/original--fixture.pdf', revision: 'sha256:fictional' } };
            return { status: 200, body: JSON.stringify({ schemaVersion: 1, status: 'ready', result: input.action.endsWith('.reopen') ? value : { schemaVersion: 2, status: 'applied', logicalOperationId: input.logicalOperationId, value } }) };
          }
          const result = input.action === 'documents.attachments.list'
            ? { schemaVersion: 1, topicId: binding.topicId, topicName: binding.name, sessionId: binding.sessionId, nextOffset: null, attachments: [{ selection, fileName: 'original.pdf' }] }
            : { schemaVersion: 2, status: 'prepared', logicalOperationId: input.logicalOperationId, canFile: ['file and reopen', 'unknown and check'].includes(scenario), topicId: binding.topicId, topicName: binding.name, source: { sessionId: binding.sessionId, entryId: selection.entryId }, document: { path: 'Documents/Reference/original--fixture.pdf', sizeBytes: 123, contentType: 'application/pdf' } };
          return { status: 200, body: JSON.stringify({ schemaVersion: 1, status: 'ready', result }) };
        } };
      window.review = mountTopicAttachmentReview(document.querySelector('#mount'), { host, signal: lifetime.signal, binding, onFiled: document => { window.openedDocument = document; }, verifyContext: async () => { if (!window.current) throw new Error('The Conversation changed.'); } });
    }, scenario);
    if (scenario === 'read-only') { assert.equal(await page.getByRole('button', { name: 'File Chat attachment' }).isDisabled(), true); assert.equal(await page.evaluate(() => window.calls.length), 0); return; }
    assert.equal(await page.getByRole('region', { name: 'Review Chat attachment filing' }).count(), 0);
    await page.getByRole('button', { name: 'File Chat attachment' }).click();
    await page.getByRole('combobox', { name: 'Chat attachment' }).selectOption('0');
    await page.getByRole('textbox', { name: 'Subfolder below Documents' }).fill('Reference');
    await page.getByRole('button', { name: 'Review destination' }).click();
    if (scenario === 'replaced Conversation') {
      await page.waitForFunction(() => typeof window.finishReview === 'function');
      await page.evaluate(() => { window.current = false; window.finishReview(); });
      await page.getByRole('status').filter({ hasText: 'changed' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'File original' }).isVisible(), false);
    } else {
      await page.getByRole('status').filter({ hasText: 'Destination reviewed' }).waitFor();
      assert.match(await page.locator('body').innerText(), /Fictional project \/ Documents\/Reference\/original--fixture.pdf/u);
      if (['file and reopen', 'unknown and check'].includes(scenario)) {
        const originalId = await page.getByRole('textbox', { name: 'Saved filing ID' }).inputValue();
        await page.getByRole('button', { name: 'File original', exact: true }).click();
        if (scenario === 'unknown and check') {
          await page.getByRole('status').filter({ hasText: 'lost response' }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'File original', exact: true }).isDisabled(), true);
          await page.getByRole('button', { name: 'Check result', exact: true }).click();
        }
        await page.getByRole('status').filter({ hasText: 'Original filed' }).waitFor();
        await page.getByRole('button', { name: 'Open filed document', exact: true }).click();
        await page.waitForFunction(() => window.openedDocument?.referenceId === 'document:fictional');
        assert.equal(await page.getByRole('textbox', { name: 'Saved filing ID' }).inputValue(), originalId);
        assert.equal(await page.evaluate(() => window.calls.filter(input => input.action === 'documents.attachment.file').length), 1);
        return;
      }
      assert.equal(await page.getByRole('button', { name: 'File original' }).isDisabled(), true);
      if (process.env.COMMAND_CENTER_FILING_DEMO_DIR) { await mkdir(process.env.COMMAND_CENTER_FILING_DEMO_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.COMMAND_CENTER_FILING_DEMO_DIR, 'attachment-review.png'), fullPage: true }); }
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'File original' }).isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'File Chat attachment' }).isEnabled(), true);
    }
    assert.equal(await page.evaluate(() => window.calls.some(input => !['documents.attachments.list', 'documents.attachment.prepare'].includes(input.action))), false);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
