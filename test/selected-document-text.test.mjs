import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelectedDocumentText, SELECTED_DOCUMENT_LIMITS } from '../src/open-loops/selected-document-text.mjs';
import { planSelectedSourceSelection } from '../src/open-loops/selected-source-intake.mjs';

function pdfWithPages(pageLines) {
  const pageCount = pageLines.length;
  const firstContent = 3 + pageCount;
  const fontId = firstContent + pageCount;
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index);
  const escape = value => value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageIds.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${firstContent + index} 0 R >>`),
    ...pageLines.map(lines => {
      const commands = ['BT', '/F1 11 Tf', '50 740 Td', ...lines.flatMap((line, index) => index === 0 ? [`(${escape(line)}) Tj`] : ['0 -18 Td', `(${escape(line)}) Tj`]), 'ET'].join('\n');
      return `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

const authorization = { scopeId: 'topic:fictional-renovation', sourceSystem: 'fictional-documents', sourceKind: 'document', resourceId: 'document:fictional-pdf-invoice' };

test('selected text PDF extraction creates a reviewable suggestion with page evidence', async () => {
  const extraction = await extractSelectedDocumentText({
    path: 'invoices/fictional-progress.pdf',
    bytes: pdfWithPages([
      ['Invoice: INV-PDF-17', 'Payee: Fictional Electrical', 'Purpose: switchboard milestone'],
      ['Amount due: AUD 480.00', 'Due: 2026-10-05T00:00:00.000Z', 'Please pay after review.']
    ])
  });
  assert.equal(extraction.extractionStatus, 'pdf-text-extracted');
  assert.equal(extraction.reviewRequired, true);
  assert.deepEqual(extraction.pageEvidence, [1, 2]);
  const plan = planSelectedSourceSelection({
    version: 'sha256:fictional-pdf-v1', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', availability: 'available', topicId: 'topic-fictional-renovation', sourcePath: 'invoices/fictional-progress.pdf', ...extraction
  }, { authorization, baselineThrough: '2026-09-01T00:00:00.000Z' });
  assert.equal(plan.loop.state, 'suggested');
  assert.equal(plan.loop.paymentState, 'potential');
  assert.equal(plan.loop.amount, 48000);
  assert.equal(plan.observation.facts.extractionStatus, 'pdf-text-extracted');
  assert.deepEqual(plan.observation.facts.pageEvidence, [1, 2]);
});

test('non-text and hostile selected documents stay informational and bounded', async () => {
  const scanned = await extractSelectedDocumentText({ path: 'scans/fictional-scan.pdf', bytes: pdfWithPages([[]]) });
  assert.equal(scanned.extractionStatus, 'pdf-no-text-layer');
  const corrupt = await extractSelectedDocumentText({ path: 'invoices/corrupt.pdf', bytes: Buffer.from('%PDF-1.4\nfictional corrupt content') });
  assert.equal(corrupt.extractionStatus, 'pdf-unreadable');
  const oversized = await extractSelectedDocumentText({ path: 'invoices/oversized.pdf', bytes: Buffer.alloc(SELECTED_DOCUMENT_LIMITS.maxPdfBytes + 1, 0x20) });
  assert.equal(oversized.extractionStatus, 'pdf-too-large');
  const unsupported = await extractSelectedDocumentText({ path: 'invoices/active.html', bytes: Buffer.from('<script>alert(1)</script>') });
  assert.equal(unsupported.extractionStatus, 'unsupported-format');
  for (const extraction of [scanned, corrupt, oversized, unsupported]) {
    const plan = planSelectedSourceSelection({ version: `sha256:${extraction.extractionStatus}`, occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', availability: 'available', topicId: 'topic-fictional-renovation', sourcePath: 'invoices/fictional.pdf', ...extraction }, { authorization, baselineThrough: '2026-09-01T00:00:00.000Z' });
    assert.equal(plan.loop, null);
    assert.equal(plan.interpretation.kind, 'informational');
  }
});

test('plaintext intake remains confirmed while invalid UTF-8 fails quiet', async () => {
  const plaintext = await extractSelectedDocumentText({ path: 'invoices/fictional.txt', bytes: Buffer.from('Invoice: TXT-1\nAmount due: AUD 12.00\nPlease pay.') });
  assert.equal(plaintext.reviewRequired, false);
  const plan = planSelectedSourceSelection({ version: 'v1', occurredAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:01:00.000Z', availability: 'available', ...plaintext }, { authorization, baselineThrough: '2026-09-01T00:00:00.000Z' });
  assert.equal(plan.loop.state, 'confirmed');
  const invalid = await extractSelectedDocumentText({ path: 'invoices/invalid.txt', bytes: Buffer.from([0xc3, 0x28]) });
  assert.equal(invalid.extractionStatus, 'invalid-utf8');
});
