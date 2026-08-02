// PROTOTYPE: Three original Space Page layouts plus one feedback-driven synthesis, switchable via ?variant=.

const variants = [
  { key: 'A', name: 'Conversation studio' },
  { key: 'B', name: 'Working notebook' },
  { key: 'C', name: 'Conversation timeline' },
  { key: 'D', name: 'Flexible workspace' },
];

const conversations = [
  { id: 'primary', title: 'Household planning', meta: 'Primary Session', time: 'Now', preview: 'Let’s turn those measurements into a short list.', primary: true },
  { id: 'paint', title: 'Hallway paint shortlist', meta: 'Space Conversation', time: 'Yesterday', preview: 'Warm white versus pale sage for the hallway.' },
  { id: 'garden', title: 'Autumn garden jobs', meta: 'Space Conversation', time: 'Friday', preview: 'Pruning order and a Saturday checklist.' },
  { id: 'archive', title: 'Old renovation chat', meta: 'Legacy Conversation Archive', time: '2024', preview: 'Read-only imported conversation.', archived: true },
];

const notes = [
  { id: 'hallway', title: 'Hallway refresh', updated: 'Updated 12 min ago', body: '## Direction\n\nKeep the hallway light, hard-wearing, and calm. Compare warm white with a muted sage before buying a full tin.\n\n## Measurements\n\n- North wall: 4.2 m × 2.4 m\n- Entry wall: 2.7 m × 2.4 m\n- Two door frames to prepare\n\n## Next check\n\nView both samples in morning and evening light.' },
  { id: 'maintenance', title: 'Seasonal maintenance', updated: 'Updated Friday', body: '## Autumn\n\nClean gutters, test smoke alarms, and inspect outdoor seals before the wetter months.' },
  { id: 'suppliers', title: 'Local suppliers', updated: 'Updated last month', body: '## Paint\n\nThree fictional suppliers with sample-pot collection and low-VOC options.' },
];

const messages = {
  primary: [
    { who: 'you', text: 'I measured the hallway and added the dimensions to the Note.' },
    { who: 'openclaw', text: 'I found them. The two candidate colours both work, but the warmer white is safer in the shaded entry.' },
    { who: 'you', text: 'Can you turn this into a Saturday test plan?' },
    { who: 'openclaw', text: 'Yes. I’ll keep the test small: two sample boards, checked at 9 am and 6 pm, with the final choice written back to the Note.' },
  ],
  paint: [
    { who: 'you', text: 'Compare warm white with pale sage for this hallway.' },
    { who: 'openclaw', text: 'Warm white will reflect more light. Pale sage adds character but may read grey in the shaded end. I linked the comparison to Hallway refresh.' },
  ],
  garden: [
    { who: 'you', text: 'What are the three highest-value garden jobs for Saturday?' },
    { who: 'openclaw', text: 'Prune the rosemary, clear the side drain, then top up the herb-bed mulch.' },
  ],
  archive: [
    { who: 'you', text: 'This imported record is available for reference only.' },
    { who: 'openclaw', text: 'Legacy archive content cannot receive new messages.' },
  ],
};

const searchResults = [
  { source: 'Note', title: 'Hallway refresh', excerpt: 'Compare warm white with a muted sage before buying a full tin.' },
  { source: 'Space Conversation', title: 'Hallway paint shortlist', excerpt: 'Pale sage may read grey at the shaded end.' },
  { source: 'Legacy Conversation Archive', title: 'Old renovation chat', excerpt: 'The entry gets indirect light for most of the day.' },
];

const state = {
  selectedConversation: 'primary',
  selectedNote: 'hallway',
  mobileSurface: defaultMobileSurface(currentVariant()),
  searchOpen: false,
  notesCompact: false,
  conversationPane: 'open',
  notePane: 'open',
  selectedFolder: 'projects/hallway/paint',
  noteEditing: false,
};

