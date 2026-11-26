export function createNoteSuggestionActions(document, signal) {
  const menu = document.createElement('details');
  menu.className = 'reader-note-actions';
  menu.hidden = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Note actions';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'btn btn--sm';
  action.textContent = 'Suggest an edit';
  action.setAttribute('aria-haspopup', 'dialog');
  menu.append(summary, action);

  const dialog = document.createElement('dialog');
  dialog.className = 'reader-note-suggestion';
  const heading = document.createElement('h2');
  heading.id = `note-suggestion-${crypto.randomUUID()}`;
  heading.textContent = 'Suggest an edit';
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn--sm';
  close.textContent = 'Close';
  close.autofocus = true;
  const header = document.createElement('header');
  header.append(heading, close);
  const body = document.createElement('div');
  dialog.append(header, body);

  let getContext;
  let view;
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    summary.focus({ preventScroll: true });
  }, { signal });
  action.addEventListener('click', () => {
    const context = getContext?.();
    if (!context?.current() || dialog.open) return;
    view ??= mountNoteProposals(body, context);
    menu.open = false;
    dialog.showModal();
  }, { signal });
  function dismiss() {
    dialog.close();
    summary.focus({ preventScroll: true });
  }
  close.addEventListener('click', dismiss, { signal });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dismiss();
  }, { signal });
  return {
    menu, dialog,
    offer(context) {
      getContext = context;
      menu.hidden = false;
    },
    sync() { view?.sync(); },
    reset() {
      getContext = undefined;
      menu.hidden = true;
      menu.open = false;
      if (dialog.open) dialog.close();
      view?.dispose();
      view = undefined;
    }
  };
}

