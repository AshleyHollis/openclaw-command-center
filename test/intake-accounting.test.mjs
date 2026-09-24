import assert from 'node:assert/strict';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { planCommitmentCapture } from '../src/open-loops/commitment-capture.mjs';
import { normalizeAcceptedExtraction, projectIntakeAccounts, recordIntakeOutcome, recordIntakeSourcePlan } from '../src/open-loops/intake-accounting.mjs';
import { findIntakeContinuation, recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceNoteOperationId } from '../src/open-loops/source-intake-tool.mjs';
import { loadPendingClarificationContext } from '../src/open-loops/clarification-context.mjs';
import { pendingClarificationToolFactory } from '../src/open-loops/clarification-tool.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function temporaryStateDir(prefix) {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { path: value, cleanup: () => rm(value, { recursive: true, force: true }) };
}

function sourcePlan() {
  return {
    schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', checkpoint: 'page-1:message-42', observedAt: '2026-09-22T01:00:00.000Z', processorVersion: 'fictional-processor-v1', acceptedExtraction: { schemaVersion: 1, proposedTopic: 'Fictional home', notePath: 'Inbox/reference.md', knowledgeMarkdown: '# Fictional reference\n', knowledgeOutcomeId: 'reference-details', obligations: [] },
    outcomes: [
      { outcomeId: 'pay-invoice', kind: 'obligation' },
      { outcomeId: 'send-reference', kind: 'obligation' },
      { outcomeId: 'choose-delivery', kind: 'decision' },
      { outcomeId: 'reference-details', kind: 'information' }
    ],
    enumeration: { scope: 'bounded', scannedCount: 25, remainingCount: 4, failedReadCount: 1, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'page-2' }
  };
}

test('accepted extraction retains an explicit payment kind and rejects payment typed as a decision', () => {
  const extraction = { schemaVersion: 1, proposedTopic: 'Fictional home', notePath: 'Inbox/bill.md', knowledgeMarkdown: '# Fictional bill\n', obligations: [{ obligationId: 'bill-1', title: 'Pay fictional bill', classification: 'obligation', obligationKind: 'payment', provenance: 'explicit' }] };
  assert.equal(normalizeAcceptedExtraction(extraction).obligations[0].obligationKind, 'payment');
  assert.throws(() => normalizeAcceptedExtraction({ ...extraction, obligations: [{ ...extraction.obligations[0], classification: 'decision' }] }), error => error.code === 'invalid-request');
});

