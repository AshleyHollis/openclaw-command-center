import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { SessionAdapter } from '../src/sources/sessions.mjs';
import { createConversationPlanSource } from '../src/conversation-plans/source.mjs';
import { readPlanHumanRequests } from '../src/conversation-plans/human-requests.mjs';
import { validateBridgeRequest, sanitizeBridgeResult } from '../src/bridge/contracts.mjs';
import { assertFirstLiveCommand, FIRST_LIVE_FEATURES } from '../src/release-scope.mjs';

function fixture(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fictional-plan-source-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  t.after(() => { metadata.close(); rmSync(stateDir, { recursive: true, force: true }); });
  const topicId = '44444444-4444-4444-8444-444444444444', sessionKey = 'agent:main:fictional-garden';
  metadata.createTopic({ topicId, name: 'Fictional garden', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'fictional-ref', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: '10' }, state: { referenceId: 'fictional-ref', sessionId: 'original', status: 'open', isPrimary: true, displayName: 'Overview' } });
  const entry = { sessionId: 'original', updatedAt: 10 };
  const sessions = new SessionAdapter({ metadata, topicId, sessionStore: { getSessionEntry: () => entry, listSessionEntries: () => [{ sessionKey, entry }] } });
  const sources = { requireTopicService() { return { sessions }; }, forTopic() { return { sessions }; }, getTopicSourceReference(input) { const reference = metadata.getSourceReference(input.referenceId); if (reference.topicId !== input.topicId) throw new Error('Reassigned'); return reference; } };
  let entries = [{ entryId: 'fictional-message', role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Draft the garden plan. Compare costs.' }] } }], allowed = true, locks = 0;
  const source = createConversationPlanSource({ metadata, sources, assertCurrent() { if (!allowed) throw new Error('revoked'); }, readEntries: async () => entries, withTranscriptLock: async (scope, operation) => { locks++; return operation({ target: scope }); } });
  return { source, topicId, referenceId: 'fictional-ref', entry, metadata, replace: value => { entries = value; }, revoke: () => { allowed = false; }, locks: () => locks };
}
test('actual CC Session adapter exposes exact entry identity and catches rewrite/reset/revocation', async t => {
  const f = fixture(t), [message] = await f.source.messages(f);
  assert.equal(message.source.messageId, 'fictional-message'); assert.equal(message.text, 'Draft the garden plan. Compare costs.');
  await assert.rejects(f.source.withSource(message.source, () => assert.fail('Must not create')), error => error.code === 'capability-unavailable'); assert.equal(f.locks(), 0);
  f.replace([{ entryId: 'fictional-message', role: 'assistant', message: { role: 'assistant', content: 'Changed' } }]);
  await assert.rejects(f.source.readSource(message.source), /changed/);
  f.entry.sessionId = 'reset'; assert.throws(() => f.source.inspect(message.source), /reset/);
  f.entry.sessionId = 'original'; f.revoke(); assert.throws(() => f.source.inspect(message.source), /revoked/);
});
test('a different Topic revision fails exact source admission', async t => {
  const f = fixture(t), [message] = await f.source.messages(f);
  message.source.membershipRevision++;
  await assert.rejects(f.source.readSource(message.source), /ownership changed/);
});
test('native question and nested approval requests require exact linked run; generic states remain quiet', async () => {
  const card = { status: 'blocked', sessionKey: 'fictional-session', runId: 'fictional-run' };
  const common = { createdAtMs: 10, expiresAtMs: 100 };
  const nativeRequest = async method => method === 'question.list' ? { questions: [{ ...common, ...card, id: 'q1', status: 'pending' }, { ...common, id: 'unrelated', status: 'pending', sessionKey: card.sessionKey, runId: 'other' }] } : [{ ...common, id: 'a1', approvalKind: 'exec', request: { sessionKey: card.sessionKey, runId: card.runId } }];
  const read = input => readPlanHumanRequests({ card: input, nativeRequest, assertCurrent() {}, now: () => 20 });
  const result = await read(card); assert.deepEqual(result.requests.map(row => row.id), ['q1', 'a1']);
  assert.equal((await read({ ...card, status: 'done' })).eligible, false);
  assert.equal((await read({ ...card, runId: '' })).eligible, false);
  assert.equal((await read({ ...card, runId: 'different' })).eligible, false);
  assert.equal((await readPlanHumanRequests({ card, nativeRequest: async () => { throw new Error('no scope'); }, assertCurrent() {} })).availability, 'unavailable');
});
test('candidate bridge is closed and all plan commands remain disabled', () => {
  assert.equal(FIRST_LIVE_FEATURES.conversationPlans, false);
  const method = 'command-center.v1.conversation-plans.messages';
  validateBridgeRequest(method, { schemaVersion: 1, topicId: 'fictional', referenceId: 'fictional-ref' });
  assert.throws(() => validateBridgeRequest(method, { schemaVersion: 1, topicId: 'fictional', referenceId: 'fictional-ref', dispatch: true }), /Unsupported/);
  for (const name of ['messages', 'list', 'track', 'reconcile']) assert.throws(() => assertFirstLiveCommand('bridge', `command-center.v1.conversation-plans.${name}`));
  const result = sanitizeBridgeResult(method, { messages: [{ source: { topicId: 'fictional', messageId: 'exact', privatePath: 'hidden' }, text: 'Reviewed text', internalIdentity: 'hidden' }] });
  assert.equal(result.messages[0].source.privatePath, undefined); assert.equal(result.messages[0].internalIdentity, undefined);
});
