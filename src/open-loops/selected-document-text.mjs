import { loadPdfRuntime } from './pdf-runtime.mjs';

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 20;

const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

function boundedText(value) {
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_TEXT_BYTES) return null;
  return normalized;
}

function unsupported(status, { pageCount } = {}) {
  return freeze({
    content: `Extraction status: ${status}`,
    extractionStatus: status,
    reviewRequired: false,
    ...(pageCount === undefined ? {} : { pageCount }),
    pageEvidence: []
  });
}

async function extractPdf(bytes) {
  if (bytes.length > MAX_PDF_BYTES) return unsupported('pdf-too-large');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return unsupported('invalid-pdf');
  let loadingTask;
  let pdf;
  try {
    const pdfjs = await loadPdfRuntime();
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false, enableXfa: false, useSystemFonts: false });
    pdf = await loadingTask.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES) return unsupported('pdf-page-limit', { pageCount: pdf.numPages });
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: false });
      let pageText = '';
      for (const item of content.items ?? []) {
        if (typeof item?.str !== 'string') continue;
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : ' ';
      }
      const text = pageText.replace(/[ \t]+\n/gu, '\n').replace(/[ \t]{2,}/gu, ' ').trim();
      if (text) pages.push({ page: pageNumber, text });
    }
    if (!pages.length) return unsupported('pdf-no-text-layer', { pageCount: pdf.numPages });
    const combined = boundedText(pages.map(page => page.text).join('\n'));
    if (!combined) return unsupported('pdf-text-limit', { pageCount: pdf.numPages });
    return freeze({ content: combined, extractionStatus: 'pdf-text-extracted', reviewRequired: true, pageCount: pdf.numPages, pageEvidence: pages.map(page => page.page) });
  } catch (error) {
    const status = error?.name === 'PasswordException' ? 'pdf-encrypted' : 'pdf-unreadable';
    return unsupported(status);
  } finally {
    await pdf?.destroy?.().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

export async function extractSelectedDocumentText({ bytes, path }) {
  if (!Buffer.isBuffer(bytes) || typeof path !== 'string' || !path.trim()) throw new TypeError('Selected-document extraction requires authoritative bytes and path.');
  if (/\.pdf$/iu.test(path)) return extractPdf(bytes);
  if (!/\.(?:txt|md)$/iu.test(path)) return unsupported('unsupported-format');
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return unsupported('invalid-utf8'); }
  const content = boundedText(decoded);
  if (!content) return unsupported(bytes.length > MAX_TEXT_BYTES ? 'text-limit' : 'empty-text');
  return freeze({ content, extractionStatus: 'labelled-plaintext', reviewRequired: false, pageEvidence: [] });
}

export const SELECTED_DOCUMENT_LIMITS = Object.freeze({ maxTextBytes: MAX_TEXT_BYTES, maxPdfBytes: MAX_PDF_BYTES, maxPdfPages: MAX_PDF_PAGES });