function addTopic(metadata) {
  metadata.createTopic({ topicId: 'topic-fictional-home', name: 'Fictional home', paraCategory: 'project', lifecycle: 'active', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' });
  metadata.createSourceReference({ version: 1, referenceId: 'folder:fictional-home', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/fictional' });
}

function addDecisionLoop(metadata) {
  const planned = planCommitmentCapture({
    schemaVersion: 1, logicalOperationId: 'decision-capture', sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', topicId: 'topic-fictional-home', title: 'Choose fictional delivery window', obligationId: 'choose-delivery', provenance: 'inferred', occurredAt: '2026-09-22T01:00:00.000Z', observedAt: '2026-09-22T01:00:00.000Z', historicalBaseline: false
  });
  return metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId: 'decision-capture', operationKind: 'commitment.capture.v1', intent: planned.value, expectedRevision: 0, observation: planned.observation, loop: planned.loop, evidenceRoles: { [planned.observation.observationId]: 'origin' }, updatedAt: '2026-09-22T01:00:00.000Z' }).loop;
}

function addObligationLoop(metadata, obligationId, title, topicId = 'topic-fictional-home') {
  const logicalOperationId = `capture-${obligationId}`;
  const planned = planCommitmentCapture({
    schemaVersion: 1, logicalOperationId, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', topicId, title, obligationId, provenance: 'explicit', occurredAt: '2026-09-22T01:00:00.000Z', observedAt: '2026-09-22T01:00:00.000Z', historicalBaseline: false
  });
  return metadata.applyOpenLoopChange({ schemaVersion: 1, logicalOperationId, operationKind: 'commitment.capture.v1', intent: planned.value, expectedRevision: 0, observation: planned.observation, loop: planned.loop, evidenceRoles: { [planned.observation.observationId]: 'origin' }, updatedAt: '2026-09-22T01:00:00.000Z' }).loop;
}

function addEffects(metadata) {
  const payment = addObligationLoop(metadata, 'pay-invoice', 'Pay fictional invoice');
  const response = addObligationLoop(metadata, 'send-reference', 'Send fictional reference');
  const decision = addDecisionLoop(metadata);
  metadata.createSourceReference({ version: 1, referenceId: 'note:fictional-message-42', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/Inbox/reference.md', observedRevision: 'note-v1' });
  const logicalOperationId = sourceNoteOperationId({ topicId: 'topic-fictional-home', sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7' });
  metadata.recordOperation({ logicalOperationId, transportRequestId: logicalOperationId, intentDigest: 'sha256:fictional-source-note', operationKind: 'notes.create', state: 'applied', resultStatus: 'applied', resultIdentity: '/fictional/Inbox/reference.md', observedRevision: 'note-v1', createdAt: '2026-09-22T01:00:00.000Z', updatedAt: '2026-09-22T01:00:00.000Z' });
  return { payment, response, decision };
}

test('email reader location changes after a move without changing accepted effects or decisions', async () => {
  const temporary = await temporaryStateDir('command-center-email-reader-');
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    addTopic(metadata);
    recordIntakeSourcePlan(metadata, sourcePlan());
    const decision = addDecisionLoop(metadata);
    const before = { plan: projectIntakeAccounts(metadata, 'email'), loop: metadata.getOpenLoop(decision.loopId) };
    const first = { sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', messageId: 'fictional-inbox-id', status: 'available', webLink: 'https://outlook.office.com/mail/inbox/id/fictional-inbox-id', observedAt: '2026-09-22T01:02:00.000Z' };
    assert.equal(metadata.recordEmailReaderLocator(first).disposition, 'recorded');
    assert.equal(metadata.recordEmailReaderLocator(first).disposition, 'duplicate');
    const moved = { ...first, messageId: 'fictional-moved-id', webLink: 'https://outlook.office.com/mail/archive/id/fictional-moved-id', observedAt: '2026-09-22T01:03:00.000Z' };
    assert.equal(metadata.recordEmailReaderLocator(moved).disposition, 'updated');
    assert.equal(metadata.recordEmailReaderLocator(first).disposition, 'stale');
    assert.equal(metadata.getEmailReaderLocator(first.sourceExternalId, first.sourceVersion).webLink, moved.webLink);
    const unavailable = { ...moved, status: 'unavailable', webLink: undefined, observedAt: '2026-09-22T01:04:00.000Z' };
    assert.equal(metadata.recordEmailReaderLocator(unavailable).disposition, 'updated');
    assert.equal(metadata.getEmailReaderLocator(first.sourceExternalId, first.sourceVersion).status, 'unavailable');
    assert.equal(metadata.getEmailReaderLocator(first.sourceExternalId, first.sourceVersion).webLink, undefined);
    const recovered = { ...moved, observedAt: '2026-09-22T01:05:00.000Z' };
    assert.equal(metadata.recordEmailReaderLocator(recovered).disposition, 'updated');
    assert.equal(metadata.listOperations().filter(operation => operation.operationKind === 'email-reader.locator.v1').length, 4, 'each accepted location observation remains immutable');
    assert.deepEqual(projectIntakeAccounts(metadata, 'email'), before.plan);
    assert.deepEqual(metadata.getOpenLoop(decision.loopId), before.loop);
    assert.throws(() => metadata.recordEmailReaderLocator({ ...moved, webLink: 'https://evil.example/mail/fictional', observedAt: '2026-09-22T01:04:00.000Z' }), /Outlook reader destination/);
    assert.throws(() => metadata.recordEmailReaderLocator({ ...moved, webLink: 'https://outlook.office.com/mail/?access_token=fictional', observedAt: '2026-09-22T01:04:00.000Z' }), /credential-like/);
    assert.throws(() => metadata.recordEmailReaderLocator({ ...moved, sourceExternalId: 'unaccepted-source' }), /accepted email source/);
    metadata.close(); metadata = null;
    const reopened = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    metadata = reopened;
    assert.equal(reopened.getEmailReaderLocator(first.sourceExternalId, first.sourceVersion).webLink, moved.webLink);
    assert.deepEqual(reopened.getOpenLoop(decision.loopId), before.loop);
  } finally { metadata?.close(); await temporary.cleanup(); }
});

test('simultaneous email reader writers cannot publish different locations for one observation time', async () => {
  const temporary = await temporaryStateDir('command-center-email-reader-race-');
  try {
    const seed = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    try { recordIntakeSourcePlan(seed, sourcePlan()); } finally { seed.close(); }
    const first = { sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', messageId: 'fictional-one', status: 'available', webLink: 'https://outlook.office.com/mail/id/fictional-one', observedAt: '2026-09-22T01:02:00.000Z' };
    const second = { ...first, messageId: 'fictional-two', webLink: 'https://outlook.office.com/mail/id/fictional-two' };
    const run = input => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./support/email-reader-write-child.mjs', import.meta.url)), temporary.path, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
    });
    const outcomes = await Promise.all([run(first), run(second)]);
    assert.deepEqual(outcomes.map(item => item.code).sort(), [0, 2]);
    assert.ok(outcomes.some(item => /(?:conflict|recovery-only)/u.test(item.stderr)), JSON.stringify(outcomes));
    const verification = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    try { assert.equal(verification.listOperations().filter(item => item.operationKind === 'email-reader.locator.v1').length, 1); }
    finally { verification.close(); }
  } finally { await temporary.cleanup(); }
});

test('mixed email accounting distinguishes accounted-for from resolved and retains bounded enumeration gaps', async () => {
  const temporary = await temporaryStateDir('command-center-intake-accounting-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata);
    const first = recordIntakeSourcePlan(metadata, sourcePlan());
    assert.equal(recordIntakeSourcePlan(metadata, sourcePlan()).disposition, 'duplicate');
    const { payment, response, decision } = addEffects(metadata);
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: payment.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'send-reference', kind: 'obligation', status: 'applied', summary: 'Send fictional reference', loopId: response.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'choose-delivery', kind: 'decision', status: 'pending-decision', summary: 'Choose fictional delivery window', loopId: decision.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained fictional reference details', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'note-v1' });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(first.plan.sourceVersion, 'change-key-7');
    assert.deepEqual({ accounted: account.accounted, resolved: account.resolved, expected: account.counts.expected, pending: account.counts.decisionsPending, quiet: account.counts.quiet }, { accounted: true, resolved: false, expected: 4, pending: 1, quiet: 1 });
    assert.deepEqual(account.enumeration, { scope: 'bounded', scannedCount: 25, remainingCount: 4, failedReadCount: 1, scanCapReached: true, scopeId: 'mailbox-fixture', resumeCursor: 'page-2' });
    assert.equal(recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained fictional reference details', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'note-v1' }).disposition, 'duplicate');
    assert.throws(() => recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Changed under retry', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'note-v1' }), { code: 'intent-mismatch' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('a pinned producer plan admits the exact externally retained Note without claiming it was created', async () => {
  const temporary = await temporaryStateDir('command-center-intake-admitted-note-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata);
    const plan = sourcePlan(); plan.retainedNoteRevision = 'sha256:retained-note';
    recordIntakeSourcePlan(metadata, plan);
    metadata.createSourceReference({ version: 1, referenceId: 'note:externally-retained', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/Inbox/reference.md', observedRevision: 'sha256:retained-note' });
    const outcome = recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained external producer Note', topicId: 'topic-fictional-home', sourceReferenceId: 'note:externally-retained', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'sha256:retained-note', recordedAt: '2026-09-22T01:01:00.000Z' });
    assert.equal(outcome.outcome.status, 'quiet');
    assert.equal(metadata.listOperations().some(item => item.operationKind === 'notes.create'), false);
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('a structured clarification resolves only its linked outcome and survives SQLite restart', async () => {
  const temporary = await temporaryStateDir('command-center-intake-clarification-');
  try {
    let metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan()); const { payment, response, decision } = addEffects(metadata);
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: payment.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'send-reference', kind: 'obligation', status: 'applied', summary: 'Send fictional reference', loopId: response.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'choose-delivery', kind: 'decision', status: 'pending-decision', summary: 'Choose fictional delivery window', loopId: decision.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Retained fictional reference details', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'note-v1' });
    metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'clarify-fictional-delivery', loopId: decision.loopId, expectedRevision: decision.revision, decision: 'confirm', actorId: 'operator-fixture', rationale: 'Use the standard fictional window.', updatedAt: '2026-09-22T01:05:00.000Z' });
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(account.resolved, true);
    assert.deepEqual(account.outcomes.map(item => [item.outcomeId, item.status]), [['pay-invoice', 'applied'], ['send-reference', 'applied'], ['choose-delivery', 'clarified'], ['reference-details', 'quiet']]);
    assert.throws(() => metadata.recordOpenLoopDecision({ schemaVersion: 1, logicalOperationId: 'stale-clarification', loopId: decision.loopId, expectedRevision: decision.revision, decision: 'dismiss', actorId: 'operator-fixture', rationale: 'A stale different answer.', updatedAt: '2026-09-22T01:06:00.000Z' }), { code: 'open-loop-stale-revision' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('pending clarification loads only its accepted outcome after SQLite restart and rejects superseded source', async () => {
  const temporary = await temporaryStateDir('command-center-targeted-clarification-');
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    addTopic(metadata);
    const plan = sourcePlan();
    plan.acceptedExtraction.obligations = [
      { obligationId: 'pay-invoice', title: 'Pay fictional invoice', provenance: 'explicit', obligationKind: 'payment' },
      { obligationId: 'send-reference', title: 'Send fictional reference', provenance: 'explicit' },
      { obligationId: 'choose-delivery', title: 'Choose fictional delivery window', provenance: 'inferred', classification: 'decision' }
    ];
    recordIntakeSourcePlan(metadata, plan);
    const { payment, response, decision } = addEffects(metadata);
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: payment.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'send-reference', kind: 'obligation', status: 'applied', summary: 'Send fictional reference', loopId: response.loopId });
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'choose-delivery', kind: 'decision', status: 'pending-decision', summary: 'Choose fictional delivery window', loopId: decision.loopId });
    const clarified = metadata.recordOpenLoopClarification({ schemaVersion: 1, logicalOperationId: 'fictional-item-words', loopId: decision.loopId, expectedRevision: decision.revision, actorId: 'operator-fixture', rationale: 'Use the morning delivery window for this one.', updatedAt: '2026-09-22T01:02:00.000Z' });
    const expected = { loopId: decision.loopId, expectedRevision: clarified.loop.revision };
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    const tool = pendingClarificationToolFactory({ getOwners: () => ({ metadata }) })();
    const loaded = (await tool.execute('fictional-call', expected)).details;
    assert.equal(loaded.status, 'pending');
    assert.equal(loaded.userWords, 'Use the morning delivery window for this one.');
    assert.deepEqual(loaded.source, { sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7' });
    assert.equal(loaded.outcomeId, 'choose-delivery');
    assert.equal(loaded.acceptedObligation.title, 'Choose fictional delivery window');
    assert.equal(JSON.stringify(loaded).includes('Pay fictional invoice'), false, 'clear siblings are not sent for reinterpretation');
    assert.equal(loadPendingClarificationContext(metadata, { ...expected, expectedRevision: decision.revision }).status, 'superseded');
    const newer = { ...plan, sourceVersion: 'change-key-8', observedAt: plan.observedAt, checkpoint: 'page-2:message-42' };
    recordIntakeSourcePlan(metadata, newer);
    assert.deepEqual(loadPendingClarificationContext(metadata, expected), { status: 'review-required', reason: 'source-revision-changed' });
    assert.equal(metadata.getOpenLoop(payment.loopId).revision, payment.revision);
    assert.equal(metadata.getOpenLoop(response.loopId).revision, response.revision);
  } finally { metadata?.close(); await temporary.cleanup(); }
});

test('missing and unresolved outcomes remain visible instead of advancing the source to resolved', async () => {
  const temporary = await temporaryStateDir('command-center-intake-partial-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path }); recordIntakeSourcePlan(metadata, sourcePlan());
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', recordedAt: '2026-09-22T01:01:00.000Z' };
    recordIntakeOutcome(metadata, { ...base, outcomeId: 'pay-invoice', kind: 'obligation', status: 'unresolved-topic', summary: 'Topic requires review' });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(account.accounted, false); assert.equal(account.resolved, false); assert.equal(account.counts.unresolvedTopics, 1); assert.equal(account.outcomes.filter(item => item.status === 'missing').length, 3);
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('an unresolved outcome can become applied without replacing its durable history', async () => {
  const temporary = await temporaryStateDir('command-center-intake-resume-outcome-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan());
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'pay-invoice', kind: 'obligation', summary: 'Pay fictional invoice' };
    recordIntakeOutcome(metadata, { ...base, status: 'unresolved-topic', recordedAt: '2026-09-22T01:01:00.000Z' });
    const { payment } = addEffects(metadata);
    recordIntakeOutcome(metadata, { ...base, status: 'applied', loopId: payment.loopId, recordedAt: '2026-09-22T01:02:00.000Z' });
    const [account] = projectIntakeAccounts(metadata, 'email');
    assert.equal(account.outcomes.find(item => item.outcomeId === 'pay-invoice').status, 'applied');
    assert.equal(metadata.listOperations().filter(item => item.operationKind === 'intake-outcome.email.v1').length, 2);
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('an admitted external producer Note cannot be accounted under a different Topic', async () => {
  const temporary = await temporaryStateDir('command-center-intake-wrong-topic-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata);
    const plan = sourcePlan(); plan.retainedNoteRevision = 'sha256:retained-note'; recordIntakeSourcePlan(metadata, plan);
    metadata.createTopic({ topicId: 'topic-foreign', name: 'Fictional Foreign', paraCategory: 'area', lifecycle: 'active' });
    metadata.createSourceReference({ version: 1, referenceId: 'folder:foreign', topicId: 'topic-foreign', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: '/foreign' });
    metadata.createSourceReference({ version: 1, referenceId: 'note:foreign', topicId: 'topic-foreign', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/foreign/Inbox/reference.md', observedRevision: 'sha256:retained-note' });
    assert.throws(() => recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Wrong Topic', topicId: 'topic-foreign', sourceReferenceId: 'note:foreign', sourcePath: 'Inbox/reference.md', sourceReferenceVersion: 'sha256:retained-note', recordedAt: '2026-09-22T01:01:00.000Z' }), { code: 'conflict' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('an applied obligation cannot be accounted under a different Topic', async () => {
  const temporary = await temporaryStateDir('command-center-intake-wrong-obligation-topic-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan());
    metadata.createTopic({ topicId: 'topic-foreign', name: 'Fictional Foreign', paraCategory: 'area', lifecycle: 'active' });
    const foreign = addObligationLoop(metadata, 'pay-invoice', 'Pay fictional invoice', 'topic-foreign');
    assert.throws(() => recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: foreign.loopId, recordedAt: '2026-09-22T01:01:00.000Z' }), { code: 'conflict' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('the intake owner commits one durable result across simultaneous SQLite owners', async () => {
  const temporary = await temporaryStateDir('command-center-intake-concurrent-');
  let first; let second;
  try {
    first = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    addTopic(first); recordIntakeSourcePlan(first, sourcePlan());
    const { payment } = addEffects(first);
    second = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } });
    const input = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'pay-invoice', kind: 'obligation', status: 'applied', summary: 'Pay fictional invoice', loopId: payment.loopId, recordedAt: '2026-09-22T01:01:00.000Z' };
    const recorded = recordIntakeOutcome(first, input);
    const replay = recordIntakeOutcome(second, { ...input, recordedAt: '2026-09-22T01:02:00.000Z' });
    assert.equal(recorded.disposition, 'recorded');
    assert.equal(replay.disposition, 'duplicate');
    assert.equal(replay.outcome.recordedAt, recorded.outcome.recordedAt);
    assert.throws(() => recordIntakeOutcome(second, { ...input, summary: 'A different result', recordedAt: '2026-09-22T01:03:00.000Z' }), { code: 'intent-mismatch' });
    assert.equal(projectIntakeAccounts(first, 'email')[0].outcomes.find(item => item.outcomeId === 'pay-invoice').summary, 'Pay fictional invoice');
  } finally {
    second?.close(); first?.close(); await temporary.cleanup();
  }
});

test('generic operation writes cannot forge or replace intake accounting receipts', async () => {
  const temporary = await temporaryStateDir('command-center-intake-owner-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    assert.throws(() => metadata.recordOperation({ logicalOperationId: 'forged-intake', transportRequestId: 'forged-intake', intentDigest: 'sha256:forged', operationKind: 'intake-source.email.v1', state: 'applied', resultStatus: 'planned', resultIdentity: '{}', observedRevision: 'v1', createdAt: '2026-09-22T01:00:00.000Z', updatedAt: '2026-09-22T01:00:00.000Z' }), { code: 'intake-accounting-owner-required' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('a failed page continuation survives SQLite restart and clears only after successful resume', async () => {
  const temporary = await temporaryStateDir('command-center-intake-continuation-');
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const counts = { processedCount: 25, actionableCount: 2, noteCount: 1 };
    const continuation = { scopeId: 'mailbox-fixture', cursor: 'page-3', remainingCount: 4, failedReadCount: 1, scanCapReached: true };
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'email-partial', checkpoint: 'page-2', status: 'incomplete', observedAt: '2026-09-22T02:00:00.000Z', nextExpectedAt: '2026-09-22T02:05:00.000Z', ...counts, continuation });
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    assert.deepEqual(findIntakeContinuation(metadata, 'email'), continuation);
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'email-resume', checkpoint: 'complete', status: 'healthy-processed', observedAt: '2026-09-22T02:06:00.000Z', lastSuccessfulAt: '2026-09-22T02:06:00.000Z', nextExpectedAt: '2026-09-23T02:06:00.000Z', ...counts });
    assert.equal(findIntakeContinuation(metadata, 'email'), null);
    metadata.close(); metadata = undefined;
  } finally { metadata?.close(); await temporary.cleanup(); }
});

test('an admitted retry receipt survives restart without replacing producer coverage or continuation', async () => {
  const temporary = await temporaryStateDir('command-center-intake-retry-receipt-');
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const counts = { processedCount: 1, actionableCount: 0, noteCount: 0 };
    const continuation = { scopeId: 'fictional-mailbox', cursor: 'next-page', remainingCount: 2, failedReadCount: 0, scanCapReached: true };
    const planDigest = `sha256:${'a'.repeat(64)}`;
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'source-run', planDigest, checkpoint: 'page-1', status: 'incomplete', observedAt: '2026-09-22T02:00:00.000Z', nextExpectedAt: '2026-09-22T03:00:00.000Z', ...counts, continuation });
    const retry = recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'source-run:retry:one', purpose: 'admitted-retry', retryOfRunId: 'source-run', planDigest, checkpoint: 'page-1', status: 'healthy-processed', observedAt: '2026-09-22T02:01:00.000Z', lastSuccessfulAt: '2026-09-22T02:01:00.000Z', ...counts });
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    assert.equal(retry.receipt.purpose, 'admitted-retry');
    assert.deepEqual(findIntakeContinuation(metadata, 'email'), continuation);
    assert.throws(() => recordIntakeReceipt(metadata, { ...retry.receipt, runId: 'unsafe-retry', enumeration: { scope: 'complete', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false } }), { code: 'invalid-request' });
    assert.throws(() => recordIntakeReceipt(metadata, { ...retry.receipt, runId: 'unsafe-chat', sourceKind: 'chat' }), { code: 'invalid-request' });
    assert.throws(() => recordIntakeReceipt(metadata, { ...retry.receipt, planDigest: `sha256:${'b'.repeat(64)}` }), { code: 'intent-mismatch' });
  } finally { metadata?.close(); await temporary.cleanup(); }
});

test('a bounded email receipt retains content-free source scope and discovery after SQLite restart', async () => {
  const temporary = await temporaryStateDir('command-center-intake-scope-');
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const scope = { accountBinding: 'sha256:fictional-account', folders: ['inbox'], sinceUtc: '2026-09-20T00:00:00.000Z', beforeUtc: '2026-09-21T00:00:00.000Z', maxMessages: 50, batchKind: 'bounded' };
    const enumeration = { scope: 'partial', scannedCount: 50, remainingCount: 4, failedReadCount: 1, scanCapReached: true };
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'email-scope', checkpoint: 'page-1', status: 'failed', observedAt: '2026-09-21T01:00:00.000Z', processedCount: 2, actionableCount: 1, noteCount: 1, scope, enumeration });
    metadata.close(); metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const operation = metadata.listOperations().find(item => item.operationKind === 'intake-receipt.email.v1');
    const retained = JSON.parse(operation.resultIdentity);
    assert.deepEqual(retained.scope, scope);
    assert.deepEqual(retained.enumeration, enumeration);
    assert.throws(() => recordIntakeReceipt(metadata, { ...retained, runId: 'invalid-scope', scope: { ...scope, sinceUtc: scope.beforeUtc } }), { code: 'invalid-request' });
    assert.throws(() => recordIntakeReceipt(metadata, { ...retained, runId: 'invalid-enumeration', enumeration: { ...enumeration, scannedCount: 51 } }), { code: 'invalid-request' });
  } finally { metadata?.close(); await temporary.cleanup(); }
});

test('a late older run cannot restore its obsolete continuation after a newer run succeeds', async () => {
  const temporary = await temporaryStateDir('command-center-intake-generation-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const counts = { processedCount: 0, actionableCount: 0, noteCount: 0 };
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'older-run', checkpoint: 'start', status: 'pending', observedAt: '2026-09-22T02:00:00.000Z', nextExpectedAt: '2026-09-22T02:05:00.000Z', ...counts });
    recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'newer-run', checkpoint: 'complete', status: 'healthy-empty', observedAt: '2026-09-22T02:01:00.000Z', lastSuccessfulAt: '2026-09-22T02:01:00.000Z', nextExpectedAt: '2026-09-23T02:01:00.000Z', ...counts });
    const late = recordIntakeReceipt(metadata, { schemaVersion: 1, sourceKind: 'email', runId: 'older-run', checkpoint: 'page-1', status: 'incomplete', observedAt: '2026-09-22T02:02:00.000Z', nextExpectedAt: '2026-09-22T02:05:00.000Z', ...counts, continuation: { scopeId: 'mailbox-fixture', cursor: 'obsolete', remainingCount: 1, failedReadCount: 0, scanCapReached: true } });
    assert.equal(late.disposition, 'superseded');
    assert.equal(findIntakeContinuation(metadata, 'email'), null);
    assert.equal(metadata.listOperations().find(item => item.logicalOperationId === late.logicalOperationId).resultStatus, 'superseded');
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('a completed run dominates a replayed pending receipt for the same run', async () => {
  const temporary = await temporaryStateDir('command-center-intake-terminal-dominates-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const base = { schemaVersion: 1, sourceKind: 'email', runId: 'completed-run', checkpoint: 'complete', observedAt: '2026-09-22T02:00:00.000Z', nextExpectedAt: '2026-09-23T02:00:00.000Z', processedCount: 1, actionableCount: 1, noteCount: 1 };
    recordIntakeReceipt(metadata, { ...base, status: 'healthy-processed', lastSuccessfulAt: base.observedAt });
    const replay = recordIntakeReceipt(metadata, { ...base, checkpoint: 'start', status: 'pending', observedAt: '2026-09-22T02:01:00.000Z' });
    assert.equal(replay.disposition, 'duplicate');
    assert.equal(replay.receipt.status, 'healthy-processed');
    assert.equal(metadata.listOperations().find(item => item.logicalOperationId === replay.logicalOperationId).resultStatus, 'healthy-processed');
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('a terminal receipt cannot be replaced by a different terminal result for the same run', async () => {
  const temporary = await temporaryStateDir('command-center-intake-terminal-conflict-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path });
    const base = { schemaVersion: 1, sourceKind: 'email', runId: 'terminal-run', checkpoint: 'complete', observedAt: '2026-09-22T02:00:00.000Z', nextExpectedAt: '2026-09-23T02:00:00.000Z', processedCount: 1, actionableCount: 1, noteCount: 1 };
    recordIntakeReceipt(metadata, { ...base, status: 'healthy-processed', lastSuccessfulAt: base.observedAt });
    assert.throws(() => recordIntakeReceipt(metadata, { ...base, status: 'failed', observedAt: '2026-09-22T02:01:00.000Z' }), { code: 'intent-mismatch' });
    assert.equal(metadata.listOperations().find(item => item.operationKind === 'intake-receipt.email.v1').resultStatus, 'healthy-processed');
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('quiet intake rejects an unrelated Note even when its revision matches', async () => {
  const temporary = await temporaryStateDir('command-center-intake-unrelated-note-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan());
    metadata.createSourceReference({ version: 1, referenceId: 'note:unrelated', topicId: 'topic-fictional-home', sourceSystem: 'obsidian', sourceKind: 'note', externalSourceId: '/fictional/unrelated.md', observedRevision: 'note-v1' });
    assert.throws(() => recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Incorrect unrelated evidence', topicId: 'topic-fictional-home', sourceReferenceId: 'note:unrelated', sourcePath: 'Inbox/unrelated.md', sourceReferenceVersion: 'note-v1', recordedAt: '2026-09-22T02:00:00.000Z' }), { code: 'conflict' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('quiet intake rejects a navigation path that does not identify its exact Note', async () => {
  const temporary = await temporaryStateDir('command-center-intake-wrong-path-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan()); addEffects(metadata);
    assert.throws(() => recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Wrong path', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourcePath: 'Totally/Wrong.md', sourceReferenceVersion: 'note-v1', recordedAt: '2026-09-22T02:00:00.000Z' }), { code: 'conflict' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('quiet intake rejects a basename suffix instead of the exact Topic-relative path', async () => {
  const temporary = await temporaryStateDir('command-center-intake-short-path-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan()); addEffects(metadata);
    assert.throws(() => recordIntakeOutcome(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Short path', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourcePath: 'reference.md', sourceReferenceVersion: 'note-v1', recordedAt: '2026-09-22T02:00:00.000Z' }), { code: 'conflict' });
    metadata.close();
  } finally { await temporary.cleanup(); }
});

test('quiet intake rejects a stale path after its Note is relocated', async () => {
  const temporary = await temporaryStateDir('command-center-intake-relocated-note-');
  try {
    const metadata = openCommandCenterMetadataService({ stateDir: temporary.path, capabilities: { notes: true } }); addTopic(metadata); recordIntakeSourcePlan(metadata, sourcePlan()); addEffects(metadata);
    metadata.setSourceLocator({ referenceId: 'note:fictional-message-42', locator: '/fictional/Archive/reference.md', ownership: 'external', observedRevision: 'note-v1' });
    const base = { schemaVersion: 1, sourceKind: 'email', sourceExternalId: 'fictional-message-42', sourceVersion: 'change-key-7', outcomeId: 'reference-details', kind: 'information', status: 'quiet', summary: 'Relocated evidence', topicId: 'topic-fictional-home', sourceReferenceId: 'note:fictional-message-42', sourceReferenceVersion: 'note-v1', recordedAt: '2026-09-22T02:00:00.000Z' };
    assert.throws(() => recordIntakeOutcome(metadata, { ...base, sourcePath: 'Inbox/reference.md' }), { code: 'conflict' });
    assert.equal(recordIntakeOutcome(metadata, { ...base, sourcePath: 'Archive/reference.md' }).outcome.sourcePath, 'Archive/reference.md');
    metadata.close();
  } finally { await temporary.cleanup(); }
});
