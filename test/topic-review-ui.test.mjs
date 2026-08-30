import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { chromium } from 'playwright';
import { createTopicAnalysisActionsHttpHandler, createTopicAnalysisReadHttpHandler } from '../src/topics/analysis-http.mjs';

const index = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');

function makeResponse() {
  return { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } };
}

async function invoke(handler, { method = 'GET', body, headers = {} } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method, headers });
  const response = makeResponse();
  await handler(request, response);
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test('Topic Review HTTP contracts are closed, POST-only, revision-aware, and read-only GET has no initialization side effect', async () => {
  let peeked = 0;
  let initialized = 0;
  const calls = [];
  const service = {
    topicAnalysisSchedule: {
      peekSettings() { peeked += 1; return { schemaVersion: 1, enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1, nextDueAt: '2026-08-31T07:00:00.000Z' }; },
      getSettings() { initialized += 1; throw new Error('GET must not initialize schedule state.'); },
      update(input) { calls.push(['schedule.update', input]); return { settings: input.settings }; }
    },
    topicAnalysisRunner: { metadata: { listTopicAnalysisRuns: () => [] }, run(input) { calls.push(['analysis.run', input]); return { outcome: 'success' }; } },
    topicReview: {
      get() { return { reviewId: 'topic-review:global', episodeRevision: 2, state: 'Active', groups: [], proposals: [], notification: false }; },
      decide(input) { calls.push(['decision', input]); return { proposal: { proposalId: input.proposalId } }; },
      snooze(input) { calls.push(['snooze', input]); return { state: 'Snoozed' }; },
      checkpoint(input) { calls.push(['checkpoint', input]); return { applicationId: input.applicationId, planRevision: 'plan-fictional' }; },
      apply(input) { calls.push(['apply', input]); return { status: 'applied' }; }
    }
  };
  const read = await invoke(createTopicAnalysisReadHttpHandler(service));
  assert.equal(read.statusCode, 200); assert.equal(peeked, 1); assert.equal(initialized, 0); assert.equal(read.body.review.notification, false);
  assert.equal((await invoke(createTopicAnalysisReadHttpHandler(service), { method: 'POST' })).statusCode, 405);
  const uuid = '71111111-1111-4111-8111-111111111111';
  assert.equal((await invoke(createTopicAnalysisActionsHttpHandler(service), { method: 'POST', body: { schemaVersion: 1, action: 'analysis.run', logicalOperationId: uuid, trigger: 'manual', extra: true }, headers: { 'content-type': 'application/json' } })).statusCode, 400);
  assert.equal((await invoke(createTopicAnalysisActionsHttpHandler(service), { method: 'POST', body: { schemaVersion: 1, action: 'analysis.run', logicalOperationId: uuid, trigger: 'manual' }, headers: { 'content-type': 'application/json' } })).statusCode, 200);
  assert.equal((await invoke(createTopicAnalysisActionsHttpHandler(service), { method: 'POST', body: { schemaVersion: 1, action: 'review.snooze', logicalOperationId: uuid, reviewId: 'topic-review:global', expectedReviewRevision: 2, snoozedUntil: '2026-08-31T07:00:00.000Z' }, headers: { 'content-type': 'application/json' } })).statusCode, 200);
  assert.equal((await invoke(createTopicAnalysisActionsHttpHandler(service), { method: 'POST', body: { schemaVersion: 1, action: 'review.apply', logicalOperationId: uuid, reviewId: 'topic-review:global', applicationId: 'application-fictional', confirm: false }, headers: { 'content-type': 'application/json' } })).statusCode, 200);
  assert.deepEqual(calls.map(([name]) => name), ['analysis.run', 'snooze', 'checkpoint']);
});

test('Topic Review UI exposes schedule, evidence/consequences, independent decisions, snooze, and final Apply confirmation', () => {
  for (const id of ['topic-analysis-schedule', 'analysis-enabled', 'analysis-weekday', 'analysis-local-time', 'analysis-time-zone', 'analysis-run', 'topic-review-groups', 'topic-review-snooze', 'topic-review-checkpoint']) assert.match(index, new RegExp(`id="${id}"`, 'u'));
  for (const label of ['Save analysis schedule', 'Run analysis now', 'Topic Review', 'Snooze Topic Review', 'Prepare Apply approved changes']) assert.match(index, new RegExp(label, 'u'));
  for (const token of ['proposal.approve', 'proposal.adjust', 'proposal.keep-as-is', 'review.snooze', 'review.apply', 'evidenceFacts', 'searchRetrievalConsequences', 'Rationale', 'Exact before state', 'Affected Source identities', 'Provenance', 'Blocked outcomes', 'Reversibility and irreversible outcomes', 'Frozen application plan', 'exactEffects', 'preconditions', 'compensationDisclosures', 'confirm: false', 'confirm: true']) assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(app, /notification(?:Emitter|Preview|Slot)|announce|pushReview/u);
});

