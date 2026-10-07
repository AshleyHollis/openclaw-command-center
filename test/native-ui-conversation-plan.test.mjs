import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { createConversationPlanOwner } from '../src/conversation-plans/owner.mjs';
import { PLAN_FAMILY, planDigest } from '../src/conversation-plans/contract.mjs';

test('fictional rendered plan uses real CC journal owner, preserves draft/focus and refuses late presentation', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'fictional-plan-browser-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  let card, writes = 0;
  const input = { family: PLAN_FAMILY, logicalOperationId: '00000000-0000-4000-8000-000000000021', source: { topicId: 'fictional-garden', referenceId: 'fictional-conversation', sessionId: 'fictional-session', sessionKey: 'agent:main:fictional-plan', membershipRevision: 1, messageId: 'fictional-message-7', messageDigest: planDigest('Fictional planning message') }, destination: { tenantId: 'fictional-tenant', boardId: 'fictional-board' }, snapshot: { outcome: 'Prepare a reviewed planting plan', steps: ['Draft a planting plan', 'Compare the fictional budget'], completionCriteria: ['Plan and comparison ready for review'] } };
  const owner = createConversationPlanOwner({ metadata, authorize: () => ({ principalId: 'fictional-operator' }), assertSourceCurrent: () => {}, readSource: async source => ({ available: true, source }), nativeRequest: async (method, params, options) => {
    if (method === 'workboard.cards.list') return { cards: card ? [card] : [] };
    assert.equal(method, 'workboard.cards.create'); options.assertCurrent(); writes++;
    card ??= { id: 'fictional-card', title: params.title, notes: params.notes, execution: params.execution, status: 'todo', updatedAt: 100, metadata: { automation: { tenant: params.tenant, boardId: params.boardId, idempotencyKey: params.idempotencyKey } } };
    return { card };
  } });
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Fictional plan review</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:1rem/1.5 system-ui;max-width:70ch;margin:2rem auto;padding:1rem}button{margin:.25rem;padding:.65rem}section{border:1px solid;padding:1rem;overflow-wrap:anywhere}</style><label>Native unsent draft<textarea id="native-draft">Unsent fictional draft</textarea></label><main id="mount"></main></html>'); return; }
    if (req.url === '/conversation-plan.mjs') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../src/native-ui/conversation-plan.mjs', import.meta.url))); return; }
    if (req.url === '/conversation-plan-workspace.mjs') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../src/native-ui/conversation-plan-workspace.mjs', import.meta.url))); return; }
    if (['/track', '/reconcile'].includes(req.url) && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      try { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await owner[req.url.slice(1)](JSON.parse(body)))); }
      catch (error) { res.statusCode = 409; res.end(JSON.stringify({ code: error.code })); } return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); metadata.close(); await rm(stateDir, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async input => {
    const { mountConversationPlan } = await import('/conversation-plan.mjs');
    window.lifetime = new AbortController(); window.opened = [];
    window.fixtureInput = structuredClone(input);
    const owner = Object.fromEntries(['track', 'reconcile'].map(action => [action, async input => {
      const response = await fetch(`/${action}`, { method: 'POST', body: JSON.stringify(input) }); const value = await response.json();
      if (!response.ok) throw Object.assign(new Error('unavailable'), value); return value;
    }]));
    document.querySelector('#native-draft').focus();
    window.component = mountConversationPlan(document.querySelector('#mount'), { input, owner, signal: window.lifetime.signal, openNativeCard: target => window.opened.push(target) });
    input.snapshot.steps[0] = 'Later edited text';
  }, input);
  assert.equal(await page.locator('#native-draft').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByText('Draft a planting plan', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Track this plan' }).click();
  await page.getByRole('status').filter({ hasText: 'Native status: todo' }).waitFor();
  assert.equal(writes, 1); assert.equal(metadata.listConversationPlans().length, 1);
  assert.equal(await page.locator('#native-draft').inputValue(), 'Unsent fictional draft');
  await page.getByRole('button', { name: 'Open native card' }).focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.opened), [{ ...input.destination, cardId: 'fictional-card' }]);
  card.status = 'done'; await page.getByRole('button', { name: 'Check tracking status' }).click();
  await page.getByRole('status').filter({ hasText: 'Native status: done' }).waitFor(); assert.equal(writes, 1);
  await page.evaluate(async input => {
    const { mountConversationPlan } = await import('/conversation-plan.mjs'); window.component.dispose();
    window.late = new AbortController(); window.releaseLate = undefined;
    mountConversationPlan(document.querySelector('#mount'), { input, signal: window.late.signal, owner: { track: () => new Promise(resolve => { window.releaseLate = resolve; }) }, openNativeCard: target => window.opened.push(target) });
  }, input);
  await page.getByRole('button', { name: 'Track this plan' }).click();
  await page.evaluate(() => { window.late.abort(); window.releaseLate({ availability: 'available', card: { id: 'late-card', status: 'review' }, progress: { availability: 'unavailable' } }); });
  assert.equal(await page.getByRole('button', { name: 'Open native card' }).count(), 0);
  assert.equal(await page.locator('#native-draft').inputValue(), 'Unsent fictional draft');
  assert.equal((await page.evaluate(() => window.opened)).length, 1);
  await page.evaluate(async () => {
    const { mountConversationPlanWorkspace } = await import('/conversation-plan-workspace.mjs');
    const input = window.fixtureInput;
    window.workspaceLifetime = new AbortController();
    window.fixtureHost = { connection: { connected: true, canRead: true, canWrite: true }, subscribe(callback) { window.changedAccess = callback; return () => {}; }, sessions: { openChat() { throw new Error('No execution navigation expected'); } },
      async request(method, params) {
        const action = method.split('.').at(-1);
        if (action === 'messages') return { result: { messages: [{ source: input.source, text: 'Draft a planting plan, then compare the budget.' }] } };
        const response = await fetch(`/${action === 'list' ? 'reconcile' : action}`, { method: 'POST', body: JSON.stringify(action === 'list' ? input : params.input) });
        const result = await response.json(); if (!response.ok) throw Object.assign(new Error('failed'), result);
        return { result: action === 'list' ? { rows: [result], coverage: 'tracked-plans-only' } : result };
      } };
    document.querySelector('#native-draft').focus();
    window.workspace = mountConversationPlanWorkspace(document.querySelector('#mount'), { host: window.fixtureHost, signal: window.workspaceLifetime.signal, topicId: input.source.topicId, referenceId: input.source.referenceId });
  });
  await page.getByLabel('Agreed outcome').waitFor();
  assert.equal(await page.locator('#native-draft').evaluate(node => node === document.activeElement), true);
  await page.getByLabel('Agreed outcome').fill(input.snapshot.outcome);
  await page.getByLabel('Exact agreed steps, one per line').fill(input.snapshot.steps.join('\n'));
  await page.getByLabel('Completion criteria, one per line').fill(input.snapshot.completionCriteria.join('\n'));
  await page.getByLabel('Exact Workboard tenant').fill(input.destination.tenantId);
  await page.getByLabel('Exact Workboard board').fill(input.destination.boardId);
  await page.getByRole('button', { name: 'Review this plan' }).click();
  await page.getByRole('button', { name: 'Track this plan' }).click();
  await page.getByRole('status').filter({ hasText: 'Native status: done' }).waitFor();
  assert.equal(writes, 1); assert.equal(await page.locator('#native-draft').inputValue(), 'Unsent fictional draft');
  assert.equal(await page.getByRole('button', { name: 'Open native card' }).count(), 0);
  await page.evaluate(() => { window.fixtureHost.connection.canRead = false; window.changedAccess(); });
  await page.getByText('Conversation plan authority changed. Reopen to review.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Track this plan' }).count(), 0);
});
