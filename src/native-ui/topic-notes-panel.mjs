import { mountTopicPage } from './topic-page.mjs';

/** The native pane supplies a locator; only the source owner resolves Topic identity. */
export function mountTopicNotesPanel(container, context, state) {
  const host = context.host;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  let currentContext = context;
  let generation = 0;
  let child;
  let childLifetime;
  let defaultFiles;
  const shell = container.ownerDocument.createElement('section');
  const controls = container.ownerDocument.createElement('div');
  const content = container.ownerDocument.createElement('section');
  content.style.padding = '12px'; content.style.minInlineSize = '0'; content.style.overflowWrap = 'anywhere';
  content.style.blockSize = '100%'; content.style.minBlockSize = '0'; content.style.boxSizing = 'border-box';
  shell.style.blockSize = '100%'; shell.style.minBlockSize = '0'; shell.style.display = 'grid'; shell.style.gridTemplateRows = 'auto minmax(0, 1fr)';
  shell.style.inlineSize = '100%'; shell.style.minInlineSize = '0'; shell.style.flex = '1 1 0';
  controls.style.padding = '8px 12px 0';
  shell.append(controls, content); container.replaceChildren(shell);
  const readable = () => host.connection.connected && host.connection.canRead;
  const current = (pending) => !signal.aborted && currentContext.presented && readable() && generation === pending;
  function clear() { defaultFiles?.(); defaultFiles = undefined; childLifetime?.abort(); child?.dispose(); child = undefined; controls.replaceChildren(); content.replaceChildren(); }
  function filesLocation(location) {
    const select = container.ownerDocument.createElement('select');
    select.setAttribute('aria-label', 'Files location');
    select.style.cssText = 'font:inherit;font-size:12px;color:var(--text,inherit);background:var(--bg,transparent);border:1px solid var(--border,currentColor);border-radius:var(--radius-md,6px);padding:5px 8px;max-width:100%';
    for (const [value, label] of [['topic', 'Topic files'], ['session', 'Session files']]) {
      const option = container.ownerDocument.createElement('option'); option.value = value; option.textContent = label; select.append(option);
    }
    select.value = location;
    select.addEventListener('change', () => { if (select.value === 'session') openDefaultFiles(); else void load(); }, { signal });
    return select;
  }
  function openDefaultFiles() {
    if (signal.aborted || !currentContext.presented || typeof currentContext.mountDefault !== 'function') return;
    childLifetime?.abort(); child?.dispose(); child = undefined;
    defaultFiles?.(); defaultFiles = currentContext.mountDefault(content);
    controls.replaceChildren(filesLocation('session'));
  }
  function message(text, { sessionFiles = false } = {}) {
    const status = container.ownerDocument.createElement('p');
    status.setAttribute('role', 'status'); status.textContent = text;
    content.replaceChildren(status);
    if (sessionFiles) content.append(container.ownerDocument.createTextNode(' Session Files are separate from Topic Notes and do not permanently file uploads.'));
  }
  const key = () => host.sessions.normalizeKey(currentContext.props.sessionKey);
  async function load() {
    const pending = ++generation;
    clear();
    if (signal.aborted || !currentContext.presented) return;
    if (!readable()) { message('Connect with read access to view Topic Files.'); return; }
    const sessionKey = key();
    if (!sessionKey) { message('Select a Conversation to view its Topic Files.'); return; }
    if (!sessionKey.startsWith('agent:')) { controls.replaceChildren(filesLocation('topic')); message('This native Conversation has no exact Topic binding.', { sessionFiles: true }); return; }
    message('Finding this Conversation’s Topic folder…');
    try {
      const response = await host.request('command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey });
      if (!current(pending)) return;
      const value = response?.result ?? response;
      if (value?.sessionKey !== sessionKey) throw new Error('The exact Conversation context is unavailable.');
      if (value.status === 'unbound') {
        controls.replaceChildren(filesLocation('topic'));
        message('No Topic assigned. Native groups organize Chats; they do not assign Notes.', { sessionFiles: true });
        return;
      }
      if (value.status !== 'bound' || !value.topicId || !value.sessionId || !value.referenceId) throw new Error('The exact Topic binding is unavailable.');
      controls.replaceChildren(filesLocation('topic'));
      childLifetime = new AbortController();
      child = mountTopicPage(content, { ...currentContext,
        signal: AbortSignal.any([signal, childLifetime.signal]), props: { topicId: value.topicId }
      }, state, { panel: true, verifyContext: async () => {
        const response = await host.request('command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey });
        const latest = response?.result ?? response;
        if (!current(pending) || latest?.status !== 'bound' || latest.sessionKey !== value.sessionKey || latest.sessionId !== value.sessionId || latest.topicId !== value.topicId || latest.referenceId !== value.referenceId) throw new Error('The Conversation’s exact Topic binding changed. Refresh Topic Notes.');
      } });
    } catch (error) {
      if (current(pending) && error?.name !== 'AbortError') message(host.redact(error?.message || 'Topic Notes are unavailable.'));
    }
  }
  let wasReadable = readable();
  const selectedIdentity = () => {
    const row = host.sessions.rows?.find(row => host.sessions.normalizeKey(row.key ?? row.sessionKey) === key());
    return JSON.stringify([row?.sessionId, row?.lifecycleRevision]);
  };
  let identity = selectedIdentity();
  const unsubscribe = host.subscribe(() => {
    const next = readable();
    const nextIdentity = next ? selectedIdentity() : '';
    if (next !== wasReadable || identity !== nextIdentity) { wasReadable = next; identity = nextIdentity; void load(); }
  });
  void load();
  return {
    update(next) {
      const changed = next.props.sessionKey !== currentContext.props.sessionKey || next.props.agentId !== currentContext.props.agentId || next.presented !== currentContext.presented;
      currentContext = next;
      if (changed) void load();
    },
    focus() { child?.focus?.(); },
    dispose() { generation += 1; lifetime.abort(); unsubscribe(); clear(); container.replaceChildren(); }
  };
}
