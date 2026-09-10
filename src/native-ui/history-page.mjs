const unwrap = response => response?.result ?? response;
const boundedInteger = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;

/** Historical source view only. The host owns all active Chat composition. */
export function mountHistoryPage(container, context) {
  const host = context.host; const document = container.ownerDocument;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let props = { ...context.props }; let presented = context.presented; let generation = 0;
  let offset = 0; let nextOffset = null; let selected; const previousOffsets = []; const urls = new Set();
  const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const button = text => { const node = element('button', text); node.type = 'button'; return node; };
  const title = element('h1', 'Imported History');
  const notice = element('p', 'Read-only preserved history. Continue ongoing conversations in native Chat.');
  const status = element('p'); status.setAttribute('role', 'status');
  const all = button('All Imported Histories'); const refresh = button('Refresh History');
  const catalog = element('ul'); const messages = element('section'); messages.setAttribute('aria-label', 'Preserved messages');
  const previous = button('Previous Messages'); const next = button('Next Messages');
  const downloads = element('div');
  container.replaceChildren(title, notice, all, refresh, status, catalog, messages, previous, next, downloads);
  const readable = () => !signal.aborted && presented && host.connection.connected && host.connection.canRead;
  const current = pending => readable() && pending === generation;
  const cleanDownloads = () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); downloads.replaceChildren(); };
  const report = error => { status.textContent = host.redact(error?.message ?? 'Imported History is unavailable.'); };
  async function download(message, file) {
    if (!readable() || !selected) return;
    const pending = generation; const historyId = selected; const chunks = []; let byteOffset = 0;
    status.textContent = `Reading ${file.filename}…`;
    try {
      if (!boundedInteger(file.totalBytes, 33_554_432) || !/^[a-f0-9]{64}$/.test(file.revision)) throw new Error('Attachment identity is unavailable.');
      do {
        const result = unwrap(await host.request('command-center.v1.histories.attachment-read', { schemaVersion: 1, historyId,
          messageId: message.messageId, attachmentId: file.attachmentId, offset: byteOffset, observedRevision: file.revision }));
        if (!current(pending) || selected !== historyId) return;
        if (result?.historyId !== historyId || result.messageId !== message.messageId || result.attachmentId !== file.attachmentId || result.revision !== file.revision ||
            result.totalBytes !== file.totalBytes || result.declaredBytes !== file.declaredBytes || result.preservationStatus !== file.preservationStatus ||
            result.byteOffset !== byteOffset || typeof result.contentBase64 !== 'string' || result.contentBase64.length > 349_528) throw new Error('The exact attachment changed during retrieval.');
        const bytes = Uint8Array.from(atob(result.contentBase64), character => character.charCodeAt(0));
        if (result.nextOffset !== byteOffset + bytes.length || result.nextOffset > file.totalBytes || result.complete !== (result.nextOffset === file.totalBytes) || (!result.complete && !bytes.length)) throw new Error('The attachment response is incomplete.');
        chunks.push(bytes); byteOffset = result.nextOffset;
      } while (byteOffset < file.totalBytes);
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (!current(pending) || selected !== historyId) return;
      if (digest !== file.revision) throw new Error('Attachment verification failed; no download was offered.');
      const url = URL.createObjectURL(blob); urls.add(url);
      const link = element('a', `Save ${file.filename}`); link.href = url;
      link.download = file.filename.replace(/[\\/\x00-\x1f]/g, '_') || 'attachment';
      downloads.append(link); link.click(); status.textContent = `Verified preserved export bytes for ${file.filename}. Download started.`;
    } catch (error) { if (current(pending)) report(error); }
  }
  function renderMessage(message) {
    const article = element('article'); article.style.overflowWrap = 'anywhere'; article.setAttribute('dir', 'auto');
    article.append(element('h2', `${message.author}${message.bot ? ' · bot' : ''}`));
    const time = element('time', message.timestamp); time.dateTime = message.timestamp; article.append(time);
    const text = element('pre', message.text); text.style.whiteSpace = 'pre-wrap'; text.style.fontFamily = 'inherit'; article.append(text);
    // Embeds are imported data, never HTML or automatically fetched media.
    const detailsValue = JSON.parse(message.detailsJson);
    for (const embed of detailsValue.message?.embeds ?? []) {
      if (typeof embed.title === 'string') article.append(element('p', embed.title));
      if (typeof embed.description === 'string') article.append(element('p', embed.description));
    }
    for (const file of message.attachments) {
      if (file.preservationStatus === 'declared-representation-unverified') article.append(element('p',
        `Preserved export copy: ${file.totalBytes} bytes; source declared ${file.declaredBytes} bytes. The declared original representation is unverified.`));
      const control = button(`Download ${file.filename}`);
      control.addEventListener('click', () => void download(message, file), { signal }); article.append(control);
    }
    const details = element('details'); details.append(element('summary', 'Original message and provenance'));
    const raw = element('pre', message.detailsJson); raw.style.whiteSpace = 'pre-wrap'; details.append(raw); article.append(details);
    return article;
  }
  async function load() {
    const pending = ++generation; cleanDownloads(); catalog.replaceChildren(); messages.replaceChildren(); selected = undefined;
    previous.disabled = true; next.disabled = true; title.textContent = 'Imported History';
    if (!readable()) { status.textContent = 'Connect with read access to view preserved history.'; return; }
    status.textContent = 'Loading preserved history…';
    try {
      if (!props.historyId) {
        const result = unwrap(await host.request('command-center.v1.histories.list', { schemaVersion: 1, ...(props.topicId ? { topicId: props.topicId } : {}) }));
        if (!current(pending)) return;
        if (!Array.isArray(result?.histories)) throw new Error('The preserved history catalog is unavailable.');
        const fragment = document.createDocumentFragment();
        for (const history of result.histories) {
          if (history.readOnly !== true || (props.topicId && history.topicId !== props.topicId)) throw new Error('The exact history association is unavailable.');
          const row = element('li'); const read = button(`Read ${history.title}`);
          read.addEventListener('click', () => { if (readable()) host.navigation.openPage({ id: 'histories', params: { historyId: history.historyId } }); }, { signal });
          row.append(read, document.createTextNode(` · ${history.totalMessages} messages`)); fragment.append(row);
        }
        catalog.replaceChildren(fragment); status.textContent = `${result.histories.length} preserved histories.`; return;
      }
      const result = unwrap(await host.request('command-center.v1.histories.read', { schemaVersion: 1, historyId: props.historyId, offset, limit: 50 }));
      if (!current(pending)) return;
      if (result?.historyId !== props.historyId || result.readOnly !== true || !Array.isArray(result.messages) || result.offset !== offset ||
          !boundedInteger(result.totalMessages, Number.MAX_SAFE_INTEGER) || typeof result.hasMore !== 'boolean' ||
          (result.hasMore ? !boundedInteger(result.nextOffset, result.totalMessages) || result.nextOffset <= offset || result.nextOffset !== offset + result.messages.length : result.nextOffset !== null || offset + result.messages.length !== result.totalMessages)) throw new Error('The preserved message page is incomplete.');
      const fragment = document.createDocumentFragment(); result.messages.forEach(message => fragment.append(renderMessage(message)));
      messages.replaceChildren(fragment); selected = result.historyId; title.textContent = result.title;
      nextOffset = result.nextOffset; previous.disabled = previousOffsets.length === 0; next.disabled = !result.hasMore;
      status.textContent = result.messages.length ? `Messages ${offset + 1}–${offset + result.messages.length} of ${result.totalMessages}.` : 'No messages in this preserved history.';
    } catch (error) { if (current(pending)) { messages.replaceChildren(); report(error); } }
  }
  all.addEventListener('click', () => { if (readable()) host.navigation.openPage({ id: 'histories' }); }, { signal });
  refresh.addEventListener('click', () => void load(), { signal });
  previous.addEventListener('click', () => {
    if (!readable() || previous.disabled || !previousOffsets.length) return;
    offset = previousOffsets.pop(); void load();
  }, { signal });
  next.addEventListener('click', () => {
    if (!readable() || next.disabled || nextOffset === null) return;
    previousOffsets.push(offset); offset = nextOffset; void load();
  }, { signal });
  let connectionReadable = readable();
  const unsubscribe = host.subscribe(() => { const next = readable(); if (next !== connectionReadable) { connectionReadable = next; void load(); } });
  void load();
  return {
    update(next) { props = { ...next.props }; presented = next.presented; offset = 0; previousOffsets.length = 0; void load(); },
    focus() { all.focus(); },
    dispose() { generation++; lifetime.abort(); unsubscribe(); cleanDownloads(); container.replaceChildren(); }
  };
}
