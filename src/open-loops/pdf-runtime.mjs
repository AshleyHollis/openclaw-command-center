// Authored-source tests use the lockfile-resolved build dependency. The sealed
// build replaces this adapter with one that loads its verified vendored copy.
export const loadPdfRuntime = () => import('pdfjs-dist/legacy/build/pdf.mjs');
