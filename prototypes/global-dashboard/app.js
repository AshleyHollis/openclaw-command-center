// PROTOTYPE: Three original Global Dashboard variants plus one feedback-driven synthesis, switchable via ?variant=.

const variants = [
  { key: 'A', name: 'Triage stack' },
  { key: 'B', name: 'Focus desk' },
  { key: 'C', name: 'Command canvas' },
  { key: 'D', name: 'Refined inbox' },
];

const state = {
  attentionFilter: 'all',
  selectedAttentionId: 'attn-backup',
  selectedSpaceId: 'household',
  completedAttentionIds: new Set(),
  snoozedAttention: new Map(),
  dialogAttentionId: null,
  activityExpanded: false,
};

const spaces = [
  { id: 'household', name: 'Household', category: 'Area', note: '2 Notes changed', resume: 'Continue hallway paint shortlist', tone: 'moss' },
  { id: 'vehicle', name: 'Vehicle', category: 'Area', note: 'Reminder due Friday', resume: 'Review weekend trip checklist', tone: 'clay' },
  { id: 'technology', name: 'Technology', category: 'Area', note: '8 Notes', resume: 'Open backup checklist', tone: 'sun' },
  { id: 'cooking', name: 'Cooking', category: 'Resource', note: 'Updated yesterday', resume: 'Browse weeknight meal notes', tone: 'ink' },
  { id: 'admin', name: 'Admin', category: 'Area', note: '2 Reminders coming up', resume: 'Review renewal checklist', tone: 'moss' },
  { id: 'learning', name: 'Learning', category: 'Area', note: 'Certification due soon', resume: 'Continue study plan', tone: 'clay' },
];

const attentionItems = [
  {
    id: 'attn-backup',
    severity: 'high',
    kind: 'Operational',
    title: 'Last night\'s backup could not be verified',
    summary: 'The workspace backup completed, but the off-site copy did not pass its freshness check.',
    source: 'Backup monitor',
    time: '22 minutes ago',
    space: null,
    primary: 'Review backup',
    secondary: 'Snooze 1 hour',
  },
  {
    id: 'attn-reminder',
    severity: 'due',
    kind: 'Reminder',
    title: 'Put the bins out tonight',
    summary: 'Due at 7:00 pm · Household',
    source: 'Reminder',
    time: 'Due 7:00 pm',
    space: 'Household',
    primary: 'Mark done',
    secondary: 'Open Space',
  },
  {
    id: 'attn-gardening',
    severity: 'normal',
    kind: 'Suggestion',
    title: 'Move the home-network Notes into Technology?',
    summary: 'Space Gardening found recurring technology context in Household. Nothing moves without your approval.',
    source: 'Space Gardening',
    time: 'Yesterday',
    space: 'Technology',
    primary: 'Review proposal',
    secondary: 'Dismiss',
  },
  {
    id: 'attn-tracker',
    severity: 'normal',
    kind: 'Operational',
    title: 'Price tracker has not refreshed since this morning',
    summary: 'The scheduled discovery run is late, but no existing price data has been lost.',
    source: 'Automation health',
    time: '3 hours ago',
    space: 'Technology',
    primary: 'Review tracker',
    secondary: 'Dismiss',
  },
];

const reminders = [
  { time: 'Tomorrow · 9:00 am', title: 'Renew cloud certification profile', space: 'Learning' },
  { time: 'Friday · 5:00 pm', title: 'Check tyre pressures before the trip', space: 'Vehicle' },
  { time: 'Saturday · 10:00 am', title: 'Plan next week\'s dinners', space: 'Cooking' },
];

const activity = [
  { time: '11:42', title: 'Note refreshed', detail: 'Technology · Backup checklist' },
  { time: '10:18', title: 'Automation completed', detail: 'Admin · Weekly renewal scan' },
  { time: 'Yesterday', title: 'Conversation summarized', detail: 'Vehicle · Weekend trip checklist' },
  { time: 'Yesterday', title: 'Search index updated', detail: '4 sources indexed' },
];

