import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSupportingNoteAnnotation } from '../src/open-loops/supporting-note-annotation.mjs';

const decision = (observationId, facts) => ({ observationId, occurredAt: '2026-09-24T02:00:00.000Z', facts: { rationale: 'Fictional operator decision.', ...facts } });
const annotate = (text, loopId, observation) => prepareSupportingNoteAnnotation({ text, loopId, observation });

test('a paid assertion adds one bounded block without modifying the source Note or its sibling text', () => {
  const original = '# Fictional email\n\n- Pay invoice\n- Reply about access\n';
  const result = annotate(original, 'fictional-payment-loop', decision('paid-decision', { operationKind: 'payment-status', paymentState: 'paid' }));
  assert.equal(result.disposition, 'created');
  assert.ok(result.text.startsWith(original));
  assert.match(result.text, /Payment status: paid \(your assertion; Command Center made no payment\)/u);
  assert.equal(annotate(result.text, 'fictional-payment-loop', decision('paid-decision', { operationKind: 'payment-status', paymentState: 'paid' })).disposition, 'unchanged');
});

test('a later decision replaces only its intact managed block and preserves unrelated edits and a sibling block', () => {
  const initial = annotate('# Fictional email\n', 'fictional-payment-loop', decision('pending', { operationKind: 'payment-status', paymentState: 'payment-pending' })).text;
  const sibling = annotate(initial, 'fictional-reply-loop', decision('defer-reply', { operationKind: 'decision-defer', decision: 'defer', reviewAt: '2026-09-30T00:00:00.000Z' })).text;
  const withUnrelatedEdit = sibling.replace('# Fictional email\n', '# Fictional email\n\nUnrelated Topic detail remains.\n');
  const updated = annotate(withUnrelatedEdit, 'fictional-payment-loop', decision('paid', { operationKind: 'payment-status', paymentState: 'paid' }));
  assert.equal(updated.disposition, 'updated');
  assert.match(updated.text, /Unrelated Topic detail remains/u);
  assert.match(updated.text, /Review deferred until 2026-09-30T00:00:00.000Z/u);
  assert.doesNotMatch(updated.text, /Payment status: payment-pending/u);
  assert.equal((updated.text.match(/Payment status: paid/gu) ?? []).length, 1);
});

test('a user edit inside the managed block or an ambiguous marker stops replacement', () => {
  const generated = annotate('# Fictional email\n', 'fictional-payment-loop', decision('pending', { operationKind: 'payment-status', paymentState: 'payment-pending' })).text;
  assert.throws(() => annotate(generated.replace('Reason:', 'My own Note edit:'), 'fictional-payment-loop', decision('paid', { operationKind: 'payment-status', paymentState: 'paid' })), /edited/u);
  assert.throws(() => annotate(generated + generated, 'fictional-payment-loop', decision('paid', { operationKind: 'payment-status', paymentState: 'paid' })), /ambiguous/u);
  assert.throws(() => annotate(generated.replace(/<!-- \/command-center:open-loop:[^>]+ -->/u, ''), 'fictional-payment-loop', decision('paid', { operationKind: 'payment-status', paymentState: 'paid' })), /ambiguous/u);
});
