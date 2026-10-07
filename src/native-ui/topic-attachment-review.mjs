const route = '/plugins/command-center/api/topic/actions';

/** Review original native attachments inside the existing Topic Files surface. */
export function mountTopicAttachmentReview(container, { host, signal, binding, verifyContext }) {
  const lifetime = new AbortController();
  const activeSignal = AbortSignal.any([signal, lifetime.signal]);
  const document = container.ownerDocument;
  const open = document.createElement('button');
  open.type = 'button'; open.textContent = 'File Chat attachment';
  const region = document.createElement('section');
  region.hidden = true; region.setAttribute('aria-label', 'Review Chat attachment filing');
  region.style.cssText = 'padding:12px 0;max-width:100%;overflow-wrap:anywhere';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Chat attachment');
  const subfolder = document.createElement('input'); subfolder.setAttribute('aria-label', 'Subfolder below Documents'); subfolder.placeholder = 'Optional subfolder below Documents';
  const review = document.createElement('button'); review.type = 'button'; review.textContent = 'Review destination';
  const more = document.createElement('button'); more.type = 'button'; more.textContent = 'Load more messages'; more.hidden = true;
  const destination = document.createElement('p');
  const file = document.createElement('button'); file.type = 'button'; file.textContent = 'File original'; file.disabled = true; file.hidden = true;
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  region.append(status, select, subfolder, review, more, destination, file, cancel);
  container.append(open, region);
  let generation = 0; let attachments = []; let nextOffset = null;
  const current = pending => !activeSignal.aborted && generation === pending && host.connection.connected && host.connection.canRead && host.connection.canWrite;
  const unavailable = () => !host.connection.connected || !host.connection.canRead || !host.connection.canWrite;
  async function request(action, fields, pending) {
    await verifyContext();
    if (!current(pending)) throw new Error('The selected Conversation changed.');
    const body = JSON.stringify({ schemaVersion: 1, action, topicId: binding.topicId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, ...fields });
    const response = await host.httpRequest({ method: 'POST', path: route, body }, { signal: activeSignal });
    if (!current(pending)) throw new Error('The selected Conversation changed.');
    if (typeof response?.body !== 'string' || new TextEncoder().encode(response.body).length > 32 * 1024) throw new Error('Attachment review is unavailable.');
    const value = JSON.parse(response.body);
    if (response.status !== 200 || value.schemaVersion !== 1 || value.status === 'error' || value.result?.topicId !== binding.topicId) throw new Error('Attachment review is unavailable. Refresh this Conversation and try again.');
    await verifyContext();
    if (!current(pending)) throw new Error('The selected Conversation changed.');
    return value.result;
  }
  async function load(offset = 0) {
    const pending = ++generation;
    review.disabled = true; more.disabled = true; status.textContent = 'Finding accepted Chat attachments…';
    destination.textContent = ''; file.hidden = true;
    try {
      const result = await request('documents.attachments.list', { offset }, pending);
      if (!Array.isArray(result.attachments) || result.attachments.length + attachments.length > 200) throw new Error('Choose an attachment from a smaller message range.');
      if (offset === 0) { attachments = []; select.replaceChildren(); }
      for (const attachment of result.attachments) {
        if (!attachment.selection || typeof attachment.selection.entryId !== 'string') throw new Error('The native attachment selection is unavailable.');
        const option = document.createElement('option'); option.value = String(attachments.length); option.textContent = attachment.fileName || 'Original attachment';
        attachments.push(attachment); select.append(option);
      }
      nextOffset = result.nextOffset; more.hidden = nextOffset === null; more.disabled = false;
      review.disabled = attachments.length === 0;
      status.textContent = attachments.length ? `Choose an attachment to review filing in ${result.topicName || binding.name || 'this Topic'}.` : 'No accepted attachments on this message page.';
      select.focus();
    } catch (error) { if (current(pending)) { status.textContent = host.redact(error.message); more.disabled = false; review.disabled = attachments.length === 0; } }
  }
  open.addEventListener('click', () => {
    if (unavailable()) return;
    region.hidden = false; open.disabled = true; void load();
  }, { signal: activeSignal });
  more.addEventListener('click', () => { if (nextOffset !== null) void load(nextOffset); }, { signal: activeSignal });
  review.addEventListener('click', async () => {
    const attachment = attachments[Number(select.value)]; if (!attachment || unavailable()) return;
    const pending = ++generation; review.disabled = true; more.disabled = true;
    destination.textContent = ''; file.hidden = true; status.textContent = 'Reviewing the original and linked Topic destination…';
    try {
      const result = await request('documents.attachment.review', { selection: attachment.selection, ...(subfolder.value.trim() ? { subfolder: subfolder.value.trim() } : {}) }, pending);
      if (result.status !== 'review' || typeof result.document?.path !== 'string' || !result.document.path.startsWith('Documents/') || result.source?.sessionId !== binding.sessionId || result.source?.entryId !== attachment.selection.entryId) throw new Error('The original attachment review changed. Select it again.');
      destination.textContent = `${result.topicName || binding.name || 'Topic'} / ${result.document.path} · ${result.document.sizeBytes} bytes · ${result.document.contentType || 'Original file'}. Source: this Conversation.`;
      file.hidden = false;
      // Publication is deliberately unavailable until the native source commit
      // contract and retained original-intent owner are integrated and qualified.
      status.textContent = 'Destination reviewed. Filing is unavailable in this build.';
    } catch (error) { if (current(pending)) status.textContent = host.redact(error.message); }
    finally { if (current(pending)) { review.disabled = false; more.disabled = false; } }
  }, { signal: activeSignal });
  const invalidateReview = () => { generation++; destination.textContent = ''; file.hidden = true; review.disabled = attachments.length === 0 || unavailable(); more.disabled = unavailable(); };
  select.addEventListener('change', invalidateReview, { signal: activeSignal }); subfolder.addEventListener('input', invalidateReview, { signal: activeSignal });
  cancel.addEventListener('click', () => { generation++; region.hidden = true; open.disabled = unavailable(); destination.textContent = ''; file.hidden = true; open.focus(); }, { signal: activeSignal });
  const unsubscribe = host.subscribe(() => { open.disabled = unavailable() || !region.hidden; if (unavailable()) { generation++; review.disabled = true; more.disabled = true; file.hidden = true; destination.textContent = ''; status.textContent = 'Reconnect with write access to review filing.'; } });
  open.disabled = unavailable();
  return { dispose() { generation++; lifetime.abort(); unsubscribe(); open.remove(); region.remove(); } };
}
