const route = '/plugins/command-center/api/topic/actions';

/** Review original native attachments inside the existing Topic Files surface. */
export function mountTopicAttachmentReview(container, { host, signal, binding, verifyContext, onFiled, onSource, onSourceCancel }) {
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
  const operation = document.createElement('input'); operation.setAttribute('aria-label', 'Saved filing ID'); operation.placeholder = 'Saved filing ID to check';
  const check = document.createElement('button'); check.type = 'button'; check.textContent = 'Check result';
  const reopen = document.createElement('button'); reopen.type = 'button'; reopen.textContent = 'Open filed document'; reopen.hidden = true;
  const source = document.createElement('button'); source.type = 'button'; source.textContent = 'Open source Conversation'; source.hidden = true;
  const next = document.createElement('button'); next.type = 'button'; next.textContent = 'New filing'; next.hidden = true;
  const previous = document.createElement('p'); previous.setAttribute('aria-label', 'Previous filing receipt');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  region.append(status, select, subfolder, review, more, destination, file, operation, check, reopen, source, next, previous, cancel);
  container.append(open, region);
  let generation = 0; let attachments = []; let nextOffset = null;
  let prepared = null; let submitted = false; let busy = false; let preparationStarted = false;
  const freezeFields = value => { select.disabled = value || preparationStarted || submitted; subfolder.disabled = value || preparationStarted || submitted; operation.readOnly = value || preparationStarted || submitted; cancel.disabled = value; review.disabled = value || submitted; more.disabled = value || preparationStarted || submitted; file.disabled = value || submitted || !prepared?.canFile; check.disabled = value; reopen.disabled = value; };
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
    if (response.status !== 200 || value.schemaVersion !== 1 || value.status === 'error' || (value.result?.topicId ?? value.result?.value?.topicId ?? binding.topicId) !== binding.topicId) throw new Error('Attachment action did not confirm a result. Keep the saved filing ID and Check result.');
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
    if (busy || submitted) return;
    const pending = ++generation; busy = true; preparationStarted = true; freezeFields(true);
    if (!operation.value) operation.value = crypto.randomUUID();
    destination.textContent = ''; file.hidden = true; status.textContent = 'Reviewing the original and linked Topic destination…';
    try {
      const result = await request('documents.attachment.prepare', { logicalOperationId: operation.value, selection: attachment.selection, ...(subfolder.value.trim() ? { subfolder: subfolder.value.trim() } : {}) }, pending);
      if (!['prepared', 'filed'].includes(result.status) || result.logicalOperationId !== operation.value || typeof result.document?.path !== 'string' || !result.document.path.startsWith('Documents/') || result.source?.sessionId !== binding.sessionId || result.source?.entryId !== attachment.selection.entryId) throw new Error('The original attachment review changed. Select it again.');
      prepared = result;
      operation.readOnly = true;
      destination.textContent = `${result.topicName || binding.name || 'Topic'} / ${result.document.path} · ${result.document.sizeBytes} bytes · ${result.document.contentType || 'Original file'}. Source: this Conversation.`;
      file.hidden = false;
      // Publication is deliberately unavailable until the native source commit
      // contract and retained original-intent owner are integrated and qualified.
      file.disabled = result.canFile !== true;
      reopen.hidden = result.status !== 'filed';
      status.textContent = result.canFile === true ? `Destination reviewed. Saved filing ID: ${operation.value}. File the original when ready.` : 'Destination reviewed. Filing is unavailable in this build.';
    } catch (error) { if (current(pending)) status.textContent = host.redact(error.message); }
    finally { busy = false; if (current(pending)) { freezeFields(false); select.disabled = true; subfolder.disabled = true; operation.readOnly = true; } }
  }, { signal: activeSignal });
  async function filingAction(action) {
    if (busy || unavailable() || !/^[0-9a-f-]{36}$/iu.test(operation.value)) return;
    const pending = ++generation; busy = true;
    if (action === 'documents.attachment.file') submitted = true;
    freezeFields(true); status.textContent = `${action.endsWith('.file') ? 'Filing original' : 'Checking original filing'}. Saved filing ID: ${operation.value}.`;
    try {
      const result = await request(action, { logicalOperationId: operation.value }, pending);
      const receipt = result.value ?? result;
      if (result.status === 'applied' || result.status === 'filed') {
        if (receipt.logicalOperationId !== operation.value || receipt.source?.sessionId !== binding.sessionId || typeof receipt.document?.referenceId !== 'string') throw new Error('The original filing receipt is unavailable. Keep the saved ID.');
        submitted = true; prepared = { ...receipt, canFile: false }; file.disabled = true; reopen.hidden = false;
        source.hidden = false; next.hidden = false;
        status.textContent = `Original filed: ${receipt.document.path}. Source: this Conversation, message ${receipt.source.entryId}. Saved filing ID: ${operation.value}.`;
        if (action.endsWith('.reopen')) await onFiled?.(receipt.document);
      } else {
        status.textContent = `${result.status === 'not-applied' ? 'Original was not filed.' : 'Filing outcome is unknown.'} Keep saved filing ID ${operation.value}; Check result never files again.`;
      }
    } catch (error) { if (current(pending)) status.textContent = `${host.redact(error.message)} Saved filing ID: ${operation.value}.`; }
    finally { busy = false; if (current(pending)) { freezeFields(false); if (submitted) { select.disabled = true; subfolder.disabled = true; operation.readOnly = true; review.disabled = true; more.disabled = true; file.disabled = true; } } }
  }
  file.addEventListener('click', () => { if (prepared?.canFile && !submitted) void filingAction('documents.attachment.file'); }, { signal: activeSignal });
  check.addEventListener('click', () => void filingAction('documents.attachment.check'), { signal: activeSignal });
  reopen.addEventListener('click', () => void filingAction('documents.attachment.reopen'), { signal: activeSignal });
  source.addEventListener('click', async () => { if (busy || unavailable() || !prepared?.source) return; const pending = ++generation; try { await verifyContext(); if (!current(pending)) return; await onSource?.(prepared.source); } catch (error) { if (current(pending)) status.textContent = host.redact(error.message); } }, { signal: activeSignal });
  next.addEventListener('click', () => { if (busy || next.hidden) return; onSourceCancel?.(); previous.textContent = `Previous filed document: ${prepared.document.path}. Saved filing ID: ${operation.value}.`; generation++; submitted = false; preparationStarted = false; prepared = null; operation.value = ''; freezeFields(false); source.hidden = true; next.hidden = true; reopen.hidden = true; file.hidden = true; destination.textContent = ''; status.textContent = 'Choose the next original attachment.'; }, { signal: activeSignal });
  const invalidateReview = () => { if (submitted || busy) return; generation++; prepared = null; operation.value = ''; destination.textContent = ''; file.hidden = true; reopen.hidden = true; review.disabled = attachments.length === 0 || unavailable(); more.disabled = unavailable(); };
  select.addEventListener('change', invalidateReview, { signal: activeSignal }); subfolder.addEventListener('input', invalidateReview, { signal: activeSignal });
  cancel.addEventListener('click', () => { if (busy) return; onSourceCancel?.(); if (prepared?.status === 'prepared' && !submitted) { prepared = null; preparationStarted = false; operation.value = ''; freezeFields(false); } generation++; region.hidden = true; open.disabled = unavailable(); destination.textContent = ''; file.hidden = true; open.focus(); }, { signal: activeSignal });
  const unsubscribe = host.subscribe(() => { open.disabled = unavailable() || !region.hidden; if (unavailable()) { generation++; review.disabled = true; more.disabled = true; file.hidden = true; destination.textContent = ''; status.textContent = 'Reconnect with write access to review filing.'; } });
  open.disabled = unavailable();
  return { dispose() { generation++; onSourceCancel?.(); lifetime.abort(); unsubscribe(); open.remove(); region.remove(); } };
}
