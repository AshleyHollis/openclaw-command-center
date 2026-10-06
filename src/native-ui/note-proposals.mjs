/** Disabled candidate UI. The operator stages text; no Chat dispatch or Note write. */
export function mountNoteProposals(container, { host, signal, current, verifyContext, topic, target, sources, panel, pointers }) {
  const document = container.ownerDocument;
  const create = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const key = `${topic.topicId}:${target.referenceId}`;
  let retained = pointers.get(key); let access = retained?.access; let value; let busy = false;
  const status = create('p'); status.setAttribute('role', 'status');
  const selection = create('fieldset'); selection.append(create('legend', 'Selected sources for suggestion'));
  const choices = sources.filter(source => source.referenceId !== target.referenceId && source.path.toLowerCase().endsWith('.md')).map(source => {
    const label = create('label'); const input = create('input'); input.type = 'checkbox';
    label.append(input, create('span', `${source.path} (${source.revision})`)); selection.append(label); return { source, input };
  });
  const stageLabel = create('label', 'Suggestion Markdown'); const stage = create('textarea'); stage.rows = 8;
  stage.style.cssText = 'display:block;inline-size:100%;box-sizing:border-box;font:inherit;'; stageLabel.append(stage); stageLabel.hidden = true;
  const comparison = create('section'); comparison.setAttribute('aria-label', 'Suggestion comparison');
  const brief = create('section'); brief.setAttribute('aria-label', 'Verified suggestion context');
  const controls = create('div'); controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const savedLabel = create('label', 'Saved suggestion ID'); const savedId = create('input'); savedId.type = 'text'; savedId.autocomplete = 'off'; savedLabel.append(savedId);
  const button = (label, action) => { const node = create('button', label); node.type = 'button'; node.className = 'btn btn--sm'; node.style.minBlockSize = '44px';
    node.addEventListener('click', () => void run(action), { signal }); controls.append(node); return node; };
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
  const inspect = button('Review saved suggestion', async () => { value = await requestOwner('inspect', access); render(); });
  const recover = button('Recover suggestion by ID', async () => {
    const logicalOperationId = savedId.value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(logicalOperationId)) throw new Error('Enter the exact saved suggestion UUID.');
    const recovered = { schemaVersion: 1, topicId: topic.topicId, logicalOperationId, generation: 1 };
    value = await requestOwner('inspect', recovered); access = recovered; retained = { access }; pointers.set(key, retained); render();
  });
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
    status.textContent = value ? `Suggestion: ${value.status}. Checked ${value.verifiedAt ?? 'not yet'}.` : 'Prepare a review suggestion from selected Markdown sources.';
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
    prepare.disabled = !allowed || !!access && (!retained?.request || ![undefined, 'reading', 'blocked'].includes(value?.status)); inspect.disabled = !allowed || !access; context.disabled = !allowed || !access;
    recover.disabled = !allowed; savedId.disabled = !allowed;
    publish.disabled = !allowed || value?.status !== 'prepared'; discard.disabled = !allowed || !access;
    stage.disabled = !allowed; selection.disabled = !allowed || !!access;
    if (!current() || !host.connection.canWrite) { value = undefined; stage.value = ''; brief.replaceChildren(); comparison.replaceChildren(); stageLabel.hidden = true; }
  }
  container.append(create('h2', 'Review suggestion'), create('p', 'Choose one or two existing Markdown source references from this Topic. Only Notes with an observed reference and revision are selectable. Refresh Notes if the selected sources are unavailable. Keep the suggestion ID to recover it after restarting.'), selection, savedLabel, controls, status, brief, stageLabel, comparison); render();
  return { sync, dispose() { value = undefined; stage.value = ''; container.replaceChildren(); } };
}
