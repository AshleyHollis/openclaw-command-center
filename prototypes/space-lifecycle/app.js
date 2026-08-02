// PROTOTYPE — throwaway planning artifact.
// Three Space lifecycle variants, switchable by ?variant=, on a standalone prototype route.

const variants = {
  A: { name: 'Guided conversation', description: 'Name the Space, then answer the one required category question.' },
  B: { name: 'Quick form', description: 'Enter the two essentials and create immediately.' },
  C: { name: 'Compact proposal', description: 'Confirm the essentials while defaults stay inspectable.' },
};

const scenarios = {
  create: { label: 'Creation flow', eyebrow: 'New durable context' },
  migrate: { label: 'Legacy import', eyebrow: 'One-time text migration' },
  garden: { label: 'Gardening proposal', eyebrow: 'Gated Space Gardening' },
};

const state = {
  spaceName: 'Garden',
  category: null,
  createdSpace: null,
  openedSpace: null,
  createStatus: 'draft',
  migrationStatus: 'ready',
  gardenStatus: 'pending',
  gardenChoice: 'move',
  packetSections: new Set(['structure']),
};

const icon = (name) => {
  const icons = {
    home: '<path d="M3 11.5 12 4l9 7.5v8a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    space: '<path d="M4 6.5 12 3l8 3.5-8 3.5zM4 11l8 3.5 8-3.5M4 15.5l8 3.5 8-3.5"/>',
    activity: '<path d="M4 12h3l2-6 4 12 2-6h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    folder: '<path d="M3 6.5h7l2 2h9v10.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
    chat: '<path d="M4 4h16v12H8l-4 4z"/>',
    archive: '<path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/>',
    leaf: '<path d="M20 4C11 4 5 8 5 15c0 2 1 4 3 5 0-6 4-10 10-12-5 3-8 7-8 12 7 0 11-6 10-16z"/>',
    arrow: '<path d="m9 18 6-6-6-6"/>',
    shield: '<path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  };
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
};

function currentRoute() {
  const params = new URLSearchParams(location.search);
  const variant = variants[params.get('variant')] ? params.get('variant') : 'A';
  const scenario = scenarios[params.get('scenario')] ? params.get('scenario') : 'create';
  const view = scenario === 'create' && params.get('view') === 'new' ? 'new' : scenario === 'create' ? 'spaces' : 'flow';
  return { variant, scenario, view };
}

function updateRoute(patch) {
  const route = currentRoute();
  const params = new URLSearchParams({ ...route, ...patch });
  history.replaceState(null, '', `?${params}`);
  render();
}

function shell(content, route) {
  const spacesLanding = route.scenario === 'create' && route.view === 'spaces';
  const newSpace = route.scenario === 'create' && route.view === 'new';
  const intro = spacesLanding
    ? 'Open a durable topic context or create a new one.'
    : newSpace
      ? 'Choose a Space name and one PARA Category. Command Center applies the standard Note Folder and Primary Session defaults.'
    : 'Review a consequential structural change without hiding authoritative sources or approval boundaries.';
  const eyebrow = spacesLanding ? 'Spaces' : newSpace ? 'Spaces / New Space' : scenarios[route.scenario].eyebrow;
  const heading = spacesLanding ? 'Your Spaces' : newSpace ? 'Create a Space' : 'Shape a Space';
  const headingAction = spacesLanding
    ? '<button class="primary-button heading-button" type="button" data-start-create>+ Create Space</button>'
    : newSpace
      ? '<button class="quiet-button" type="button" data-back-spaces>← Back to Spaces</button>'
      : '<button class="quiet-button" type="button" data-reset>Reset fixture</button>';
  const scenarioNav = Object.entries(scenarios).map(([key, item]) => `
    <button class="scenario-tab" data-scenario="${key}" aria-pressed="${route.scenario === key}">
      <span>${item.label}</span>
    </button>`).join('');

  return `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Command Center">
        <a class="brand" href="#" aria-label="Command Center home">
          <span class="brand-mark">OC</span><span class="brand-copy">Command<br>Center</span>
        </a>
        <nav class="main-nav" aria-label="Main navigation">
          <a href="#">${icon('home')}<span>Home</span></a>
          <a href="#" aria-current="page">${icon('space')}<span>Spaces</span></a>
          <a href="#">${icon('activity')}<span>Activity</span></a>
        </nav>
        <a class="settings-link" href="#">${icon('settings')}<span>Settings</span></a>
      </aside>
      <div class="page-shell">
        <header class="topbar">
          <div>
            <span class="mobile-brand">OC</span>
            <span class="prototype-label">Prototype · fictional data</span>
          </div>
          <button class="profile-button" type="button" aria-label="Open profile menu">AH</button>
        </header>
        <main id="main-content" tabindex="-1">
          <header class="page-heading">
            <div>
              <p class="eyebrow">${eyebrow}</p>
              <h1>${heading}</h1>
              <p>${intro}</p>
            </div>
            ${headingAction}
          </header>
          <nav class="scenario-nav" aria-label="Prototype scenario">${scenarioNav}</nav>
          ${content}
        </main>
      </div>
    </div>
    ${prototypeSwitcher(route)}
  `;
}

function prototypeSwitcher(route) {
  return `
    <div class="prototype-switcher" role="group" aria-label="Prototype variant switcher">
      <button type="button" data-cycle="-1" aria-label="Previous variant">←</button>
      <div><strong>${route.variant} — ${variants[route.variant].name}</strong><span>${variants[route.variant].description}</span></div>
      <button type="button" data-cycle="1" aria-label="Next variant">→</button>
    </div>`;
}

function spacesLanding() {
  const fixtures = [
    { name: 'Household', category: 'Area', initial: 'H', detail: 'Home routines and shared context' },
    { name: 'Vehicle', category: 'Area', initial: 'V', detail: 'Maintenance, records, and planning' },
    { name: 'Cooking', category: 'Resource', initial: 'C', detail: 'Recipes and meal ideas' },
    { name: 'Technology', category: 'Area', initial: 'T', detail: 'Devices, services, and upkeep' },
    { name: 'Learning', category: 'Area', initial: 'L', detail: 'Courses and reference notes' },
    { name: 'Admin', category: 'Area', initial: 'A', detail: 'Personal administration' },
  ];
  const spaces = state.createdSpace
    ? [{ name: state.createdSpace.name, category: state.createdSpace.category, initial: state.createdSpace.name.slice(0, 1).toUpperCase(), detail: 'New Space', fresh: true }, ...fixtures]
    : fixtures;
  const options = spaces.map((space) => `<option value="${space.name}">${space.name} · ${space.category}</option>`).join('');
  const cards = spaces.map((space) => `
    <li class="space-card ${space.fresh ? 'is-new' : ''}">
      <span class="space-initial" aria-hidden="true">${space.initial}</span>
      <div><div class="space-title-row"><h3>${space.name}</h3>${space.fresh ? '<span class="new-badge">New</span>' : ''}</div><p>${space.detail}</p><span class="category-badge">${space.category}</span></div>
      <button class="secondary-button" type="button" data-open-space="${space.name}">Open</button>
    </li>`).join('');
  return `<section class="spaces-landing" aria-labelledby="all-spaces-title">
    ${state.openedSpace ? `<div class="status-banner" role="status">${icon('check')}<span>${state.openedSpace} would open as a Space Page in the production app.</span></div>` : ''}
    <section class="space-launcher" aria-labelledby="space-launcher-title">
      <div><p class="eyebrow">Quick open</p><h2 id="space-launcher-title">Choose an existing Space</h2></div>
      <div class="launcher-controls"><label class="sr-only" for="existing-space">Existing Space</label><select id="existing-space" data-space-select>${options}</select><button class="primary-button" type="button" data-open-selected>Open Space</button></div>
    </section>
    <section class="all-spaces"><div class="section-heading"><div><p class="eyebrow">Browse</p><h2 id="all-spaces-title">All Spaces</h2></div><span>${spaces.length} Spaces</span></div><ul class="space-grid">${cards}</ul></section>
  </section>`;
}

function sourceBoundary() {
  return `
    <div class="boundary-note">
      ${icon('shield')}
      <div><strong>Source boundary</strong><p>Notes stay in the Note Folder. Conversations stay in OpenClaw Sessions. Command Center stores links and presentation metadata only.</p></div>
    </div>`;
}

function liveRecord() {
  const category = state.category || 'Choose one';
  return `
    <aside class="live-record" aria-labelledby="live-record-title">
      <div class="record-header"><div><p class="eyebrow">Live preview</p><h2 id="live-record-title">Household</h2></div><span class="status-dot">Draft</span></div>
      <dl class="record-list">
        <div><dt>Space name</dt><dd>${state.spaceName}</dd></div>
        <div><dt>PARA Category</dt><dd class="${state.category ? '' : 'needs-choice'}">${category}</dd></div>
        <div><dt>Source defaults</dt><dd>${icon('check')}Ready <span>Automatic</span></dd></div>
      </dl>
      ${defaultDetails()}
    </aside>`;
}

function spaceNameField() {
  return `<div class="name-field"><label for="space-name">Space name <span>(required)</span></label><input id="space-name" data-space-name value="${state.spaceName}" autocomplete="off"><p class="field-error" data-name-error hidden>Enter a Space name.</p></div>`;
}

function defaultDetails() {
  return `<details class="defaults-disclosure"><summary>Review automatic defaults</summary><div class="defaults-content"><dl><div><dt>Note Folder</dt><dd>${icon('folder')}Use the conventional “${state.spaceName}” folder</dd></div><div><dt>Primary Session</dt><dd>${icon('chat')}Create “${state.spaceName} main”</dd></div></dl><p>An exact conventional match can be adopted automatically. Ambiguity or a naming conflict becomes an exception to resolve.</p>${sourceBoundary()}</div></details>`;
}

function categoryChoices(compact = false) {
  return `
    <fieldset class="category-fieldset ${compact ? 'compact' : ''}">
      <legend>Choose one PARA Category <span>(required)</span></legend>
      <div class="choice-row">
        ${['Project', 'Area', 'Resource', 'Archive'].map((value) => `
          <button type="button" class="choice-chip" data-category="${value}" aria-pressed="${state.category === value}">${value}${value === 'Area' ? '<small>Suggested</small>' : ''}</button>`).join('')}
      </div>
      <p class="field-error" data-category-error hidden>Choose a PARA Category before creating the Space.</p>
    </fieldset>`;
}

function conversationCreate() {
  return `
    <div class="chat-thread">
      <article class="message agent-message">
        <span class="agent-avatar">OC</span>
        <div><p class="message-meta">OpenClaw · now</p><p>What should this Space be called, and which PARA Category describes it?</p>${spaceNameField()}${categoryChoices()}</div>
      </article>
      <article class="message agent-message">
        <span class="agent-avatar">OC</span>
        <div><p class="message-meta">Defaults are handled</p><p>I’ll apply the standard Note Folder and Primary Session convention. You only need to review those details if there’s a conflict.</p>${defaultDetails()}
          <div class="action-row"><button class="primary-button" type="button" data-create>Create Space</button></div>
        </div>
      </article>
    </div>`;
}

function conversationMigrate() {
  return `
    <div class="chat-thread">
      <article class="message user-message"><div><p class="message-meta">You</p><p>Bring my old Household conversations into this Space.</p></div></article>
      <article class="message agent-message"><span class="agent-avatar">OC</span><div><p class="message-meta">OpenClaw · import scan complete</p><p>I found a fictional export with <strong>38 text conversations</strong> and <strong>12 binary attachments</strong>. MVP can import the text once. Attachments stay in the source export and are listed as skipped.</p>
        <ul class="plain-list"><li>The archive is read-only.</li><li>Nothing is replayed into the Primary Session.</li><li>No continuing connection to the legacy service remains.</li></ul>
      </div></article>
      <article class="message agent-message compact-message"><span class="agent-avatar">OC</span><div><p class="message-meta">Review before import</p><div class="import-summary"><span><strong>38</strong> conversations</span><span><strong>1,264</strong> messages</span><span><strong>12</strong> skipped files</span></div>
        <div class="action-row"><button class="primary-button" type="button" data-import>Import text archive</button><button class="secondary-button" type="button">View manifest</button></div>
      </div></article>
    </div>`;
}

function conversationGarden() {
  return `
    <div class="chat-thread">
      <article class="message agent-message"><span class="agent-avatar">OC</span><div><p class="message-meta">Space Gardening · proposal</p><p>Vehicle maintenance appears in <strong>7 Household Notes</strong> and <strong>4 Space Conversations</strong>. A separate Vehicle Space may make both contexts clearer.</p></div></article>
      <article class="message agent-message"><span class="agent-avatar">OC</span><div><p class="message-meta">Nothing changes without approval</p><div class="proposal-compare"><div><span>Now</span><strong>Household</strong><p>Mixed home and vehicle context</p></div>${icon('arrow')}<div><span>Proposed</span><strong>Vehicle</strong><p>New Area with its own folder and Primary Session</p></div></div>
        <p>I can move 7 Notes after confirmation. Conversation transcripts remain authoritative and are linked to the new Space; they are not rewritten.</p>
        <div class="action-row"><button class="primary-button" type="button" data-garden="move">Approve proposal</button><button class="secondary-button" type="button" data-garden="keep">Keep as-is</button><button class="text-button" type="button">Adjust proposal</button></div>
      </div></article>
    </div>`;
}

function variantA(scenario) {
  const body = scenario === 'create' ? conversationCreate() : scenario === 'migrate' ? conversationMigrate() : conversationGarden();
  return `<section class="variant variant-a" aria-label="Guided conversation variant"><div class="conversation-panel"><div class="panel-heading"><div><p class="eyebrow">A · Guided conversation</p><h2>Decide in context</h2></div><span class="step-badge">Agent-guided</span></div>${body}</div>${liveRecord()}</section>`;
}

function workbenchCreate() {
  return `
    <section class="workbench-stage">
      <header><p class="eyebrow">Quick create</p><h2>Two details, then done</h2><p>Source conventions are automatic unless Command Center detects a conflict.</p></header>
      <div class="quick-create-layout">
        <section class="essentials-card"><h3>Space essentials</h3>${spaceNameField()}${categoryChoices()}<div class="action-row"><button class="primary-button" type="button" data-create>Create Space</button></div></section>
        <aside class="defaults-card"><div class="source-icon">${icon('check')}</div><div><p class="eyebrow">No decisions needed</p><h3>Defaults ready</h3><p>The conventional Note Folder and new Primary Session will use the Space name.</p>${defaultDetails()}</div></aside>
      </div>
    </section>`;
}

function workbenchMigrate() {
  return `
    <section class="workbench-stage">
      <header><p class="eyebrow">Legacy source</p><h2>Build the archive manifest</h2><p>Choose what enters the read-only Legacy Conversation Archive.</p></header>
      <div class="manifest-layout">
        <aside class="source-browser"><h3>Fictional export</h3><label class="check-row"><input type="checkbox" checked><span><strong>Text conversations</strong><small>38 conversations · 1,264 messages</small></span></label><label class="check-row muted"><input type="checkbox" disabled><span><strong>Binary attachments</strong><small>12 files · deferred beyond MVP</small></span></label><button class="secondary-button full" type="button">Replace export</button></aside>
        <div class="manifest-preview"><div class="manifest-header"><div><p class="eyebrow">Destination preview</p><h3>Household · Legacy Conversation Archive</h3></div><span class="status-dot">One-time</span></div>
          <div class="flow-diagram"><div>${icon('archive')}<strong>Legacy export</strong><span>Text snapshot</span></div><span>→</span><div>${icon('space')}<strong>Read-only archive</strong><span>Searchable in Household</span></div></div>
          <div class="guardrail-grid"><div>${icon('check')}<span><strong>No transcript replay</strong>Primary Session starts clean.</span></div><div>${icon('check')}<span><strong>No ongoing sync</strong>Source can be disconnected.</span></div><div>${icon('check')}<span><strong>Failures are itemised</strong>Partial import never looks complete.</span></div></div>
        </div>
      </div>
      <footer class="workbench-footer"><p class="footer-note">Estimated result: 38 archived conversations, 12 skipped attachments, 1 signed manifest.</p><div class="action-row"><button class="secondary-button" type="button">Download manifest</button><button class="primary-button" type="button" data-import>Start text import</button></div></footer>
    </section>`;
}

function workbenchGarden() {
  return `
    <section class="workbench-stage gardening-stage">
      <header><p class="eyebrow">Space Gardening</p><h2>Shape the boundary before approving</h2><p>Inspect evidence, adjust the proposed structure, then make one explicit decision.</p></header>
      <div class="garden-board">
        <article class="evidence-column"><h3>Evidence in Household</h3><div class="evidence-card"><span>Note</span><strong>Seasonal vehicle checks</strong><small>Vehicle topic · repeated 4 times</small></div><div class="evidence-card"><span>Conversation cluster</span><strong>Service and repair planning</strong><small>4 linked conversations</small></div><div class="evidence-card"><span>Note</span><strong>Registration checklist</strong><small>Vehicle topic · stable content</small></div><button class="text-button" type="button">View all 11 signals</button></article>
        <div class="decision-column"><h3>Proposed boundary</h3><label for="new-space-name">New Space</label><input id="new-space-name" value="Vehicle"><label for="garden-category">PARA Category</label><select id="garden-category"><option>Area</option><option>Project</option><option>Resource</option><option>Archive</option></select><fieldset><legend>Move now</legend><label class="check-row"><input type="checkbox" checked><span>7 relevant Notes</span></label><label class="check-row"><input type="checkbox" checked><span>Link 4 conversations</span></label></fieldset><p class="microcopy">Conversation transcripts are relinked, never rewritten.</p></div>
        <aside class="impact-column"><h3>After approval</h3><ol class="impact-list"><li><span>1</span>Create Vehicle Space and sources</li><li><span>2</span>Move selected Notes</li><li><span>3</span>Update compact Space context</li><li><span>4</span>Record outcome in Activity</li></ol><div class="warning-note"><strong>Approval gate</strong><p>No structural change runs silently.</p></div></aside>
      </div>
      <footer class="workbench-footer"><button class="text-button" type="button" data-garden="keep">Reject suggestion</button><div class="action-row"><button class="secondary-button" type="button">Save adjustments</button><button class="primary-button" type="button" data-garden="move">Approve 4 changes</button></div></footer>
    </section>`;
}

function variantB(scenario) {
  const body = scenario === 'create' ? workbenchCreate() : scenario === 'migrate' ? workbenchMigrate() : workbenchGarden();
  const banner = scenario === 'create'
    ? `<div class="variant-banner"><div><p class="eyebrow">B · Quick form</p><strong>Fastest path</strong></div><span class="step-badge">Defaults automatic</span></div>`
    : `<div class="variant-banner"><div><p class="eyebrow">B · Setup workbench</p><strong>Direct manipulation</strong></div><ol><li class="active">Configure</li><li>Review</li><li>Apply</li></ol></div>`;
  return `<section class="variant variant-b" aria-label="${scenario === 'create' ? 'Quick form' : 'Setup workbench'} variant">${banner}${body}</section>`;
}

function packetSection(id, title, meta, content, open = false) {
  const isOpen = state.packetSections.has(id) || open;
  return `<section class="packet-section"><button type="button" class="packet-toggle" data-packet="${id}" aria-expanded="${isOpen}"><span>${icon(isOpen ? 'check' : 'arrow')}<span><strong>${title}</strong><small>${meta}</small></span></span><span>${isOpen ? 'Hide' : 'Review'}</span></button>${isOpen ? `<div class="packet-content">${content}</div>` : ''}</section>`;
}

function proposalPacket(scenario) {
  if (scenario === 'create') {
    return `
      <div class="packet-summary"><div><p class="eyebrow">Compact proposal</p><h2>Create a Space</h2><p>Confirm the two essentials. Routine source setup stays out of the decision path.</p></div><span class="confidence-badge">2 fields</span></div>
      <section class="packet-essentials">${spaceNameField()}${categoryChoices()}</section>
      ${packetSection('defaults', 'Automatic defaults', 'No action required', `<p>Command Center uses the conventional “${state.spaceName}” Note Folder and creates “${state.spaceName} main” as the Primary Session. Only conflicts interrupt creation.</p>${sourceBoundary()}`)}
      <div class="packet-approval"><p class="approval-copy"><strong>Ready when the category is chosen.</strong><span>There is no separate source-binding step.</span></p><button class="primary-button" type="button" data-create>Create Space</button></div>`;
  }
  if (scenario === 'migrate') {
    return `
      <div class="packet-summary"><div><p class="eyebrow">Import proposal</p><h2>Add a read-only legacy archive</h2><p>A one-time, text-first import into Household with an explicit record of omissions.</p></div><span class="confidence-badge">38 conversations</span></div>
      ${packetSection('structure', 'Included content', '1,264 text messages', '<div class="metric-row"><div><strong>38</strong><span>conversations</span></div><div><strong>1,264</strong><span>messages</span></div><div><strong>6 years</strong><span>date range</span></div></div>', true)}
      ${packetSection('omissions', 'Excluded content', '12 binary attachments', '<p>Binary attachments, previews, and content indexing are deferred. Each skipped file remains named in the import manifest so the result cannot be mistaken for complete.</p>')}
      ${packetSection('isolation', 'Isolation guarantees', 'No replay and no ongoing dependency', '<ul class="plain-list"><li>Imported conversations are read-only.</li><li>Nothing enters the Primary Session transcript.</li><li>The legacy source can be disconnected after verification.</li></ul>')}
      <div class="packet-approval"><label class="acknowledge"><input type="checkbox"><span>I reviewed the 12 excluded attachments and the one-time import boundary.</span></label><button class="primary-button" type="button" data-import>Approve text import</button></div>`;
  }
  return `
    <div class="packet-summary"><div><p class="eyebrow">Gardening proposal</p><h2>Separate Vehicle from Household</h2><p>Recurring context suggests a more durable boundary. This proposal cannot apply without approval.</p></div><span class="confidence-badge">11 signals</span></div>
    ${packetSection('structure', 'Proposed structural changes', '4 changes', '<ol class="change-list"><li>Create Vehicle as an Area.</li><li>Bind a new Vehicle Note Folder and Primary Session.</li><li>Move 7 Notes from Household.</li><li>Link 4 authoritative conversation transcripts to Vehicle.</li></ol>', true)}
    ${packetSection('evidence', 'Why this was suggested', '7 Notes and 4 conversations', '<p>Vehicle maintenance is recurring, independently useful context rather than a temporary Household topic. The suggestion is based on topic recurrence and retrieval ambiguity, not message volume alone.</p>')}
    ${packetSection('consequences', 'Consequences & rollback', 'What changes and what does not', '<p>Notes move between authoritative folders. Conversation transcripts are not rewritten. Compact Space context is regenerated. Existing backups remain the initial recovery path.</p>')}
    <div class="decision-radio"><fieldset><legend>Your decision</legend><label><input type="radio" name="packet-decision" value="move" ${state.gardenChoice === 'move' ? 'checked' : ''}>Approve this structure</label><label><input type="radio" name="packet-decision" value="adjust" ${state.gardenChoice === 'adjust' ? 'checked' : ''}>Send back with adjustments</label><label><input type="radio" name="packet-decision" value="keep" ${state.gardenChoice === 'keep' ? 'checked' : ''}>Keep Household as-is</label></fieldset><button class="primary-button" type="button" data-garden="packet">Submit decision</button></div>`;
}

function variantC(scenario) {
  const create = scenario === 'create';
  return `<section class="variant variant-c" aria-label="${create ? 'Compact proposal' : 'Proposal packet'} variant"><div class="packet-layout"><aside class="packet-index"><p class="eyebrow">C · ${create ? 'Compact proposal' : 'Proposal packet'}</p><h2>${create ? 'Quick confirmation' : 'Decision brief'}</h2><p>${create ? 'Two essentials with optional detail.' : 'Prepared by OpenClaw for explicit review.'}</p><div class="packet-progress">${create ? `<span class="complete">${icon('check')}Defaults ready</span><span>${icon('arrow')}Name & category</span>` : `<span class="complete">${icon('check')}Evidence gathered</span><span class="complete">${icon('check')}Sources checked</span><span>${icon('arrow')}Your decision</span>`}</div><button class="secondary-button full" type="button">Ask OpenClaw</button></aside><article class="proposal-packet">${proposalPacket(scenario)}</article></div></section>`;
}

function statusBanner(scenario) {
  let message = '';
  if (scenario === 'create' && state.createStatus === 'created') message = 'Space plan accepted. Creation is represented only in this in-memory prototype.';
  if (scenario === 'migrate' && state.migrationStatus === 'running') message = 'Text import started. The prototype will keep the manifest visible until verification.';
  if (scenario === 'garden' && state.gardenStatus !== 'pending') message = state.gardenStatus === 'approved' ? 'Gardening proposal approved. Structural work would now run and report to Activity.' : 'Gardening proposal declined. Household remains unchanged.';
  return message ? `<div class="status-banner" role="status">${icon('check')}<span>${message}</span></div>` : '';
}

function render() {
  const route = currentRoute();
  const content = route.scenario === 'create' && route.view === 'spaces'
    ? spacesLanding()
    : route.variant === 'A' ? variantA(route.scenario) : route.variant === 'B' ? variantB(route.scenario) : variantC(route.scenario);
  document.querySelector('#app').innerHTML = shell(`${statusBanner(route.scenario)}${content}`, route);
  bindEvents(route);
}

function announce(message) {
  document.querySelector('#announcer').textContent = message;
}

function bindEvents(route) {
  document.querySelectorAll('[data-scenario]').forEach((button) => button.addEventListener('click', () => updateRoute({ scenario: button.dataset.scenario, view: button.dataset.scenario === 'create' ? 'spaces' : 'flow' })));
  document.querySelector('[data-start-create]')?.addEventListener('click', () => updateRoute({ view: 'new' }));
  document.querySelector('[data-back-spaces]')?.addEventListener('click', () => updateRoute({ view: 'spaces' }));
  document.querySelectorAll('[data-open-space]').forEach((button) => button.addEventListener('click', () => {
    state.openedSpace = button.dataset.openSpace;
    announce(`${state.openedSpace} selected.`);
    render();
  }));
  document.querySelector('[data-open-selected]')?.addEventListener('click', () => {
    state.openedSpace = document.querySelector('[data-space-select]')?.value || 'Space';
    announce(`${state.openedSpace} selected.`);
    render();
  });
  document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
    state.category = button.dataset.category;
    announce(`${state.category} selected as PARA Category.`);
    render();
  }));
  document.querySelectorAll('[data-create]').forEach((button) => button.addEventListener('click', () => {
    const nameInput = document.querySelector('[data-space-name]');
    const enteredName = nameInput?.value.trim();
    if (!enteredName) {
      const error = document.querySelector('[data-name-error]');
      if (error) error.hidden = false;
      announce('Enter a Space name before creating the Space.');
      return;
    }
    state.spaceName = enteredName;
    if (!state.category) {
      const error = document.querySelector('[data-category-error]');
      if (error) { error.hidden = false; error.focus?.(); }
      announce('Choose a PARA Category before creating the Space.');
      return;
    }
    state.createStatus = 'created';
    state.createdSpace = { name: state.spaceName, category: state.category };
    announce('Space plan accepted in the prototype.');
    updateRoute({ view: 'spaces' });
  }));
  document.querySelectorAll('[data-import]').forEach((button) => button.addEventListener('click', () => {
    state.migrationStatus = 'running';
    announce('Text import started in the prototype.');
    render();
  }));
  document.querySelectorAll('[data-garden]').forEach((button) => button.addEventListener('click', () => {
    const choice = button.dataset.garden === 'packet' ? state.gardenChoice : button.dataset.garden;
    state.gardenStatus = choice === 'move' ? 'approved' : 'declined';
    announce(state.gardenStatus === 'approved' ? 'Gardening proposal approved.' : 'Gardening proposal declined.');
    render();
  }));
  document.querySelectorAll('input[name="packet-decision"]').forEach((input) => input.addEventListener('change', () => { state.gardenChoice = input.value; }));
  document.querySelectorAll('[data-packet]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.packet;
    state.packetSections.has(id) ? state.packetSections.delete(id) : state.packetSections.add(id);
    render();
  }));
  document.querySelectorAll('[data-cycle]').forEach((button) => button.addEventListener('click', () => cycleVariant(Number(button.dataset.cycle))));
  document.querySelector('[data-reset]')?.addEventListener('click', () => {
    state.spaceName = 'Garden'; state.category = null; state.createdSpace = null; state.openedSpace = null; state.createStatus = 'draft'; state.migrationStatus = 'ready'; state.gardenStatus = 'pending'; state.gardenChoice = 'move'; state.packetSections = new Set(['structure']); render(); announce('Fictional prototype state reset.');
  });
}

function cycleVariant(direction) {
  const route = currentRoute();
  const keys = Object.keys(variants);
  const index = keys.indexOf(route.variant);
  updateRoute({ variant: keys[(index + direction + keys.length) % keys.length] });
}

window.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  if (event.target.matches('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  cycleVariant(event.key === 'ArrowRight' ? 1 : -1);
});

window.addEventListener('popstate', render);
render();
