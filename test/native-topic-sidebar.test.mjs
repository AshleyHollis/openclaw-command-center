import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('native Topic sidebar projects exact links, General and the loaded unassigned Conversation catalog', { timeout: 30_000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><style>#scroll{height:260px;width:360px;overflow:auto}</style><div id="scroll"><main id="mount"></main></div><input aria-label="Outside composer">'); return; }
    if (!/^\/[a-z-]+\.mjs$/u.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { default: plugin } = await import('/entry.mjs');
      const lifetime = new AbortController(); window.calls = []; window.opened = [];
      const host = {
        signal: lifetime.signal, connection: { connected: true, canRead: true, canWrite: true }, redact: text => text,
        sessions: { openChat: value => { window.opened.push(value); if (window.remountOnOpen) window.remountSidebar(value.sessionKey); },
          openFiles: value => { window.filesOpened = value; window.opened.push(value); if (window.remountOnOpen) window.remountSidebar(value.sessionKey); } },
        ui: {
          registerReplacement: spec => { if (spec.id === 'topic-sidebar') window.mountSidebar = spec.mount; return () => {}; },
          selectReplacement() {}, registerPage: () => () => {}, registerNavigation: () => () => {}
        },
        navigation: { openPage: value => window.calls.push(['page', value]) },
        request: async (method, params) => {
          window.calls.push([method, params]);
          if (method.endsWith('topics.list')) return { result: { activeGroups: { project: [{ topicId: 'topic-project', name: 'Fictional Project', paraCategory: 'project', lifecycle: 'active', usable: true, revision: 4 }], area: [], resource: [] } } };
          if (method.endsWith('sessions.browse')) return { result: { topicId: 'topic-project', conversations: [{ referenceId: 'primary-ref', sessionId: 'primary-id', isPrimary: true, status: 'open', displayName: 'Primary Conversation' }, { referenceId: 'linked-ref', sessionId: 'linked-id', isPrimary: false, status: 'open', displayName: 'Linked Conversation' }] } };
          if (method.endsWith('histories.list')) {
            if (window.historyUnavailable) throw new Error('The requested authoritative source capability is unavailable.');
            return { result: { histories: [{ topicId: 'topic-project', historyId: 'a'.repeat(64), title: 'Imported history', readOnly: true }] } };
          }
          if (method.endsWith('sessions.topic-context')) { if (window.failedMembership === params.sessionKey) throw new Error('membership unavailable'); return { result: { schemaVersion: 1, status: 'unbound', sessionKey: params.sessionKey } }; }
          if (method.endsWith('sessions.resolve-native')) return { result: { sessionKey: 'agent:main:primary' } };
          if (method.endsWith('sessions.assign-topic')) return { result: { schemaVersion: 1, status: 'applied', logicalOperationId: params.sessionKey === 'agent:main:inbox' ? 'wrong-operation' : params.logicalOperationId, topicId: 'topic-project', referenceId: `conversation-assignment:${params.logicalOperationId}`, sessionKey: params.sessionKey, sessionId: params.expectedSessionId, topicRevision: 5 } };
          throw new Error(`unexpected ${method}`);
        }
      };
      window.deactivate = plugin.activate(host);
      let viewLifetime = new AbortController();
      let context;
      context = { host, signal: viewLifetime.signal, presented: true, props: {
        sessionKey: 'agent:main:inbox', mainSessionKey: 'agent:main:main', nativeSessionsHaveMore: true,
        sessions: [{ key: 'agent:main:inbox', sessionId: 'inbox-id', updatedAt: 17, displayName: 'Inbox one' }, { key: 'agent:main:inbox-two', sessionId: 'inbox-two-id', updatedAt: 18, displayName: 'Inbox two' }, { key: 'agent:main:failed', sessionId: 'failed-id', updatedAt: 19, status: 'failed', displayName: 'Terminal failed conversation' }],
        async loadMoreNativeSessions() { context = { ...context, props: { ...context.props, nativeSessionsHaveMore: false, sessions: [...context.props.sessions, { key: 'agent:main:inbox-three', sessionId: 'inbox-three-id', updatedAt: 19, displayName: 'Inbox three' }] } }; window.sidebar.update(context); }
      }, mountDefault: element => { element.textContent = 'Native conversation fallback'; return () => element.replaceChildren(); } };
      window.sidebar = window.mountSidebar(document.querySelector('#mount'), context);
      window.remountSidebar = sessionKey => {
        viewLifetime.abort(); window.sidebar.dispose(); viewLifetime = new AbortController();
        context = { ...context, signal: viewLifetime.signal, props: { ...context.props, sessionKey } };
        window.sidebar = window.mountSidebar(document.querySelector('#mount'), context);
      };
      window.reactivateSidebar = () => {
        viewLifetime.abort(); window.sidebar.dispose(); window.deactivate(); window.deactivate = plugin.activate(host);
        viewLifetime = new AbortController(); context = { ...context, signal: viewLifetime.signal };
        window.sidebar = window.mountSidebar(document.querySelector('#mount'), context);
      };
      window.updateWithSemanticallyIdenticalSessions = () => window.sidebar.update({ ...context, props: {
        ...context.props, sessions: context.props.sessions.map(row => ({ ...row }))
      } });
      window.updateWithCurrentInbox = () => { context = { ...context, props: { ...context.props, sessions: context.props.sessions.map(row => row.key === 'agent:main:inbox' ? { ...row, sessionId: 'inbox-id-current', updatedAt: 20, displayName: 'Inbox refreshed' } : row) } }; window.sidebar.update(context); };
      window.closeSidebar = () => { lifetime.abort(); window.sidebar.dispose(); window.deactivate(); };
    });
    assert.equal(
      await page.getByRole('button', { name: 'Manage Topics', exact: true }).count(),
      0,
      'the native host navigation owns the single Manage Topics action',
    );
    const projects = page.getByRole('button', { name: 'Projects', exact: true });
    assert.equal(await projects.getAttribute('aria-expanded'), 'false', 'fresh activation keeps PARA children collapsed');
    await page.getByRole('button', { name: 'Expand all Topics', exact: true }).click();
    assert.equal(await projects.getAttribute('aria-expanded'), 'true', 'Expand all opens only the Topic projection');
    await page.getByRole('button', { name: 'Collapse all Topics', exact: true }).click();
    assert.equal(await projects.getAttribute('aria-expanded'), 'false', 'Collapse all restores the collapsed Topic projection');
    await projects.click();
    assert.equal(await projects.getAttribute('aria-expanded'), 'true');
    await page.waitForTimeout(300);
    assert.match(await page.locator('#mount').innerText(), /Fictional Project/);
    const project = page.getByRole('button', { name: 'Fictional Project', exact: true });
    const projectToggle = page.locator('[data-topic-control-key="toggle:topic-project"]');
    await project.waitFor();
    const inbox = page.getByRole('button', { name: 'Inbox / Unassigned (2)', exact: true });
    assert.equal(await inbox.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('button', { name: 'Assign to Topic', exact: true }).first().isVisible(), false);
    await inbox.press('Enter');
    assert.equal(await inbox.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Assign to Topic', exact: true }).first().isVisible(), true);
    await inbox.press('Space');
    assert.equal(await inbox.getAttribute('aria-expanded'), 'false');
    await inbox.press('Enter');
    await projectToggle.click();
    await page.getByRole('button', { name: 'Collapse all Topics', exact: true }).click();
    assert.equal(await projectToggle.getAttribute('aria-expanded'), 'false', 'Collapse all closes every Topic child disclosure');
    await page.getByRole('button', { name: 'Expand all Topics', exact: true }).click();
    assert.equal(await projectToggle.getAttribute('aria-expanded'), 'true', 'Expand all opens every Topic child disclosure');
    const paraBox = await page.getByRole('button', { name: 'Projects', exact: true }).boundingBox();
    const topicBox = await project.boundingBox();
    const conversationBox = await page.getByRole('button', { name: 'Primary Conversation', exact: true }).boundingBox();
    assert.ok(topicBox.x >= paraBox.x + 12, 'Topics are visibly indented under their PARA category');
    assert.ok(conversationBox.x >= topicBox.x + 12, 'Conversations are visibly indented under their Topic');
    assert.equal(await page.getByRole('button', { name: 'Linked Conversation', exact: true }).getAttribute('title'), 'Linked Conversation', 'truncated Conversation labels retain their full hover label');
    assert.equal(await page.getByText('Imported History · read-only', { exact: true }).isVisible(), true, 'history is distinguishable without reading a truncated row suffix');
    for (const name of ['Projects', 'Areas', 'Resources', 'Archives']) {
      const group = page.getByRole('button', { name, exact: true });
      if (await group.getAttribute('aria-expanded') !== 'true') await group.press('Enter');
      assert.equal(await group.getAttribute('aria-expanded'), 'true');
      await group.press('Enter');
      assert.equal(await group.getAttribute('aria-expanded'), 'false');
      const bodyId = await group.getAttribute('aria-controls');
      assert.equal(await page.locator(`#${bodyId}`).isVisible(), false);
      assert.equal(await group.evaluate(el => el === document.activeElement), true);
      await group.press('Space');
      assert.equal(await group.getAttribute('aria-expanded'), 'true');
    }
    await projects.click();
    await page.evaluate(() => { window.historyUnavailable = true; });
    await page.getByRole('button', { name: 'Refresh Topic workspace' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]').textContent === '');
    assert.equal(await projects.getAttribute('aria-expanded'), 'false', 'refresh retains collapsed PARA state');
    await projects.press('Enter');
    await page.getByRole('button', { name: 'Primary Conversation' }).waitFor();
    assert.doesNotMatch(await page.locator('#mount').innerText(), /authoritative source capability is unavailable/i);
    await page.getByText('Imported History is currently unavailable; existing preserved history remains unchanged.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Primary Conversation' }).click();
    await page.waitForFunction(() => window.opened.length === 1);
    assert.deepEqual(await page.evaluate(() => window.opened), [{ sessionKey: 'agent:main:primary', agentId: 'main' }]);
    assert.equal(await page.evaluate(() => window.filesOpened), undefined, 'Conversation controls open Chat without requesting Files');
    assert.equal(await inbox.getAttribute('aria-expanded'), 'true', 'inbox disclosure state survives a refresh');
    await page.getByRole('button', { name: 'Open General' }).click();
    await page.waitForFunction(() => window.opened.length === 2);
    assert.deepEqual(await page.evaluate(() => window.opened[1]), { sessionKey: 'agent:main:main' });
    const primary = page.getByRole('button', { name: 'Primary Conversation', exact: true });
    await primary.focus();
    await page.evaluate(() => window.updateWithSemanticallyIdenticalSessions());
    assert.equal(await primary.evaluate(node => node === document.activeElement && node.isConnected), true, 'A host-cloned but unchanged Session catalog must not recreate the focused Conversation control.');
    assert.equal(await page.getByText('Inbox one', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Terminal failed conversation', { exact: true }).count(), 0, 'terminal native Conversations must not be offered for assignment');
    assert.equal(await page.getByText('Inbox two', { exact: true }).count(), 1);
    await page.getByText('All conversations', { exact: true }).click();
    await page.getByRole('button', { name: 'Load more native Conversations' }).click();
    await page.getByText('Inbox three', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load more native Conversations' }).count(), 0);
    await projects.click();
    await page.evaluate(() => window.updateWithCurrentInbox());
    await page.getByText('Inbox refreshed', { exact: true }).waitFor();
    assert.equal(await projects.getAttribute('aria-expanded'), 'false', 'a changed host roster retains collapsed PARA state');
    await projects.press('Space');
    assert.equal(await primary.isVisible(), true, 'nested Topic expansion survives parent collapse and refreshed rendering');
    await page.getByRole('listitem').filter({ hasText: 'Inbox refreshed' }).getByRole('button', { name: 'Assign to Topic' }).click();
    await page.waitForFunction(() => window.calls.some(([method]) => method.endsWith('sessions.assign-topic')));
    const assignment = await page.evaluate(() => window.calls.find(([method]) => method.endsWith('sessions.assign-topic'))[1]);
    assert.deepEqual(assignment, { schemaVersion: 1, logicalOperationId: assignment.logicalOperationId, topicId: 'topic-project', expectedTopicRevision: 4, sessionKey: 'agent:main:inbox', expectedSessionId: 'inbox-id-current', expectedSessionRevision: '20', expectedMembership: 'unassigned' });
    await page.getByText('The exact Topic assignment did not return an authoritative receipt.', { exact: true }).waitFor();
    await page.evaluate(() => { window.failedMembership = 'agent:main:inbox-two'; });
    await page.getByRole('button', { name: 'Refresh Topic workspace' }).click();
    await page.getByText('1 native Conversation membership check is unavailable; only verified unassigned Conversations appear in Inbox.', { exact: true }).waitFor();
    assert.match(await page.locator('#mount').innerText(), /Native conversation fallback/);
    // The real host aborts/disposes the replacement on a sessionKey change.
    // A props-only update cannot catch this navigation regression.
    await page.getByRole('button', { name: 'Areas', exact: true }).click();
    await primary.focus();
    await page.locator('#scroll').evaluate(el => { el.scrollTop = 150; });
    const beforeScroll = await page.locator('#scroll').evaluate(el => el.scrollTop);
    assert.ok(beforeScroll > 0);
    await page.evaluate(() => { window.remountOnOpen = true; });
    await primary.press('Enter');
    await page.getByText('Inbox refreshed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Areas', exact: true }).getAttribute('aria-expanded'), 'false', 'Conversation navigation retains collapsed PARA groups across the host remount');
    assert.equal(await primary.isVisible(), true, 'the clicked Primary remains inside its expanded Topic after remount');
    assert.equal(await page.getByText('Native conversation fallback', { exact: true }).isVisible(), true, 'native fallback disclosure is retained');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#scroll').evaluate(el => el.scrollTop), beforeScroll, 'Conversation navigation restores the sidebar scroll position');
    assert.equal(await primary.evaluate(el => el === document.activeElement), true, 'keyboard navigation restores its originating sidebar control');
    // Views get fresh authority/catalog data; retained preferences do not keep
    // old catalogs or live callbacks, and they never steal newer user focus.
    await page.evaluate(() => { window.remountSidebar('agent:main:other'); document.querySelector('input').focus(); });
    await primary.waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Outside composer' }).evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => window.reactivateSidebar());
    assert.equal(await projects.getAttribute('aria-expanded'), 'false', 'a new plugin activation starts from the collapsed PARA defaults');
    assert.equal(await primary.isVisible(), false);
    await page.evaluate(() => window.closeSidebar());
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
});