test('Topic Review controls render and send independent decisions without notification output', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const document = index
      .replace('<link rel="stylesheet" href="/plugins/command-center/styles.css">', '<style></style>')
      .replace('<script defer src="/plugins/command-center/app.js"></script>', '');
    await page.setContent(document);
    await page.evaluate(() => {
      const proposal = { proposalId: 'proposal-fictional', revision: 1, operation: 'archive', affectedTopicIds: ['topic-fictional'], affectedSourceIds: ['source-fictional'], plannedSourceIds: [], before: { topicId: 'topic-fictional', paraCategory: 'project', revision: 1 }, after: { topicId: 'topic-fictional', paraCategory: 'archive', revision: 2 }, rationale: 'The fictional source explicitly requires archival.', evidenceFacts: [{ sourceId: 'source-fictional', sourceRevision: 'source-r1', fact: 'A fictional source records an explicit archive boundary.' }], provenance: { source: 'fictional-ui-provider', observedAt: '2026-08-24T07:00:00.000Z' }, searchRetrievalConsequences: { archive: 'History remains retained and searchable.' }, blockers: [], reversibility: { reversible: true, irreversible: false, ambiguity: null }, state: 'pending' };
      let operationSequence = 0;
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: () => `71111111-1111-4111-8111-${String(++operationSequence).padStart(12, '0')}` });
      globalThis.__topicReviewCalls = [];
      globalThis.__topicReviewApproved = false;
      globalThis.prompt = () => JSON.stringify({ paraCategory: 'area' });
      globalThis.confirm = () => { globalThis.__visiblePlanAtConfirmation = document.querySelector('#topic-review-plan').textContent; return true; };
      globalThis.fetch = async (url, options = {}) => {
        if (url.startsWith('/plugins/command-center/api/dashboard')) return { ok: true, async json() { return { status: 'ok', result: { attention: [], attentionBadgeCount: 0, inProgress: [], comingUp: [], topics: [], activity: { records: [], hasMore: false }, notificationSettings: null } }; } };
        if (url.endsWith('/api/topic-analysis') && options.method !== 'POST') return { ok: true, async json() { const current = globalThis.__topicReviewApproved ? { ...proposal, state: 'approved' } : proposal; return { status: 'ok', result: { schedule: { enabled: true, weekday: 1, localTime: '07:00', timeZone: 'UTC', revision: 1 }, runs: [], review: { reviewId: 'topic-review:global', episodeRevision: 1, state: 'Active', notification: false, groups: [{ topicId: 'topic-fictional', operation: 'archive', proposals: [current] }], proposals: [current] } } }; } };
        if (url.endsWith('/api/topics/actions')) return { ok: true, async json() { return { status: 'ok', result: { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] } }; } };
        if (url.endsWith('/api/topic-analysis/actions')) { const input = JSON.parse(options.body); globalThis.__topicReviewCalls.push(input); if (input.action === 'proposal.approve') globalThis.__topicReviewApproved = true; return { ok: true, async json() { return { status: 'ok', result: input.action === 'review.apply' && input.confirm !== true ? { applicationId: 'application-fictional', planRevision: 'plan-fictional', reviewRevision: 1, currentProposalRevisions: [{ proposalId: 'proposal-fictional', revision: 1 }], dependencies: { 'proposal-fictional': [] }, effects: [{ kind: 'archive', structuralChangeId: 'change-fictional' }], blockers: [], steps: [{ proposalId: 'proposal-fictional', preconditions: { topicRevisions: [{ topicId: 'topic-fictional', revision: 1 }] }, compensation: { eligible: true }, intent: { authoritativePreview: { kind: 'archive', reversibility: { irreversible: false } } } }] } : { outcome: 'applied' } }; } }; }
        return { ok: true, async json() { return { status: 'ok', result: { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] } }; } };
      };
      window.addEventListener('message', (event) => { const payload = event.data?.payload; if (payload?.type === 'openclaw:capability-bridge-hello') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-ready', methods: ['command-center.v1.topics.list', 'command-center.v1.topics.get', 'command-center.v1.sessions.browse', 'command-center.v1.sessions.history', 'command-center.v1.sessions.navigate', 'command-center.v1.notes.browse', 'command-center.v1.notes.read', 'command-center.v1.search.query', 'ui.session.navigate'] } }, '*'); if (payload?.type === 'openclaw:capability-bridge-request') window.postMessage({ type: 'openclaw:capability-bridge-receive', protocolVersion: 1, payload: { type: 'openclaw:capability-bridge-response', requestId: payload.requestId, result: { result: { activeGroups: { project: [], area: [], resource: [] }, provisioning: [], recovery: [], archived: [], retired: [] } } } }, '*'); });
    });
    await page.addScriptTag({ content: app });
    await page.getByText('archive · 1 inspectable facts · pending').waitFor();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Prepare Apply approved changes' }).waitFor();
    await page.getByRole('button', { name: 'Prepare Apply approved changes' }).click();
    await page.waitForFunction(() => globalThis.__topicReviewCalls.some((input) => input.action === 'review.apply' && input.confirm === true));
    const actions = await page.evaluate(() => globalThis.__topicReviewCalls.map((input) => input.action));
    assert.deepEqual(actions.slice(0, 2), ['proposal.approve', 'review.apply']);
    assert.equal(actions.at(-1), 'review.apply');
    const checkpoint = await page.evaluate(() => globalThis.__topicReviewCalls.find((input) => input.action === 'review.apply' && input.confirm === false));
    assert.equal(checkpoint.expectedReviewRevision, 1); assert.deepEqual(checkpoint.approvedProposalRevisions, [{ proposalId: 'proposal-fictional', revision: 1 }]);
    const visiblePlan = await page.evaluate(() => globalThis.__visiblePlanAtConfirmation);
    assert.match(visiblePlan, /change-fictional/u); assert.match(visiblePlan, /topicRevisions/u); assert.match(visiblePlan, /compensationDisclosures/u);
  } finally { await browser.close(); }
});
