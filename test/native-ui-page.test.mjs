import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

for (const scenario of ['native Chat handoff', 'initial connection', 'reconnection', 'hidden retained view', 'Topic Notes', 'Note pagination', 'Note snapshot mismatch', 'Note tree filter', 'Note selection superseded', 'Original attachments', 'Evidence deep link', 'Changed evidence deep link', 'Topic Conversations', 'Topic histories', 'Malformed Topic Conversations', 'Note cancels Chat', 'Old Chat error', 'Notes panel', 'Missing panel promotion', 'Unbound panel', 'Late panel context', 'Late panel Note', 'Replaced panel Session', 'Replaced panel document', 'Group setup']) test(`native Topics: ${scenario}`, { timeout: 30000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional native host</title><style>#mount{height:700px;width:900px}</style><main id="mount"></main></html>'); return; }
    // Serve the actual native module directory, including newly added siblings.
    // Keep the fixture boundary to one plain module filename; no traversal.
    const vendor = { '/vendor/markdown-it.mjs': '../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs', '/vendor/purify.es.mjs': '../node_modules/dompurify/dist/purify.es.mjs' }[req.url];
    if (!vendor && !/^\/[a-z-]+\.mjs$/u.test(req.url)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL(vendor ?? `../src/native-ui${req.url}`, import.meta.url))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    let downloadCount = 0;
    page.on('download', () => { downloadCount++; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async (scenario) => {
      const plugin = (await import('/entry.mjs')).default;
      const lifetime = new AbortController();
      window.opened = [];
      window.promoted = 0;
      window.methods = [];
      window.noteBrowseInputs = [];
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
        // Match the public Control UI SDK exactly: native Chat receives only
        // the resolver-authorized Session key and agent id through openChat.
        sessions: { openChat: (value) => window.opened.push(value), normalizeKey: (key) => key, refresh: async () => {} },
        navigation: { openPage: (target) => {
          view.dispose();
          context = { ...context, props: target.params };
          view = registrations.get(`page:${target.id}`).mount(document.querySelector('#mount'), context);
        } },
        request: async (method, params) => {
          window.methods.push(method);
          if (method.endsWith('sessions.group-preview')) return { schemaVersion: 1, topicId: 'fictional-topic', name: 'Fictional project', revision: 1, members: [
            { referenceId: 'fixture-ref', sessionId: 'fixture-session', lifecycleRevision: 'fixture-revision', eligible: true },
            { referenceId: 'already-grouped-ref', eligible: false, grouped: true }
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
          if (method.endsWith('histories.list')) return { result: { histories: scenario === 'Topic histories' ? [{ historyId: 'a'.repeat(64), topicId: 'fictional-topic', title: 'Fictional preserved history', totalMessages: 2, readOnly: true }] : [] } };
          if (method.endsWith('histories.read')) return { result: { historyId: 'a'.repeat(64), title: 'Fictional preserved history', readOnly: true, totalMessages: 2, offset: 0, nextOffset: null, hasMore: false, messages: [
            { messageId: 'event-1', author: 'Fictional author', bot: false, timestamp: '2026-01-01T00:00:00Z', text: 'Preserved message 1', detailsJson: '{}', attachments: [] },
            { messageId: 'event-2', author: 'Fictional author', bot: false, timestamp: '2026-01-01T00:00:00Z', text: 'Preserved message 2', detailsJson: '{}', attachments: [] }
          ] } };
          if (method.endsWith('notes.browse')) {
            window.noteBrowseInputs.push(params);
            if (scenario === 'Note pagination') {
              const next = params.offset === 50;
              if (next && params.cursor !== 'fictional-cursor') throw new Error('Pagination lost the authoritative snapshot.');
              return { result: { notes: (next ? ['last.md'] : Array.from({ length: 50 }, (_, index) => `note-${index}.md`)).map((path) => ({ path, revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: `fictional:${path}` } })), total: 51, offset: next ? 50 : 0, nextOffset: next ? null : 50, hasMore: !next, cursor: 'fictional-cursor' } };
            }
            if (scenario === 'Note snapshot mismatch') {
              const next = params.offset === 50;
              return { result: { notes: (next ? ['last.md'] : Array.from({ length: 50 }, (_, index) => `note-${index}.md`)).map((path) => ({ path, revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: `fictional:${path}` } })), total: 51, offset: next ? 50 : 0, nextOffset: next ? null : 50, hasMore: !next, cursor: next ? 'changed-cursor' : 'fictional-cursor' } };
            }
            if (scenario === 'Note tree filter') return { result: { notes: ['root.md', 'planning/brief.md', 'planning/invoice.md'].map((path) => ({ path, revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: `fictional:${path}` } })), total: 3, offset: 0, nextOffset: null, hasMore: false, cursor: 'fictional-cursor' } };
            if (scenario === 'Note selection superseded') return { result: { notes: ['first.md', 'nested/second.md'].map((path) => ({ path, revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: `fictional:${path}` } })), total: 2, offset: 0, nextOffset: null, hasMore: false, cursor: 'fictional-cursor' } };
            if (['Original attachments', 'Replaced panel document', 'Evidence deep link', 'Changed evidence deep link'].includes(scenario)) return { result: { notes: [{ path: 'Documents/ATO/return.pdf', revision: scenario === 'Changed evidence deep link' ? 'sha256:current-version' : 'sha256:8c39a3fe40d6c8d46260914e943df7d2a921ab4c92b6f48803c867fb854bf1b2', sourceKind: 'document', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-document', sourceKind: 'document' } }], total: 1, offset: 0, nextOffset: null, hasMore: false, cursor: 'fictional-cursor' } };
            return { result: { notes: [{ path: 'brief.md', revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-note' } }], total: 1, offset: 0, nextOffset: null, hasMore: false, cursor: 'fictional-cursor' } };
          }
          if (method.endsWith('notes.read')) {
            if (['Original attachments', 'Replaced panel document', 'Evidence deep link'].includes(scenario)) {
              if (scenario === 'Replaced panel document') { const delayed = Promise.withResolvers(); window.resolveDocumentRead = delayed.resolve; await delayed.promise; }
              const bytes = 'fictional original bytes';
              return { result: { path: 'Documents/ATO/return.pdf', revision: 'sha256:8c39a3fe40d6c8d46260914e943df7d2a921ab4c92b6f48803c867fb854bf1b2', sourceReference: { topicId: 'fictional-topic', referenceId: 'fictional-document' }, contentEncoding: 'identity', contentBase64: btoa(bytes), byteOffset: 0, nextOffset: bytes.length, totalBytes: bytes.length, complete: true } };
            }
            if (['Late panel Note', 'Replaced panel Session'].includes(scenario)) { const delayed = Promise.withResolvers(); window.resolveNote = delayed.resolve; await delayed.promise; }
            if (scenario === 'Note selection superseded' && params.path === 'first.md') { const delayed = Promise.withResolvers(); window.resolveFirstNote = delayed.resolve; await delayed.promise; }
            const path = ['Note tree filter', 'Note selection superseded'].includes(scenario) ? params.path : 'brief.md';
            const referenceId = ['Note tree filter', 'Note selection superseded'].includes(scenario) ? `fictional:${path}` : 'fictional-note';
            const text = path === 'brief.md' ? '<img src=x onerror=alert(1)>Fictional Note' : `Fictional Note ${path}`;
            return { result: { path, revision: 'r1', sourceReference: { topicId: 'fictional-topic', referenceId }, contentEncoding: 'identity', contentBase64: btoa(text), byteOffset: 0, nextOffset: text.length, totalBytes: text.length, complete: true } };
          }
          if (method.endsWith('topics.list')) return { result: { activeGroups: { project: [{ topicId: 'fictional-topic', name: 'Fictional project', usable: true }], area: [], resource: [] } } };
          if (method.endsWith('sessions.browse')) {
            if (scenario === 'Topic Conversations') return { result: { topicId: 'fictional-topic', conversations: [
              { referenceId: 'linked-beta', sessionId: 'linked-beta-session', displayName: 'Beta linked Conversation', isPrimary: false, status: 'open' },
              { referenceId: 'primary-reference', sessionId: 'primary-session', displayName: 'Primary Conversation', isPrimary: true, status: 'open' },
              { referenceId: 'linked-alpha', sessionId: 'linked-alpha-session', displayName: 'Alpha linked Conversation', isPrimary: false, status: 'open' }
            ] } };
            if (scenario === 'Malformed Topic Conversations') return { result: { topicId: 'fictional-topic', conversations: [{ referenceId: 'primary-reference', displayName: 'Primary Conversation', isPrimary: true, status: 'open' }] } };
            return { result: { topicId: 'fictional-topic', conversations: [{ topicId: 'fictional-topic', referenceId: 'fictional-reference', sessionId: 'fictional-session', isPrimary: true, status: 'open' }] } };
          }
          if (method.endsWith('sessions.resolve-native')) {
            if (['hidden retained view', 'Note cancels Chat', 'Old Chat error'].includes(scenario)) {
              delayedNavigation = Promise.withResolvers();
              window.navigationAttempt = (window.navigationAttempt ?? 0) + 1;
              window.resolveNavigation = delayedNavigation.resolve;
              window.rejectNavigation = delayedNavigation.reject;
              await delayedNavigation.promise;
            }
            if (scenario === 'Topic Conversations') {
              const sessionId = params.referenceId === 'primary-reference' ? 'primary-session' : `${params.referenceId}-session`;
              return { result: { sessionKey: `agent:fictional:${params.referenceId}` } };
            }
            return { result: { sessionKey: 'agent:fictional:chat' } };
          }
          throw new Error('Unexpected method');
        },
        ui: {
          registerReplacement: (value) => { registrations.set(`replacement:${value.id}`, value); return () => registrations.delete(`replacement:${value.id}`); },
          selectReplacement: () => {},
          registerPage: (value) => { registrations.set(`page:${value.id}`, value); return () => registrations.delete(`page:${value.id}`); },
          registerNavigation: (value) => { registrations.set(`navigation:${value.id}`, value); return () => registrations.delete(`navigation:${value.id}`); }
        }
      };
      window.deactivate = plugin.activate(host);
      window.registrationCount = () => registrations.size;
      const panel = scenario.includes('panel');
      const evidence = ['Evidence deep link', 'Changed evidence deep link'].includes(scenario);
      context = { host, signal: lifetime.signal, props: panel ? { sessionKey: 'agent:fictional:chat', agentId: 'fictional' } : evidence ? { topicId: 'fictional-topic', sourceReferenceId: 'fictional-document', sourcePath: 'Documents/ATO/return.pdf', evidenceSourceVersion: 'sha256:8c39a3fe40d6c8d46260914e943df7d2a921ab4c92b6f48803c867fb854bf1b2' } : {}, presented: true,
        ...(scenario === 'Missing panel promotion' ? {} : { panel: { showInMain: () => window.promoted++ } }) };
      view = registrations.get(panel ? 'replacement:topic-files' : evidence ? 'page:topic' : 'page:topics').mount(document.querySelector('#mount'), context);
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
      await page.getByText('1 Conversations organized. 1 already grouped and preserved. 0 blocked and left unchanged.', { exact: false }).waitFor();
      const commands = await page.evaluate(() => window.groupCommands);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].referenceId, 'fixture-ref');
      assert.equal(commands[0].expectedLifecycleRevision, 'fixture-revision');
      assert.equal(commands[0].expectedTopicRevision, 1);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Evidence deep link') {
      await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'invalid file signature' }).waitFor({ timeout: 5_000 });
      assert.equal(await page.evaluate(() => window.methods.filter(method => method.endsWith('notes.read')).length), 1);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Changed evidence deep link') {
      await page.getByText('The evidence used source version', { exact: false }).waitFor();
      await page.getByText('It was not opened as the earlier evidence.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => window.methods.some(method => method.endsWith('notes.read'))), false);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario.includes('panel')) {
      if (scenario === 'Replaced panel document') {
        await page.locator('summary').filter({ hasText: 'Documents' }).click();
        await page.locator('summary').filter({ hasText: 'ATO' }).click();
        const attachment = page.getByRole('button', { name: 'View attachment information for Documents/ATO/return.pdf' });
        try { await attachment.waitFor({ timeout: 5_000 }); }
        catch (error) {
          const diagnostic = await page.evaluate(() => ({ text: document.body.innerText, methods: window.methods }));
          throw new Error(`Document panel did not expose its exact attachment: ${JSON.stringify(diagnostic)}`, { cause: error });
        }
        await attachment.click();
        const download = page.getByRole('button', { name: 'Download original attachment' });
        await download.waitFor({ timeout: 5_000 });
        await download.click();
        await page.waitForFunction(() => typeof window.resolveDocumentRead === 'function', undefined, { timeout: 5_000 });
        await page.evaluate(() => { window.sessionReplaced = true; window.resolveDocumentRead(); });
        await page.getByText('The native Session was replaced.', { exact: false }).waitFor();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(downloadCount, 0);
        await page.evaluate(() => window.disposeNative());
        return;
      }
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
        await page.waitForFunction(() => document.body.textContent.includes('No Topic assigned'));
        await page.evaluate(async () => { window.resolveContext(); await new Promise(resolve => setTimeout(resolve, 0)); });
      } else if (scenario !== 'Unbound panel') {
        await page.getByRole('button', { name: 'Read brief.md' }).click({ timeout: 5_000 });
        if (scenario === 'Missing panel promotion') {
          await page.getByText('This OpenClaw host cannot show Topic Notes in the centre pane.', { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => window.promoted), 0);
          assert.match(await page.getByRole('region', { name: 'Note content' }).innerText(), /Fictional Note/);
        } else if (scenario === 'Late panel Note') {
          await page.waitForFunction(() => window.resolveNote);
          await page.evaluate(() => window.selectUnbound());
          await page.waitForFunction(() => document.body.textContent.includes('No Topic assigned'));
          await page.evaluate(async () => { window.resolveNote(); await new Promise(resolve => setTimeout(resolve, 0)); });
        } else {
          await page.waitForFunction(() => window.promoted === 1, undefined, { timeout: 5_000 });
          assert.match(await page.getByRole('region', { name: 'Note content' }).innerText(), /Fictional Note/);
          assert.equal(await page.locator('img').count(), 0);
          await page.getByRole('button', { name: 'Source', exact: true }).click();
          assert.match(await page.getByRole('region', { name: 'Note source' }).innerText(), /<img src=x onerror=alert\(1\)>Fictional Note/);
          await page.getByRole('button', { name: 'Reading', exact: true }).click();
          await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'Fictional Note' }).waitFor();
          assert.match(await page.getByRole('region', { name: 'Note content' }).innerText(), /Fictional Note/);
          assert.equal(await page.getByRole('button', { name: 'Open Topic in Chat' }).count(), 0);
          await page.evaluate(() => window.focusNative());
          assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Refresh Notes');
        }
      }
      if (!['Notes panel', 'Missing panel promotion'].includes(scenario)) {
        await page.waitForFunction(() => document.body.textContent.includes('No Topic assigned'));
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
      await page.getByRole('button', { name: 'Read last.md' }).waitFor({ timeout: 2000 });
      assert.equal(await page.locator('[data-topic-notes] .note-tree-item').count(), 51);
      assert.equal(await page.getByRole('button', { name: 'Next Notes' }).count(), 0);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Note snapshot mismatch') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      await page.getByText('The Note catalogue changed during retrieval; refresh Notes.', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-topic-notes] .note-tree-item').count(), 0);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Note tree filter') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      await page.getByText('planning', { exact: true }).waitFor();
      const filter = page.getByLabel('Filter filenames');
      await filter.fill('invoice');
      await page.getByText('1 of 3 Topic files match “invoice”.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Read planning/invoice.md' }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Read planning/brief.md' }).count(), 0);
      await page.getByRole('button', { name: 'Read planning/invoice.md' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'Fictional Note planning/invoice.md' }).waitFor();
      assert.equal(await page.locator('img').count(), 0);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Note selection superseded') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      // Nested folders intentionally start collapsed. Expand the real tree
      // disclosure before attempting the second selection so this scenario
      // exercises stale-read fencing rather than waiting on a hidden button.
      await page.locator('summary').filter({ hasText: 'nested' }).click();
      await page.getByRole('button', { name: 'Read first.md' }).click();
      await page.waitForFunction(() => Boolean(window.resolveFirstNote));
      await page.getByRole('button', { name: 'Read nested/second.md' }).click();
      await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'Fictional Note nested/second.md' }).waitFor();
      await page.evaluate(async () => { window.resolveFirstNote(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.doesNotMatch(await page.getByRole('region', { name: 'Note content' }).innerText(), /first\.md/u);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Topic Conversations') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      await page.getByRole('button', { name: 'Primary Conversation', exact: true }).waitFor();
      assert.deepEqual(await page.locator('[data-topic-conversations] > li').evaluateAll((rows) => rows.map((row) => row.dataset.referenceId)), ['primary-reference', 'linked-alpha', 'linked-beta']);
      await page.getByRole('button', { name: 'Alpha linked Conversation', exact: true }).click();
      await page.waitForFunction(() => window.opened.length === 1);
      assert.deepEqual(await page.evaluate(() => window.opened), [{ sessionKey: 'agent:fictional:linked-alpha', agentId: 'fictional' }]);
      assert.deepEqual(await page.evaluate(() => window.methods.filter((method) => method.endsWith('sessions.resolve-native'))), ['command-center.v1.sessions.resolve-native']);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Original attachments') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click({ timeout: 5_000 });
      // Nested folders intentionally start collapsed. Exercise the real tree
      // disclosure instead of relying on a forced click through hidden UI.
      await page.locator('summary').filter({ hasText: 'Documents' }).click({ timeout: 5_000 });
      await page.locator('summary').filter({ hasText: 'ATO' }).click({ timeout: 5_000 });
      await page.getByRole('button', { name: 'View attachment information for Documents/ATO/return.pdf' }).click({ timeout: 5_000 });
      // These original bytes intentionally are not a PDF. Preview must fail
      // safely while the exact original download remains available.
      await page.getByRole('region', { name: 'Note content' }).filter({ hasText: 'invalid file signature' }).waitFor({ timeout: 5_000 });
      const download = page.waitForEvent('download', { timeout: 5_000 });
      await page.getByRole('button', { name: 'Download original attachment' }).click();
      assert.equal(await (await download).suggestedFilename(), 'return.pdf');
      await page.getByText('Verified original attachment downloaded', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => window.methods.filter((method) => method.endsWith('notes.read')).length), 2);
      assert.equal(await page.evaluate(() => window.noteBrowseInputs.every((input) => input.includeDocuments === true)), true);
      assert.equal(await page.locator('iframe,img,object,embed').count(), 0);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Topic histories') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      const preservedHistory = page.getByRole('button', { name: 'Fictional preserved history', exact: true });
      await preservedHistory.waitFor({ timeout: 2000 });
      await preservedHistory.click();
      await page.getByRole('heading', { name: 'Fictional preserved history', exact: true }).waitFor();
      assert.equal(await page.getByText('Read-only preserved history. Continue ongoing conversations in native Chat.').count(), 1);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Malformed Topic Conversations') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click();
      await page.getByText('The exact Topic Conversation is unavailable.', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-topic-conversations] > li').count(), 0);
      assert.equal(await page.evaluate(() => window.methods.some((method) => method.endsWith('sessions.resolve-native'))), false);
      await page.evaluate(() => window.disposeNative());
      return;
    }
    if (scenario === 'Topic Notes') {
      await page.getByRole('button', { name: 'View Notes for Fictional project' }).click({ timeout: 2000 });
      assert.equal(await page.evaluate(() => window.methods.some((method) => method.endsWith('metadata.read'))), false);
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
      const cancelledAttempt = await page.evaluate(() => window.navigationAttempt);
      await page.evaluate(async () => {
        window.setPresented(false);
        window.resolveNavigation();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(await page.evaluate(() => window.opened), []);
      await page.evaluate(() => window.setPresented(true));
      await topic.click();
      await page.waitForFunction((cancelledAttempt) => window.navigationAttempt > cancelledAttempt, cancelledAttempt);
      await page.evaluate(() => window.resolveNavigation());
    }
    await page.waitForFunction(() => window.opened.length === 1, null, { timeout: 2000 });
    assert.deepEqual(await page.evaluate(() => window.opened), [{ sessionKey: 'agent:fictional:chat', agentId: 'fictional' }]);
    assert.equal(await page.locator('textarea,[contenteditable=true],iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.registrationCount()), 9);
    await page.evaluate(() => window.disposeNative());
    assert.equal(await page.evaluate(() => window.registrationCount()), 0);
    assert.equal(await page.locator('#mount').innerText(), '');
  } finally {
    await browser?.close();
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});
