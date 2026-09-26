import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClarificationProposalRequest, parseClarificationProposal, runClarificationProposal } from '../src/open-loops/clarification-proposal.mjs';

test('proposal request contains only saved words and one accepted obligation', () => {
  const request = buildClarificationProposalRequest({ status: 'pending', userWords: 'I paid the bill yesterday.',
    acceptedObligation: { obligationId: 'fictional-bill', title: 'Utility bill' },
    source: { sourceExternalId: 'private-provider-id' }, processorVersion: 'v1' });
  assert.deepEqual(request.execution, { mode: 'isolated-agent-runtime', timeoutMs: 30_000 });
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].content.includes('private-provider-id'), false);
  assert.equal(request.messages[0].content.includes('fictional-bill'), true);
});

test('clear proposal preserves exact user evidence and bounded paid assertion', () => {
  const proposal = parseClarificationProposal(JSON.stringify({ outcome: 'clear', paymentState: 'paid',
    evidenceQuote: 'I paid the bill yesterday.' }), 'I paid the bill yesterday.');
  assert.deepEqual(proposal, { outcome: 'clear', paymentState: 'paid', evidenceQuote: 'I paid the bill yesterday.' });
});

test('one isolated tool-free model completion yields only a validated proposal', async () => {
  let calls = 0;
  const proposal = await runClarificationProposal({ context: { status: 'pending', userWords: 'Please review this next Friday.',
    acceptedObligation: { obligationId: 'fictional-task', title: 'Review task' } },
  complete: async request => {
    calls += 1;
    assert.equal(request.execution.mode, 'isolated-agent-runtime');
    assert.equal(Object.hasOwn(request, 'tools'), false);
    return { text: '{"outcome":"ambiguous"}' };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(proposal, { outcome: 'ambiguous' });
});

test('ambiguous proposal cannot carry an action', () => {
  assert.deepEqual(parseClarificationProposal('{"outcome":"ambiguous"}', 'Maybe later'), { outcome: 'ambiguous' });
  assert.throws(() => parseClarificationProposal('{"outcome":"ambiguous","paymentState":"paid"}', 'Maybe later'), { code: 'invalid-proposal' });
});

test('malformed, ungrounded and overbroad responses fail closed', () => {
  const words = 'I paid the bill yesterday.';
  for (const output of ['```json\n{}\n```', '[]', '{"outcome":"clear","paymentState":"paid","evidenceQuote":"paid yesterday"}',
    '{"outcome":"clear","paymentState":"paid","decision":"resolve","evidenceQuote":"I paid the bill yesterday."}',
    '{"outcome":"clear","paymentState":"paid","actorId":"forged","evidenceQuote":"I paid the bill yesterday."}',
    '{"outcome":"clear","decision":"defer","evidenceQuote":"I paid the bill yesterday."}']) {
    assert.throws(() => parseClarificationProposal(output, words), { code: 'invalid-proposal' });
  }
});

test('a negated or hypothetical paid phrase stays for review even if the model selects a positive substring', () => {
  for (const words of ['I paid the bill, but the bank reversed it.', 'I will pay the bill.', 'I paid the bill? Maybe not.']) {
    assert.throws(() => parseClarificationProposal(JSON.stringify({ outcome: 'clear', paymentState: 'paid',
      evidenceQuote: words.slice(0, words.indexOf(',') > 0 ? words.indexOf(',') : words.indexOf('.') > 0 ? words.indexOf('.') : words.length) }), words),
    { code: 'invalid-proposal' });
  }
});
