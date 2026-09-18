import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

// A generated, fictional two-page PDF. No private data or external resources.
function samplePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 25 >>\nstream\n0 0 1 rg 10 10 50 50 re f\nendstream',
    '<< /Length 25 >>\nstream\n1 0 0 rg 10 10 50 50 re f\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

const packagedRoot = process.env.COMMAND_CENTER_NATIVE_UI_ROOT;
const nativeUiRoot = packagedRoot ? path.resolve(packagedRoot) : fileURLToPath(new URL('../src/native-ui/', import.meta.url));
const previewAsset = (name, source) => packagedRoot ? path.join(nativeUiRoot, 'vendor', name) : new URL(source, import.meta.url);

test('authorized original preview shows images and PDF pages without remote requests', { timeout: 30000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><main style="width:600px;height:600px"></main>'); return; }
    const routes = {
      '/document-preview.mjs': path.join(nativeUiRoot, 'document-preview.mjs'),
      '/vendor/pdf-resources.mjs': packagedRoot ? path.join(nativeUiRoot, 'vendor', 'pdf-resources.mjs') : new URL('../dist/native-ui/vendor/pdf-resources.mjs', import.meta.url),
      '/vendor/pdf.mjs': previewAsset('pdf.mjs', '../node_modules/pdfjs-dist/build/pdf.mjs'),
      '/vendor/pdf.worker.mjs': previewAsset('pdf.worker.mjs', '../node_modules/pdfjs-dist/build/pdf.worker.mjs')
    };
    if (!routes[req.url]) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(routes[req.url])); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const external = [];
    page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}`) && !request.url().startsWith('blob:')) external.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async pdf => {
      const { mountDocumentPreview } = await import('/document-preview.mjs');
      const lifetime = new AbortController(); window.previewLifetime = lifetime;
      window.preview = await mountDocumentPreview(document.querySelector('main'), { bytes: new Blob([pdf]), path: 'invoices/sample.pdf', signal: lifetime.signal });
    }, samplePdf());
    await page.getByRole('status').filter({ hasText: 'Page 1 of 2' }).waitFor();
    assert.ok(await page.locator('canvas').evaluate(el => el.width > 0 && el.height > 0));
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Page 2 of 2' }).waitFor();
    const before = await page.locator('canvas').evaluate(el => el.width);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(width => (document.querySelector('canvas')?.width ?? 0) > width, before);
    await page.evaluate(async () => {
      window.preview.dispose();
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24; canvas.getContext('2d').fillRect(0, 0, 32, 24);
      const bytes = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const { mountDocumentPreview } = await import('/document-preview.mjs');
      window.preview = await mountDocumentPreview(document.querySelector('main'), { bytes, path: 'images/sample.png', signal: window.previewLifetime.signal });
    });
    assert.equal(await page.getByRole('img', { name: 'sample.png', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    for (const [mime, filename] of [['image/jpeg', 'sample.jpg'], ['image/webp', 'sample.webp']]) {
      await page.evaluate(async ({ mime, filename }) => {
        window.preview.dispose();
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24; canvas.getContext('2d').fillRect(0, 0, 32, 24);
        const bytes = await new Promise(resolve => canvas.toBlob(resolve, mime));
        const { mountDocumentPreview } = await import('/document-preview.mjs');
        window.preview = await mountDocumentPreview(document.querySelector('main'), { bytes, path: `images/${filename}`, signal: window.previewLifetime.signal });
      }, { mime, filename });
      assert.equal(await page.getByRole('img', { name: filename, exact: true }).isVisible(), true);
    }
    const encryptedError = await page.evaluate(async pdf => {
      window.preview.dispose();
      const { mountDocumentPreview } = await import('/document-preview.mjs');
      try { await mountDocumentPreview(document.querySelector('main'), { bytes: new Blob([pdf.replace('trailer', '/Encrypt 99 0 R\ntrailer')]), path: 'invoices/protected.pdf', signal: window.previewLifetime.signal }); }
      catch (error) { return error.message; }
      return null;
    }, samplePdf());
    assert.equal(encryptedError, 'Encrypted PDFs cannot be previewed. Download the original.');
    const corruptError = await page.evaluate(async () => {
      const { mountDocumentPreview } = await import('/document-preview.mjs');
      try { await mountDocumentPreview(document.querySelector('main'), { bytes: new Blob(['%PDF-1.4\\nfictional corrupt PDF']), path: 'invoices/corrupt.pdf', signal: window.previewLifetime.signal }); }
      catch (error) { return error.name; }
      return null;
    });
    assert.equal(corruptError, 'InvalidPDFException');
    const oversizedError = await page.evaluate(async () => {
      const { mountDocumentPreview } = await import('/document-preview.mjs');
      try { await mountDocumentPreview(document.querySelector('main'), { bytes: new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]), path: 'invoices/large.pdf', signal: window.previewLifetime.signal }); }
      catch (error) { return error.message; }
      return null;
    });
    assert.equal(oversizedError, 'This attachment is too large for an inline preview. Download the original.');
    assert.deepEqual(external, []);
    await page.evaluate(() => window.previewLifetime.abort());
    assert.equal(await page.locator('canvas,img').count(), 0, 'aborted preview removes old content');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});

test('a late PDF publication cannot replace a cancelled attachment selection', { timeout: 30000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><main style="width:600px;height:600px"></main>'); return; }
    const routes = {
      '/document-preview.mjs': path.join(nativeUiRoot, 'document-preview.mjs'),
      '/vendor/pdf-resources.mjs': packagedRoot ? path.join(nativeUiRoot, 'vendor', 'pdf-resources.mjs') : new URL('../dist/native-ui/vendor/pdf-resources.mjs', import.meta.url),
      '/vendor/pdf.mjs': previewAsset('pdf.mjs', '../node_modules/pdfjs-dist/build/pdf.mjs'),
      '/vendor/pdf.worker.mjs': previewAsset('pdf.worker.mjs', '../node_modules/pdfjs-dist/build/pdf.worker.mjs')
    };
    if (!routes[req.url]) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(routes[req.url])); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(pdf => {
      const gate = Promise.withResolvers(); const controller = new AbortController();
      window.latePdf = { gate, controller };
      window.latePdf.result = import('/document-preview.mjs').then(({ mountDocumentPreview }) => mountDocumentPreview(document.querySelector('main'), {
        bytes: new Blob([pdf]), path: 'invoices/late.pdf', signal: controller.signal,
        beforePublish: () => gate.promise
      })).then(() => 'published', error => error.name);
    }, samplePdf());
    await page.getByRole('status').filter({ hasText: 'Loading page 1' }).waitFor();
    await page.evaluate(() => { window.latePdf.controller.abort(); window.latePdf.gate.resolve(); });
    assert.equal(await page.evaluate(() => window.latePdf.result), 'AbortError');
    assert.equal(await page.locator('canvas,img').count(), 0, 'cancelled preview left no stale media');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
      const bytes = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const { mountDocumentPreview } = await import('/document-preview.mjs');
      window.currentPreview = await mountDocumentPreview(document.querySelector('main'), {
        bytes, path: 'images/current.png', signal: new AbortController().signal
      });
    });
    assert.equal(await page.getByRole('img', { name: 'current.png', exact: true }).isVisible(), true);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
