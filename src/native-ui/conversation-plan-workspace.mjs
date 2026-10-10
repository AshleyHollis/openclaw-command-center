import { mountConversationPlan, nativeWorkboardCardTarget } from './conversation-plan.mjs';

// Hosted by the existing Topic/dashboard; never mounts or owns native Chat.
export function mountConversationPlanWorkspace(container, { host, signal, topicId, referenceId, attentionContainer = container, current = () => true }) {
  const document = container.ownerDocument, lifetime = new AbortController();
  const activeSignal = AbortSignal.any([signal, lifetime.signal]);
  let generation = 0, review;
  const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const section = el('section'); section.className = 'cc-module'; section.dataset.conversationPlans = 'true';
  section.setAttribute('aria-label', 'Conversation plans');
  const status = el('p'); status.setAttribute('role', 'status');
  const rows = el('div'), editor = el('div'), refresh = el('button', 'Refresh tracked plans'); refresh.type = 'button';
  section.append(el('h2', 'Conversation plans'), refresh, status, rows, editor); container.append(section);
  const humanRequests = el('section'); humanRequests.setAttribute('aria-label', 'Conversation plan human requests'); attentionContainer.append(humanRequests);
  const live = version => !activeSignal.aborted && current() && version === generation && host.connection.connected && host.connection.canRead;
  const request = async (method, params) => (await host.request(`command-center.v1.conversation-plans.${method}`, { schemaVersion: 1, ...params })).result;
  async function load() {
    const version = ++generation; status.textContent = 'Reading native tracked plans.';
    try {
      const result = await request('list', { ...(topicId ? { topicId } : {}) });
      if (!live(version)) return;
      rows.replaceChildren(); humanRequests.replaceChildren();
      for (const row of result.rows ?? []) {
        const article = el('article');
        if (!row.input || !row.card) { article.append(el('p', 'An exact native card is unavailable.')); rows.append(article); continue; }
        article.append(el('h3', row.input.snapshot.outcome), el('p', `Native status: ${row.card.status}. ${row.progress.availability === 'available' ? `Linked run: ${row.progress.status}.` : 'Linked run progress is unavailable.'}`));
        for (const original of row.attention?.eligible ? row.attention.requests ?? [] : []) {
          const resultReview = original.kind === 'requested-result-review';
          const open = el('button', resultReview ? 'Review requested result' : 'Review native human request'); open.type = 'button';
          open.onclick = async () => {
            if (!live(version)) return;
            open.disabled = true;
            try {
              const currentRow = await request('reconcile', { input: row.input, logicalOperationId: row.input.logicalOperationId });
              if (!live(version)) return;
              if (currentRow.availability !== 'available' || currentRow.card.id !== row.card.id || currentRow.card.sessionKey !== row.card.sessionKey || currentRow.card.runId !== row.card.runId || !currentRow.attention?.eligible || !currentRow.attention.requests?.some(request => original.id === request.id && original.kind === request.kind && original.requestRevision === request.requestRevision && original.episodeId === request.episodeId && original.episodeRevision === request.episodeRevision)) { status.textContent = 'This native human request changed. Refresh tracked plans.'; return; }
              if (resultReview) host.navigation.openPage(nativeWorkboardCardTarget({ ...row.input.destination, cardId: currentRow.card.id }));
              else host.sessions.openChat({ sessionKey: currentRow.card.sessionKey });
            } catch { if (live(version)) status.textContent = 'Current native human-request authority is unavailable.'; }
            finally { if (live(version)) open.disabled = false; }
          };
          const human = el('article'); human.append(el('h3', row.input.snapshot.outcome), open); humanRequests.append(human);
        }
        const nativeCard = el('button', 'Open native card'); nativeCard.type = 'button';
        nativeCard.onclick = async () => {
          if (!live(version)) return; nativeCard.disabled = true;
          try {
            const currentRow = await request('reconcile', { input: row.input, logicalOperationId: row.input.logicalOperationId });
            if (!live(version)) return;
            if (currentRow.availability !== 'available' || currentRow.card?.id !== row.card.id) throw new Error('Exact native card unavailable');
            host.navigation.openPage(nativeWorkboardCardTarget({ ...row.input.destination, cardId: currentRow.card.id }));
          } catch { if (live(version)) status.textContent = 'The exact native card destination is unavailable.'; }
          finally { if (live(version)) nativeCard.disabled = false; }
        };
        article.append(el('p', `Workboard card ${row.card.id} · ${row.input.destination.boardId}.`), nativeCard); rows.append(article);
      }
      status.textContent = `${result.rows?.length ?? 0} tracked plans. Coverage: ${result.coverage}.`;
    } catch { if (live(version)) { rows.replaceChildren(); humanRequests.replaceChildren(); status.textContent = 'Authorized native plan status is unavailable.'; } }
  }
  async function compose() {
    const version = generation;
    try {
      const result = await request('messages', { topicId, referenceId }); if (!live(version)) return;
      const form = el('form'), choice = el('select'); choice.required = true;
      for (const [index, message] of result.messages.entries()) { const option = el('option', message.text.slice(0, 100)); option.value = String(index); choice.append(option); }
      const message = el('pre'); message.style.whiteSpace = 'pre-wrap'; choice.onchange = () => { message.textContent = result.messages[Number(choice.value)]?.text ?? ''; }; choice.onchange();
      const fields = {};
      const add = (name, title, multiline = false) => { const label = el('label', title); const field = el(multiline ? 'textarea' : 'input'); field.required = true; label.append(field); fields[name] = field; form.append(label); };
      const sourceLabel = el('label', 'Source Conversation message'); sourceLabel.append(choice); form.append(sourceLabel, message);
      add('outcome', 'Agreed outcome'); add('steps', 'Exact agreed steps, one per line', true); add('criteria', 'Completion criteria, one per line', true); add('tenant', 'Exact Workboard tenant'); add('board', 'Exact Workboard board');
      const submit = el('button', 'Review this plan'); submit.type = 'submit'; form.append(submit);
      form.onsubmit = event => {
        event.preventDefault(); if (review || !live(version) || !host.connection.canWrite) return;
        const origin = result.messages[Number(choice.value)]; if (!origin) return;
        const input = { family: 'approved-conversation-plan.v1', logicalOperationId: crypto.randomUUID(), source: structuredClone(origin.source), destination: { tenantId: fields.tenant.value, boardId: fields.board.value }, snapshot: { outcome: fields.outcome.value, steps: fields.steps.value.split('\n'), completionCriteria: fields.criteria.value.split('\n') } };
        form.inert = true;
        review = mountConversationPlan(editor, { input, signal: activeSignal, openNativeCard: target => { if (!live(version)) throw new Error('Current destination unavailable'); host.navigation.openPage(nativeWorkboardCardTarget(target)); }, owner: Object.fromEntries(['track', 'reconcile'].map(action => [action, accepted => { if (!live(version)) throw new Error('Current source unavailable'); return request(action, { logicalOperationId: accepted.logicalOperationId, input: accepted }); }])) });
      };
      if (!result.messages.length) { editor.append(el('p', 'No authoritative assistant message is available.')); return; }
      editor.append(form);
    } catch { if (live(version)) editor.append(el('p', 'The exact authorized Conversation is unavailable.')); }
  }
  refresh.onclick = () => { if (!review) { editor.replaceChildren(); void load().then(() => { if (referenceId && !activeSignal.aborted) void compose(); }); } };
  const unsubscribe = host.subscribe(() => { if (!host.connection.connected || !host.connection.canRead || !host.connection.canWrite && referenceId) { generation++; review?.dispose(); rows.replaceChildren(); humanRequests.replaceChildren(); editor.replaceChildren(); status.textContent = 'Conversation plan authority changed. Reopen to review.'; } });
  const dispose = () => { generation++; review?.dispose(); lifetime.abort(); unsubscribe(); section.remove(); humanRequests.remove(); };
  signal.addEventListener('abort', dispose, { once: true });
  void load().then(() => { if (referenceId && !activeSignal.aborted) void compose(); });
  return { dispose };
}
