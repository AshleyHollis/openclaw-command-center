import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchPinnedChromium } from '../src/browser-setup.mjs';
import { assertKeyboardAccessibility, auditDynamicAccessibilityState } from './support/keyboard-accessibility.mjs';
import { tabTo } from './support/keyboard-navigation.mjs';

async function withUi(run, { query = '' } = {}) {
  const browser = await launchPinnedChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(3000);
    const [html, app, css] = await Promise.all(['index.html', 'app.js', 'styles.css'].map((name) => readFile(new URL(`../src/ui/${name}`, import.meta.url), 'utf8')));
    await page.route('https://keyboard.invalid/**', (route) => route.fulfill({ contentType: 'text/html', body: html.replace('<script defer src="/plugins/command-center/app.js"></script>', '').replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', `<style>${css}</style>`) }));
    await page.goto(`https://keyboard.invalid/${query}`);
    await page.addScriptTag({ content: app });
    await page.evaluate(() => {
      applyOperatingState({ mode: 'ready', unavailableCapabilities: [] });
      window.cards = [{ episodeId: 'fictional-one', topicId: 'fictional-topic', context: 'Fictional reminder', sourceCapabilityId: 'reminders', actions: [], eligibleSnoozeChoices: [] }];
      renderAttentionCards(cards);
    });
    await run(page);
  } finally { await browser.close(); }
}

test('Evidence keyboard audit reaches its target beyond a long Activity focus path', async () => withUi(async (page) => {
  await page.evaluate(() => {
    renderActivity(Array.from({ length: 100 }, (_, index) => ({ activityId: `fictional-${index}`, operationKind: 'fixture', outcome: 'applied', navigation: { verified: true, kind: 'note' } })));
    document.querySelector('#activity .dashboard-action').focus();
  });
  await assertKeyboardAccessibility(page.mainFrame(), page);
}));

test('Evidence close restores the same card after a refresh and its owner after removal', async () => withUi(async (page) => {
  for (const remove of [false, true]) {
    const trigger = page.getByRole('button', { name: 'View evidence', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    await page.evaluate((remove) => renderAttentionCards(remove ? [] : cards), remove);
    await page.keyboard.press('Escape');
    await page.waitForFunction((remove) => document.activeElement === (remove ? document.querySelector('#attention-heading') : document.querySelector('[data-episode-id="fictional-one"] [data-focus-key="View evidence"]')), remove);
  }
}));

test('native command dialogs participate in the modal accessibility audit', async () => withUi(async (page) => {
  await page.evaluate(() => { void askUser('Fictional confirmation'); document.querySelector('#command-dialog').removeAttribute('aria-labelledby'); });
  await assert.rejects(auditDynamicAccessibilityState(page.mainFrame(), page, 1440, 'command confirmation', true), /dialog is not labelled/);
}));

test('an already-focused keyboard target still requires a visible focus indicator', async () => withUi(async (page) => {
  const target = page.getByRole('button', { name: 'View evidence', exact: true });
  await target.focus();
  await target.evaluate((node) => { node.style.setProperty('outline', 'none', 'important'); node.style.setProperty('box-shadow', 'none', 'important'); });
  await assert.rejects(tabTo(target), /visible/);
}));

test('Notes refresh preserves exact row focus and paging transfers focus from disabled controls', async () => withUi(async (page) => {
  await page.evaluate(() => {
    setWorkspaceVisible(true);
    workspace.notes = Array.from({ length: 101 }, (_, index) => ({ path: `fictional-${index}.md`, sourceReference: { referenceId: `fictional-${index}` } }));
    workspace.notesServerPaged = false; workspace.notePage = 0; renderNotes();
  });
  const note = page.locator('.note-tree-item').nth(1);
  await note.focus(); await page.evaluate(() => renderNotes());
  assert.equal(await note.evaluate((node) => document.activeElement === node), true, 'Notes refresh must retain the exact row');
  await page.locator('#note-last').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.closest('#notes-pane') !== null && !document.activeElement.disabled && !document.activeElement.closest('[hidden]')), true, 'last page must not strand focus on a disabled control');
}));

test('Activity refresh preserves exact source action focus', async () => withUi(async (page) => {
  await page.evaluate(() => { window.records = [{ activityId: 'fictional-activity', navigation: { verified: true, kind: 'note' } }]; renderActivity(records); });
  const source = page.locator('#activity button');
  await source.focus(); await page.evaluate(() => renderActivity(records));
  assert.equal(await source.evaluate((node) => document.activeElement === node), true);
}));

test('keyboard traversal is bounded by the travelled path, not the collection size', async () => withUi(async (page) => {
  await page.evaluate(() => {
    renderActivity(Array.from({ length: 300 }, (_, index) => ({ activityId: `fictional-${index}`, navigation: { verified: true, kind: 'note' } })));
    document.querySelector('#activity button').focus();
  });
  await tabTo(page.locator('#activity button').nth(1));
}));

test('a color-only status marker fails the accessibility audit', async () => withUi(async (page) => {
  await page.evaluate(() => {
    const marker = document.createElement('span'); marker.dataset.status = 'error'; marker.style.cssText = 'display:block;width:20px;height:20px;background:red'; document.body.append(marker);
  });
  await assert.rejects(auditDynamicAccessibilityState(page.mainFrame(), page, 1440, 'color-only status', false), /only by color/);
}));

test('command confirmation restores an exact replaced Activity invoker', async () => withUi(async (page) => {
  await page.evaluate(() => {
    window.records = [{ activityId: 'fictional-command', navigation: { verified: true, kind: 'note' } }];
    renderActivity(records); document.querySelector('#activity button').focus(); void askUser('Fictional confirmation'); renderActivity(records);
  });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#activity button').evaluate((node) => node === document.activeElement), true);
}));

test('resolved Review returns focus from hidden checkpoint and Snooze controls', async () => withUi(async (page) => {
  for (const id of ['topic-review-checkpoint', 'topic-review-snooze']) {
    await page.evaluate((id) => {
      renderTopicReview({ state: 'Pending', groups: [], proposals: [{ state: 'approved' }] });
      document.getElementById(id).focus(); renderTopicReview({ state: 'Resolved', groups: [], proposals: [] });
    }, id);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'topic-review-heading');
  }
}));

test('switching to a Topic transfers hidden invoker focus without stealing header focus', async () => withUi(async (page) => {
  await page.getByRole('button', { name: 'View evidence', exact: true }).focus();
  await page.evaluate(() => setWorkspaceVisible(true));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'topic-workspace-heading');
  await page.evaluate(() => { setWorkspaceVisible(false); document.querySelector('#header-topic-selector').focus(); setWorkspaceVisible(true); });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'header-topic-selector');
}));

