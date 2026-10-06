import { validatedOutlookWebLink } from './outlook-web-link.mjs';
import { billActionTimePresets, createBillActionTimeIntent, resolveBillActionLocalTime, formatBillActionTime } from './bill-action-time.mjs';

const unwrap = response => response?.result ?? response;
const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const messages = {
  pending: 'Submitting the exact action.',
  unknown: 'Could not confirm whether this action was saved. Reconcile the original operation before choosing another action.',
  conflict: 'This item changed. Review it before trying again.',
  unavailable: 'Current native action or source access is unavailable. Refresh to check again.',
  'handled-observed': 'Handled status confirmed. This is manual action status, not payment confirmation.',
  applied: 'Review eligibility saved. It returns when Attention is next opened or refreshed after the selected time.'
};

/** Consume the closed #331 read only when explicitly supplied; no activation or private writes. */
export function renderBillActionCards(parent, projection, context) {
  if (projection === undefined) return;
  const { host, signal, operations, current, writable, reload, report } = context;
  const document = parent.ownerDocument;
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const button = (text, run) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', run, { signal }); return node; };
  const section = el('section'); section.className = 'cc-module'; section.dataset.billActions = 'true';
  const heading = el('h2', 'Bill actions'); heading.tabIndex = -1; heading.dataset.attentionEmpty = 'true'; section.append(heading);
  parent.append(section);
  if (projection?.schemaVersion !== 1 || !Array.isArray(projection.rows) || !Number.isSafeInteger(projection.total) || !['partial', 'bound-actions-only'].includes(projection.coverage)) {
    section.append(el('p', 'Bill action coverage is unavailable. Refresh to check again.')); return;
  }
  section.append(el('p', `${projection.rows.length} shown of ${projection.total} currently authorized bound actions. Coverage: ${projection.coverage === 'partial' ? 'partial' : 'bound actions only'}. This is not a complete email inbox.`));
  if (projection.unavailableCount) section.append(el('p', 'Some native actions or sources could not be read. Their current status is unknown.'));
  const active = el('div'); active.dataset.billActionGroup = 'active'; section.append(active);
  const deferred = el('details'); deferred.dataset.billDeferred = 'true'; deferred.append(el('summary', 'Deferred bill actions'));
  const handled = el('details'); handled.dataset.billHandled = 'true'; handled.append(el('summary', 'Recent handled'));
  section.append(deferred, handled);
  const serverTime = projection.observedAt;
  for (const row of projection.rows) {
    if (row?.schemaVersion !== 1 || !nonBlank(row.loopId)) { section.append(el('p', 'An unqualified bill action is unavailable.')); continue; }
    const key = `bill-action:${row.loopId}`;
    if (!operations.has(key) && row.pendingOperation?.intent?.loopId === row.loopId && row.pendingOperation.intent.logicalOperationId === row.pendingOperation.logicalOperationId && ['handle', 'defer'].includes(row.pendingOperation.kind)) operations.set(key, { method: `command-center.v1.bill-actions.${row.pendingOperation.kind}`, params: Object.freeze({ ...row.pendingOperation.intent }), state: 'unknown', pending: false });
    const op = operations.get(key);
    const qualified = row.availability === 'available' && nonBlank(row.actionId) && nonBlank(row.topicId) && row.binding && Number.isFinite(row.native?.updatedAt) && Number.isSafeInteger(row.eligibility?.revision);
    const done = qualified && row.native.status === 'done';
    const later = qualified && !op && row.native.status === 'todo' && row.eligibility.eligible === false && nonBlank(row.eligibility.reviewAt);
    const article = el('article'); article.className = 'cc-open-loop-card'; article.dataset.openLoopId = row.loopId; article.dataset.billActionId = row.actionId ?? row.loopId;
    (done ? handled : later ? deferred : active).append(article);
    article.append(el('h3', row.title ?? 'Bill action'));
    const state = el('p'); state.setAttribute('role', 'status'); state.tabIndex = -1; article.append(state);
    const status = () => { state.textContent = done ? messages['handled-observed'] : op ? (op.params?.reviewAt && op.state === 'unknown' ? 'Could not confirm whether Later was saved. Reconcile the original operation before choosing another action.' : op.params?.reviewAt ? messages[op.state] : op.state === 'unknown' ? 'Could not confirm whether this was handled. Reconcile the original operation before choosing another action.' : messages[op.state]) : !qualified ? messages.unavailable : row.outcome === 'conflict' ? messages.conflict : later ? 'Deferred. You can review or handle it early.' : 'Current native Backlog. Handling is manual and does not make a payment.'; };
    status();
    if (!qualified) continue;
    article.append(el('p', row.reason), el('p', row.deadline?.known === true && nonBlank(row.deadline.instant) ? `Accepted deadline: ${row.deadline.instant}` : 'Deadline unknown'));
    if (later) article.append(el('p', `Review time: ${formatBillActionTime({ reviewAt: row.eligibility.reviewAt, timeZone: row.eligibility.timeZone, offsetMinutes: row.eligibility.offsetMinutes })}`));
    if (done) {
      article.append(el('p', 'Current native Done is confirmed. Native evidence does not identify who handled it.'));
      if (Number.isFinite(row.native.completedAt)) article.append(el('p', `Native completion time: ${new Date(row.native.completedAt).toISOString()}`));
      const events = Array.isArray(row.native.events) ? row.native.events.filter(event => nonBlank(event.id) && nonBlank(event.kind) && Number.isFinite(event.at)) : [];
      if (events.length) {
        const history = el('details'); history.append(el('summary', 'Native history'));
        for (const event of [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) history.append(el('p', `${new Date(event.at).toISOString()}: ${event.kind}${event.fromStatus || event.toStatus ? ` (${event.fromStatus ?? 'unknown'} to ${event.toStatus ?? 'unknown'})` : ''}`));
        article.append(history);
      } else article.append(el('p', 'Native completion history is unavailable.'));
    }
    const controls = el('div'); controls.className = 'cc-card-actions'; article.append(controls);
    const review = button('Review source', async () => {
      if (!current() || review.disabled) return;
      review.disabled = true;
      try {
        const fresh = unwrap(await host.request('command-center.v1.bill-actions.read', { schemaVersion: 1, loopId: row.loopId }));
        if (!current()) return;
        if (fresh?.schemaVersion !== 1 || fresh.loopId !== row.loopId || fresh.topicId !== row.topicId || fresh.availability !== 'available') throw new Error('The exact current source is unavailable.');
        const source = fresh.source;
        if (source?.kind === 'outlook') {
          const link = el('a', 'Open exact email in Outlook'); link.href = validatedOutlookWebLink(source.url); link.target = '_blank'; link.rel = 'noopener noreferrer';
          // Keep default-navigation cancellation even on a retained node after scope abort.
          link.addEventListener('click', event => { if (!current()) { event.preventDefault(); return; } if (op?.state === 'conflict') { operations.delete(key); void reload('Current source opened. Choose a new explicit action.'); } });
          article.querySelector('[data-bill-source-link]')?.remove(); link.dataset.billSourceLink = 'true'; article.append(link); link.focus();
          report('Exact Outlook destination ready. Outlook verifies your access.');
        } else if (source?.kind === 'note' && source.topicId === fresh.topicId && [source.referenceId, source.path, source.revision].every(nonBlank)) {
          host.navigation.openPage({ id: 'topic', params: { topicId: source.topicId, sourceReferenceId: source.referenceId, sourcePath: source.path, evidenceSourceVersion: source.revision } });
          if (op?.state === 'conflict') operations.delete(key);
        } else throw new Error('No currently authorized exact reader destination is available.');
      } catch (error) { if (current()) report(error.message || 'Source unavailable.'); }
      finally { if (current()) review.disabled = false; }
    });
    review.dataset.focusIdentity = `${key}:source`; article.insertBefore(review, controls);
    const predecessor = row.predecessor;
    if (predecessor && [predecessor.loopId, predecessor.observationId, predecessor.title, predecessor.explanation].every(nonBlank) && predecessor.loopId !== row.loopId) {
      const prior = el('section'); prior.dataset.billPredecessor = 'true';
      const priorTitle = el('h4', `Prior request: ${predecessor.title}`); const priorExplanation = el('p', predecessor.explanation); prior.append(priorTitle, priorExplanation);
      let priorSourceGeneration = 0;
      const priorStatus = el('p'); prior.append(priorStatus);
      const showPriorStatus = native => { priorStatus.textContent = native?.availability === 'available' && nonBlank(native.status) && Number.isFinite(native.updatedAt) ? `Prior request current native status: ${native.status === 'done' ? 'Done (manual action status)' : native.status === 'todo' ? 'Backlog' : native.status}.` : 'Prior request native status unavailable. Its current handled status is unknown.'; };
      showPriorStatus(predecessor.native);
      const priorReview = button('Review prior request source', async () => {
        if (!current() || priorReview.disabled) return;
        priorReview.disabled = true; const sourceGeneration = ++priorSourceGeneration; prior.querySelector('[data-bill-predecessor-source-link]')?.remove();
        try {
          // The relation belongs to this new action. Never resolve the prior loop's latest evidence.
          const fresh = unwrap(await host.request('command-center.v1.bill-actions.read', { schemaVersion: 1, loopId: row.loopId }));
          if (!current()) return;
          const relation = fresh?.predecessor;
          if (fresh?.schemaVersion !== 1 || fresh.loopId !== row.loopId || fresh.topicId !== row.topicId || fresh.availability !== 'available' || relation?.loopId !== predecessor.loopId || relation.observationId !== predecessor.observationId || !nonBlank(relation.title) || !nonBlank(relation.explanation)) throw new Error('The exact authorized prior request relation is unavailable. Refresh to check again.');
          priorTitle.textContent = `Prior request: ${relation.title}`; priorExplanation.textContent = relation.explanation;
          showPriorStatus(relation.native);
          const source = relation.source;
          if (source?.kind === 'outlook') {
            const link = el('a', 'Open exact prior request email in Outlook'); link.href = validatedOutlookWebLink(source.url); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.billPredecessorSourceLink = 'true';
            // Retained links must still refuse navigation after their mount is retired.
            link.addEventListener('click', event => { if (!current() || sourceGeneration !== priorSourceGeneration) event.preventDefault(); });
            prior.append(link); link.focus(); report('Exact prior request Outlook destination ready. Outlook verifies your access.');
          } else if (source?.kind === 'note' && [source.topicId, source.referenceId, source.path, source.revision].every(nonBlank)) {
            host.navigation.openPage({ id: 'topic', params: { topicId: source.topicId, sourceReferenceId: source.referenceId, sourcePath: source.path, evidenceSourceVersion: source.revision } });
          } else throw new Error('No currently authorized exact prior request reader destination is available.');
        } catch (error) { if (current()) { priorTitle.textContent = 'Prior request unavailable'; priorExplanation.textContent = ''; priorStatus.textContent = 'Prior request evidence is unavailable. Refresh to check again.'; report(error.message || 'Prior request source unavailable.'); } }
        finally { if (current()) priorReview.disabled = false; }
      });
      priorReview.dataset.focusIdentity = `${key}:predecessor:${predecessor.observationId}`; prior.append(priorReview); article.append(prior);
    }
    if (done) continue;
    const canAct = () => current() && writable() && row.canWrite === true && row.native.status === 'todo';
    async function run(operation, reconcile = false) {
      if (!current() || operation.pending || (!reconcile && !canAct())) return;
      operation.pending = true; operation.state = 'pending'; state.textContent = messages.pending; state.focus();
      for (const control of controls.querySelectorAll('button')) control.disabled = true;
      try {
        const response = unwrap(await host.request(reconcile ? 'command-center.v1.bill-actions.reconcile' : operation.method, reconcile ? { schemaVersion: 1, loopId: operation.params.loopId, logicalOperationId: operation.params.logicalOperationId } : operation.params));
        const outcome = response?.outcome ?? response?.state;
        if (response?.logicalOperationId !== operation.params.logicalOperationId || !['applied', 'handled-observed', 'conflict', 'unknown', 'unavailable'].includes(outcome)) throw new Error('The exact operation outcome is unknown.');
        operation.state = outcome;
        if (['applied', 'handled-observed'].includes(operation.state)) operations.delete(key);
      } catch { operation.state = 'unknown'; }
      finally { operation.pending = false; if (current()) await reload(messages[operation.state] ?? messages.unknown, row.loopId); }
    }
    if (op) {
      if (['unknown', 'pending', 'unavailable'].includes(op.state)) {
        const reconcile = button('Reconcile original operation', () => void run(op, true)); reconcile.disabled = !current() || op.pending; controls.append(reconcile);
        const retry = button('Retry original operation', () => void run(op)); retry.disabled = !canAct() || op.pending; controls.append(retry);
        article.append(el('p', 'Retry resends the same original action and revision. It does not choose a new action.'));
      }
      continue;
    }
    if (row.outcome === 'conflict' || row.native.status !== 'todo') continue;
    const handle = button('Handled', () => {
      if (!canAct() || operations.has(key)) return;
      const operation = { method: 'command-center.v1.bill-actions.handle', params: Object.freeze({ schemaVersion: 1, loopId: row.loopId, logicalOperationId: crypto.randomUUID(), expectedUpdatedAt: row.native.updatedAt }), state: 'pending', pending: false };
      operations.set(key, operation); void run(operation);
    }); handle.dataset.focusIdentity = `${key}:handled`; handle.disabled = !canAct(); controls.append(handle);
    let laterDisclosure; let zoneControl;
    const createLaterForm = () => {
      laterDisclosure = el('details'); laterDisclosure.dataset.billLater = 'true'; laterDisclosure.hidden = !canAct(); laterDisclosure.append(el('summary', 'Later review time'));
      const form = el('form'); form.dataset.billLaterForm = 'true';
      const label = (text, input) => { const node = el('label', text); node.append(input); form.append(node); return input; };
      const zone = label('Timezone (IANA)', el('input')); zone.value = projection.userTimeZone ?? ''; zone.placeholder = 'Australia/Brisbane'; zone.required = true;
      zoneControl = zone;
      const local = label('Custom local date and time', el('input')); local.type = 'datetime-local';
      const offset = label('Occurrence / UTC offset', el('select')); offset.append(el('option', 'Choose an occurrence if this time repeats')); offset.firstChild.value = '';
      const offsetDraft = el('input'); offsetDraft.type = 'hidden'; offsetDraft.value = ''; form.append(offsetDraft);
      const preview = el('p'); preview.setAttribute('role', 'status'); form.append(preview);
      let intent;
      const clear = () => { intent = undefined; preview.textContent = 'Preview the exact date, time and timezone before saving.'; };
      const show = selected => { local.value = selected.localDateTime; rebuildOffsets(selected.offset); intent = selected; preview.textContent = selected.confirmation; form.dispatchEvent(new Event('input', { bubbles: true })); };
      const presets = el('div'); form.append(presets);
      for (const [name, choice] of [['Later today', 'laterToday'], ['Tomorrow morning', 'tomorrowMorning']]) presets.append(button(name, () => { try { const selected = billActionTimePresets({ serverTime, timeZone: zone.value })[choice]; if (!selected) throw new Error('This preset is unavailable. Choose a custom future time.'); show(selected); } catch (error) { clear(); preview.textContent = error.message; } }));
      const rebuildOffsets = (selectedOffset = '') => {
        clear(); offset.replaceChildren(el('option', 'Choose an occurrence if this time repeats')); offset.firstChild.value = '';
        try { for (const candidate of resolveBillActionLocalTime({ localDateTime: local.value, timeZone: zone.value })) { const option = el('option', `${candidate.offset} (occurrence ${candidate.occurrence})`); option.value = candidate.offset; offset.append(option); } } catch { /* validation is explained on preview */ }
        offset.value = selectedOffset; offsetDraft.value = offset.value;
      };
      zone.addEventListener('input', () => rebuildOffsets(), { signal }); local.addEventListener('input', () => rebuildOffsets(), { signal }); offset.addEventListener('change', () => { offsetDraft.value = offset.value; clear(); }, { signal });
      form.append(button('Preview review time', () => { try { show(createBillActionTimeIntent({ localDateTime: local.value, timeZone: zone.value, offset: offset.value || undefined, serverTime })); } catch (error) { clear(); preview.textContent = error.message; } }));
      const save = el('button', 'Save Later'); save.type = 'submit'; form.append(save);
      form.append(button('Cancel Later', () => { laterDisclosure.open = false; laterButton.focus(); }));
      form.addEventListener('submit', event => {
        event.preventDefault(); if (!canAct() || operations.has(key)) return;
        if (!intent) { preview.textContent = 'Preview and confirm the exact review time before saving.'; return; }
        const params = Object.freeze({ schemaVersion: 1, loopId: row.loopId, logicalOperationId: crypto.randomUUID(), expectedEligibilityRevision: row.eligibility.revision, reviewAt: intent.reviewAt, timeZone: intent.timeZone, offsetMinutes: intent.offsetMinutes });
        const operation = { method: 'command-center.v1.bill-actions.defer', params, confirmation: intent.confirmation, state: 'pending', pending: false };
        operations.set(key, operation); void run(operation);
      }, { signal });
      context.bindDraft?.(form, row, { zone, local, offset: offsetDraft }, () => rebuildOffsets(offsetDraft.value));
      laterDisclosure.append(form); article.append(laterDisclosure);
    };
    const laterButton = button('Later', () => { if (!canAct() || operations.has(key)) return; laterDisclosure.open = true; zoneControl.focus(); }); laterButton.dataset.focusIdentity = `${key}:later`; laterButton.disabled = !canAct(); controls.append(laterButton);
    createLaterForm();
  }
}