/** The operator stages text for comparison with the original note. */
function mountNoteProposals(container, { host, signal, current, verifyContext, topic, target, sources, panel, pointers }) {
  const document = container.ownerDocument;
  const create = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const key = `${topic.topicId}:${target.referenceId}`;
  let retained = pointers.get(key); let access = retained?.access; let value; let busy = false;
  const status = create('p'); status.setAttribute('role', 'status');
  const selection = create('fieldset');
  const instructions = create('p', 'Choose one or two other Markdown notes from this Topic as references for your draft.');
  instructions.id = `note-references-${crypto.randomUUID()}`;
  selection.setAttribute('aria-describedby', instructions.id);
  const references = create('div');
  references.className = 'note-suggestion-references';
  selection.append(create('legend', 'Reference notes'), instructions, references);
  const choices = sources.filter(source => source.referenceId !== target.referenceId && source.path.toLowerCase().endsWith('.md')).map(source => {
    const label = create('label'); const input = create('input'); input.type = 'checkbox';
    label.append(input, create('span', source.path)); references.append(label); return { source, input };
  });
  const stageLabel = create('label', 'Suggestion Markdown'); const stage = create('textarea'); stage.rows = 8;
  stage.style.cssText = 'display:block;inline-size:100%;box-sizing:border-box;font:inherit;'; stageLabel.append(stage); stageLabel.hidden = true;
  const comparison = create('section'); comparison.setAttribute('aria-label', 'Suggestion comparison');
  const brief = create('section'); brief.setAttribute('aria-label', 'Verified suggestion context');
  const controls = create('div'); controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const savedLabel = create('label', 'Saved suggestion ID'); const savedId = create('input'); savedId.type = 'text'; savedId.autocomplete = 'off'; savedLabel.append(savedId);
  const recovery = create('details');
  recovery.append(create('summary', 'Recover a draft'), savedLabel);
  const button = (label, action, parent = controls) => { const node = create('button', label); node.type = 'button'; node.className = 'btn btn--sm'; node.style.minBlockSize = '44px';
    node.addEventListener('click', () => void run(action), { signal }); parent.append(node); return node; };
  const prepare = button('Prepare suggestion', async () => {
    const selected = retained?.request?.sources ?? choices.filter(choice => choice.input.checked).map(choice => choice.source);
    if (selected.length < 1 || selected.length > 2) throw new Error('Select one or two Markdown sources.');
    // Retain this exact request through a lost response. Restart recovery is an
    // explicit operator inspection; no automatic generation is introduced.
    access ??= { schemaVersion: 1, topicId: topic.topicId, logicalOperationId: crypto.randomUUID(), generation: 1 };
    const request = retained?.request ?? { ...access, expectedTopicRevision: topic.revision, target, sources: selected, ...(panel ? { panel } : {}) };
    retained = { access, request }; pointers.set(key, retained);
    savedId.value = access.logicalOperationId;
    value = await requestOwner('prepare', request); render();
  });
  const inspect = button('Review saved suggestion', async () => { value = await requestOwner('inspect', access); render(); }, recovery);
  const recover = button('Recover suggestion by ID', async () => {
    const logicalOperationId = savedId.value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(logicalOperationId)) throw new Error('Enter the exact saved suggestion UUID.');
    const recovered = { schemaVersion: 1, topicId: topic.topicId, logicalOperationId, generation: 1 };
    value = await requestOwner('inspect', recovered); access = recovered; retained = { access }; pointers.set(key, retained); render();
  }, recovery);
  const context = button('Verify generation context', async () => { value = await requestOwner('context', access); render(); });
  const publish = button('Review suggestion', async () => {
    value = await requestOwner('publish', { ...access, basisDigest: value.basisDigest, proposedText: stage.value,
      citations: value.snapshot.sources.map(({ referenceId, revision }) => ({ referenceId, revision })) }); render();
  });
  const discard = button('Discard', async () => { value = await requestOwner('discard', access, false); stage.value = ''; render(); });
  async function requestOwner(action, params, checkSources = true) {
    if (!current() || !host.connection.canWrite) throw new Error('Current operator write access is required.');
    if (checkSources) await verifyContext?.();
    if (!current() || !host.connection.canWrite) throw new Error('The current Note context changed.');
    const response = await host.request(`command-center.v1.notes.proposals.${action}`, params);
    if (checkSources) await verifyContext?.();
    if (!current() || !host.connection.canWrite) throw new Error('The current Note context changed.');
    const result = response?.result ?? response;
    if (result?.snapshot && (result.snapshot.target.referenceId !== target.referenceId || result.snapshot.target.path !== target.path)) throw new Error('The saved suggestion belongs to another Note.');
    return result;
  }
  async function run(action) {
    if (busy) return; busy = true; sync(); status.textContent = 'Checking suggestion context.';
    try { await action(); }
    catch (error) { value = undefined; brief.replaceChildren(); comparison.replaceChildren(); stage.value = ''; stageLabel.hidden = true;
      if (current()) status.textContent = host.redact(error?.message ?? 'Suggestion unavailable.'); }
    finally { busy = false; sync(); }
  }
  function render() {
    brief.replaceChildren(); comparison.replaceChildren(); stageLabel.hidden = value?.status !== 'prepared';
    status.textContent = value ? `Suggestion: ${value.status}. Checked ${value.verifiedAt ?? 'not yet'}.` : '';
    if (access) savedId.value = access.logicalOperationId;
    if (['stale', 'failed', 'discarded'].includes(value?.status)) { stage.value = ''; pointers.delete(key); retained = undefined; access = undefined; }
    if (value?.snapshot) {
      const text = create('pre'); text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;';
      text.textContent = [`Target: ${value.snapshot.target.path} (${value.snapshot.target.revision})\n${value.snapshot.target.text}`,
        'Keep the operator edits and source references. Return proposed Markdown for review.',
        ...value.snapshot.sources.map(source => `Source: ${source.path} — ${source.referenceId} (${source.revision})\n${source.text}`)].join('\n\n'); brief.append(text);
    }
    if (value?.comparison) for (const [label, text] of [['Original', value.comparison.before], ['Proposed', value.comparison.after]]) {
      const pre = create('pre', text); pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;'; comparison.append(create('h3', label), pre);
    }
    sync();
  }
  function sync() {
    const allowed = !busy && current() && host.connection.canWrite;
    context.hidden = !access;
    discard.hidden = !access;
    publish.hidden = value?.status !== 'prepared';
    prepare.disabled = !allowed || !!access && (!retained?.request || ![undefined, 'reading', 'blocked'].includes(value?.status)); inspect.disabled = !allowed || !access; context.disabled = !allowed || !access;
    recover.disabled = !allowed; savedId.disabled = !allowed;
    publish.disabled = !allowed || value?.status !== 'prepared'; discard.disabled = !allowed || !access;
    stage.disabled = !allowed; selection.disabled = !allowed || !!access;
    if (!current() || !host.connection.canWrite) { value = undefined; stage.value = ''; brief.replaceChildren(); comparison.replaceChildren(); stageLabel.hidden = true; }
  }
  container.append(selection, controls, recovery, status, brief, stageLabel, comparison); render();
  return { sync, dispose() { value = undefined; stage.value = ''; container.replaceChildren(); } };
}