test('search refresh retains exact result identity, then falls back without stealing other focus', async () => withUi(async (page) => {
  for (const workspaceSearch of [false, true]) {
    await page.evaluate((local) => {
      setWorkspaceVisible(local);
      window.searchId = local ? 'workspace-notes-results' : 'notes-results';
      window.renderResults = local ? renderWorkspaceSearch : renderSearch;
      window.results = [1, 2].map((index) => ({ heading: `Fictional ${index}`, navigation: { kind: 'note', referenceId: `fictional-${index}`, topicId: 'fictional-topic', path: `${index}.md` } }));
      renderResults(searchId, results); document.querySelectorAll(`#${searchId} button`)[1].focus(); renderResults(searchId, [...results].reverse());
    }, workspaceSearch);
    const id = workspaceSearch ? 'workspace-notes-results' : 'notes-results';
    assert.equal(await page.locator(`#${id} button`).first().evaluate((node) => node === document.activeElement), true);
    await page.evaluate(() => renderResults(searchId, []));
    assert.equal(await page.evaluate(() => document.activeElement.id), workspaceSearch ? 'workspace-search-heading' : 'search-heading');
    await page.locator('#header-topic-selector').focus();
    await page.evaluate(() => renderResults(searchId, results));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'header-topic-selector');
  }
}));

test('Notes and Conversations terminal pagination gives focus to their content', async () => withUi(async (page) => {
  await page.evaluate(() => {
    setWorkspaceVisible(true);
    workspace.notes = Array.from({ length: 101 }, (_, i) => ({ path: `fictional-${i}.md`, sourceReference: { referenceId: `fictional-${i}` } }));
    workspace.notesServerPaged = false; workspace.notePage = 0; renderNotes();
    workspace.conversations = Array.from({ length: 101 }, (_, i) => ({ referenceId: `fictional-${i}`, displayName: `Fictional ${i}`, isPrimary: true })); renderConversations();
  });
  await page.locator('#note-last').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'notes-heading');
  await page.evaluate(() => { document.querySelector('#conversation-next').focus(); workspace.conversationPage = 100; renderConversations(); });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'conversations-heading');
}));

test('pending Note dialog retains visible focus and restores the field on failure', async () => withUi(async (page) => {
  await page.evaluate(() => {
    setWorkspaceVisible(true); openNoteDialog('notes.create', document.querySelector('#note-new'));
    document.querySelector('#note-action-submit').focus(); setNoteDialogPending(true);
  });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'note-action-status');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'note-action-status');
  await page.evaluate(() => setNoteDialogPending(false));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'note-action-path');
}));

test('delayed Topic creation does not steal newer focus, but repairs its own pending focus', async () => withUi(async (page) => {
  for (const moveAway of [true, false]) {
    await page.evaluate(() => {
      mutate = () => new Promise((resolve) => { window.finishCreate = resolve; });
      document.querySelector('#topic-create input[name="name"]').value = 'Fictional creation';
    });
    await page.locator('#topic-create-submit').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => typeof window.finishCreate === 'function');
    if (moveAway) await page.locator('#header-topic-selector').focus();
    await page.evaluate(() => { window.finishCreate({}); window.finishCreate = null; });
    await page.waitForFunction(() => !document.querySelector('#topic-create-submit').disabled);
    assert.equal(await page.evaluate(() => document.activeElement.id), moveAway ? 'header-topic-selector' : 'topic-create-submit');
  }
}));