function icon(name) {
  const paths = {
    dashboard: '<path d="M4 4h6v6H4zM14 4h6v4h-6zM14 12h6v8h-6zM4 14h6v6H4z"/>',
    spaces: '<path d="M4 6.5 12 3l8 3.5v10L12 20l-8-3.5z"/><path d="m4 6.5 8 3.5 8-3.5M12 10v10"/>',
    activity: '<path d="M3 12h4l2.2-5 4.1 10 2.1-5H21"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7M10 19h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 17h.01"/>',
    spark: '<path d="m12 3 1.3 4.2L17.5 9l-4.2 1.8L12 15l-1.3-4.2L6.5 9l4.2-1.8zM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7z"/>',
    note: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 11h6M9 15h6"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  };
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
}

function shell(content, current = 'dashboard') {
  return `
    <div class="app-shell">
      <aside class="rail" aria-label="Primary navigation">
        <a class="brand" href="?variant=${currentVariant()}" aria-label="Command Center dashboard"><span class="brand-mark">OC</span><span class="brand-name">Command Center</span></a>
        <nav class="rail-nav" aria-label="Command Center">
          ${navLink('dashboard', 'Dashboard', current === 'dashboard')}
          ${navLink('spaces', 'Spaces', current === 'spaces')}
          ${navLink('activity', 'Activity', current === 'activity')}
        </nav>
        <div class="rail-bottom">${navLink('settings', 'Settings', false)}</div>
      </aside>
      <div class="shell-main">
        <header class="topbar">
          <button class="mobile-menu icon-button" type="button" aria-label="Open navigation">${icon('menu')}</button>
          <button class="search-trigger" type="button">${icon('search')}<span>Search Command Center</span><kbd>⌘ K</kbd></button>
          <div class="topbar-actions">
            <button class="icon-button notification-button" type="button" aria-label="Open 2 attention items">${icon('bell')}<span class="badge-dot" aria-hidden="true"></span></button>
            <button class="avatar" type="button" aria-label="Open profile menu">AX</button>
          </div>
        </header>
        ${content}
      </div>
      <nav class="mobile-nav" aria-label="Mobile navigation">
        ${navLink('dashboard', 'Dashboard', true)}
        ${navLink('spaces', 'Spaces', false)}
        ${navLink('activity', 'Activity', false)}
      </nav>
    </div>`;
}

function navLink(name, label, active) {
  return `<a href="#${name}" class="nav-link ${active ? 'is-active' : ''}" ${active ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span></a>`;
}

function pageHeading(eyebrow, title, copy, action = true) {
  return `<header class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">${copy}</p></div>${action ? `<button class="primary-button" type="button" data-action="new-space">${icon('plus')}New Space</button>` : ''}</header>`;
}

function attentionCard(item, compact = false) {
  const done = state.completedAttentionIds.has(item.id);
  return `<article class="attention-card severity-${item.severity} ${compact ? 'is-compact' : ''} ${done ? 'is-done' : ''}" data-id="${item.id}">
    <div class="attention-marker">${icon(item.severity === 'high' ? 'alert' : item.kind === 'Reminder' ? 'clock' : 'spark')}</div>
    <div class="attention-copy">
      <div class="card-meta"><span class="kind-label">${item.kind}</span><span>${item.time}</span></div>
      <h3>${item.title}</h3>
      <p>${done ? 'Handled for this prototype session.' : item.summary}</p>
      ${compact ? '' : `<p class="source-line">Source: ${item.source}</p>`}
    </div>
    <div class="attention-actions">
      <button class="small-button primary-small" type="button" data-action="attention-primary" data-id="${item.id}">${done ? icon('check') + 'Done' : item.primary}</button>
      <button class="small-button" type="button" data-action="attention-secondary" data-id="${item.id}">${item.secondary}</button>
    </div>
  </article>`;
}

function spaceButton(space, expanded = false) {
  const selected = state.selectedSpaceId === space.id;
  return `<button class="space-card tone-${space.tone} ${selected ? 'is-selected' : ''} ${expanded ? 'is-expanded' : ''}" type="button" data-action="select-space" data-id="${space.id}" ${selected ? 'aria-pressed="true"' : 'aria-pressed="false"'}>
    <span class="space-monogram" aria-hidden="true">${space.name.split(' ').map(part => part[0]).join('').slice(0, 2)}</span>
    <span class="space-card-copy"><span class="space-card-top"><strong>${space.name}</strong><span class="category-chip">${space.category}</span></span><span>${space.note}</span>${expanded ? `<span class="resume-line">${icon('arrow')}${space.resume}</span>` : ''}</span>
    ${icon('arrow')}
  </button>`;
}

function reminderList(limit = reminders.length) {
  return `<ol class="timeline-list">${reminders.slice(0, limit).map(item => `<li><span class="timeline-dot" aria-hidden="true"></span><div><time>${item.time}</time><strong>${item.title}</strong><span>${item.space}</span></div></li>`).join('')}</ol>`;
}

function activityList(limit = activity.length) {
  return `<ol class="activity-list">${activity.slice(0, limit).map(item => `<li><time>${item.time}</time><div><strong>${item.title}</strong><span>${item.detail}</span></div></li>`).join('')}</ol>`;
}

function VariantA() {
  const visibleAttention = attentionItems.filter(item => state.attentionFilter === 'all' || item.kind.toLowerCase() === state.attentionFilter);
  const content = `<main id="main-content" class="page page-a">
    ${pageHeading('Sunday, 2 August', 'Good afternoon, Alex', 'Three things need a decision. Everything else can wait.')}
    <div class="dashboard-grid-a">
      <section class="attention-stack" aria-labelledby="attention-a-title">
        <div class="section-heading"><div><p class="section-kicker">Needs you</p><h2 id="attention-a-title">Attention inbox <span class="count">${visibleAttention.length}</span></h2></div>
          <div class="segmented" aria-label="Filter attention items">
            ${['all', 'reminder', 'operational'].map(filter => `<button type="button" data-action="filter-attention" data-filter="${filter}" class="${state.attentionFilter === filter ? 'is-active' : ''}" aria-pressed="${state.attentionFilter === filter}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join('')}
          </div>
        </div>
        <div class="attention-list">${visibleAttention.map(item => attentionCard(item)).join('')}</div>
      </section>
      <aside class="right-stack">
        <section class="panel" aria-labelledby="spaces-a-title"><div class="panel-heading"><h2 id="spaces-a-title">Spaces</h2><a href="#spaces">View all</a></div><div class="space-list">${spaces.slice(0, 3).map(space => spaceButton(space)).join('')}</div></section>
        <section class="panel" aria-labelledby="reminders-a-title"><div class="panel-heading"><h2 id="reminders-a-title">Coming up</h2><a href="#reminders">All Reminders</a></div>${reminderList(2)}</section>
        <details class="panel quiet-activity" ${state.activityExpanded ? 'open' : ''}><summary><span>${icon('activity')}Recent OpenClaw Activity</span><span class="quiet-count">4 records</span></summary>${activityList(3)}</details>
      </aside>
    </div>
  </main>`;
  return shell(content);
}

function VariantB() {
  const openItems = attentionItems.filter(item => !state.completedAttentionIds.has(item.id));
  const selected = attentionItems.find(item => item.id === state.selectedAttentionId) ?? openItems[0] ?? attentionItems[0];
  const content = `<main id="main-content" class="page page-b">
    ${pageHeading('Focus desk', 'What needs a decision?', 'Select one item, understand it, and move it forward.', false)}
    <div class="focus-layout">
      <section class="focus-queue" aria-labelledby="queue-title">
        <div class="queue-heading"><h2 id="queue-title">Queue</h2><span>${openItems.length} open</span></div>
        <div class="queue-list">${attentionItems.map(item => {
          const active = item.id === selected.id;
          const done = state.completedAttentionIds.has(item.id);
          return `<button type="button" class="queue-item severity-${item.severity} ${active ? 'is-active' : ''} ${done ? 'is-done' : ''}" data-action="select-attention" data-id="${item.id}" aria-pressed="${active}"><span class="queue-icon">${icon(item.severity === 'high' ? 'alert' : item.kind === 'Reminder' ? 'clock' : 'spark')}</span><span><small>${item.kind} · ${item.time}</small><strong>${item.title}</strong><span>${done ? 'Handled' : item.source}</span></span>${icon('arrow')}</button>`;
        }).join('')}</div>
        <section class="mini-reminders" aria-labelledby="later-title"><h3 id="later-title">Later</h3>${reminderList(2)}</section>
      </section>
      <section class="focus-detail" aria-labelledby="focus-title">
        <div class="focus-detail-top"><span class="severity-pill severity-${selected.severity}">${icon(selected.severity === 'high' ? 'alert' : selected.kind === 'Reminder' ? 'clock' : 'spark')}${selected.kind}</span><span>${selected.time}</span></div>
        <h2 id="focus-title">${selected.title}</h2>
        <p class="focus-summary">${selected.summary}</p>
        <div class="evidence-box"><p class="section-kicker">Why this is here</p><p>${selected.kind === 'Operational' ? 'The source crossed its action threshold, so one deduplicated Attention Item was raised.' : selected.kind === 'Reminder' ? `This lightweight commitment is due and belongs to the ${selected.space ?? 'related'} Space.` : 'The proposed structural change requires approval. No Notes have moved.'}</p><dl><div><dt>Source</dt><dd>${selected.source}</dd></div><div><dt>Space</dt><dd>${selected.space ?? 'Global'}</dd></div><div><dt>Status</dt><dd>${state.completedAttentionIds.has(selected.id) ? 'Handled' : 'Waiting for you'}</dd></div></dl></div>
        <div class="focus-actions"><button class="primary-button" type="button" data-action="attention-primary" data-id="${selected.id}">${state.completedAttentionIds.has(selected.id) ? icon('check') + 'Handled' : selected.primary}</button><button class="secondary-button" type="button" data-action="attention-secondary" data-id="${selected.id}">${selected.secondary}</button></div>
      </section>
      <aside class="focus-context" aria-label="Space and activity context">
        <section><div class="panel-heading"><h2>Resume a Space</h2><a href="#spaces">All Spaces</a></div><div class="space-list">${spaces.slice(0, 3).map(space => spaceButton(space, true)).join('')}</div><button class="dashed-button" type="button" data-action="new-space">${icon('plus')}New Space</button></section>
        <details class="quiet-activity" ${state.activityExpanded ? 'open' : ''}><summary><span>${icon('activity')}OpenClaw Activity</span><span class="quiet-count">4</span></summary>${activityList(3)}</details>
      </aside>
    </div>
  </main>`;
  return shell(content);
}

function VariantC() {
  const selectedSpace = spaces.find(space => space.id === state.selectedSpaceId) ?? spaces[0];
  const content = `<main id="main-content" class="page page-c">
    ${pageHeading('Command canvas', 'Your day at a glance', 'Act where needed, then drop back into the Space that matters.')}
    <section class="action-strip" aria-labelledby="action-strip-title">
      <div class="strip-title"><p class="section-kicker">Needs you</p><h2 id="action-strip-title">${attentionItems.length} decisions</h2></div>
      <div class="strip-items">${attentionItems.map(item => `<button type="button" class="strip-item severity-${item.severity}" data-action="select-attention" data-id="${item.id}"><span>${icon(item.severity === 'high' ? 'alert' : item.kind === 'Reminder' ? 'clock' : 'spark')}</span><span><small>${item.kind}</small><strong>${item.title}</strong></span>${icon('arrow')}</button>`).join('')}</div>
    </section>
    <div class="canvas-layout">
      <section class="space-canvas" aria-labelledby="space-canvas-title">
        <div class="section-heading"><div><p class="section-kicker">Pick up where you left off</p><h2 id="space-canvas-title">Spaces</h2></div><a href="#spaces">Manage Spaces</a></div>
        <div class="space-grid">${spaces.map(space => spaceButton(space, true)).join('')}</div>
        <article class="resume-panel tone-${selectedSpace.tone}"><div><p class="section-kicker">Ready to resume</p><h3>${selectedSpace.name}</h3><p>${selectedSpace.resume}</p></div><button class="primary-button" type="button">Open Space${icon('arrow')}</button></article>
      </section>
      <aside class="day-rail">
        <section aria-labelledby="today-title"><div class="panel-heading"><h2 id="today-title">Coming up</h2><a href="#reminders">All</a></div>${reminderList()}</section>
        <section class="activity-ledger" aria-labelledby="ledger-title"><div class="panel-heading"><h2 id="ledger-title">OpenClaw Activity</h2><span>Pull-based</span></div>${activityList(4)}<a class="text-link" href="#activity">Open full activity</a></section>
      </aside>
    </div>
  </main>`;
  return shell(content);
}

function attentionListRow(item) {
  const snoozedFor = state.snoozedAttention.get(item.id);
  const handled = state.completedAttentionIds.has(item.id);
  const quickSnooze = `<div class="quick-snooze-split"><button class="small-button" type="button" data-action="quick-snooze" data-id="${item.id}" data-duration="1 hour">${icon('clock')}Snooze 1h</button><details class="quick-snooze-options"><summary aria-label="Choose snooze duration for ${item.title}">${icon('chevron')}</summary><div class="quick-snooze-menu" aria-label="Snooze duration"><button type="button" data-action="quick-snooze" data-id="${item.id}" data-duration="15 minutes">15 minutes</button><button type="button" data-action="quick-snooze" data-id="${item.id}" data-duration="1 hour">1 hour</button><button type="button" data-action="quick-snooze" data-id="${item.id}" data-duration="3 hours">3 hours</button><button type="button" data-action="quick-snooze" data-id="${item.id}" data-duration="until tomorrow morning">Tomorrow morning</button><button type="button" data-action="quick-snooze" data-id="${item.id}" data-duration="1 week">1 week</button></div></details></div>`;
  return `<li class="inbox-row severity-${item.severity} ${handled ? 'is-done' : ''}">
    <button type="button" class="inbox-row-open" data-action="open-attention" data-id="${item.id}" aria-label="Open details for ${item.title}">
      <span class="inbox-row-icon">${icon(item.severity === 'high' ? 'alert' : item.kind === 'Reminder' ? 'clock' : 'spark')}</span>
      <span class="inbox-row-main"><span class="inbox-row-meta"><strong>${item.kind}</strong><span>${handled ? 'Handled' : snoozedFor ? `Snoozed ${snoozedFor}` : item.time}</span></span><span class="inbox-row-title">${item.title}</span></span>
      ${icon('arrow')}
    </button>
    <div class="inbox-row-actions" aria-label="Quick actions for ${item.title}"><button class="small-button primary-small" type="button" data-action="attention-primary" data-id="${item.id}">${handled ? icon('check') + 'Done' : item.primary}</button>${handled ? '' : item.kind === 'Suggestion' ? `<button class="small-button" type="button" data-action="attention-secondary" data-id="${item.id}">Dismiss</button>` : quickSnooze}</div>
  </li>`;
}

function attentionDialog() {
  const item = attentionItems.find(candidate => candidate.id === state.dialogAttentionId);
  if (!item) return '';
  const handled = state.completedAttentionIds.has(item.id);
  const snoozedFor = state.snoozedAttention.get(item.id);
  return `<dialog class="attention-dialog" aria-labelledby="attention-dialog-title">
    <div class="dialog-shell">
      <header class="dialog-heading"><div><span class="severity-pill severity-${item.severity}">${icon(item.severity === 'high' ? 'alert' : item.kind === 'Reminder' ? 'clock' : 'spark')}${item.kind}</span><h2 id="attention-dialog-title">${item.title}</h2></div><button type="button" class="dialog-close icon-button" data-action="close-attention" aria-label="Close Attention Item details">×</button></header>
      <p class="dialog-summary">${item.summary}</p>
      <section class="dialog-evidence" aria-labelledby="why-title"><p class="section-kicker" id="why-title">Why this needs you</p><p>${item.kind === 'Operational' ? 'The source crossed its action threshold. Repeated records were deduplicated into this single Attention Item.' : item.kind === 'Reminder' ? 'A lightweight commitment reached its due window and now requires a decision.' : 'This proposal would change structural context, so OpenClaw cannot apply it silently.'}</p></section>
      <dl class="dialog-facts"><div><dt>Source</dt><dd>${item.source}</dd></div><div><dt>Space</dt><dd>${item.space ?? 'Global'}</dd></div><div><dt>Status</dt><dd>${handled ? 'Handled' : snoozedFor ? `Snoozed ${snoozedFor}` : 'Waiting for you'}</dd></div><div><dt>Raised</dt><dd>${item.time}</dd></div></dl>
      <div class="dialog-actions"><button class="primary-button" type="button" data-action="attention-primary" data-id="${item.id}">${handled ? icon('check') + 'Handled' : item.primary}</button>${item.secondary.startsWith('Snooze') ? '' : `<button class="secondary-button" type="button" data-action="attention-secondary" data-id="${item.id}">${item.secondary}</button>`}</div>
      <form class="snooze-form" data-id="${item.id}" method="dialog"><label for="snooze-duration">Snooze for</label><div><select id="snooze-duration" name="duration"><option value="15 minutes">15 minutes</option><option value="1 hour" selected>1 hour</option><option value="3 hours">3 hours</option><option value="until tomorrow morning">Until tomorrow morning</option><option value="1 week">1 week</option></select><button type="button" class="small-button" data-action="confirm-snooze" data-id="${item.id}">${icon('clock')}Snooze</button></div></form>
    </div>
  </dialog>`;
}

function VariantD() {
  const visibleAttention = attentionItems.filter(item => state.attentionFilter === 'all' || item.kind.toLowerCase() === state.attentionFilter);
  const selectedSpace = spaces.find(space => space.id === state.selectedSpaceId) ?? spaces[0];
  const content = `<main id="main-content" class="page page-d">
    ${pageHeading('Sunday, 2 August', 'Good afternoon, Alex', 'Handle what needs you, then move into a Space.', true)}
    <div class="dashboard-grid-d">
      <section class="refined-inbox" aria-labelledby="attention-d-title">
        <header class="inbox-banner"><div><h2 id="attention-d-title">Attention inbox <span>${visibleAttention.length}</span></h2><p>Items that need action now.</p></div><div class="segmented segmented-dark" aria-label="Filter attention items">${['all', 'reminder', 'operational'].map(filter => `<button type="button" data-action="filter-attention" data-filter="${filter}" class="${state.attentionFilter === filter ? 'is-active' : ''}" aria-pressed="${state.attentionFilter === filter}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join('')}</div></header>
        <ol class="inbox-rows">${visibleAttention.map(item => attentionListRow(item)).join('')}</ol>
        <footer class="inbox-footer"><button class="small-button" type="button" data-action="load-more">Load more</button></footer>
      </section>
      <aside class="right-stack refined-right">
        <section class="panel space-launcher" aria-labelledby="space-launcher-title"><div class="panel-heading"><h2 id="space-launcher-title">Open a Space</h2></div><label class="sr-only" for="space-select">Choose a Space</label><select id="space-select" data-action="select-space-dropdown">${spaces.map(space => `<option value="${space.id}" ${space.id === selectedSpace.id ? 'selected' : ''}>${space.name}</option>`).join('')}</select><button class="primary-button" type="button" data-action="open-space">Open${icon('arrow')}</button></section>
        <section class="panel" aria-labelledby="reminders-d-title"><div class="panel-heading"><h2 id="reminders-d-title">Coming up</h2><a href="#reminders">All Reminders</a></div>${reminderList(3)}</section>
        <details class="panel quiet-activity" ${state.activityExpanded ? 'open' : ''}><summary><span>${icon('activity')}Recent OpenClaw Activity</span><span class="quiet-count">4 records</span></summary>${activityList(3)}</details>
      </aside>
    </div>
    ${attentionDialog()}
  </main>`;
  return shell(content);
}

function currentVariant() {
  const candidate = new URLSearchParams(window.location.search).get('variant')?.toUpperCase();
  return variants.some(variant => variant.key === candidate) ? candidate : 'A';
}

function setVariant(nextKey) {
  const params = new URLSearchParams(window.location.search);
  params.set('variant', nextKey);
  window.history.pushState({}, '', `${window.location.pathname}?${params}`);
  render();
  announce(`Showing variant ${nextKey}, ${variants.find(variant => variant.key === nextKey).name}`);
}

function cycleVariant(direction) {
  const index = variants.findIndex(variant => variant.key === currentVariant());
  setVariant(variants[(index + direction + variants.length) % variants.length].key);
}

function switcher() {
  const variant = variants.find(item => item.key === currentVariant());
  return `<div class="switcher-inner"><span class="prototype-label">Prototype</span><button type="button" data-action="previous-variant" aria-label="Previous prototype variant">←</button><strong>${variant.key} — ${variant.name}</strong><button type="button" data-action="next-variant" aria-label="Next prototype variant">→</button></div>`;
}

function announce(message) {
  document.querySelector('#live-region').textContent = message;
}

function render() {
  const renderers = { A: VariantA, B: VariantB, C: VariantC, D: VariantD };
  document.querySelector('#app').innerHTML = renderers[currentVariant()]();
  document.querySelector('#prototype-switcher').innerHTML = switcher();
  bindActions();
  const dialog = document.querySelector('.attention-dialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function bindActions() {
  document.querySelectorAll('button[data-action], a[data-action]').forEach(element => element.addEventListener('click', handleAction));
  document.querySelectorAll('select[data-action="select-space-dropdown"]').forEach(element => element.addEventListener('change', handleAction));
  document.querySelectorAll('.quiet-activity').forEach(element => element.addEventListener('toggle', () => { state.activityExpanded = element.open; }));
  document.querySelectorAll('.attention-dialog').forEach(element => element.addEventListener('close', () => { state.dialogAttentionId = null; render(); }));
}

function handleAction(event) {
  const target = event.currentTarget;
  const action = target.dataset.action;
  if (action === 'previous-variant') return cycleVariant(-1);
  if (action === 'next-variant') return cycleVariant(1);
  if (action === 'filter-attention') {
    state.attentionFilter = target.dataset.filter;
    render();
    return announce(`Attention filter changed to ${state.attentionFilter}`);
  }
  if (action === 'select-attention') {
    state.selectedAttentionId = target.dataset.id;
    if (currentVariant() !== 'B') setVariant('B'); else render();
    return announce('Attention Item selected');
  }
  if (action === 'open-attention') {
    state.dialogAttentionId = target.dataset.id;
    render();
    return announce('Attention Item details opened');
  }
  if (action === 'close-attention') {
    state.dialogAttentionId = null;
    render();
    return announce('Attention Item details closed');
  }
  if (action === 'select-space-dropdown') {
    state.selectedSpaceId = target.value;
    return announce(`${spaces.find(space => space.id === state.selectedSpaceId).name} selected`);
  }
  if (action === 'select-space') {
    state.selectedSpaceId = target.dataset.id;
    render();
    return announce(`${spaces.find(space => space.id === state.selectedSpaceId).name} selected`);
  }
  if (action === 'attention-primary') {
    state.completedAttentionIds.add(target.dataset.id);
    render();
    return announce('Attention Item handled');
  }
  if (action === 'attention-secondary') {
    if (target.textContent.trim() === 'Dismiss') {
      state.completedAttentionIds.add(target.dataset.id);
      render();
      return announce('Attention Item dismissed');
    }
    return announce('Secondary action previewed; prototype data was not changed');
  }
  if (action === 'quick-snooze') {
    const duration = target.dataset.duration ?? '1 hour';
    state.snoozedAttention.set(target.dataset.id, duration);
    render();
    return announce(`Attention Item snoozed for ${duration}`);
  }
  if (action === 'confirm-snooze') {
    const form = target.closest('.snooze-form');
    const duration = form.querySelector('select').value;
    state.snoozedAttention.set(target.dataset.id, duration);
    state.dialogAttentionId = null;
    render();
    return announce(`Attention Item snoozed for ${duration}`);
  }
  if (action === 'open-space') return announce(`${spaces.find(space => space.id === state.selectedSpaceId).name} would open`);
  if (action === 'load-more') return announce('More Attention Items would load here');
  if (action === 'new-space') return announce('New Space flow belongs to a separate prototype ticket');
}

window.addEventListener('keydown', event => {
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA'].includes(tag) || document.activeElement?.isContentEditable) return;
  if (event.key === 'ArrowLeft') cycleVariant(-1);
  if (event.key === 'ArrowRight') cycleVariant(1);
});

window.addEventListener('popstate', render);
render();
