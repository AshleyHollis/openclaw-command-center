import assert from 'node:assert/strict';
import test from 'node:test';
import { registerConversationCaptureHook } from '../src/open-loops/conversation-capture-hook.mjs';
import { normalizeIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';

function harness(enabled = true) {
  const registrations = [];
  const api = { pluginConfig: enabled ? { conversationCapture: { enabled: true } } : {}, on(name, handler, options) { registrations.push({ name, handler, options }); } };
  return { api, registrations };
}

test('conversation capture remains absent until explicitly configured', () => {
  const { api, registrations } = harness(false);
  assert.equal(registerConversationCaptureHook(api), false);
  assert.deepEqual(registrations, []);
});

test('conversation capture contributes only with exact turn tool authority', () => {
  const { api, registrations } = harness();
  assert.equal(registerConversationCaptureHook(api), true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'before_prompt_build');
  assert.deepEqual(registrations[0].options, { requiresToolAuthority: true });
  const denied = registrations[0].handler({}, { runId: 'run-1', toolAuthority: { allows: () => false } });
  assert.equal(denied, undefined);
  let asserted = 0;
  const allowed = registrations[0].handler({}, { runId: 'run-1', inputProvenance: { kind: 'external_user' }, toolAuthority: { allows: () => true, assertActive() { asserted += 1; } } });
  assert.equal(asserted, 1);
  assert.match(allowed.appendContext, /one stable obligationId/u);
  assert.match(allowed.appendContext, /checkpoint "run-1"/u);
  assert.equal(allowed.appendContext.includes('nextExpectedAt'), true);
});

test('conversation capture ignores internal system turns and missing run identity', () => {
  const { api, registrations } = harness();
  registerConversationCaptureHook(api);
  const handler = registrations[0].handler;
  const authority = { allows: () => true, assertActive() { throw new Error('must not be reached'); } };
  assert.equal(handler({}, { runId: 'run-1', inputProvenance: { kind: 'internal_system' }, toolAuthority: authority }), undefined);
  assert.equal(handler({}, { toolAuthority: authority }), undefined);
});

test('on-demand Chat health receipts do not fabricate a schedule', () => {
  const receipt = normalizeIntakeReceipt({ schemaVersion: 1, sourceKind: 'chat', runId: 'run-1', checkpoint: 'run-1', status: 'healthy-empty', observedAt: '2026-09-21T00:00:00.000Z', lastSuccessfulAt: '2026-09-21T00:00:00.000Z', processedCount: 1, actionableCount: 0, noteCount: 0 });
  assert.equal(receipt.nextExpectedAt, undefined);
  assert.throws(() => normalizeIntakeReceipt({ ...receipt, sourceKind: 'email' }), /nextExpectedAt/u);
});
