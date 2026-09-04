import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('mounted approval retries preserve exact intent and block a competing action until reconciled', { skip: !existsSync(chromium.executablePath()) && 'Playwright browser is supplied by the isolated evaluator' }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8'));
    await page.evaluate(() => {
      const episode = { episodeId: 'episode-approval', sourceCapabilityId: 'monitor', stableSubjectId: 'subject-approval', topicId: 'topic-approval', sourceReferenceId: 'source-approval', revision: 1, sourceRevision: 'config-1', context: 'Fictional approval', evidence: {}, actions: [
        { actionId: 'approval.approve', label: 'Approve', target: { approvalId: 'approval-exact', disclosure: { actionId: 'monitor.change', target: { stableSubjectId: 'subject-approval' }, parameters: {}, sideEffects: ['Changes the fictional monitor.'], expiresAt: '2099-01-01T00:00:00Z' } } },
        { actionId: 'approval.reject', label: 'Reject', target: { approvalId: 'approval-exact' } }
      ] };
      window.__actions = [];
      window.__dashboardReads = 0;
      globalThis.fetch = async () => { throw new Error('Dashboard operations must not use HTTP'); };
      window.addEventListener('message', (event) => {
        const payload = event.data?.payload;
        const send = (value) => window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: value }, '*');
        if (payload?.type === 'openclaw:capability-bridge-hello') {
          send({ type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.dashboard.get', 'command-center.v1.attention.act', 'command-center.v1.sources.status', 'command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.sessions.send', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] });
          return;
        }
        if (payload?.type !== 'openclaw:capability-bridge-request') return;
        const response = { type: 'openclaw:capability-bridge-response', requestId: payload.requestId };
        if (payload.method === 'command-center.v1.attention.act') {
          window.__actions.push(payload);
          if (window.__actions.length === 1) send({ ...response, error: { code: 'MUTATION_OUTCOME_UNKNOWN', message: 'Acknowledgement was lost.' } });
          else send({ ...response, result: { status: 'applied', result: { episode: { state: 'Resolved' } } } });
          return;
        }
        let result = {};
        if (payload.method === 'command-center.v1.dashboard.get') {
          window.__dashboardReads += 1;
          result = { serverTime: '2026-09-05T00:00:00Z', attentionBadgeCount: 1, attention: [episode], inProgress: [], comingUp: [], topics: [], activity: { records: [], hasMore: false } };
        } else if (payload.method === 'command-center.v1.sources.status') result = { mode: 'ready', unavailableCapabilities: [] };
        else if (payload.method === 'command-center.v1.topics.list') result = { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] };
        send({ ...response, result: { result } });
      });
    });
    await page.addScriptTag({ content: await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8') });
    await page.getByText('Fictional approval', { exact: true }).waitFor();
    assert.match(await page.locator('.attention-card').innerText(), /Side effects:.*Changes the fictional monitor/u);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Reconcile action', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__actions.length), 1);
    await page.getByRole('button', { name: 'Reconcile action', exact: true }).click();
    await page.waitForFunction(() => window.__actions.length === 2 && window.__dashboardReads === 2);
    const actions = await page.evaluate(() => window.__actions);
    assert.deepEqual(actions[1].params, actions[0].params);
    assert.equal(actions[1].operationId, actions[0].operationId);
    assert.equal(actions[0].params.approvalId, 'approval-exact');
    assert.equal(actions[0].params.sourceCapabilityId, 'monitor');
    assert.equal(actions[0].params.stableSubjectId, 'subject-approval');
    assert.equal(actions[0].params.expectedSourceRevision, 'config-1');
    assert.equal(actions[0].params.actionId, 'approval.approve');
  } finally { await browser.close(); }
});