test('Activity load-more repairs terminal focus without stealing a newer selection', async () => withUi(async (page) => {
  for (const moveAway of [false, true]) {
    await page.evaluate(async () => {
      loadTopicAnalysis = async () => {};
      dashboardRead = async () => ({ activity: { records: [], hasMore: true, nextOffset: 50 } });
      await loadDashboard();
      dashboardRead = () => new Promise((resolve) => { window.finishActivity = resolve; });
    });
    await page.locator('#activity-load-more').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => typeof window.finishActivity === 'function');
    if (moveAway) await page.locator('#header-topic-selector').focus();
    await page.evaluate(() => { window.finishActivity({ activity: { records: [], hasMore: false } }); window.finishActivity = null; });
    await page.waitForFunction(() => document.querySelector('#activity-load-more').hidden);
    assert.equal(await page.evaluate(() => document.activeElement.id), moveAway ? 'header-topic-selector' : 'activity-heading');
  }
}));

test('notification deep-link focus is consumed once, not on every refresh', async () => withUi(async (page) => {
  await page.evaluate(() => {
    document.querySelector('[data-episode-id]').dataset.notificationRecord = 'record-fictional'; focusNotificationTarget();
  });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.notificationRecord), 'record-fictional');
  await page.locator('#header-topic-selector').focus();
  await page.evaluate(() => focusNotificationTarget());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'header-topic-selector');
}, { query: '?notification=plugin-detail&destination=attention-card&record=record-fictional' }));

test('keyboard helper rejects a trapped path and disabled target', async () => withUi(async (page) => {
  await page.evaluate(() => {
    document.querySelector('#header-topic-selector').focus();
    document.addEventListener('keydown', (event) => { if (event.key === 'Tab') event.preventDefault(); });
  });
  await assert.rejects(tabTo(page.getByRole('button', { name: 'View evidence', exact: true })), /cycled/);
  await page.evaluate(() => { document.querySelector('[data-focus-key="View evidence"]').disabled = true; });
  await assert.rejects(tabTo(page.getByRole('button', { name: 'View evidence', exact: true })), /absent from the sequential focus order/);
}));

test('all native dialogs have real labels and modal focus, including command confirmation', async () => withUi(async (page) => {
  await page.evaluate(() => { void askUser('Fictional confirmation'); });
  await auditDynamicAccessibilityState(page.mainFrame(), page, 1440, 'command confirmation', true);
  await page.evaluate(() => document.querySelector('#command-dialog').setAttribute('aria-labelledby', 'nonexistent-label'));
  await assert.rejects(auditDynamicAccessibilityState(page.mainFrame(), page, 1440, 'missing dialog label', true), /dialog is not labelled/);
}));

test('refused native Chat resolution must not steal newer focus', async () => withUi(async (page) => {
  await page.evaluate(() => {
    setWorkspaceVisible(true); workspace.topic = { topicId: 'fictional-topic', paraCategory: 'project' };
    workspace.selected = { referenceId: 'fictional-reference', sessionId: 'fictional-session', status: 'open' };
    syncSelectedConversationControls();
    bridgeRequest = () => new Promise((_resolve, reject) => { window.refuseChat = reject; });
  });
  await page.locator('#chat-open').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => typeof window.refuseChat === 'function');
  await page.locator('#notes-refresh').focus();
  await page.evaluate(() => window.refuseChat(new Error('Fictional refusal')));
  await page.waitForFunction(() => document.querySelector('#chat-status').textContent === 'Fictional refusal');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'notes-refresh');
}));

test('Activity pagination admits one request per page and ignores an obsolete response', async () => withUi(async (page) => {
  await page.evaluate(async () => {
    loadTopicAnalysis = async () => {};
    dashboardRead = async () => ({ activity: { records: [], hasMore: true, nextOffset: 50 } }); await loadDashboard();
    window.pageRequests = 0;
    dashboardRead = () => { window.pageRequests += 1; return new Promise((resolve) => { window.finishOldPage = resolve; }); };
  });
  await page.locator('#activity-load-more').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.pageRequests), 1, 'repeated keyboard activation must not duplicate page requests');
  await page.evaluate(async () => {
    dashboardRead = async () => ({ activity: { records: [{ activityId: 'fictional-current' }], hasMore: false } });
    await loadDashboard(); window.finishOldPage({ activity: { records: [{ activityId: 'fictional-obsolete' }], hasMore: true } });
  });
  await page.waitForFunction(() => !document.querySelector('#activity-load-more').hasAttribute('aria-busy'));
  assert.deepEqual(await page.locator('#activity [data-activity-id]').evaluateAll((nodes) => nodes.map((node) => node.dataset.activityId)), ['fictional-current']);
}));

test('keyboard helper rejects an unnamed control on the actual traversal path', async () => withUi(async (page) => {
  await page.evaluate(() => {
    const target = document.querySelector('[data-focus-key="View evidence"]');
    const start = document.createElement('button'); start.textContent = 'Fictional start';
    const unnamed = document.createElement('button'); unnamed.id = 'diagnostic-id-is-not-a-name';
    target.before(start, unnamed); start.focus();
  });
  await assert.rejects(tabTo(page.getByRole('button', { name: 'View evidence', exact: true })), /unnamed/);
}));
