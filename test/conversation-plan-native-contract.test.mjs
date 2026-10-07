import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { nativePlanSourceSelection, createNativePlanTranscriptAdapter, assertSameNativePlanProjection } from '../src/conversation-plans/native-source.mjs';
import { nativeWorkboardCardTarget } from '../src/native-ui/conversation-plan.mjs';

test('native selection carries exact versioned public digest/generation and no path or serialized authority', () => {
  const source = { topicId: 'fictional', sessionKey: 'agent:main:fictional', sessionId: 'session', messageId: 'message', nativeAdmission: { generation: 'native-generation', digest: `sha256-public-message-v1:${'a'.repeat(64)}` } };
  assert.deepEqual(nativePlanSourceSelection(source), { agentId: 'main', sessionKey: source.sessionKey, sessionId: 'session', entryId: 'message', generation: 'native-generation', digest: source.nativeAdmission.digest });
  for (const changed of [{ ...source, nativeAdmission: undefined }, { ...source, nativeAdmission: { ...source.nativeAdmission, digest: 'a'.repeat(64) } }, { ...source, nativeAdmission: { ...source.nativeAdmission, path: '/fictional' } }, { ...source, sessionKey: 'agent:foreign:fictional' }]) assert.throws(() => nativePlanSourceSelection(changed), error => error.code === 'capability-unavailable');
  assert.throws(() => createNativePlanTranscriptAdapter({}), error => error.code === 'capability-unavailable');
});

test('declared native card target preserves exact plugin, board, card and tenant', () => {
  assert.deepEqual(nativeWorkboardCardTarget({ boardId: 'fictional.plans', tenantId: 'fictional', cardId: 'card' }), { pluginId: 'workboard', id: 'workboard', path: ['fictional.plans'], params: { cardId: 'card', tenant: 'fictional' } });
  for (const changed of [{ boardId: '__all__', tenantId: 'fictional', cardId: 'card' }, { boardId: 'default', tenantId: '', cardId: 'card' }, { boardId: 'default', tenantId: 'fictional', cardId: '' }]) assert.throws(() => nativeWorkboardCardTarget(changed));
});
test('same-generation same-count branch switch and malformed leaf proof refuse source publication', () => {
  const page = { kind: 'page', generation: 'fictional-rewrite', totalMessages: 2, activeLeafEntryId: 'fictional-leaf', entries: [] };
  assert.doesNotThrow(() => assertSameNativePlanProjection(page, { ...page }));
  for (const changed of [{ ...page, activeLeafEntryId: 'another-leaf' }, { ...page, activeLeafEntryId: undefined }, { ...page, totalMessages: 3 }, { ...page, generation: 'another-rewrite' }, { ...page, kind: 'reset' }]) assert.throws(() => assertSameNativePlanProjection(page, changed), error => error.code === 'unavailable');
});

// Optional installed-pair proof consumes a real built SDK path, never a stub.
// Native admission/IPC/Workboard integration still needs the native owner lane.
test('real built native SDK exposes the exact admission and digest contract', { skip: !process.env.COMMAND_CENTER_NATIVE_PLAN_SDK ? 'Exact native #67 SDK artifact is not available; no fake SDK substituted.' : false }, async () => {
  const sdk = await import(pathToFileURL(process.env.COMMAND_CENTER_NATIVE_PLAN_SDK).href);
  assert.doesNotThrow(() => createNativePlanTranscriptAdapter(sdk));
  const entry = { entryId: 'fictional-message', parentId: null, seq: 1, role: 'assistant', message: { role: 'assistant', content: 'Fictional plan' } };
  assert.match(sdk.createSessionTranscriptVisibleMessageDigest(entry), /^sha256-public-message-v1:[a-f0-9]{64}$/);
  await assert.rejects(sdk.prepareSessionTranscriptSourceAdmission({ agentId: 'main', sessionKey: 'agent:foreign:fictional', sessionId: 'fictional-session', entryId: entry.entryId, generation: 'fictional', digest: sdk.createSessionTranscriptVisibleMessageDigest(entry) }, { assertCurrent() { assert.fail('Foreign source must refuse before native lookup'); } }), /exact agent/);
});
