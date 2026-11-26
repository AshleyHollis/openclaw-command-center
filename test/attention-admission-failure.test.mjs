import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureAttentionAdmissionFailure, persistAttentionAdmissionFailure } from './support/attention-admission-failure.mjs';
import { redact } from '../src/host-harness.mjs';

const fictionalCredential = ['fictional', 'sensitive', 'fixture', 'value'].join('-');
const diagnostics = () => ({ stdout: redact(`Bearer ${fictionalCredential}`), stderr: '', guard: { attempts: [] } });
const binding = { tenantId: 'fictional-attention', boardId: 'default', cardId: null,
  createIntent: { idempotencyKey: 'fictional-key' }, privateSourceBody: 'must-never-be-retained' };
const card = { id: 'fictional-card', status: 'todo', title: 'must-never-be-retained',
  metadata: { automation: { tenant: binding.tenantId, idempotencyKey: binding.createIntent.idempotencyKey } } };

test('failure observation distinguishes absent reservation, native effect and settled binding without retaining owner rows', async () => {
  for (const [value, cards, phase, count] of [
    [null, [], 'before-binding-reservation', null],
    [binding, [], 'binding-reserved-native-effect-unconfirmed', 0],
    [binding, [card], 'native-card-observed-before-binding-settlement', 1],
    [{ ...binding, cardId: card.id }, [card], 'after-binding-settlement', 1]
  ]) {
    const observation = await captureAttentionAdmissionFailure({ readBinding: () => value, readNativeCards: async () => cards, diagnostics: diagnostics() });
    assert.equal(observation.phase, phase); assert.equal(observation.correlatedCardCount, count);
    assert.doesNotMatch(JSON.stringify(observation), /must-never-be-retained|fictional-sensitive-fixture-value|fictional-key|fictional-card/u);
  }
});

test('failed observations remain unknown and do not retain error messages or infer absence', async () => {
  const failure = () => { throw new Error('private failed observation'); };
  const observation = await captureAttentionAdmissionFailure({ readBinding: failure, readNativeCards: failure, diagnostics: diagnostics() });
  assert.equal(observation.bindingPresent, null); assert.equal(observation.bindingCardIdPresent, null);
  assert.equal(observation.correlatedCardCount, null); assert.equal(observation.nativeRead, 'unavailable');
  assert.equal(observation.phase, 'unknown'); assert.doesNotMatch(JSON.stringify(observation), /private failed/u);
});

test('correlation observation counts exact tenant board and immutable key only, retaining bounded supported statuses', async () => {
  const cards = [card, { ...card, id: 'fictional-duplicate' },
    { ...card, metadata: { automation: { ...card.metadata.automation, tenant: 'another-fictional-tenant' } } },
    { ...card, metadata: { automation: { ...card.metadata.automation, boardId: 'another-fictional-board' } } }];
  const observation = await captureAttentionAdmissionFailure({ readBinding: () => binding, readNativeCards: async () => cards, diagnostics: diagnostics() });
  assert.equal(observation.correlatedCardCount, 2); assert.deepEqual(observation.correlatedStatuses, ['todo', 'todo']);
});

test('persisted failure evidence refreshes drained redacted host output and preserves prior owner observation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fictional-attention-failure-'));
  try {
    const host = diagnostics();
    const observation = await captureAttentionAdmissionFailure({ readBinding: () => binding, readNativeCards: async () => [card], diagnostics: host });
    let drained;
    const outputDrained = new Promise(resolve => { drained = resolve; });
    queueMicrotask(() => {
      host.stderr = redact(`drained shutdown output ${['to', 'ken'].join('')}=${['fictional', 'secret', 'after', 'drain'].join('-')}`);
      drained();
    });
    await persistAttentionAdmissionFailure({ observation, diagnostics: host, outputDrained, evidenceDirectory: directory });
    const retained = JSON.parse(await readFile(path.join(directory, 'attention-admission-failure.json'), 'utf8'));
    assert.equal(retained.phase, observation.phase); assert.equal(retained.correlatedCardCount, 1);
    assert.equal(retained.hostOutputComplete, true);
    assert.match(retained.host.stderr, /drained shutdown output/u);
    assert.doesNotMatch(JSON.stringify(retained), /fictional-secret-after-drain|fictional-sensitive-fixture-value|must-never-be-retained/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed host drain retains owner observations with an explicit incomplete-output flag', async () => {
  const observation = await captureAttentionAdmissionFailure({ readBinding: () => binding, readNativeCards: async () => [card], diagnostics: diagnostics() });
  const retained = await persistAttentionAdmissionFailure({ observation, diagnostics: diagnostics(), outputDrained: Promise.reject(new Error('private drain failure')) });
  assert.equal(retained.hostOutputComplete, false); assert.equal(retained.correlatedCardCount, 1);
  assert.equal(retained.phase, observation.phase); assert.doesNotMatch(JSON.stringify(retained), /private drain failure/u);
});