function icon(name) {
  const paths = {
    home: '<path d="m3 11 9-8 9 8v9h-6v-6H9v6H3z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    note: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 11h6M9 15h6"/>',
    history: '<path d="M4 8V4m0 0h4M4 4l3 3a8 8 0 1 1-2 8"/><path d="M12 8v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="m3 11 18-8-8 18-2-8zM11 13l4-4"/>',
    star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    maximize: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    restore: '<path d="M8 8h11v11H8z"/><path d="M5 16H3V3h13v2"/>',
    panelLeft: '<path d="M3 4h18v16H3zM9 4v16"/>',
    panelRight: '<path d="M3 4h18v16H3zM15 4v16"/>',
    edit: '<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10zM13.5 6.5 17 10"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  };
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
}

function currentVariant() {
  const candidate = new URLSearchParams(location.search).get('variant')?.toUpperCase();
  return variants.some(variant => variant.key === candidate) ? candidate : 'A';
}

function activeConversation() {
  return conversations.find(item => item.id === state.selectedConversation) ?? conversations[0];
}

function activeNote() {
  return notes.find(item => item.id === state.selectedNote) ?? notes[0];
}

function appShell(content) {
  return `<div class="app-shell">
    <header class="global-header">
      <a class="brand" href="#dashboard" aria-label="Back to Command Center dashboard"><span class="brand-mark">OC</span><span>Command Center</span></a>
      <nav aria-label="Breadcrumb"><ol class="breadcrumbs"><li><a href="#dashboard">Dashboard</a></li><li aria-current="page">Household</li></ol></nav>
      <button class="global-search" type="button" data-action="open-search">${icon('search')}<span>Search this Space</span><kbd>⌘ K</kbd></button>
      <button class="avatar" type="button" aria-label="Open profile menu">AX</button>
    </header>
    <header class="space-header">
      <div><span class="space-glyph" aria-hidden="true">H</span><div><p class="eyebrow">Area · Household</p><h1>Household</h1></div></div>
      <div class="space-header-actions"><span class="context-chip">${icon('folder')}Household Notes</span><button class="icon-button" type="button" aria-label="More Space actions">${icon('more')}</button></div>
    </header>
    ${content}
    ${mobileNav()}
    ${state.searchOpen ? searchDialog() : ''}
  </div>`;
}

function mobileNav() {
  const orders = {
    A: [['chat', 'Chat'], ['notes', 'Notes'], ['history', 'History'], ['search', 'Search']],
    B: [['notes', 'Notes'], ['chat', 'Chat'], ['history', 'History'], ['search', 'Search']],
    C: [['history', 'History'], ['chat', 'Chat'], ['notes', 'Notes'], ['search', 'Search']],
    D: [['chat', 'Chat'], ['history', 'Conversations'], ['notes', 'Notes'], ['search', 'Search']],
  };
  return `<nav class="mobile-nav" aria-label="Space sections">${orders[currentVariant()].map(([id, label]) => mobileTab(id, label)).join('')}</nav>`;
}

function defaultMobileSurface(variant) {
  return variant === 'B' ? 'notes' : variant === 'C' ? 'history' : 'chat';
}

function mobileTab(id, label) {
  return `<button type="button" data-action="mobile-surface" data-surface="${id}" class="${state.mobileSurface === id ? 'is-active' : ''}" aria-pressed="${state.mobileSurface === id}">${icon(id === 'notes' ? 'note' : id === 'history' ? 'history' : id === 'search' ? 'search' : 'chat')}<span>${label}</span></button>`;
}

function conversationList(mode = 'rail') {
  return `<div class="conversation-list ${mode}">${conversations.map(item => {
    const selected = item.id === state.selectedConversation;
    return `<button type="button" class="conversation-item ${selected ? 'is-active' : ''}" data-action="select-conversation" data-id="${item.id}" aria-pressed="${selected}">
      <span class="conversation-icon">${icon(item.archived ? 'lock' : item.primary ? 'star' : 'chat')}</span>
      <span><span class="conversation-top"><strong>${item.title}</strong><time>${item.time}</time></span><small>${item.meta}</small><span class="conversation-preview">${item.preview}</span></span>
    </button>`;
  }).join('')}</div>`;
}

function chatPanel(layout = 'standard') {
  const conversation = activeConversation();
  const readOnly = conversation.archived;
  return `<section class="chat-panel ${layout}" aria-labelledby="chat-title">
    <header class="panel-header chat-header"><div><p class="eyebrow">${conversation.meta}</p><h2 id="chat-title">${conversation.title}${conversation.primary ? '<span class="primary-badge">Primary</span>' : ''}</h2></div><button class="icon-button" type="button" aria-label="Conversation options">${icon('more')}</button></header>
    <div class="message-stream">${(messages[conversation.id] ?? []).map(message => `<article class="message ${message.who}"><span class="message-avatar" aria-hidden="true">${message.who === 'you' ? 'AX' : 'OC'}</span><div><strong>${message.who === 'you' ? 'You' : 'OpenClaw'}</strong><p>${message.text}</p></div></article>`).join('')}</div>
    ${readOnly ? `<div class="archive-notice">${icon('lock')}This Legacy Conversation Archive is read-only.</div>` : `<form class="composer" data-action="send-message"><label class="sr-only" for="message-${currentVariant()}">Message Household</label><textarea id="message-${currentVariant()}" rows="2" placeholder="Message Household…"></textarea><div><span>Context: Household Notes</span><button type="submit" aria-label="Send message">${icon('send')}</button></div></form>`}
  </section>`;
}

function notesPanel(layout = 'standard') {
  const note = activeNote();
  return `<section class="notes-panel ${layout}" aria-labelledby="notes-title">
    <header class="panel-header"><div><p class="eyebrow">Note</p><h2 id="notes-title">${note.title}</h2></div><span class="saved-state">Saved</span></header>
    <div class="note-tabs" role="tablist" aria-label="Household Notes">${notes.map(item => `<button type="button" role="tab" data-action="select-note" data-id="${item.id}" aria-selected="${item.id === state.selectedNote}" class="${item.id === state.selectedNote ? 'is-active' : ''}">${item.title}</button>`).join('')}</div>
    <article class="note-document"><p class="note-updated">${note.updated}</p>${markdown(note.body)}</article>
  </section>`;
}

function markdown(value) {
  return value.split('\n').filter(Boolean).map(line => {
    if (line.startsWith('## ')) return `<h3>${line.slice(3)}</h3>`;
    if (line.startsWith('- ')) return `<p class="bullet">${line.slice(2)}</p>`;
    return `<p>${line}</p>`;
  }).join('');
}

function historyPanel(title = 'Conversations') {
  return `<aside class="history-panel" aria-labelledby="history-title"><header class="panel-header"><div><p class="eyebrow">Space history</p><h2 id="history-title">${title}</h2></div><button class="icon-button" type="button" data-action="new-conversation" aria-label="Start a Space Conversation">${icon('plus')}</button></header>${conversationList()}</aside>`;
}

function mobileSurfaceContent() {
  if (state.mobileSurface === 'notes') return notesPanel('mobile-only');
  if (state.mobileSurface === 'history') return historyPanel('Conversation history');
  if (state.mobileSurface === 'search') return searchResultsPanel();
  return chatPanel('mobile-only');
}

function VariantA() {
  return appShell(`<main id="main-content" class="variant-a">
    <div class="desktop-layout studio-layout">
      ${historyPanel()}
      ${chatPanel()}
      ${notesPanel()}
    </div>
    <div class="mobile-layout">${mobileSurfaceContent()}</div>
  </main>`);
}

function VariantB() {
  const conversation = activeConversation();
  return appShell(`<main id="main-content" class="variant-b">
    <div class="desktop-layout notebook-layout">
      <section class="notebook-main" aria-label="Household working Note">${notesPanel('notebook')}</section>
      <aside class="notebook-chat">
        <div class="conversation-select"><label for="conversation-select">Conversation</label><select id="conversation-select" data-action="conversation-select">${conversations.map(item => `<option value="${item.id}" ${item.id === conversation.id ? 'selected' : ''}>${item.title}${item.primary ? ' · Primary' : ''}</option>`).join('')}</select><button class="icon-button" type="button" data-action="new-conversation" aria-label="Start a Space Conversation">${icon('plus')}</button></div>
        ${chatPanel('compact')}
        <details class="history-drawer"><summary>${icon('history')}Conversation history <span>${conversations.length}</span></summary>${conversationList('compact-list')}</details>
      </aside>
    </div>
    <div class="mobile-layout">${mobileSurfaceContent()}</div>
  </main>`);
}

function VariantC() {
  const conversation = activeConversation();
  return appShell(`<main id="main-content" class="variant-c">
    <div class="desktop-layout timeline-layout">
      <section class="timeline-main" aria-labelledby="timeline-title">
        <header class="timeline-heading"><div><p class="eyebrow">All context, by conversation</p><h2 id="timeline-title">Conversation timeline</h2></div><button class="primary-button" type="button" data-action="new-conversation">${icon('plus')}New conversation</button></header>
        <div class="timeline-search"><label class="sr-only" for="timeline-filter">Filter conversation history</label>${icon('search')}<input id="timeline-filter" type="search" placeholder="Filter this Space’s conversation history"></div>
        <ol class="conversation-timeline">${conversations.map((item, index) => `<li class="${item.id === state.selectedConversation ? 'is-active' : ''}"><span class="timeline-dot" aria-hidden="true"></span><button type="button" data-action="select-conversation" data-id="${item.id}" aria-pressed="${item.id === state.selectedConversation}"><span><small>${item.time} · ${item.meta}</small><strong>${item.title}</strong><span>${item.preview}</span></span>${icon('chevron')}</button>${index === 0 ? '<span class="timeline-now">Now</span>' : ''}</li>`).join('')}</ol>
      </section>
      <section class="timeline-workbench" aria-label="Selected conversation and Note">
        ${chatPanel('timeline-chat')}
        ${notesPanel('timeline-note')}
      </section>
    </div>
    <div class="mobile-layout">${mobileSurfaceContent()}</div>
  </main>`);
}

function paneControls(pane, focused = false) {
  const label = pane === 'conversation' ? 'Conversations' : 'Notes';
  return `<div class="pane-controls">
    <button class="icon-button" type="button" data-action="${focused ? 'restore-pane' : 'focus-pane'}" data-pane="${pane}" aria-label="${focused ? `Restore ${label} pane` : `Focus ${label} pane`}">${icon(focused ? 'restore' : 'maximize')}</button>
    ${focused ? '' : `<button class="icon-button" type="button" data-action="close-pane" data-pane="${pane}" aria-label="Close ${label} pane">${icon('close')}</button>`}
  </div>`;
}

function dConversationBrowser(focused = false) {
  const visible = conversations.filter(item => !item.archived);
  return `<aside class="d-conversations ${focused ? 'is-focused' : ''}" aria-labelledby="d-conversations-title">
    <header class="d-pane-header"><div><p class="eyebrow">Household</p><h2 id="d-conversations-title">Conversations</h2></div>${paneControls('conversation', focused)}</header>
    <div class="d-conversation-search"><label class="sr-only" for="conversation-search-d">Search conversations</label>${icon('search')}<input id="conversation-search-d" type="search" placeholder="Search conversations"></div>
    ${focused ? '<div class="d-filter-row"><button class="is-active" type="button">All conversations</button><button type="button">Primary Session</button><button type="button">Space Conversations</button></div>' : ''}
    <div class="conversation-list d-list">${visible.map(item => {
      const selected = item.id === state.selectedConversation;
      return `<button type="button" class="conversation-item ${selected ? 'is-active' : ''}" data-action="select-conversation" data-id="${item.id}" aria-pressed="${selected}"><span class="conversation-icon">${icon(item.primary ? 'star' : 'chat')}</span><span><span class="conversation-top"><strong>${item.title}</strong><time>${item.time}</time></span><small>${item.meta}</small><span class="conversation-preview">${item.preview}</span></span></button>`;
    }).join('')}</div>
    <button class="d-new-conversation" type="button" data-action="new-conversation">${icon('plus')}New conversation</button>
  </aside>`;
}

function dChatPanel() {
  const conversation = activeConversation();
  return `<section class="d-chat" aria-labelledby="d-chat-title">
    <header class="d-chat-header"><div class="d-chat-tools"><button class="pane-toggle ${state.conversationPane === 'closed' ? '' : 'is-active'}" type="button" data-action="toggle-pane" data-pane="conversation" aria-pressed="${state.conversationPane !== 'closed'}">${icon('panelLeft')}<span>Conversations</span></button></div><div><p class="eyebrow">${conversation.meta}</p><h2 id="d-chat-title">${conversation.title}${conversation.primary ? '<span class="primary-badge">Primary</span>' : ''}</h2></div><div class="d-chat-tools"><button class="pane-toggle ${state.notePane === 'closed' ? '' : 'is-active'}" type="button" data-action="toggle-pane" data-pane="note" aria-pressed="${state.notePane !== 'closed'}">${icon('panelRight')}<span>Note</span></button></div></header>
    <div class="message-stream d-message-stream">
      <div class="migration-marker"><span>Imported conversation history</span><small>Original authors, timestamps, replies, and thread context preserved</small></div>
      ${(messages[conversation.id] ?? []).map((message, index) => `<article class="message ${message.who}"><span class="message-avatar" aria-hidden="true">${message.who === 'you' ? 'AX' : 'OC'}</span><div><strong>${message.who === 'you' ? 'You' : 'OpenClaw'}</strong><p>${message.text}</p>${message.who === 'openclaw' && index === 1 ? `<button class="note-reference" type="button" data-action="open-note" data-id="hallway">${icon('note')}Hallway refresh <span>Open Note</span></button>` : ''}</div></article>`).join('')}
    </div>
    <form class="composer" data-action="send-message"><label class="sr-only" for="message-d">Message Household</label><textarea id="message-d" rows="2" placeholder="Message Household…"></textarea><div><span>Context: Household Notes</span><button type="submit" aria-label="Send message">${icon('send')}</button></div></form>
  </section>`;
}

function dNotePreview(focused = false) {
  const note = activeNote();
  return `<aside class="d-note ${focused ? 'is-focused' : ''}" aria-labelledby="d-note-title">
    <header class="d-pane-header"><div><p class="eyebrow">${focused ? 'Notes workspace' : 'Note preview'}</p><h2 id="d-note-title">${note.title}</h2></div>${paneControls('note', focused)}</header>
    ${focused ? dNotesWorkspace() : `<article class="note-document"><p class="note-updated">${note.updated}</p>${markdown(note.body)}</article><footer class="d-note-footer"><button type="button" data-action="focus-pane" data-pane="note">${icon('maximize')}Open full Notes workspace</button></footer>`}
  </aside>`;
}

function dNotesWorkspace() {
  const note = activeNote();
  const folderLabels = {
    'projects': 'Projects',
    'projects/hallway': 'Hallway',
    'projects/hallway/paint': 'Paint',
    'projects/hallway/measurements': 'Measurements',
    'projects/kitchen': 'Kitchen refresh',
    'maintenance': 'Maintenance',
    'maintenance/seasonal': 'Seasonal',
    'maintenance/seasonal/autumn': 'Autumn',
    'reference': 'Reference',
    'reference/suppliers': 'Suppliers',
    'archive': 'Archive',
  };
  const selectedFolderLabel = folderLabels[state.selectedFolder] ?? 'Notes';
  return `<div class="notes-workspace">
    <nav class="folder-tree" aria-label="Household Note folders">
      <div class="folder-root">${icon('folder')}<strong>Household Notes</strong></div>
      <details open><summary>${icon('folder')}<span>Projects</span><small>6</small></summary><div class="folder-children">
        <details open><summary>${icon('folder')}<span>Hallway</span><small>4</small></summary><div class="folder-children">
          ${folderButton('projects/hallway/paint', 'Paint', 2)}
          ${folderButton('projects/hallway/measurements', 'Measurements', 2)}
        </div></details>
        ${folderButton('projects/kitchen', 'Kitchen refresh', 2)}
      </div></details>
      <details open><summary>${icon('folder')}<span>Maintenance</span><small>11</small></summary><div class="folder-children">
        <details open><summary>${icon('folder')}<span>Seasonal</span><small>7</small></summary><div class="folder-children">${folderButton('maintenance/seasonal/autumn', 'Autumn', 4)}</div></details>
      </div></details>
      <details><summary>${icon('folder')}<span>Reference</span><small>18</small></summary><div class="folder-children">${folderButton('reference/suppliers', 'Suppliers', 8)}</div></details>
      ${folderButton('archive', 'Archive', 9)}
    </nav>
    <section class="note-browser" aria-labelledby="note-browser-title"><header><h3 id="note-browser-title">${selectedFolderLabel}</h3><button class="icon-button" type="button" aria-label="Create Note">${icon('plus')}</button></header><div class="note-list-search"><label class="sr-only" for="note-search-d">Search Notes</label>${icon('search')}<input id="note-search-d" type="search" placeholder="Search Notes"></div><div class="note-browser-list">${notes.map(item => `<button type="button" data-action="select-note" data-id="${item.id}" class="${item.id === state.selectedNote ? 'is-active' : ''}" aria-pressed="${item.id === state.selectedNote}"><strong>${item.title}</strong><span>${item.updated}</span><small>${item.id === 'hallway' ? 'Projects / Hallway / Paint' : item.id === 'maintenance' ? 'Maintenance / Seasonal / Autumn' : 'Reference / Suppliers / Paint'}</small></button>`).join('')}</div></section>
    <section class="note-canvas ${state.noteEditing ? 'is-editing' : ''}" aria-labelledby="note-canvas-title"><header><div><p class="eyebrow">Household Notes / ${selectedFolderLabel}</p><h3 id="note-canvas-title">${note.title}</h3></div><div class="note-canvas-actions"><span class="saved-state">${state.noteEditing ? 'Editing' : 'Saved'}</span><button type="button" data-action="toggle-note-edit">${icon(state.noteEditing ? 'eye' : 'edit')}${state.noteEditing ? 'Preview' : 'Edit'}</button></div></header>${state.noteEditing ? noteEditor(note) : `<article class="note-document"><p class="note-updated">${note.updated}</p>${markdown(note.body)}<h3>Long document example</h3><p>This focused canvas is designed to keep reading and editing comfortable when a Note grows well beyond a short side preview. The document scrolls independently while folders and the Note list remain available.</p></article>`}</section>
  </div>`;
}

function folderButton(id, label, count) {
  return `<button type="button" data-action="select-folder" data-id="${id}" class="${id === state.selectedFolder ? 'is-active' : ''}" aria-pressed="${id === state.selectedFolder}">${icon('folder')}<span>${label}</span><small>${count}</small></button>`;
}

function noteEditor(note) {
  return `<form class="note-editor" data-action="save-note"><label for="note-body-d">Markdown content for ${note.title}</label><textarea id="note-body-d" name="body" spellcheck="true">${escapeMarkup(note.body)}</textarea><footer><button type="button" data-action="cancel-note-edit">Cancel</button><button class="primary-button" type="submit">Save changes</button></footer></form>`;
}

function escapeMarkup(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function dMobileContent() {
  if (state.mobileSurface === 'notes') return `<section class="d-mobile-notes">${dNotePreview(true)}</section>`;
  if (state.mobileSurface === 'history') return dConversationBrowser(true);
  if (state.mobileSurface === 'search') return searchResultsPanel();
  return dChatPanel();
}

function VariantD() {
  const focusedPane = state.notePane === 'focused' ? dNotePreview(true) : state.conversationPane === 'focused' ? dConversationBrowser(true) : null;
  const layoutClass = `d-layout conversations-${state.conversationPane} note-${state.notePane}`;
  return appShell(`<main id="main-content" class="variant-d">
    <div class="desktop-layout ${layoutClass}">${focusedPane ?? `${state.conversationPane === 'open' ? dConversationBrowser() : ''}${dChatPanel()}${state.notePane === 'open' ? dNotePreview() : ''}`}</div>
    <div class="mobile-layout">${dMobileContent()}</div>
  </main>`);
}

function searchResultsPanel() {
  return `<section class="search-results" aria-labelledby="search-results-title"><header><p class="eyebrow">Space Search</p><h2 id="search-results-title">Results for “hallway”</h2><p>Across Notes, Space Conversations, and the read-only Legacy Conversation Archive.</p></header><ol>${searchResults.map(result => `<li><button type="button" data-action="search-result"><span class="source-badge">${result.source}</span><strong>${result.title}</strong><span>${result.excerpt}</span></button></li>`).join('')}</ol></section>`;
}

function searchDialog() {
  return `<dialog class="search-dialog"><div class="search-dialog-shell"><header><div><p class="eyebrow">Household</p><h2>Search this Space</h2></div><button class="icon-button" type="button" data-action="close-search" aria-label="Close search">${icon('close')}</button></header><label for="space-search">Search Notes and conversations</label><div class="search-field">${icon('search')}<input id="space-search" type="search" value="hallway" autocomplete="off"></div>${searchResultsPanel()}</div></dialog>`;
}

function switcher() {
  const variant = variants.find(item => item.key === currentVariant());
  return `<div class="switcher-inner"><span class="prototype-label">Prototype</span><button type="button" data-action="previous-variant" aria-label="Previous prototype variant">←</button><strong>${variant.key} — ${variant.name}</strong><button type="button" data-action="next-variant" aria-label="Next prototype variant">→</button></div>`;
}

function render() {
  const renderers = { A: VariantA, B: VariantB, C: VariantC, D: VariantD };
  document.querySelector('#app').innerHTML = renderers[currentVariant()]();
  document.querySelector('#prototype-switcher').innerHTML = switcher();
  bindActions();
  const dialog = document.querySelector('.search-dialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function setVariant(key) {
  const params = new URLSearchParams(location.search);
  params.set('variant', key);
  history.pushState({}, '', `${location.pathname}?${params}`);
  state.mobileSurface = defaultMobileSurface(key);
  render();
  announce(`Showing variant ${key}, ${variants.find(item => item.key === key).name}`);
}

function cycleVariant(direction) {
  const index = variants.findIndex(item => item.key === currentVariant());
  setVariant(variants[(index + direction + variants.length) % variants.length].key);
}

function bindActions() {
  document.querySelectorAll('[data-action]').forEach(element => {
    const eventName = element.tagName === 'FORM' ? 'submit' : element.tagName === 'SELECT' ? 'change' : 'click';
    element.addEventListener(eventName, handleAction);
  });
}

function handleAction(event) {
  const target = event.currentTarget;
  const action = target.dataset.action;
  if (action === 'previous-variant') return cycleVariant(-1);
  if (action === 'next-variant') return cycleVariant(1);
  if (action === 'select-conversation' || action === 'conversation-select') {
    state.selectedConversation = action === 'conversation-select' ? target.value : target.dataset.id;
    render();
    return announce(`${activeConversation().title} selected`);
  }
  if (action === 'select-note') {
    state.selectedNote = target.dataset.id;
    state.noteEditing = false;
    render();
    return announce(`${activeNote().title} opened`);
  }
  if (action === 'open-note') {
    state.selectedNote = target.dataset.id;
    state.notePane = 'open';
    render();
    return announce(`${activeNote().title} opened beside Chat`);
  }
  if (action === 'toggle-pane') {
    const key = target.dataset.pane === 'conversation' ? 'conversationPane' : 'notePane';
    state[key] = state[key] === 'closed' ? 'open' : 'closed';
    render();
    return announce(`${target.dataset.pane} pane ${state[key]}`);
  }
  if (action === 'close-pane') {
    const key = target.dataset.pane === 'conversation' ? 'conversationPane' : 'notePane';
    state[key] = 'closed';
    render();
    return announce(`${target.dataset.pane} pane closed`);
  }
  if (action === 'focus-pane') {
    if (target.dataset.pane === 'conversation') {
      state.conversationPane = 'focused';
      state.notePane = 'closed';
    } else {
      state.notePane = 'focused';
      state.conversationPane = 'closed';
    }
    render();
    return announce(`${target.dataset.pane} pane focused`);
  }
  if (action === 'restore-pane') {
    state.conversationPane = 'open';
    state.notePane = 'open';
    render();
    return announce('Chat workspace restored');
  }
  if (action === 'select-folder') {
    state.selectedFolder = target.dataset.id;
    render();
    return announce(`${target.textContent.trim()} folder selected`);
  }
  if (action === 'toggle-note-edit') {
    state.noteEditing = !state.noteEditing;
    render();
    return announce(state.noteEditing ? 'Note editor opened' : 'Note preview opened');
  }
  if (action === 'cancel-note-edit') {
    state.noteEditing = false;
    render();
    return announce('Note edit cancelled');
  }
  if (action === 'save-note') {
    event.preventDefault();
    const noteToSave = activeNote();
    noteToSave.body = target.querySelector('textarea').value;
    noteToSave.updated = 'Updated just now';
    state.noteEditing = false;
    render();
    return announce(`${noteToSave.title} saved in prototype memory`);
  }
  if (action === 'mobile-surface') {
    state.mobileSurface = target.dataset.surface;
    render();
    return announce(`${state.mobileSurface} section opened`);
  }
  if (action === 'open-search') {
    state.searchOpen = true;
    render();
    return announce('Space Search opened');
  }
  if (action === 'close-search') {
    state.searchOpen = false;
    render();
    return announce('Space Search closed');
  }
  if (action === 'new-conversation') return announce('A new isolated Space Conversation would start here');
  if (action === 'search-result') return announce('The authoritative source would open here');
  if (action === 'send-message') {
    event.preventDefault();
    const input = target.querySelector('textarea');
    if (!input.value.trim()) return announce('Write a message first');
    messages[state.selectedConversation].push({ who: 'you', text: input.value.trim() });
    render();
    return announce('Prototype message added in memory');
  }
}

function announce(message) {
  document.querySelector('#live-region').textContent = message;
}

window.addEventListener('keydown', event => {
  const focused = document.activeElement;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(focused?.tagName) || focused?.isContentEditable) return;
  if (event.key === 'ArrowLeft') cycleVariant(-1);
  if (event.key === 'ArrowRight') cycleVariant(1);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    state.searchOpen = true;
    render();
  }
});

window.addEventListener('popstate', render);
render();
