// Candidate component. Production registration waits for exact source-message,
// cross-plugin card navigation and human-request owner qualification (#370).
export function mountConversationPlan(container, { input, owner, openNativeCard, signal }) {
  const document = container.ownerDocument;
  const accepted = structuredClone(input);
  let generation = 0, pending = false;
  const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const section = element('section'); section.setAttribute('aria-label', 'Review Conversation plan');
  const heading = element('h2', accepted.snapshot.outcome);
  const origin = element('p', `Conversation ${accepted.source.messageId} · Topic ${accepted.source.topicId}`);
  const steps = element('ol'); accepted.snapshot.steps.forEach(text => steps.append(element('li', text)));
  const criteria = element('ul'); accepted.snapshot.completionCriteria.forEach(text => criteria.append(element('li', text)));
  const destination = element('p', `Workboard ${accepted.destination.boardId} · ${accepted.destination.tenantId}`);
  const explanation = element('p', 'Tracking creates one manual todo card. Open it in Workboard to choose Start.');
  const status = element('p'); status.setAttribute('role', 'status');
  const track = element('button', 'Track this plan'); track.type = 'button';
  const reconcile = element('button', 'Check tracking status'); reconcile.type = 'button'; reconcile.hidden = true;
  const open = element('button', 'Open native card'); open.type = 'button'; open.hidden = true;
  const dispose = () => { generation++; section.remove(); };
  signal?.addEventListener('abort', dispose, { once: true });
  async function run(action) {
    if (pending || signal?.aborted) return;
    pending = true; const version = ++generation; track.disabled = true; reconcile.disabled = true; open.hidden = true;
    status.textContent = action === 'track' ? 'Tracking plan…' : 'Checking native status…';
    try {
      const result = await owner[action](structuredClone(accepted));
      if (signal?.aborted || version !== generation) return;
      reconcile.hidden = false;
      if (result.availability !== 'available') { status.textContent = 'Tracking outcome is unknown. Check status before retrying the same plan.'; return; }
      status.textContent = `Native status: ${result.card.status}. ${result.progress.availability === 'available' ? `Linked run: ${result.progress.status}.` : 'Linked run progress is unavailable.'}`;
      track.hidden = true;
      if (typeof openNativeCard === 'function') {
        open.hidden = false;
        open.onclick = () => { if (!signal?.aborted && version === generation) openNativeCard({ ...accepted.destination, cardId: result.card.id }); };
      }
    } catch (error) {
      if (!signal?.aborted && version === generation) {
        status.textContent = ['intent-mismatch', 'conflict'].includes(error.code) ? 'This acceptance changed. Review a new plan.' : 'The exact authorized source or native status is unavailable.';
        reconcile.hidden = false;
      }
    } finally {
      if (!signal?.aborted && version === generation) { pending = false; track.disabled = false; reconcile.disabled = false; }
    }
  }
  track.onclick = () => run('track'); reconcile.onclick = () => run('reconcile');
  section.append(heading, origin, steps, element('h3', 'Completion criteria'), criteria, destination, explanation, track, reconcile, open, status);
  if (!signal?.aborted) container.append(section);
  return { dispose, accepted: () => structuredClone(accepted) };
}
