const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 12 * 1024 * 1024;

/** Present already-authorized bytes. This component has no Gateway or path reader. */
export async function mountDocumentPreview(container, { bytes, path, signal, beforePublish }) {
  signal.throwIfAborted();
  if (bytes.size > MAX_BYTES) throw new Error('This attachment is too large for an inline preview. Download the original.');
  const document = container.ownerDocument;
  const name = path.split('/').at(-1);
  const root = document.createElement('section'); root.setAttribute('aria-label', 'Original attachment preview');
  const toolbar = document.createElement('div'); toolbar.className = 'reader-toolbar';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.style.cssText = 'font-size:12px;color:var(--muted,inherit);margin-inline-start:auto';
  const surface = document.createElement('div'); surface.style.overflow = 'auto'; surface.style.maxInlineSize = '100%';
  toolbar.append(status); root.append(toolbar, surface); container.replaceChildren(root);
  let disposed = false; let url; let loadingTask; let renderTask; let generation = 0;
  const current = pending => !disposed && !signal.aborted && (pending === undefined || pending === generation);
  const dispose = () => {
    if (disposed) return;
    disposed = true; generation++; renderTask?.cancel();
    void loadingTask?.destroy().catch(() => {});
    if (url) URL.revokeObjectURL(url);
    root.remove(); signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  const button = (name, action) => {
    const control = document.createElement('button'); control.type = 'button'; control.className = 'btn btn--sm'; control.textContent = ({ 'Previous page': '‹', 'Next page': '›', 'Zoom out': '−', 'Zoom in': '+' })[name] ?? name;
    control.setAttribute('aria-label', name); control.title = name;
    control.addEventListener('click', () => { if (current()) action(); }, { signal }); toolbar.insertBefore(control, status); return control;
  };
  try {
    const data = new Uint8Array(await bytes.arrayBuffer()); signal.throwIfAborted();
    const starts = signature => signature.every((byte, i) => data[i] === byte);
    const png = /\.png$/iu.test(path) && starts([137, 80, 78, 71, 13, 10, 26, 10]);
    const jpeg = /\.jpe?g$/iu.test(path) && starts([255, 216, 255]);
    const webp = /\.webp$/iu.test(path) && starts([82, 73, 70, 70]) && new TextDecoder().decode(data.subarray(8, 12)) === 'WEBP';
    if (png || jpeg || webp) {
      const image = document.createElement('img'); image.alt = name; image.decoding = 'async';
      url = URL.createObjectURL(new Blob([data], { type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' }));
      image.src = url; await image.decode(); signal.throwIfAborted();
      if (image.naturalWidth * image.naturalHeight > 40 * 1024 * 1024) throw new Error('Image dimensions exceed the inline preview limit. Download the original.');
      image.width = image.naturalWidth; image.height = image.naturalHeight; image.style.height = 'auto';
      let scale = 1;
      const fit = () => { scale = 1; image.style.width = 'auto'; image.style.maxWidth = '100%'; status.textContent = 'Image · Fit to pane'; };
      const zoom = factor => { scale = Math.max(.25, Math.min(4, scale * factor)); image.style.maxWidth = 'none'; image.style.width = `${image.naturalWidth * scale}px`; status.textContent = `Image · ${Math.round(scale * 100)}%`; };
      button('Fit image', fit); button('Zoom out', () => zoom(.8)); button('Zoom in', () => zoom(1.25)); button('Actual size', () => { scale = 1; zoom(1); });
      await beforePublish?.(); signal.throwIfAborted();
      surface.append(image); fit();
      return { dispose };
    }
    if (!/\.pdf$/iu.test(path) || !starts([37, 80, 68, 70, 45])) throw new Error('Inline preview is unavailable for this file type or invalid file signature. Download the original.');
    // Password-encrypted PDFs have no safe credential flow in this read-only preview.
    // Refuse them before PDF.js parsing while retaining verified original download.
    if (new TextDecoder().decode(data).includes('/Encrypt')) throw new Error('Encrypted PDFs cannot be previewed. Download the original.');
    status.textContent = 'Opening PDF…';
    const [pdfjs, { pdfResources }] = await Promise.all([import('./vendor/pdf.mjs'), import('./vendor/pdf-resources.mjs')]); signal.throwIfAborted();
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
    loadingTask = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false,
      useWasm: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
      maxImageSize: MAX_PIXELS, canvasMaxAreaInBytes: MAX_PIXELS * 4, stopAtErrors: true,
      BinaryDataFactory: class { async fetch({ kind, filename }) {
        const key = `${kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : ''}/${filename}`;
        const encoded = pdfResources[key];
        if (!encoded) throw new Error('Unsupported PDF auxiliary resource');
        const bytes = atob(encoded); return Uint8Array.from(bytes, value => value.charCodeAt(0));
      } } });
    const pdf = await loadingTask.promise; signal.throwIfAborted();
    let pageNumber = 1; let zoom = 1;
    const previous = button('Previous page', () => { pageNumber--; void render(); });
    const next = button('Next page', () => { pageNumber++; void render(); });
    button('Zoom out', () => { zoom = Math.max(.25, zoom / 1.25); void render(); });
    button('Zoom in', () => { zoom = Math.min(3, zoom * 1.25); void render(); });
    button('Fit page', () => { zoom = 1; void render(); });
    async function render() {
      const pending = ++generation; renderTask?.cancel();
      previous.disabled = pageNumber <= 1; next.disabled = pageNumber >= pdf.numPages;
      surface.replaceChildren(); status.textContent = `Loading page ${pageNumber}…`;
      try {
        const page = await pdf.getPage(pageNumber);
        if (!current(pending)) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(1, Math.max(200, container.clientWidth - 24) / base.width) * zoom;
        const viewport = page.getViewport({ scale });
        if (!Number.isFinite(viewport.width * viewport.height) || viewport.width * viewport.height > MAX_PIXELS) throw new Error('Page dimensions exceed the preview limit. Reduce zoom or download the original.');
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${name}, page ${pageNumber}`);
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
        await renderTask.promise;
        if (!current(pending)) return;
        const text = await page.getTextContent();
        if (!current(pending)) return;
        await beforePublish?.();
        if (!current(pending)) return;
        const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Page text';
        const plain = document.createElement('p'); plain.textContent = text.items.filter(item => typeof item.str === 'string').map(item => item.str).join(' ');
        details.append(summary, plain); surface.replaceChildren(canvas, details);
        status.textContent = `Page ${pageNumber} of ${pdf.numPages} · ${Math.round(zoom * 100)}%`;
      } catch (error) {
        if (current(pending)) status.textContent = `PDF preview unavailable: ${error.message}. Download the original.`;
      }
    }
    await render(); signal.throwIfAborted();
    return { dispose };
  } catch (error) { dispose(); throw error; }
}
