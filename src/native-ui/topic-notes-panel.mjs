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
  const content = container.ownerDocument.createElement('section');
  content.style.padding = '16px'; content.style.minInlineSize = '0'; content.style.overflowWrap = 'anywhere';
  const readable = () => host.connection.connected && host.connection.canRead;
  const current = (pending) => !signal.aborted && currentContext.presented && readable() && generation === pending;
  function clear() { childLifetime?.abort(); child?.dispose(); child = undefined; content.replaceChildren(); container.replaceChildren(content); }
  function message(text) {
    const status = container.ownerDocument.createElement('p');
    status.setAttribute('role', 'status'); status.textContent = text;
    content.replaceChildren(status);
  }
  const key = () => host.sessions.normalizeKey(currentContext.props.sessionKey);
  async function load() {
    const pending = ++generation;
    clear();
    if (signal.aborted || !currentContext.presented) return;
    if (!readable()) { message('Connect with read access to view Topic Notes.'); return; }
    const sessionKey = key();
    if (!sessionKey) { message('Select a Conversation to view its Topic Notes.'); return; }
    if (!sessionKey.startsWith('agent:')) { message('This native Conversation has no exact Topic binding. Open a linked Conversation from Topics to view its Notes.'); return; }
    message('Finding this Conversation’s Topic…');
    try {
      const response = await host.request('command-center.v1.sessions.topic-context', { schemaVersion: 1, sessionKey });
      if (!current(pending)) return;
      const value = response?.result ?? response;
      if (value?.sessionKey !== sessionKey) throw new Error('The exact Conversation context is unavailable.');
      if (value.status === 'unbound') {
        message('This Conversation is not linked to a Topic. Native groups organize Chats; they do not assign Notes. Start a Topic Conversation from Topics to share its Notes.');
        return;
      }
      if (value.status !== 'bound' || !value.topicId || !value.sessionId || !value.referenceId) throw new Error('The exact Topic binding is unavailable.');
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
