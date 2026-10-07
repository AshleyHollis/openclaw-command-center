import { createNativeCreationForm } from './creation-form.mjs';
import { createNativeTopicNavigation } from './topic-navigation.mjs';
import { topicSourceAvailable } from './topic-source-availability.mjs';

/** Presentation around the existing activation-owned creation/recovery form. */
export function mountTopicConversationDialog(container, { host, state, signal, presented, topicId, returnFocusTarget }) {
  const document = container.ownerDocument;
  const lifetime = new AbortController();
  const viewSignal = AbortSignal.any([signal, host.signal, lifetime.signal]);
  const navigation = createNativeTopicNavigation({ signal: viewSignal, get connection() { return host.connection; }, request: (method, input) => host.request(method, input), sessions: host.sessions });
  let form; let dialog; let closed = false; let navigationGeneration = 0;
  const current = () => !closed && !viewSignal.aborted && presented() && host.connection.connected && host.connection.canRead && host.connection.canWrite;
  const content = document.createElement('div');
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Checking the exact Topic.';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  content.append(status, cancel); container.replaceChildren(content);
  function close() {
    if (closed) return;
    closed = true; lifetime.abort(); navigation.cancel(); form?.dispose(); dialog?.dispose(); container.replaceChildren();
  }
  cancel.addEventListener('click', close, { signal: viewSignal });
  viewSignal.addEventListener('abort', close, { once: true });
  async function start() {
    try {
      if (typeof host.components?.mountDialog !== 'function') throw new Error('This OpenClaw host does not support the focused Topic conversation dialog. The existing Topic page remains available.');
      if (!current()) throw new Error('Current operator write access is required.');
      const response = await host.request('command-center.v1.topics.get', { schemaVersion: 1, topicId });
      if (!current()) return;
      const topic = (response?.result ?? response)?.topic;
      if (topic?.topicId !== topicId || topic.lifecycle !== 'active' || !topicSourceAvailable(topic, 'session')) throw new Error('The exact active Topic is unavailable. Refresh the Topic workspace.');
      const captureNavigation = () => { const generation = navigationGeneration; return () => current() && generation === navigationGeneration; };
      form = createNativeCreationForm({ host, state, document, signal: viewSignal, presented: current, getTopic: () => topic,
        beginNavigation: () => { navigation.cancel(); navigationGeneration++; return captureNavigation(); }, captureNavigation,
        onCreated: async (result, input) => {
          const stillCurrent = captureNavigation();
          const response = await host.request('command-center.v1.sessions.browse', { schemaVersion: 1, topicId: input.topicId, includeClosed: false });
          if (!stillCurrent()) return;
          const catalog = response?.result ?? response;
          const matches = catalog?.conversations?.filter(row => row.referenceId === result.referenceId && row.status === 'open' && typeof row.sessionId === 'string' && row.sessionId);
          if (catalog?.topicId !== input.topicId || matches?.length !== 1) throw new Error('The exact created Conversation is unavailable. Check creation outcome before another creation.');
          await navigation.open({ topicId: input.topicId, referenceId: result.referenceId, expectedSessionId: matches[0].sessionId });
          if (stillCurrent()) close();
        } });
      form.form.querySelector('h2').textContent = `New conversation in ${topic.name}`;
      content.replaceChildren(form.form, cancel);
      // Native components own modal containment, Escape and focus return.
      dialog = host.components.mountDialog(container, { label: `New conversation in ${topic.name}`, content, returnFocusTarget,
        description: 'Optional label. Cancel preserves your current Chat and unsent draft. An uncertain creation must be checked before another.', onCancel: () => { close(); return false; } });
    } catch (error) { if (current()) status.textContent = host.redact(error?.message || 'Topic conversation creation is unavailable.'); }
  }
  void start();
  return { sync() { if (!current()) close(); else form?.sync(); }, cancel: close, dispose: close };
}
