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

  const formatInstant = value => {
    if (!nonBlank(value) || Number.isNaN(Date.parse(value))) return value;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  };
  const formatDue = value => nonBlank(value?.dueDate)
    ? `${value.dueDate} (${value.dueTimeZone}, calendar date)`
    : nonBlank(value?.dueAt) ? formatInstant(value.dueAt) : null;

  function renderEvidence(disclosure, detail) {
    disclosure.replaceChildren(element('summary', 'Source evidence'));
    const loop = detail?.loop;
    if (nonBlank(loop?.expectedEvent)) disclosure.append(element('p', `Expected next event: ${loop.expectedEvent}`));
    if (nonBlank(loop?.reviewAt)) disclosure.append(element('p', `Review after ${formatInstant(loop.reviewAt)}`));
    const evidence = Array.isArray(detail?.evidence) ? detail.evidence : [];
    if (evidence.length === 0) {
      disclosure.append(element('p', 'No readable source facts are currently available. The source may be unavailable or require a separately authorized reader.'));
      return;
    }
    for (const item of evidence) {
      const article = element('article');
      article.append(element('h5', nonBlank(item.summary) ? item.summary : `${item.type ?? 'Evidence'} from ${item.sourceKind ?? item.sourceSystem ?? 'source'}`));
      const source = [item.sourceSystem, item.sourceKind, item.sourceVersion].filter(nonBlank).join(' · ');
      if (source) article.append(element('p', `Source: ${source}`));
      const timing = [nonBlank(item.occurredAt) ? `Occurred ${formatInstant(item.occurredAt)}` : null, nonBlank(item.observedAt) ? `Observed ${formatInstant(item.observedAt)}` : null, item.historicalBaseline === true ? 'Historical baseline' : null].filter(Boolean);
      if (timing.length) article.append(element('p', timing.join(' · ')));
      const facts = [
        ['Payee', item.payee], ['Purpose', item.purpose], ['Invoice', item.invoiceId], ['Account', item.accountId],
        ['Amount', Number.isSafeInteger(item.amount) && nonBlank(item.currency) ? `${item.currency} ${(item.amount / 100).toFixed(2)}` : null],
        ['Due', formatDue(item)], ['Event', item.eventKind],
        ['Requirement', nonBlank(item.requirementKind) && nonBlank(item.requirementId) ? `${item.requirementKind}: ${item.requirementId}` : null],
        ['Stage', nonBlank(item.stageId) ? item.stageId : null], ['Choice', item.chosenOption],
        ['Recorded choice', item.recordedChoice], ['Observed choice', item.observedChoice], ['Rationale', item.rationale], ['Assumption', item.assumption],
        ['Assessment', item.assessment], ['Status', item.status]
      ].filter(([, value]) => value !== undefined && value !== null && value !== '');
      if (facts.length) {
        const list = element('dl');
        for (const [label, value] of facts) list.append(element('dt', label), element('dd', String(value)));
        article.append(list);
      }
      if (item.sourceAvailable === false) article.append(element('p', 'The original source is currently unavailable. This does not mean the open loop is complete.'));
      disclosure.append(article);
    }
    disclosure.append(element('p', 'Exact original-source navigation is not available from this item yet. Use the displayed source system, kind, and version to verify it in its authorized reader.'));
  }

  async function submitOpenLoopOperation({ key, method, params, card, pending, success, includeLoopId = true }) {
    const operation = operations.get(key) ?? { method, params: { schemaVersion: 1, logicalOperationId: crypto.randomUUID(), ...(includeLoopId ? { loopId: card.loopId } : {}), expectedRevision: card.revision, ...params } };
    operations.set(key, operation);
    const envelope = await host.request(operation.method, operation.params);
    const response = unwrap(envelope);
    if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || response?.loop?.loopId !== card.loopId) throw new Error('The action outcome is not confirmed. Retry to reconcile the same operation.');
    if (!current(pending)) return false;
    operations.delete(key);
    await load();
    if (!signal.aborted && presented && readable()) report(success);
    return true;
  }

  function appendDecisionControls(row, card, pending) {
    if (!writable() || ['resolved', 'cancelled'].includes(card.state)) return;
    const disclosure = element('details'); disclosure.dataset.openLoopDecisions = 'true';
    disclosure.append(element('summary', card.state === 'suggested' ? 'Review suggestion' : 'Defer or resolve'));
    const form = element('form');
    const decisionLabel = element('label', 'Action '); const decision = element('select');
    const choices = card.state === 'suggested'
      ? [['confirm', 'Confirm this obligation'], ['dismiss', 'Dismiss this suggestion']]
      : [['defer', 'Defer until a review time'], ['correct-date', 'Correct the accepted due date'], ...(card.kind === 'payment' || card.kind === 'response' ? [] : [['resolve', 'Mark resolved']])];
    for (const [value, label] of choices) { const option = element('option', label); option.value = value; decision.append(option); }
    if (!choices.length) return;
    decisionLabel.append(decision);
    const reviewLabel = element('label', ' Review time '); const reviewAt = element('input'); reviewAt.type = 'datetime-local'; reviewLabel.append(reviewAt);
    const dateOnlyLabel = element('label', ' Calendar date only '); const dateOnly = element('input'); dateOnly.type = 'checkbox'; dateOnlyLabel.prepend(dateOnly);
    const dueLabel = element('label', ' Corrected due date and time '); const dueAt = element('input'); dueAt.type = 'datetime-local'; dueLabel.append(dueAt);
    const dueDateLabel = element('label', ' Corrected calendar date '); const dueDate = element('input'); dueDate.type = 'date'; dueDateLabel.append(dueDate);
    const rationaleLabel = element('label', ' Rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
    const update = () => {
      const deferred = decision.value === 'defer'; const correcting = decision.value === 'correct-date';
      reviewLabel.hidden = !deferred; reviewAt.required = deferred;
      dateOnlyLabel.hidden = !correcting;
      dueLabel.hidden = !correcting || dateOnly.checked; dueAt.required = correcting && !dateOnly.checked;
      dueDateLabel.hidden = !correcting || !dateOnly.checked; dueDate.required = correcting && dateOnly.checked;
    };
    decision.addEventListener('change', update, { signal }); dateOnly.addEventListener('change', update, { signal }); update();
    const save = element('button', 'Save action'); save.type = 'submit';
    form.append(decisionLabel, reviewLabel, dateOnlyLabel, dueLabel, dueDateLabel, rationaleLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
      save.disabled = true;
      try {
        const review = decision.value === 'defer' ? new Date(reviewAt.value).toISOString() : undefined;
        const due = decision.value === 'correct-date' && !dateOnly.checked ? new Date(dueAt.value).toISOString() : undefined;
        const calendarDue = decision.value === 'correct-date' && dateOnly.checked ? dueDate.value : undefined;
        const dueTimeZone = calendarDue === undefined ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone;
        await submitOpenLoopOperation({
          key: `open-loop-decision:${card.loopId}:${decision.value}`,
          method: 'command-center.v1.open-loops.decide',
          params: { decision: decision.value, ...(review === undefined ? {} : { reviewAt: review }), ...(due === undefined ? {} : { dueAt: due }), ...(calendarDue === undefined ? {} : { dueDate: calendarDue, dueTimeZone }), rationale: rationale.value.trim() },
          card, pending,
          success: decision.value === 'defer' ? 'The item was deferred to the selected review time.' : decision.value === 'correct-date' ? 'The accepted due date was corrected.' : decision.value === 'confirm' ? 'The suggestion was confirmed.' : decision.value === 'dismiss' ? 'The suggestion was dismissed.' : 'The outcome was recorded.'
        });
      } catch (error) { if (current(pending)) report(error?.message || 'Action outcome is unknown. Retry to reconcile the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

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

  function appendRenovationRelationshipControl(row, card, detail, pending) {
    if (!writable() || ['resolved', 'cancelled'].includes(card.state) || row.querySelector('details[data-renovation-purchase]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'purchase' && nonBlank(item.requirementNamespace) && nonBlank(item.requirementId));
    if (!requirement) return;
    const disclosure = element('details'); disclosure.dataset.renovationPurchase = 'true'; disclosure.append(element('summary', 'Confirm exact purchased item'));
    const form = element('form'); form.append(element('p', `This resolves only requirement ${requirement.requirementId}. A name match alone is not accepted.`));
    const purchaseLabel = element('label', 'Purchase or receipt item ID '); const purchaseId = element('input'); purchaseId.required = true; purchaseId.maxLength = 300; purchaseLabel.append(purchaseId);
    const save = element('button', 'Link purchase to requirement'); save.type = 'submit'; form.append(purchaseLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!current(pending) || !writable() || save.disabled || !purchaseId.value.trim()) return;
      save.disabled = true;
      const key = `renovation-purchase:${card.loopId}`;
      try {
        let operation = operations.get(key);
        if (!operation) {
          const logicalOperationId = crypto.randomUUID(); const now = new Date().toISOString();
          operation = { method: 'command-center.v1.open-loops.renovation-purchase', params: { schemaVersion: 1, logicalOperationId, expectedRevision: card.revision, reconciliation: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-purchase-relationship', externalId: logicalOperationId, version: 'operator-v1' }, requirement: { kind: 'purchase', namespace: requirement.requirementNamespace, id: requirement.requirementId }, purchase: { kind: 'purchase', namespace: requirement.requirementNamespace, id: purchaseId.value.trim() }, occurredAt: now, observedAt: now, historicalBaseline: false, ...(card.topicId ? { topicId: card.topicId } : {}) } } };
          operations.set(key, operation);
        }
        const envelope = await host.request(operation.method, operation.params); const response = unwrap(envelope);
        if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || response?.loop?.loopId !== card.loopId || response.loop.state !== 'resolved') throw new Error('The purchase relationship outcome is not confirmed. Retry to reconcile the same operation.');
        if (!current(pending)) return;
        operations.delete(key); await load(); if (current(pending)) report('The exact purchase was linked. Other requirements and any return obligation remain separate.');
      } catch (error) { if (current(pending)) report(error?.message || 'The purchase relationship outcome is unknown. Retry to reconcile the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationFulfilmentControl(row, card, detail, pending) {
    if (!writable() || row.querySelector('details[data-renovation-fulfilment]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && ['purchase', 'installation'].includes(item.requirementKind) && nonBlank(item.requirementNamespace) && nonBlank(item.requirementId));
    if (!requirement) return;
    const disclosure = element('details'); disclosure.dataset.renovationFulfilment = 'true'; disclosure.append(element('summary', 'Record delivery or installation'));
    const form = element('form'); form.append(element('p', `Record fulfilment only for exact requirement ${requirement.requirementId}. Delivery does not imply installation.`));
    const kindLabel = element('label', 'Outcome '); const kind = element('select');
    for (const [value, label] of [['delivered', 'Delivered'], ['installed', 'Installed']]) { const option = element('option', label); option.value = value; kind.append(option); } kindLabel.append(kind);
    const installationLabel = element('label', ' Installation still required '); const installationRequired = element('input'); installationRequired.type = 'checkbox'; installationRequired.checked = requirement.requirementKind === 'installation'; installationLabel.append(installationRequired);
    const save = element('button', 'Record fulfilment'); save.type = 'submit'; form.append(kindLabel, installationLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled) return; save.disabled = true;
      try {
        const now = new Date().toISOString();
        await submitOpenLoopOperation({ key: `renovation-fulfilment:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-fulfilment', params: { fulfilment: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-fulfilment', externalId: crypto.randomUUID(), version: 'operator-v1' }, requirement: { kind: requirement.requirementKind, namespace: requirement.requirementNamespace, id: requirement.requirementId }, fulfilmentKind: kind.value, installationRequired: kind.value === 'installed' ? false : installationRequired.checked, occurredAt: now, observedAt: now, historicalBaseline: false, ...(card.topicId ? { topicId: card.topicId } : {}) } }, card, pending, includeLoopId: false, success: kind.value === 'installed' ? 'Installation recorded.' : 'Delivery recorded; any required installation remains open.' });
      } catch (error) { if (current(pending)) report(error?.message || 'The fulfilment outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationReplacementControl(row, card, detail, pending) {
    if (!writable() || row.querySelector('details[data-renovation-replacement]')) return;
    const requirement = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'purchase' && nonBlank(item.requirementNamespace));
    if (!requirement) return;
    const disclosure = element('details'); disclosure.dataset.renovationReplacement = 'true'; disclosure.append(element('summary', 'Record replacement follow-up'));
    const form = element('form'); form.append(element('p', 'A replacement purchase and its return, refund, or resale obligation remain separate records.'));
    const field = (labelText, required = true) => { const label = element('label', `${labelText} `); const input = element('input'); input.required = required; input.maxLength = 300; label.append(input); form.append(label); return input; };
    const replacementId = field('Replacement purchase ID'); const replacedItemId = field('Replaced item ID');
    const kindLabel = element('label', 'Follow-up '); const obligationKind = element('select'); for (const value of ['return', 'refund', 'resale']) { const option = element('option', value[0].toUpperCase() + value.slice(1)); option.value = value; obligationKind.append(option); } kindLabel.append(obligationKind); form.append(kindLabel);
    const obligationId = field('Follow-up ID'); const title = field('Follow-up title'); const dueLabel = element('label', 'Deadline '); const due = element('input'); due.type = 'datetime-local'; due.required = true; dueLabel.append(due); form.append(dueLabel);
    const save = element('button', 'Record replacement and follow-up'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled || !replacementId.value.trim() || !replacedItemId.value.trim() || !obligationId.value.trim() || !title.value.trim() || !due.value) return; save.disabled = true;
      const key = `renovation-replacement:${card.loopId}`;
      try {
        let operation = operations.get(key);
        if (!operation) {
          const logicalOperationId = crypto.randomUUID(); const now = new Date().toISOString();
          operation = { method: 'command-center.v1.open-loops.renovation-replacement', params: { schemaVersion: 1, logicalOperationId, expectedRevision: 0, replacement: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-replacement-follow-up', externalId: logicalOperationId, version: 'operator-v1' }, replacementPurchase: { kind: 'purchase', namespace: requirement.requirementNamespace, id: replacementId.value.trim() }, replacedItem: { kind: 'renovation-item', namespace: requirement.requirementNamespace, id: replacedItemId.value.trim() }, obligation: { kind: obligationKind.value, namespace: requirement.requirementNamespace, id: obligationId.value.trim() }, occurredAt: now, observedAt: now, historicalBaseline: false, title: title.value.trim(), dueAt: new Date(due.value).toISOString(), ...(card.topicId ? { topicId: card.topicId } : {}) } } };
          operations.set(key, operation);
        }
        const envelope = await host.request(operation.method, operation.params); const response = unwrap(envelope);
        if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || !nonBlank(response?.loop?.loopId) || response.loop.loopId === card.loopId) throw new Error('The separate replacement follow-up was not confirmed. Retry the same operation.');
        if (!current(pending)) return; operations.delete(key); await load(); if (current(pending)) report('Replacement recorded with a separate follow-up obligation.');
      } catch (error) { if (current(pending)) report(error?.message || 'The replacement outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal });
    disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationStageControl(row, card, detail, pending) {
    if (!writable() || row.querySelector('details[data-renovation-stage]')) return;
    const prerequisite = detail?.evidence?.find(item => item.eventKind === 'requirement-recorded' && item.requirementKind === 'prerequisite' && nonBlank(item.stageNamespace) && nonBlank(item.stageId));
    if (!prerequisite) return;
    const disclosure = element('details'); disclosure.dataset.renovationStage = 'true'; disclosure.append(element('summary', 'Set exact renovation stage'));
    const form = element('form'); form.append(element('p', `Only prerequisites for stage ${prerequisite.stageId} will surface together.`));
    const stateLabel = element('label', 'Stage state '); const active = element('select'); for (const [value, label] of [['true', 'Active'], ['false', 'Inactive']]) { const option = element('option', label); option.value = value; active.append(option); } stateLabel.append(active);
    const save = element('button', 'Save stage state'); save.type = 'submit'; form.append(stateLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled) return; save.disabled = true; const key = `renovation-stage:${prerequisite.stageNamespace}:${prerequisite.stageId}`;
      try {
        let operation = operations.get(key); if (!operation) { const logicalOperationId = crypto.randomUUID(); const now = new Date().toISOString(); operation = { method: 'command-center.v1.open-loops.renovation-stage', params: { schemaVersion: 1, logicalOperationId, expectedRevision: 0, activation: { schemaVersion: 1, source: { system: 'command-center', kind: 'explicit-stage-state', externalId: logicalOperationId, version: 'operator-v1' }, stage: { kind: 'renovation-stage', namespace: prerequisite.stageNamespace, id: prerequisite.stageId }, active: active.value === 'true', occurredAt: now, observedAt: now, ...(card.topicId ? { topicId: card.topicId } : {}) } } }; operations.set(key, operation); }
        const envelope = await host.request(operation.method, operation.params); const response = unwrap(envelope); if (envelope?.schemaVersion !== 1 || envelope.status !== 'applied' || envelope.logicalOperationId !== operation.params.logicalOperationId || !nonBlank(response?.observationId)) throw new Error('The stage state was not confirmed. Retry the same operation.');
        if (!current(pending)) return; operations.delete(key); await load(); if (current(pending)) report(active.value === 'true' ? 'The exact stage is active.' : 'The exact stage is inactive.');
      } catch (error) { if (current(pending)) report(error?.message || 'The stage outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal }); disclosure.append(form); row.append(disclosure);
  }

  function appendRenovationDecisionConflictControl(row, card, detail, pending) {
    if (!writable() || card.kind !== 'decision' || card.state === 'decision-needed' || row.querySelector('details[data-renovation-conflict]')) return;
    const decision = detail?.evidence?.filter(item => nonBlank(item.decisionId) && nonBlank(item.chosenOption)).at(-1);
    if (!decision) return;
    const disclosure = element('details'); disclosure.dataset.renovationConflict = 'true'; disclosure.append(element('summary', 'Record changed quote or purchase'));
    const form = element('form'); form.append(element('p', `The recorded choice remains ${decision.chosenOption} until you explicitly revise it.`));
    const kindLabel = element('label', 'Evidence kind '); const kind = element('select'); for (const [value, label] of [['revised-quote', 'Revised quote'], ['purchase-vs-choice', 'Purchase differs from choice']]) { const option = element('option', label); option.value = value; kind.append(option); } kindLabel.append(kind);
    const choiceLabel = element('label', 'Observed choice '); const observedChoice = element('input'); observedChoice.required = true; observedChoice.maxLength = 500; choiceLabel.append(observedChoice);
    const summaryLabel = element('label', 'Summary '); const summary = element('textarea'); summary.required = true; summary.maxLength = 1000; summaryLabel.append(summary); const save = element('button', 'Record evidence for review'); save.type = 'submit'; form.append(kindLabel, choiceLabel, summaryLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current(pending) || !writable() || save.disabled || !observedChoice.value.trim() || !summary.value.trim()) return; save.disabled = true;
      try { const now = new Date().toISOString(); await submitOpenLoopOperation({ key: `renovation-conflict:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-decision-conflict', params: { conflict: { schemaVersion: 1, decisionId: decision.decisionId, source: { system: 'command-center', kind: kind.value, externalId: crypto.randomUUID(), version: 'operator-v1' }, conflictKind: kind.value, occurredAt: now, observedAt: now, historicalBaseline: false, summary: summary.value.trim(), recordedChoice: decision.chosenOption, observedChoice: observedChoice.value.trim(), evidenceSelectors: ['explicit-operator-evidence'] } }, card, pending, includeLoopId: false, success: observedChoice.value.trim() === decision.chosenOption ? 'Matching evidence recorded without changing Attention.' : 'Changed evidence recorded for explicit decision review.' }); }
      catch (error) { if (current(pending)) report(error?.message || 'The changed evidence outcome is unknown. Retry the same operation.'); }
      finally { if (current(pending)) save.disabled = false; }
    }, { signal }); disclosure.append(form); row.append(disclosure);
  }

  function renderOpenLoops(openLoops, pending) {
    if (!openLoops || typeof openLoops !== 'object' || !Number.isSafeInteger(openLoops.total)) return;
    content.append(element('h2', 'Open loops'));
    content.append(element('p', `${openLoops.attentionTotal} need attention · ${openLoops.comingUpTotal} coming up · ${openLoops.waitingTotal} waiting · ${openLoops.suggestedTotal} suggestions · ${openLoops.deferredTotal} deferred`));
    const stageGroups = Array.isArray(openLoops.stageReviews) ? openLoops.stageReviews.map(group => [`Active renovation stage: ${group.stage?.id ?? 'stage'}`, group.items]) : [];
    const groups = [['Needs attention', openLoops.highlighted], ...stageGroups, ['Coming up', openLoops.comingUp], ['Waiting', openLoops.waiting], ['Suggestions', openLoops.suggested], ['Deferred', openLoops.deferred], ['Needs reconciliation', openLoops.reconciliation]];
    for (const [label, cards] of groups) {
      if (!Array.isArray(cards) || cards.length === 0) continue;
      const quiet = ['Waiting', 'Suggestions', 'Deferred', 'Needs reconciliation'].includes(label);
      const group = quiet ? element('details') : content;
      if (quiet) { group.dataset.openLoopGroup = label; group.append(element('summary', `${label} (${cards.length} shown)`)); content.append(group); }
      else content.append(element('h3', label));
      for (const card of cards) {
        if (!nonBlank(card.loopId) || !nonBlank(card.title)) continue;
        const row = element('article'); row.dataset.openLoopId = card.loopId;
        row.append(element('h4', card.title));
        const facts = [card.paymentState ?? card.state, Number.isSafeInteger(card.amount) && nonBlank(card.currency) ? `${card.currency} ${(card.amount / 100).toFixed(2)}` : null, formatDue(card) ? `Due ${formatDue(card)}` : null].filter(Boolean);
        if (facts.length) row.append(element('p', facts.join(' · ')));
        if (nonBlank(card.whyNow)) row.append(element('p', card.whyNow));
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
            renderEvidence(disclosure, detail);
            appendRenovationRelationshipControl(row, card, detail, pending);
            appendRenovationFulfilmentControl(row, card, detail, pending);
            appendRenovationReplacementControl(row, card, detail, pending);
            appendRenovationStageControl(row, card, detail, pending);
            appendRenovationDecisionConflictControl(row, card, detail, pending);
            disclosure.open = true;
          } catch (error) { if (current(pending)) report(error?.message || 'Open-loop evidence is unavailable.'); }
          finally { if (current(pending)) evidence.disabled = false; }
        }, { signal });
        row.append(evidence);
        if (writable() && card.kind === 'payment' && card.state !== 'suggested' && !['resolved', 'cancelled'].includes(card.state) && !['paid', 'cancelled'].includes(card.paymentState)) {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Record payment status'));
          form.append(element('p', 'This records your status assertion. It does not pay the bill or contact the sender.'));
          const statusLabel = element('label', 'Status '); const choice = element('select'); choice.name = 'paymentState';
          for (const [value, label] of [['payment-pending', 'Payment initiated; settlement pending'], ['partially-paid', 'Partially paid'], ['paid', 'Paid and verified by me'], ['disputed', 'Disputed'], ['cancelled', 'Cancelled by the authority'], ['uncertain', 'Needs reconciliation']]) { const option = element('option', label); option.value = value; choice.append(option); }
          statusLabel.append(choice);
          const amountLabel = element('label', ' Amount paid '); const paidAmount = element('input'); paidAmount.name = 'paidAmount'; paidAmount.type = 'number'; paidAmount.min = '0.01'; paidAmount.step = '0.01'; amountLabel.append(paidAmount);
          const currencyLabel = element('label', ' Currency '); const currency = element('input'); currency.name = 'currency'; currency.maxLength = 3; currency.value = card.currency ?? ''; currencyLabel.append(currency);
          const updatePartialInputs = () => { const partial = choice.value === 'partially-paid'; paidAmount.disabled = !partial; currency.disabled = !partial; paidAmount.required = partial; currency.required = partial; };
          choice.addEventListener('change', updatePartialInputs, { signal }); updatePartialInputs();
          const rationaleLabel = element('label', ' Evidence or rationale '); const rationale = element('textarea'); rationale.name = 'rationale'; rationale.required = true; rationale.maxLength = 1000; rationaleLabel.append(rationale);
          const save = element('button', 'Save payment status'); save.type = 'submit';
          form.append(statusLabel, amountLabel, currencyLabel, rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              const partial = choice.value === 'partially-paid';
              const amountMinor = partial ? Math.round(Number(paidAmount.value) * 100) : undefined;
              if (partial && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[A-Za-z]{3}$/u.test(currency.value.trim()))) throw new Error('Enter a positive partial amount and three-letter currency.');
              await submitOpenLoopOperation({ key: `open-loop-payment:${card.loopId}`, method: 'command-center.v1.open-loops.payment-status', params: { paymentState: choice.value, ...(partial ? { paidAmount: amountMinor, currency: currency.value.trim().toUpperCase() } : {}), rationale: rationale.value.trim() }, card, pending, success: 'Payment status recorded. No payment was submitted.' });
            } catch (error) { if (current(pending)) report(error?.message || 'Payment outcome is unknown. Retry to reconcile the same operation.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        } else if (writable() && card.kind === 'response' && !['resolved', 'cancelled'].includes(card.state)) {
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
              await submitOpenLoopOperation({ key: `open-loop-response:${card.loopId}`, method: 'command-center.v1.open-loops.decide', params: { decision: 'resolve', rationale: rationale.value.trim() }, card, pending, success: 'Response outcome recorded. No message was sent.' });
            } catch (error) { if (current(pending)) report(error?.message || 'Response outcome is unknown. Retry to reconcile the same operation.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        } else if (writable() && card.kind === 'decision' && card.state === 'decision-needed') {
          const form = element('form');
          const actionDisclosure = element('details'); actionDisclosure.append(element('summary', 'Revise recorded decision'));
          form.append(element('p', 'Record the choice you now want to keep. The prior choice and source evidence remain in history.'));
          const choiceLabel = element('label', 'Chosen option '); const chosenOption = element('input'); chosenOption.required = true; chosenOption.maxLength = 500; choiceLabel.append(chosenOption);
          const rationaleLabel = element('label', ' Rationale '); const rationale = element('textarea'); rationale.required = true; rationale.maxLength = 2000; rationaleLabel.append(rationale);
          const save = element('button', 'Record revised decision'); save.type = 'submit'; form.append(choiceLabel, rationaleLabel, save);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!current(pending) || !writable() || save.disabled || !chosenOption.value.trim() || !rationale.value.trim()) return;
            save.disabled = true;
            try {
              await submitOpenLoopOperation({ key: `renovation-decision:${card.loopId}`, method: 'command-center.v1.open-loops.renovation-decision-revise', params: { chosenOption: chosenOption.value.trim(), rationale: rationale.value.trim(), decidedAt: new Date().toISOString() }, card, pending, success: 'The revised decision was recorded; earlier evidence remains available.' });
            } catch (error) { if (current(pending)) report(error?.message || 'The decision outcome is unknown. Retry to reconcile the same operation.'); }
            finally { if (current(pending)) save.disabled = false; }
          }, { signal });
          actionDisclosure.append(form); row.append(actionDisclosure);
        }
        appendDecisionControls(row, card, pending);
        group.append(row);
      }
    }
    const inventory = element('details'); inventory.dataset.openLoopInventory = 'true'; inventory.append(element('summary', `Review all open loops (${openLoops.total})`));
    const inventoryRows = element('section'); inventoryRows.setAttribute('aria-label', 'All open loops');
    const more = element('button', 'Load open loops'); more.type = 'button'; let offset = 0; let cursor;
    more.addEventListener('click', async () => {
      if (!current(pending) || more.disabled) return;
      more.disabled = true;
      try {
        const page = unwrap(await host.request('command-center.v1.open-loops.list', { schemaVersion: 1, offset, limit: 20, ...(cursor === undefined ? {} : { cursor }) }));
        if (!current(pending) || !Array.isArray(page?.loops) || page.offset !== offset) throw new Error('The open-loop inventory changed. Refresh before continuing.');
        for (const loop of page.loops) {
          if (!nonBlank(loop.loopId) || !nonBlank(loop.title) || inventoryRows.querySelector(`[data-open-loop-id="${CSS.escape(loop.loopId)}"]`)) continue;
          const row = element('article'); row.dataset.openLoopId = loop.loopId;
          row.append(element('h4', loop.title), element('p', [loop.paymentState ?? loop.state, formatDue(loop) ? `Due ${formatDue(loop)}` : null].filter(Boolean).join(' · ')));
          appendDecisionControls(row, loop, pending);
          inventoryRows.append(row);
        }
        offset = page.nextOffset ?? offset + page.loops.length;
        cursor = page.nextCursor ?? cursor;
        if (page.hasMore && nonBlank(page.nextCursor)) { more.textContent = 'Load more open loops'; more.disabled = false; }
        else more.remove();
      } catch (error) { if (current(pending)) { more.disabled = false; report(error?.message || 'The open-loop inventory is unavailable.'); } }
    }, { signal });
    inventory.append(inventoryRows, more); content.append(inventory);
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
