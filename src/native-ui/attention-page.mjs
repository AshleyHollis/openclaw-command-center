const text = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const unwrap = (response) => response?.result ?? response;

/** One exact notification destination, using the existing authenticated Attention owner. */
export function mountAttentionPage(container, context, operations = new Map()) {
  const host = context.host;
  const document = container.ownerDocument;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let presented = context.presented;
  let recordId = context.props.notificationRecord;
  let generation = 0;
  let selected;
  const element = (tag, value) => { const node = document.createElement(tag); if (value) node.textContent = value; return node; };
  const heading = element('h1', 'Attention');
  const status = element('p'); status.setAttribute('role', 'status'); status.tabIndex = -1;
  const refresh = element('button', 'Refresh Attention'); refresh.type = 'button';
  const topics = element('button', 'All Topics'); topics.type = 'button';
  const content = element('section'); content.setAttribute('aria-label', 'Attention items'); content.style.overflowWrap = 'anywhere';
  container.replaceChildren(heading, topics, refresh, status, content);
  const readable = () => host.connection.connected && host.connection.canRead;
  const current = (pending) => !signal.aborted && presented && readable() && pending === generation;
  const writable = () => !signal.aborted && presented && readable() && host.connection.canWrite;
  const report = (message) => { status.textContent = host.redact(message); };
  const setBusy = (busy) => { content.setAttribute('aria-busy', String(busy)); refresh.disabled = busy; };

  function renderActivity(records, pending) {
    if (!records.length) return;
    content.append(element('h2', 'Recent Activity'));
    for (const record of records) {
      const row = element('article');
      const operation = nonBlank(record.operationKind) ? record.operationKind : nonBlank(record.actionId) ? record.actionId : 'Activity';
      row.append(element('h3', operation), element('p', `${nonBlank(record.outcome) ? record.outcome : 'recorded'}${nonBlank(record.occurredAt) ? ` · ${record.occurredAt}` : ''}`));
      const target = record.navigation;
      if (target?.verified === true && target.topicId === record.topicId && target.referenceId === record.sourceReferenceId) {
        const open = element('button', target.kind === 'session' ? 'Open Conversation' : 'Open Topic'); open.type = 'button';
        open.addEventListener('click', async () => {
          if (!current(pending) || !readable() || open.disabled) return;
          open.disabled = true;
          try {
            if (target.kind === 'session' && nonBlank(target.sessionId)) {
              const response = await host.request('command-center.v1.sessions.resolve-native', { schemaVersion: 1, topicId: target.topicId, referenceId: target.referenceId, expectedSessionId: target.sessionId });
              if (!current(pending) || !readable()) return;
              const resolved = unwrap(response);
              const agent = /^agent:([^:]+):.+$/.exec(resolved?.sessionKey ?? '');
              if (!agent || Object.keys(resolved ?? {}).some((key) => key !== 'sessionKey')) throw new Error('The exact Activity Conversation is unavailable.');
              host.sessions.openChat({ sessionKey: resolved.sessionKey, agentId: agent[1] });
            } else if (target.kind === 'source') {
              const response = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId: target.topicId });
              if (!current(pending) || !readable()) return;
              if (unwrap(response)?.topic?.topicId !== target.topicId) throw new Error('The exact Activity Topic is unavailable.');
              host.navigation.openPage({ id: 'topic', params: { topicId: target.topicId } });
            }
          } catch (error) { if (current(pending)) report(error?.message || 'Activity navigation is unavailable.'); }
          finally { if (current(pending)) open.disabled = false; }
        }, { signal });
        row.append(open);
      }
      content.append(row);
    }
  }

  function renderOpenLoops(openLoops, pending) {
    if (!openLoops || typeof openLoops !== 'object' || !Number.isSafeInteger(openLoops.total)) return;
    content.append(element('h2', 'Open loops'));
    content.append(element('p', `${openLoops.attentionTotal} need attention · ${openLoops.comingUpTotal} coming up · ${openLoops.waitingTotal} waiting · ${openLoops.suggestedTotal} suggestions · ${openLoops.deferredTotal} deferred`));
    const groups = [['Needs attention', openLoops.highlighted], ['Coming up', openLoops.comingUp]];
    for (const [label, cards] of groups) {
      if (!Array.isArray(cards) || cards.length === 0) continue;
      content.append(element('h3', label));
      for (const card of cards) {
        if (!nonBlank(card.loopId) || !nonBlank(card.title)) continue;
        const row = element('article'); row.dataset.openLoopId = card.loopId;
        row.append(element('h4', card.title));
        const facts = [card.paymentState ?? card.state, Number.isSafeInteger(card.amount) && nonBlank(card.currency) ? `${card.currency} ${(card.amount / 100).toFixed(2)}` : null, nonBlank(card.dueAt) ? `Due ${card.dueAt}` : null].filter(Boolean);
        if (facts.length) row.append(element('p', facts.join(' · ')));
        if (nonBlank(card.whyNow)) row.append(element('p', card.whyNow));
        if (Array.isArray(card.actions) && card.actions.length) row.append(element('p', `Available actions: ${card.actions.join(', ')}.`));
        row.append(element('p', `${Number.isSafeInteger(card.evidenceCount) ? card.evidenceCount : 0} linked source ${card.evidenceCount === 1 ? 'item' : 'items'}.`));
        const evidence = element('button', 'Review evidence'); evidence.type = 'button';
        evidence.addEventListener('click', async () => {
          if (!current(pending) || evidence.disabled) return;
          evidence.disabled = true;
          try {
            const detail = unwrap(await host.request('command-center.v1.open-loops.get', { schemaVersion: 1, loopId: card.loopId }));
            if (!current(pending) || detail?.loop?.loopId !== card.loopId) return;
            let disclosure = row.querySelector('details[data-open-loop-evidence]');
            if (!disclosure) { disclosure = element('details'); disclosure.dataset.openLoopEvidence = 'true'; disclosure.append(element('summary', 'Source evidence')); row.append(disclosure); }
            disclosure.replaceChildren(element('summary', 'Source evidence'), element('pre', text(detail.evidence)));
            disclosure.open = true;
          } catch (error) { if (current(pending)) report(error?.message || 'Open-loop evidence is unavailable.'); }
          finally { if (current(pending)) evidence.disabled = false; }
        }, { signal });
        row.append(evidence);
        if (label === 'Needs attention' && writable() && card.kind === 'payment' && !['paid', 'cancelled'].includes(card.paymentState)) {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Record payment status'));
          form.append(element('p', 'This records your status assertion. It does not pay the bill or contact the sender.'));
          const statusLabel = element('label', 'Status '); const choice = element('select'); choice.name = 'paymentState';
          for (const [value, label] of [['payment-pending', 'Payment initiated; settlement pending'], ['paid', 'Paid and verified by me'], ['disputed', 'Disputed'], ['uncertain', 'Needs reconciliation']]) { const option = element('option', label); option.value = value; choice.append(option); }
          statusLabel.append(choice);
          const rationaleLabel = element('label', ' Evidence or rationale '); const rationale = element('textarea'); rationale.name = 'rationale'; rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
          const save = element('button', 'Save payment status'); save.type = 'submit';
          form.append(statusLabel, rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              const response = unwrap(await host.request('command-center.v1.open-loops.payment-status', { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), loopId: card.loopId, expectedRevision: card.revision, paymentState: choice.value, rationale: rationale.value.trim() }));
              if (!current(pending) || response?.loop?.loopId !== card.loopId) return;
              await load();
              if (!signal.aborted && presented && readable()) report('Payment status recorded. No payment was submitted.');
            } catch (error) { if (current(pending)) report(error?.message || 'Payment status was not recorded.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        } else if (label === 'Needs attention' && writable() && card.kind === 'response' && !['resolved', 'cancelled'].includes(card.state)) {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Record response outcome'));
          form.append(element('p', 'This records that the request was addressed. It does not send a message.'));
          const rationaleLabel = element('label', ' Evidence or rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
          const save = element('button', 'Mark response addressed'); save.type = 'submit'; form.append(rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              const response = unwrap(await host.request('command-center.v1.open-loops.decide', { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), loopId: card.loopId, expectedRevision: card.revision, decision: 'resolve', rationale: rationale.value.trim() }));
              if (!current(pending) || response?.loop?.loopId !== card.loopId) return;
              await load();
              if (!signal.aborted && presented && readable()) report('Response outcome recorded. No message was sent.');
            } catch (error) { if (current(pending)) report(error?.message || 'Response outcome was not recorded.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        }
        content.append(row);
      }
    }
  }

  function render(episode) {
    content.replaceChildren();
    const card = element('article'); card.dataset.episodeId = episode.episodeId;
    card.append(element('h2', episode.context || 'Attention item'), element('p', `${episode.severity} · ${episode.state}`));
    const evidence = element('details'); evidence.append(element('summary', 'Evidence'));
    const evidenceText = element('pre', text({ diagnosis: episode.diagnosis, evidence: episode.evidenceFacts }));
    evidenceText.style.whiteSpace = 'pre-wrap'; evidence.append(evidenceText); card.append(evidence);
    content.append(card);
    if (episode.sourceCapabilityId === 'topic-review') {
      card.append(element('p', 'Topic Review decisions are not yet available on this native page. No Topic action has been submitted.'));
      return;
    }
    if (!nonBlank(episode.topicId) || !nonBlank(episode.sourceReferenceId) || !nonBlank(episode.sourceRevision)) {
      card.append(element('p', 'The exact Topic source and revision are unavailable. Source Recovery is required before taking an action.'));
      return;
    }
    if (!writable()) card.append(element('p', 'Connect with write access to take an action.'));
    const operation = operations.get(episode.episodeId);
    if (operation) {
      card.append(element('p', `${operation.pending ? 'Action pending' : 'Action outcome not confirmed'} · ${operation.params.logicalOperationId}. Refreshing or reopening this page does not submit another action.`));
      const reconcile = element('button', 'Reconcile same action'); reconcile.type = 'button'; reconcile.disabled = operation.pending || !writable();
      reconcile.addEventListener('click', () => void run(episode, operation), { signal }); card.append(reconcile);
      return;
    }
    if (episode.state !== 'Active') { card.append(element('p', 'This item has no action available in its current state.')); return; }
    for (const action of episode.actions ?? []) {
      if (!nonBlank(action.actionId) || !nonBlank(action.label) || !['mutation', 'navigation'].includes(action.kind)) continue;
      const form = element('form');
      form.append(element('h3', action.label));
      for (const [label, value] of Object.entries(action.target?.disclosure ?? {})) form.append(element('p', `${label}: ${text(value)}`));
      if (action.sideEffects?.length) form.append(element('p', `Side effects: ${action.sideEffects.join(' ')}`));
      let inputValue = () => ({});
      const snooze = ['attention.snooze', 'reminder.snooze'].includes(action.actionId);
      if (snooze) {
        const choices = episode.eligibleSnoozeChoices ?? [];
        if (!choices.length) continue;
        const label = element('label', 'Snooze duration'); const select = element('select');
        for (const choice of choices) { const option = element('option', ({ NEXT_0700: 'Tomorrow morning', PT72H: 'Three days', PT168H: 'One week', custom: 'Custom time' })[choice] ?? choice); option.value = choice; select.append(option); }
        label.append(select); form.append(label);
        const timeLabel = element('label', 'Custom snooze time'); const time = element('input'); time.type = 'datetime-local'; timeLabel.append(time); timeLabel.hidden = true; form.append(timeLabel);
        select.addEventListener('change', () => { timeLabel.hidden = select.value !== 'custom'; time.required = !timeLabel.hidden; }, { signal });
        inputValue = () => select.value === 'custom' ? { until: new Date(time.value).toISOString() } : { preset: select.value };
      } else if (Object.keys(action.parameterSchema?.properties ?? {}).some((key) => key !== 'expectedConfigRevision')) {
        const label = element('label', `Parameters for ${action.label} (JSON)`); const input = element('textarea'); input.value = '{}'; input.rows = 4; label.append(input); form.append(label);
        inputValue = () => { const value = JSON.parse(input.value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Action parameters must be a JSON object.'); return value; };
      }
      const button = element('button', action.label); button.type = 'submit'; button.disabled = !writable(); form.append(button);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!writable() || selected !== episode || operations.has(episode.episodeId)) return;
        try {
          const input = inputValue();
          if (['reminder.complete', 'reminder.snooze'].includes(action.actionId)) input.expectedConfigRevision = episode.sourceRevision;
          const approvalId = action.target?.approvalId;
          if (['approval.approve', 'approval.reject'].includes(action.actionId) && !nonBlank(approvalId)) throw new Error('The exact approval is unavailable. Refresh Attention.');
          const params = { schemaVersion: 1, topicId: episode.topicId, sourceReferenceId: episode.sourceReferenceId,
            episodeId: episode.episodeId, expectedEpisodeRevision: episode.revision, expectedSourceRevision: episode.sourceRevision,
            actionId: action.actionId, input, ...(approvalId ? { approvalId } : {}), logicalOperationId: crypto.randomUUID() };
          if (new TextEncoder().encode(JSON.stringify(params)).length > 8192) throw new Error('Action parameters exceed the supported size.');
          const operation = { params, kind: action.kind, pending: false }; operations.set(episode.episodeId, operation);
          void run(episode, operation);
        } catch (error) { report(error.message || 'Check the action parameters.'); }
      }, { signal });
      card.append(form);
    }
  }

  async function run(episode, operation) {
    if (!writable() || operation.pending || selected !== episode) return;
    const pending = ++generation; operation.pending = true; render(episode); report('Submitting the exact action…'); status.focus();
    try {
      const response = await host.request('command-center.v1.attention.act', operation.params);
      const result = unwrap(response);
      if (response?.schemaVersion !== 1 || response.logicalOperationId !== operation.params.logicalOperationId ||
          !['applied', 'approval-required'].includes(result?.status) || result?.episode?.episodeId !== episode.episodeId) throw new Error('The action outcome is not confirmed. Reconcile the same action before choosing another.');
      operations.delete(episode.episodeId);
      if (!current(pending) || !writable()) return;
      if (result.navigation) {
        const target = result.navigation;
        if (operation.kind !== 'navigation' || target.actionId !== operation.params.actionId || target.kind !== 'navigation' || target.target?.topicId !== episode.topicId) throw new Error('The returned destination is not supported on this native page.');
        const response = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId: episode.topicId });
        if (!current(pending) || !writable()) return;
        if (unwrap(response)?.topic?.topicId !== episode.topicId) throw new Error('The exact Topic is unavailable.');
        host.navigation.openPage({ id: 'topic', params: { topicId: episode.topicId } }); return;
      }
      await load(result.status === 'approval-required' ? 'Approval is required. Review the exact disclosure below.' : 'Action applied.');
    } catch (error) {
      if (current(pending)) report(error?.message || 'The action outcome is unknown. Reconcile the same action.');
    } finally {
      operation.pending = false;
      if (current(pending) && selected === episode) render(episode);
    }
  }

  async function load(message = '') {
    const pending = ++generation; selected = undefined; content.replaceChildren(); setBusy(false); container.inert = !presented || signal.aborted;
    if (signal.aborted || !presented) return;
    if (!readable()) { report('Connect with read access to view Attention.'); return; }
    setBusy(true); report('Loading Attention…');
    try {
      const response = await host.request('command-center.v1.dashboard.get', { schemaVersion: 1, activityOffset: 0, activityLimit: 20 });
      if (!current(pending)) return;
      const dashboard = unwrap(response);
      if (!Array.isArray(dashboard?.attention) || !Array.isArray(dashboard?.inProgress)) throw new Error('The Attention destination is unavailable.');
      const cards = [...dashboard.attention, ...dashboard.inProgress];
      if (!recordId) {
        if (cards.length) content.append(element('h2', 'Needs Attention'));
        for (const card of cards) {
          if (!nonBlank(card.notificationRecordId)) continue;
          const button = element('button', `Review ${card.context || 'Attention item'}`); button.type = 'button';
          button.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'attention', params: { notificationRecord: card.notificationRecordId } }); }, { signal }); content.append(button);
        }
        renderOpenLoops(dashboard.openLoops, pending);
        renderActivity(Array.isArray(dashboard?.activity?.records) ? dashboard.activity.records : [], pending);
        report(cards.length || dashboard.openLoops?.attentionTotal ? 'Review the current Attention items and open loops.' : 'No current Attention items.'); return;
      }
      const matches = cards.filter((card) => card.notificationRecordId === recordId);
      if (matches.length !== 1) { report(`${message ? `${message} ` : ''}The exact Attention item is no longer available in the current inbox. Refresh to check again.`); return; }
      const card = matches[0];
      const detail = unwrap(await host.request('command-center.v1.attention.get', { schemaVersion: 1, episodeId: card.episodeId }))?.episode;
      if (!current(pending)) return;
      if (detail?.episodeId !== card.episodeId || detail.topicId !== card.topicId || detail.sourceReferenceId !== card.sourceReferenceId || !Number.isSafeInteger(detail.revision)) throw new Error('The exact Attention source changed. Refresh before taking an action.');
      selected = { ...detail, context: card.context }; render(selected); report(message || 'Attention item ready.');
    } catch (error) { if (current(pending)) report(error?.message || 'Attention is unavailable.'); }
    finally { if (current(pending)) setBusy(false); }
  }
  refresh.addEventListener('click', () => void load(), { signal });
  topics.addEventListener('click', () => { if (!signal.aborted && presented) { generation++; host.navigation.openPage({ id: 'topics' }); } }, { signal });
  let access = `${readable()}:${host.connection.canWrite}`;
  const unsubscribe = host.subscribe(() => { const next = `${readable()}:${host.connection.canWrite}`; if (next !== access) { access = next; void load(); } });
  let disposed = false;
  const cleanup = () => { if (disposed) return; disposed = true; generation++; unsubscribe(); container.inert = false; container.replaceChildren(); };
  signal.addEventListener('abort', cleanup, { once: true });
  void load();
  if (signal.aborted) cleanup();
  return {
    update(next) { if (recordId === next.props.notificationRecord && presented === next.presented) return; recordId = next.props.notificationRecord; presented = next.presented; void load(); },
    focus() { refresh.focus(); },
    dispose() { lifetime.abort(); cleanup(); }
  };
}
