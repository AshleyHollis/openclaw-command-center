import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

for (const scenario of ['native Chat handoff', 'initial connection', 'reconnection', 'hidden retained view', 'Topic Notes', 'Note pagination', 'Note cancels Chat', 'Old Chat error', 'Notes panel', 'Unbound panel', 'Late panel context', 'Late panel Note', 'Replaced panel Session', 'Group setup']) test(`native Topics: ${scenario}`, { timeout: 30000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional native host</title><main id="mount"></main></html>'); return; }
    // Serve the actual native module directory, including newly added siblings.
    // Keep the fixture boundary to one plain module filename; no traversal.
    if (!/^\/[a-z-]+\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(`../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async (scenario) => {
      const plugin = (await import('/entry.mjs')).default;
      const lifetime = new AbortController();
      window.opened = [];
      window.promoted = 0;
      window.methods = [];
      window.groupCommands = [];
      window.sessionReplaced = false;
      const registrations = new Map();
      const subscribers = new Set();
      let delayedNavigation;
      let view;
      let context;
      const host = {
        apiVersion: 1, pluginId: 'command-center', signal: lifetime.signal,
        connection: { connected: scenario !== 'initial connection', canRead: true, canWrite: true },
        redact: (text) => text,
        subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); },
        sessions: { open: (value) => window.opened.push(value), normalizeKey: (key) => key, refresh: async () => {} },
        navigation: { openPage: (target) => {
          view.dispose();
          context = { ...context, props: target.params };
          view = registrations.get(`page:${target.id}`).mount(document.querySelector('#mount'), context);
        } },
        request: async (method, params) => {
          window.methods.push(method);
          if (method.endsWith('sessions.group-preview')) return { schemaVersion: 1, topicId: 'fictional-topic', name: 'Fictional project', revision: 1, members: [
            { referenceId: 'fixture-ref', sessionId: 'fixture-session', lifecycleRevision: 'fixture-revision', eligible: true },
            { referenceId: 'already-grouped-ref', eligible: false }
          ] };
          if (method.endsWith('sessions.group')) {
            window.groupCommands.push(params);
            return { status: 'applied', logicalOperationId: params.logicalOperationId, value: { topicId: params.topicId, referenceId: params.referenceId, sessionId: params.expectedSessionId, name: params.name } };
          }
          if (method.endsWith('sessions.topic-context')) {
            if (window.sessionReplaced) throw new Error('The native Session was replaced.');
            if (scenario === 'Late panel context' && params.sessionKey === 'agent:fictional:chat') {
              const delayed = Promise.withResolvers(); window.resolveContext = delayed.resolve; await delayed.promise;
            }
            if (scenario === 'Unbound panel' || params.sessionKey === 'agent:fictional:unbound') return { schemaVersion: 1, status: 'unbound', sessionKey: params.sessionKey };
            return { schemaVersion: 1, status: 'bound', sessionKey: params.sessionKey, sessionId: 'fictional-session', topicId: 'fictional-topic', referenceId: 'fictional-reference' };
          }
          if (method.endsWith('sources.status')) return { result: { schemaVersion: 1, mode: 'ready', unavailableCapabilities: [] } };
          if (method.endsWith('topics.get')) return { result: { topic: { topicId: 'fictional-topic', name: 'Fictional project', revision: 1, usable: true, lifecycle: 'active' } } };
          if (method.endsWith('notes.browse')) {
            if (scenario === 'Note pagination') {
              const next = params.offset === 50;
              if (next && params.cursor !== 'fictional-cursor') throw new Error('Pagination lost the authoritative snapshot.');
              return { result: { notes: (next ? ['last.md'] : Array.from({ length: 50 }, (_, index) => `note-${index}.md`)).map((path) => ({ path, revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: `fictional:${path}` } })), total: 51, offset: next ? 50 : 0, nextOffset: next ? null : 50, hasMore: !next, cursor: 'fictional-cursor' } };
            }
            return { result: { notes: [{ path: 'brief.md', revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-note' } }], total: 1, offset: 0, nextOffset: null, hasMore: false, cursor: 'fictional-cursor' } };
          }
          if (method.endsWith('notes.read')) {
            if (['Late panel Note', 'Replaced panel Session'].includes(scenario)) { const delayed = Promise.withResolvers(); window.resolveNote = delayed.resolve; await delayed.promise; }
            const text = '<img src=x onerror=alert(1)>Fictional Note';
            return { result: { path: 'brief.md', revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-note' }, contentEncoding: 'identity', contentBase64: btoa(text), byteOffset: 0, nextOffset: text.length, totalBytes: text.length, complete: true } };
          }
          if (method.endsWith('topics.list')) return { result: { activeGroups: { project: [{ topicId: 'fictional-topic', name: 'Fictional project', usable: true }], area: [], resource: [] } } };
          if (method.endsWith('sessions.browse')) return { result: { topicId: 'fictional-topic', conversations: [{ topicId: 'fictional-topic', referenceId: 'fictional-reference', sessionId: 'fictional-session', isPrimary: true, status: 'open' }] } };
          if (method.endsWith('sessions.navigate')) {
            if (['hidden retained view', 'Note cancels Chat', 'Old Chat error'].includes(scenario)) {
              delayedNavigation = Promise.withResolvers();
              window.resolveNavigation = delayedNavigation.resolve;
              window.rejectNavigation = delayedNavigation.reject;
              await delayedNavigation.promise;
            }
            return { result: { sessionKey: 'agent:fictional:chat', sessionId: 'fictional-session', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-reference' } } };
          }
          throw new Error('Unexpected method');
        },
        ui: {
          registerPanel: (value) => { registrations.set(`panel:${value.id}`, value); return () => registrations.delete(`panel:${value.id}`); },
          registerPage: (value) => { registrations.set(`page:${value.id}`, value); return () => registrations.delete(`page:${value.id}`); },
          registerNavigation: (value) => { registrations.set(`navigation:${value.id}`, value); return () => registrations.delete(`navigation:${value.id}`); }
        }
      };
      window.deactivate = plugin.activate(host);
      window.registrationCount = () => registrations.size;
      const panel = scenario.includes('panel');
      context = { host, signal: lifetime.signal, props: panel ? { sessionKey: 'agent:fictional:chat', agentId: 'fictional' } : {}, presented: true,
        panel: { showInMain: () => window.promoted++ } };
      view = registrations.get(panel ? 'panel:topic-notes' : 'page:topics').mount(document.querySelector('#mount'), context);
      window.selectUnbound = () => { context = { ...context, props: { sessionKey: 'agent:fictional:unbound', agentId: 'fictional' } }; view.update(context); };
      window.setPresented = (presented) => view.update?.({ ...context, presented });
      window.setConnected = (connected) => { host.connection = { ...host.connection, connected }; for (const listener of subscribers) listener(); };
      window.focusNative = () => view.focus?.();
      window.disposeNative = () => { lifetime.abort(); view.dispose(); window.deactivate(); };
    }, scenario);
    if (scenario === 'Group setup') {
      await page.getByRole('button', { name: 'Organize Conversations in native group' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.groupCommands), []);
      await page.getByRole('button', { name: 'Organize Conversations in native group' }).click();
      await page.getByText('1 Conversations organized. 1 left unchanged.', { exact: false }).waitFor();
      const commands = await page.evaluate(() => window.groupCommands);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].referenceId, 'fixture-ref');
      assert.equal(commands[0].expectedLifecycleRevision, 'fixture-revision');
      assert.equal(commands[0].expectedTopicRevision, 1);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario.includes('panel')) {
      if (scenario === 'Replaced panel Session') {
        await page.getByRole('button', { name: 'Read brief.md' }).click();
        await page.waitForFunction(() => window.resolveNote);
        await page.evaluate(() => { window.sessionReplaced = true; window.resolveNote(); });
        await page.getByText('The native Session was replaced.', { exact: false }).waitFor();
        assert.equal(await page.evaluate(() => window.promoted), 0);
        assert.doesNotMatch(await page.getByRole('region', { name: 'Note content' }).innerText(), /Fictional Note/);
        await page.evaluate(() => window.disposeNative());
        return;
      }
      if (scenario === 'Late panel context') {
        await page.waitForFunction(() => window.resolveContext);
        await page.evaluate(() => window.selectUnbound());
        await page.waitForFunction(() => document.body.textContent.includes('not linked to a Topic'));
        await page.evaluate(async () => { window.resolveContext(); await new Promise(resolve => setTimeout(resolve, 0)); });
      } else if (scenario !== 'Unbound panel') {
        await page.getByRole('button', { name: 'Read brief.md' }).click();
        if (scenario === 'Late panel Note') {
          await page.waitForFunction(() => window.resolveNote);
          await page.evaluate(() => window.selectUnbound());
          await page.waitForFunction(() => document.body.textContent.includes('not linked to a Topic'));
          await page.evaluate(async () => { window.resolveNote(); await new Promise(resolve => setTimeout(resolve, 0)); });
        } else {
          await page.waitForFunction(() => window.promoted === 1);
          assert.match(await page.getByRole('region', { name: 'Note content' }).innerText(), /Fictional Note/);
          assert.equal(await page.locator('img').count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).count(), 0);
          await page.evaluate(() => window.focusNative());
          assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Refresh Notes');
        }
      }
      if (scenario !== 'Notes panel') {
        await page.waitForFunction(() => document.body.textContent.includes('not linked to a Topic'));
        assert.equal(await page.evaluate(() => window.promoted), 0);
        assert.equal(await page.getByRole('region', { name: 'Note content' }).count(), 0);
        if (scenario !== 'Late panel Note') assert.equal(await page.evaluate(() => window.methods.some(method => method.endsWith('notes.browse'))), false);
      }
      await page.evaluate(() => window.disposeNative());
      assert.equal(await page.evaluate(() => window.registrationCount()), 0);
      return;
    }
    if (scenario === 'Note cancels Chat' || scenario === 'Old Chat error') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      await page.getByRole('button', { name: 'Open Topic in Chat' }).click();
      await page.waitForFunction(() => window.resolveNavigation);
      if (scenario === 'Note cancels Chat') {
        await page.getByRole('button', { name: 'Read brief.md' }).click();
        await page.waitForFunction(() => document.querySelector('[aria-label="Note content"]')?.textContent.includes('Fictional Note'));
      } else await page.evaluate(() => window.setConnected(false));
      const status = await page.getByRole('status').first().innerText();
      await page.evaluate(async (scenario) => {
        if (scenario === 'Note cancels Chat') window.resolveNavigation();
        else window.rejectNavigation(new Error('Old failed request'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }, scenario);
      assert.deepEqual(await page.evaluate(() => window.opened), []);
      assert.equal(await page.getByRole('status').first().innerText(), status);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Note pagination') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      await page.getByRole('button', { name: 'Read note-0.md' }).waitFor();
      await page.getByRole('button', { name: 'Next Notes' }).click({ timeout: 2000 });
      await page.getByRole('button', { name: 'Read last.md' }).waitFor({ timeout: 2000 });
      assert.equal(await page.getByRole('button', { name: 'Read note-0.md', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Next Notes' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Previous Notes' }).click();
      await page.getByRole('button', { name: 'Read note-0.md', exact: true }).waitFor();
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Topic Notes') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click({ timeout: 2000 });
      await page.getByRole('button', { name: 'Read brief.md' }).click({ timeout: 2000 });
      await page.waitForFunction(() => document.querySelector('[aria-label="Note content"]')?.textContent.includes('Fictional Note'));
      assert.equal(await page.getByRole('region', { name: 'Note content' }).innerText(), '<img src=x onerror=alert(1)>Fictional Note');
      assert.equal(await page.locator('img').count(), 0);
      await page.getByRole('button', { name: 'Open Topic in Chat' }).click();
      await page.waitForFunction(() => window.opened.length === 1);
      await page.evaluate(() => window.disposeNative());
      assert.equal(await page.evaluate(() => window.registrationCount()), 0);
      return;
    }
    const topic = page.getByRole('button', { name: 'Open Fictional project in Chat' });
    if (scenario === 'reconnection') {
      await topic.waitFor();
      await page.evaluate(() => window.setConnected(false));
    }
    if (scenario === 'initial connection' || scenario === 'reconnection') {
      assert.equal(await topic.count(), 0);
      await page.evaluate(() => window.setConnected(true));
    }
    await topic.waitFor({ timeout: 2000 });
    await topic.focus();
    await page.keyboard.press('Enter');
    if (scenario === 'hidden retained view') {
      await page.waitForFunction(() => window.resolveNavigation);
      await page.evaluate(async () => {
        window.setPresented(false);
        window.resolveNavigation();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(await page.evaluate(() => window.opened), []);
      await page.evaluate(() => window.setPresented(true));
      await topic.click();
      await page.evaluate(() => window.resolveNavigation());
    }
    await page.waitForFunction(() => window.opened.length === 1, null, { timeout: 2000 });
    assert.deepEqual(await page.evaluate(() => window.opened), [{ sessionKey: 'agent:fictional:chat', agentId: 'fictional' }]);
    assert.equal(await page.locator('textarea,[contenteditable=true],iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.registrationCount()), 6);
    await page.evaluate(() => window.disposeNative());
    assert.equal(await page.evaluate(() => window.registrationCount()), 0);
    assert.equal(await page.locator('#mount').innerText(), '');
  } finally {
    await browser?.close();
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});
