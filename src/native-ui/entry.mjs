import { createNativeTopicNavigation } from './topic-navigation.mjs';
import { mountTopicPage } from './topic-page.mjs';
import { mountTopicNotesPanel } from './topic-notes-panel.mjs';
import { createTopicGroupSetup } from './topic-group-setup.mjs';
import { mountHistoryPage } from './history-page.mjs';
import { createNativeCreationForm } from './creation-form.mjs';
import { createNativeState } from './mutations.mjs';
import { FIRST_LIVE_FEATURES } from './release-scope.mjs';

/** Native Control UI contribution. OpenClaw owns Chat, its roster and its drafts. */
export function mountTopics(container, context, state = createNativeState()) {
  const host = context.host;
  let presented = context.presented;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, host.signal, lifetime.signal]);
  const navigation = createNativeTopicNavigation({
    signal,
    get connection() { return host.connection; },
    request: (method, params) => host.request(method, params),
    sessions: host.sessions
  });
  const document = container.ownerDocument;
  const heading = document.createElement('h1');
  heading.textContent = 'Topics';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Refresh Topics';
  const list = document.createElement('div');
  const creation = FIRST_LIVE_FEATURES.topicProvisioning ? createNativeCreationForm({ host, state, document, signal, presented: () => presented,
    onCreated: (_result, input) => { navigation.cancel(); host.navigation.openPage({ id: 'topic', params: { topicId: input.topicId } }); } }) : null;
  const scopeNotice = document.createElement('p');
  scopeNotice.textContent = 'Existing Topics are available. New Topic creation is not available in this release.';
  container.replaceChildren(heading, status, refresh, ...(creation ? [creation.form] : [scopeNotice]), list);
  let generation = 0;
  let groupSetups = [];
  const current = (value) => !signal.aborted && presented && host.connection.connected && host.connection.canRead && value === generation;
  const report = (error) => { if (!signal.aborted && error?.name !== 'AbortError') status.textContent = host.redact(error?.message || 'Topics are unavailable.'); };
  async function load() {
    const pending = ++generation;
    groupSetups.forEach(setup => setup.dispose()); groupSetups = [];
    if (signal.aborted || !presented) return;
    if (!host.connection.connected || !host.connection.canRead) {
      list.replaceChildren();
      status.textContent = 'Connect with read access to view Topics.';
      return;
    }
    status.textContent = 'Loading Topics…';
    try {
      const [response, statusResponse] = await Promise.all([
        host.request('command-center.v1.topics.list', { schemaVersion: 1 }),
        host.request('command-center.v1.sources.status', { schemaVersion: 1 })
      ]);
      if (!current(pending)) return;
      const mode = (statusResponse?.result ?? statusResponse)?.mode;
      if (!['ready', 'degraded', 'recovery-only'].includes(mode)) throw new Error('The operating mode is unavailable. Refresh Topics before continuing.');
      const destination = response?.result ?? response;
      if (!destination?.activeGroups) throw new Error('The Topic destination is unavailable.');
      const fragment = document.createDocumentFragment();
      let count = 0;
      for (const category of ['project', 'area', 'resource']) {
        const topics = destination.activeGroups[category];
        if (!Array.isArray(topics)) throw new Error('The Topic destination is incomplete.');
        if (!topics.length) continue;
        const title = document.createElement('h2');
        title.textContent = { project: 'Projects', area: 'Areas', resource: 'Resources' }[category];
        fragment.append(title);
        const group = document.createElement('ul');
        for (const topic of topics) {
          const row = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `Open ${topic.name} in Chat`;
          button.disabled = topic.usable !== true || mode === 'recovery-only';
          button.addEventListener('click', () => {
            if (!presented) return;
            status.textContent = 'Opening native Chat…';
            void navigation.openPrimary(topic.topicId).then(() => {
              if (!signal.aborted && presented) status.textContent = 'Opened in native Chat.';
            }).catch(report);
          }, { signal });
          row.append(button);
          const notes = document.createElement('button');
          notes.type = 'button'; notes.textContent = `View Notes for ${topic.name}`;
          notes.addEventListener('click', () => {
            if (!presented) return;
            navigation.cancel();
            host.navigation.openPage({ id: 'topic', params: { topicId: topic.topicId } });
          }, { signal });
          row.append(notes);
          if (topic.usable === true && mode !== 'recovery-only') {
            const setup = createTopicGroupSetup({ host, document, topicId: topic.topicId, signal, presented: () => presented && pending === generation });
            groupSetups.push(setup); row.append(setup.container);
          }
          if (button.disabled) row.append(document.createTextNode(' — Source Recovery required'));
          group.append(row);
          count += 1;
        }
        fragment.append(group);
      }
      const recoveryTopics = destination.recovery ?? [];
      if (!Array.isArray(recoveryTopics)) throw new Error('The Topic recovery destination is incomplete.');
      if (recoveryTopics.length) {
        const title = document.createElement('h2'); title.textContent = 'Source Recovery';
        const recoveryList = document.createElement('ul');
        for (const topic of recoveryTopics) {
          const row = document.createElement('li');
          row.textContent = `${topic.name} — Source Recovery required.`;
          recoveryList.append(row);
        }
        fragment.append(title, recoveryList);
      }
      list.replaceChildren(fragment);
      const summary = count ? `${count} Topics. Conversations open in native Chat.` : recoveryTopics.length ? `${recoveryTopics.length} Topics require Source Recovery.` : 'No active Topics.';
      status.textContent = mode === 'recovery-only' ? 'Recovery-only · diagnostics and safe reads only. Changes are unavailable until recovery is resolved.'
        : mode === 'degraded' ? `Degraded · some capabilities are unavailable. ${summary}` : summary;
    } catch (error) { if (current(pending)) { list.replaceChildren(); report(error); } }
  }
  refresh.addEventListener('click', () => void load(), { signal });
  const canRead = () => host.connection.connected && host.connection.canRead;
  let readable = canRead();
  const unsubscribe = host.subscribe(() => {
    creation?.sync();
    const next = canRead();
    if (next === readable) return;
    readable = next;
    navigation.cancel();
    void load();
  });
  void load();
  return {
    update(next) {
      if (presented === next.presented) return;
      presented = next.presented;
      creation?.sync();
      generation += 1;
      navigation.cancel();
      if (presented) void load();
    },
    focus() { refresh.focus(); },
    dispose() { groupSetups.forEach(setup => setup.dispose()); creation?.dispose(); lifetime.abort(); unsubscribe(); container.replaceChildren(); }
  };
}

/** @type {import('openclaw/plugin-sdk/control-ui').ControlUiPluginV2} */
export default {
  id: 'command-center',
  activate(host) {
    const state = createNativeState(host.signal);
    const notesPanel = host.ui.registerPanel({ id: 'topic-notes', label: 'Topic Notes', mount: (container, context) => mountTopicNotesPanel(container, context, state) });
    const page = host.ui.registerPage({ id: 'topics', label: 'Topics', mount: (container, context) => mountTopics(container, context, state) });
    const topic = host.ui.registerPage({ id: 'topic', label: 'Topic Notes', mount: (container, context) => mountTopicPage(container, context, state) });
    const histories = host.ui.registerPage({ id: 'histories', label: 'Imported History', mount: mountHistoryPage });
    const historyNavigation = host.ui.registerNavigation({ id: 'histories', label: 'Imported History', page: { id: 'histories' }, order: 11 });
    const navigation = host.ui.registerNavigation({ id: 'topics', label: 'Topics', page: { id: 'topics' }, order: 10 });
    return () => { state.retire(); notesPanel(); historyNavigation(); histories(); navigation(); topic(); page(); };
  }
};
