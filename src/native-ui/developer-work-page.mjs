const unwrap = response => response?.result ?? response;
const nonBlank = value => typeof value === 'string' && value.trim().length > 0;
const boundReady = result => result?.status === 'ready' && Number.isInteger(result.requestRevision) && result.requestRevision > 0 &&
  nonBlank(result.requestId) && nonBlank(result.agentId) && nonBlank(result.sessionKey) &&
  nonBlank(result.sessionId) && nonBlank(result.lifecycleRevision) && !result.agentId.includes(':') &&
  result.sessionKey.startsWith(`agent:${result.agentId}:`) && result.sessionKey.length > `agent:${result.agentId}:`.length;
const staleReasons = Object.freeze({
  'request-missing': 'That waiting request is no longer available.',
  'request-ended': 'That waiting request has ended.',
  'request-changed': 'That waiting request changed while it was being checked.',
  'request-expired': 'That waiting request expired. Open current work to find an active request.',
  'session-binding-missing': 'The request has no exact Code session binding.',
  'session-replaced': 'The Code session was reset, replaced, or removed.',
  'session-read-unavailable': 'The Code session could not be checked right now.'
});

export function mountDeveloperWorkPage(container, context) {
  const { host } = context;
  const document = container.ownerDocument;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let presented = context.presented;
  let props = { ...context.props };
  let generation = 0;
  const element = (tag, value) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; return node; };
  const heading = element('h1', 'Developer Work');
  const status = element('p'); status.setAttribute('role', 'status'); status.tabIndex = -1;
  const content = element('section'); content.setAttribute('aria-label', 'Code work handoff');
  const refresh = element('button', 'Refresh Code work'); refresh.type = 'button';
  container.replaceChildren(heading, status, refresh, content);
  const readable = () => host.connection.connected && host.connection.canRead;
  const current = value => !signal.aborted && presented && readable() && value === generation;
  const report = message => { status.textContent = host.redact?.(message) ?? message; };
  const target = () => ({ schemaVersion: 1, workId: props.workId, ...(props.requestId ? { requestId: props.requestId } : {}) });

  function showCurrentWork(workId) {
    const button = element('button', 'Open current Code work'); button.type = 'button';
    button.addEventListener('click', () => { if (!signal.aborted && presented) host.navigation.openPage({ id: 'developer-work', params: { workId } }); }, { signal });
    content.append(button);
  }

  function render(result, pending) {
    content.replaceChildren();
    if (boundReady(result) && result.workId === props.workId && result.requestId === props.requestId) {
      content.append(element('h2', result.summary), element('p', 'This waiting request is attached to one exact Code session. Opening Chat does not answer or resolve it.'));
      const open = element('button', 'Open exact Code session'); open.type = 'button';
      open.addEventListener('click', async () => {
        if (!current(pending) || open.disabled) return;
        open.disabled = true; report('Checking the Code request and session again…');
        try {
          const checked = unwrap(await host.request('command-center.v1.developer-work.resolve', target()));
          if (!current(pending)) return;
          if (!boundReady(checked) || checked.workId !== result.workId || checked.requestId !== result.requestId || checked.requestRevision !== result.requestRevision || checked.agentId !== result.agentId || checked.sessionKey !== result.sessionKey || checked.sessionId !== result.sessionId || checked.lifecycleRevision !== result.lifecycleRevision) {
            const reason = checked?.status === 'stale' && checked.reason === 'request-expired' ? 'request-expired' : checked?.status === 'ready' && !boundReady(checked) ? 'session-binding-missing' : 'request-changed';
            render({ schemaVersion: 1, status: 'stale', reason, workId: result.workId, requestId: result.requestId }, pending);
            report(reason === 'request-expired' ? staleReasons[reason] : 'The exact Code context changed. Choose a current request separately.');
            return;
          }
          host.sessions.openChat({ sessionKey: checked.sessionKey, agentId: checked.agentId });
          report('Opened the exact Code session. The request remains open.');
        } catch (error) { if (current(pending)) report(error?.message || 'The Code session could not be opened.'); }
        finally { if (current(pending)) open.disabled = false; }
      }, { signal });
      content.append(open);
      return;
    }
    if (result.status === 'current-work' && result.workId === props.workId) {
      content.append(element('h2', 'Current Code work'));
      if (!result.requests?.length) { content.append(element('p', 'No waiting requests are active for this work.')); return; }
      const list = element('ul');
      for (const request of result.requests) {
        const item = element('li');
        const button = element('button', request.summary || 'Open request'); button.type = 'button';
        button.addEventListener('click', () => { if (current(pending)) host.navigation.openPage({ id: 'developer-work', params: { workId: result.workId, requestId: request.requestId } }); }, { signal });
        item.append(button); list.append(item);
      }
      content.append(list);
      return;
    }
    const reason = staleReasons[result.reason] ?? 'The exact Code context is unavailable.';
    content.append(element('h2', result.status === 'stale' ? 'This handoff is stale' : 'Code context unavailable'), element('p', reason));
    if (result.workId) showCurrentWork(result.workId);
  }

  async function load() {
    const pending = ++generation;
    container.inert = !presented || signal.aborted;
    content.replaceChildren();
    if (!presented || signal.aborted) return;
    if (typeof props.workId !== 'string' || !props.workId) { report('Choose a Code work request from Life Attention.'); return; }
    if (!readable()) { report('Connect to Code with read access to check this handoff.'); return; }
    report('Checking the exact Code context…');
    try {
      const result = unwrap(await host.request('command-center.v1.developer-work.resolve', target()));
      if (!current(pending)) return;
      if (result?.schemaVersion !== 1 || result.workId !== props.workId || !['ready', 'stale', 'unavailable', 'current-work'].includes(result.status)) throw new Error('The Code resolver returned an invalid result.');
      const displayed = result.status === 'ready' && !boundReady(result)
        ? { schemaVersion: 1, status: 'stale', reason: 'session-binding-missing', workId: result.workId, requestId: result.requestId }
        : result;
      render(displayed, pending);
      report(displayed.status === 'ready' ? 'The exact waiting session is current.' : displayed.status === 'current-work' ? 'Current waiting requests are shown.' : staleReasons[displayed.reason] ?? 'The exact Code context is unavailable.');
    } catch (error) { if (current(pending)) report(error?.message || 'Code work is unavailable.'); }
  }

  refresh.addEventListener('click', () => void load(), { signal });
  const unsubscribe = host.subscribe(() => { if (presented) void load(); });
  void load();
  return {
    update(next) {
      const changed = presented !== next.presented || props.workId !== next.props.workId || props.requestId !== next.props.requestId;
      presented = next.presented; props = { ...next.props };
      if (changed) void load();
    },
    focus() { refresh.focus(); },
    dispose() { lifetime.abort(); unsubscribe(); container.replaceChildren(); }
  };
}
