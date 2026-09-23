import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { emailReaderRefreshOperationId, recordEmailReaderRefreshReceipt } from '../src/open-loops/email-reader-refresh-receipt.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';
import { recordIntakeSourcePlan } from '../src/open-loops/intake-accounting.mjs';
import { producerSourceExternalId } from '../src/open-loops/intake-retry.mjs';
import { emailReaderPlanDigest } from '../src/open-loops/email-reader-plan.mjs';

const namespace = `microsoft-graph:sha256:${'a'.repeat(64)}`;
const batchId = `sha256:${'b'.repeat(64)}`;
const firstAttempt = '11111111-1111-4111-8111-111111111111';
const secondAttempt = '22222222-2222-4222-8222-222222222222';
const receipt = (attemptId, status, observedAt, overrides = {}) => ({
  schemaVersion: 1, sourceNamespace: namespace, captureRunId: 'fictional-accepted-run', batchId, attemptId, status, observedAt,
  selectedCount: 2, linkedCount: 0, unavailableCount: 0, ...overrides
});
const acceptedCapture = metadata => recordIntakeReceipt(metadata, {
  schemaVersion: 1, sourceKind: 'email', runId: 'fictional-accepted-run', checkpoint: 'fictional-checkpoint',
  status: 'healthy-processed', observedAt: '2026-09-23T00:55:00.000Z', lastSuccessfulAt: '2026-09-23T00:55:00.000Z',
  nextExpectedAt: '2026-09-24T00:55:00.000Z', processedCount: 2, actionableCount: 0, noteCount: 2,
  scope: { accountBinding: `sha256:${'a'.repeat(64)}`, folders: ['inbox'], sinceUtc: '2026-09-22T00:00:00.000Z', beforeUtc: '2026-09-23T00:00:00.000Z', maxMessages: 2, batchKind: 'bounded' }
});
const readerPlan = { schemaVersion: 1, purpose: 'command-center-email-reader-locators', sourceNamespace: namespace, records: [
  { sourceExternalId: 'fictional-one', sourceVersion: 'upstream-one', messageId: 'message-one', status: 'available', webLink: 'https://outlook.office.com/mail/id/fictional-one', observedAt: '2026-09-23T01:00:30.000Z' },
  { sourceExternalId: 'fictional-two', sourceVersion: 'upstream-two', messageId: 'message-two', status: 'unavailable', observedAt: '2026-09-23T01:00:30.000Z' }
] };
const acceptedReaders = (metadata, refreshOperationId) => {
  for (const record of readerPlan.records) {
    const sourceExternalId = producerSourceExternalId(namespace, record.sourceExternalId);
    recordIntakeSourcePlan(metadata, { schemaVersion: 1, sourceKind: 'email', sourceExternalId, sourceVersion: record.sourceVersion, checkpoint: `fictional-${record.sourceExternalId}`, observedAt: '2026-09-23T00:56:00.000Z', processorVersion: 'fictional-v1', acceptedExtraction: { schemaVersion: 1, notePath: '', knowledgeMarkdown: '', obligations: [], noAction: { outcomeId: 'none', summary: 'Fictional information only' } }, outcomes: [{ outcomeId: 'none', kind: 'no-action' }] });
    metadata.recordEmailReaderLocator({ sourceExternalId, sourceVersion: record.sourceVersion, messageId: record.messageId, status: record.status, ...(record.webLink ? { webLink: record.webLink } : {}), observedAt: record.observedAt, ...(refreshOperationId ? { refreshOperationId } : {}) });
  }
};

test('reader refresh attempt survives reopen, completes once, and cannot change its terminal result', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-reader-refresh-'));
  let metadata;
  try {
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    const pending = receipt(firstAttempt, 'pending', '2026-09-23T01:00:00.000Z');
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, pending), /exact accepted email capture run/);
    acceptedCapture(metadata);
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, { ...pending, captureRunId: 'another-run' }), /exact accepted email capture run/);
    assert.equal(recordEmailReaderRefreshReceipt(metadata, pending).disposition, 'recorded');
    metadata.close();
    metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    assert.equal(metadata.listEmailReaderRefreshOperations(namespace)[0].resultStatus, 'pending');
    const completed = receipt(firstAttempt, 'completed', '2026-09-23T01:01:00.000Z', { linkedCount: 1, unavailableCount: 1, readerPlanDigest: emailReaderPlanDigest(readerPlan) });
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, completed, readerPlan), /exact reader location effect/);
    acceptedReaders(metadata, emailReaderRefreshOperationId(pending));
    assert.equal(recordEmailReaderRefreshReceipt(metadata, completed, readerPlan).disposition, 'updated');
    assert.equal(recordEmailReaderRefreshReceipt(metadata, completed, readerPlan).disposition, 'duplicate');
    metadata.recordEmailReaderLocator({ sourceExternalId: producerSourceExternalId(namespace, 'fictional-one'), sourceVersion: 'upstream-one', messageId: 'newer-message', status: 'unavailable', observedAt: '2026-09-23T01:02:00.000Z' });
    assert.equal(recordEmailReaderRefreshReceipt(metadata, completed, readerPlan).disposition, 'duplicate', 'replaying an accepted terminal result cannot require the locator to remain latest forever');
    assert.equal(metadata.listEmailReaderRefreshOperations(namespace)[0].resultStatus, 'completed');
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, receipt(firstAttempt, 'failed', '2026-09-23T01:02:00.000Z', { failureCode: 'provider-read-failed' })), /cannot be replaced/);
    assert.throws(() => metadata.recordOperation({ logicalOperationId: 'other', transportRequestId: 'other', intentDigest: 'sha256:other', operationKind: 'email-reader.refresh.v1', state: 'applied', resultStatus: 'completed', resultIdentity: '{}', observedRevision: batchId, createdAt: completed.observedAt, updatedAt: completed.observedAt }), /dedicated owner/);
  } finally { metadata?.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('new reader attempt supersedes an unfinished older attempt and rejects its late completion', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-reader-refresh-race-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  try {
    acceptedCapture(metadata);
    recordEmailReaderRefreshReceipt(metadata, receipt(firstAttempt, 'pending', '2026-09-23T01:00:00.000Z'));
    recordEmailReaderRefreshReceipt(metadata, receipt(secondAttempt, 'pending', '2026-09-23T01:02:00.000Z'));
    const late = recordEmailReaderRefreshReceipt(metadata, receipt(firstAttempt, 'failed', '2026-09-23T01:03:00.000Z', { failureCode: 'reader-apply-failed' }));
    assert.equal(late.disposition, 'superseded');
    const current = recordEmailReaderRefreshReceipt(metadata, receipt(secondAttempt, 'failed', '2026-09-23T01:04:00.000Z', { linkedCount: 1, failureCode: 'reader-apply-failed' }));
    assert.equal(current.disposition, 'updated');
    assert.deepEqual(metadata.listEmailReaderRefreshOperations(namespace).map(item => item.resultStatus), ['superseded', 'failed']);
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, receipt('33333333-3333-4333-8333-333333333333', 'pending', '2026-09-23T01:03:00.000Z')), /stale reader refresh attempt/);
    assert.deepEqual(metadata.listEmailReaderRefreshOperations(namespace).map(item => item.resultStatus), ['superseded', 'failed']);
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('reader refresh cannot reuse locator effects from before its durable start', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-reader-refresh-causal-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  try {
    acceptedCapture(metadata);
    acceptedReaders(metadata);
    recordEmailReaderRefreshReceipt(metadata, receipt(firstAttempt, 'pending', '2026-09-23T01:01:00.000Z'));
    const beforeStart = receipt(firstAttempt, 'completed', '2026-09-23T01:02:00.000Z', { linkedCount: 1, unavailableCount: 1, readerPlanDigest: emailReaderPlanDigest(readerPlan) });
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, beforeStart, readerPlan), /not applied by this attempt/);
    const refreshedPlan = { ...readerPlan, records: readerPlan.records.map(record => ({ ...record, observedAt: '2026-09-23T01:01:30.000Z' })) };
    for (const record of refreshedPlan.records) metadata.recordEmailReaderLocator({ sourceExternalId: producerSourceExternalId(namespace, record.sourceExternalId), sourceVersion: record.sourceVersion, messageId: record.messageId, status: record.status, ...(record.webLink ? { webLink: record.webLink } : {}), observedAt: record.observedAt, refreshOperationId: emailReaderRefreshOperationId(receipt(firstAttempt, 'pending', '2026-09-23T01:01:00.000Z')) });
    const afterStart = { ...beforeStart, readerPlanDigest: emailReaderPlanDigest(refreshedPlan) };
    assert.equal(recordEmailReaderRefreshReceipt(metadata, afterStart, refreshedPlan).disposition, 'updated');
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('overlapping refresh batches cannot claim another attempt’s locator effects', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-reader-refresh-overlap-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
  try {
    acceptedCapture(metadata);
    const first = receipt(firstAttempt, 'pending', '2026-09-23T01:00:00.000Z');
    const second = receipt(secondAttempt, 'pending', '2026-09-23T01:00:10.000Z', { batchId: `sha256:${'c'.repeat(64)}` });
    recordEmailReaderRefreshReceipt(metadata, first);
    recordEmailReaderRefreshReceipt(metadata, second);
    acceptedReaders(metadata, emailReaderRefreshOperationId(first));
    const claim = receipt(secondAttempt, 'completed', '2026-09-23T01:01:00.000Z', { batchId: second.batchId, linkedCount: 1, unavailableCount: 1, readerPlanDigest: emailReaderPlanDigest(readerPlan) });
    assert.throws(() => recordEmailReaderRefreshReceipt(metadata, claim, readerPlan), /not applied by this attempt/);
    const correct = receipt(firstAttempt, 'completed', '2026-09-23T01:01:00.000Z', { linkedCount: 1, unavailableCount: 1, readerPlanDigest: emailReaderPlanDigest(readerPlan) });
    assert.equal(recordEmailReaderRefreshReceipt(metadata, correct, readerPlan).disposition, 'updated');
  } finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('actual process termination after the pending effect leaves a recoverable receipt', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-reader-refresh-death-'));
  try {
    const seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    try { acceptedCapture(seed); } finally { seed.close(); }
    const pending = receipt(firstAttempt, 'pending', '2026-09-23T01:00:00.000Z');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./support/email-reader-refresh-crash-child.mjs', import.meta.url)), stateDir, JSON.stringify(pending)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await new Promise((resolve, reject) => {
      let output = ''; let error = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pending child did not persist')); }, 10_000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('pending-persisted')) child.kill('SIGKILL'); });
      child.stderr.on('data', chunk => { error += chunk; });
      child.once('error', event => { clearTimeout(timeout); reject(event); });
      child.once('exit', (code, signal) => { clearTimeout(timeout); if (!output.includes('pending-persisted')) reject(new Error(`child exited before persistence: ${error}`)); else resolve({ code, signal }); });
    });
    assert.ok(result.signal === 'SIGKILL' || result.code !== 0, 'the child must actually terminate');
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    try {
      assert.equal(metadata.listEmailReaderRefreshOperations(namespace)[0].resultStatus, 'pending');
      assert.equal(recordEmailReaderRefreshReceipt(metadata, receipt(secondAttempt, 'pending', '2026-09-23T01:02:00.000Z')).disposition, 'recorded');
      assert.deepEqual(metadata.listEmailReaderRefreshOperations(namespace).map(item => item.resultStatus), ['superseded', 'pending']);
    } finally { metadata.close(); }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('two process owners racing the same attempt retain one durable start', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cc-reader-refresh-compete-'));
  try {
    const seed = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    try { acceptedCapture(seed); } finally { seed.close(); }
    const pending = receipt(firstAttempt, 'pending', '2026-09-23T01:00:00.000Z');
    const openCompetitor = () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./support/email-reader-refresh-crash-child.mjs', import.meta.url)), stateDir, JSON.stringify(pending), 'barrier'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let readyResolve; let readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('competing reader owner timed out')); }, 15_000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('ready\n')) readyResolve(); });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timeout); readyReject(error); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); if (!stdout.includes('ready\n')) readyReject(new Error(`competing reader owner never opened: ${stderr}`)); code === 0 ? resolve(stdout.trim().split('\n').at(-1)) : reject(new Error(`competing reader owner failed: ${stderr}`)); });
      });
      return { child, ready, done };
    };
    const first = openCompetitor(); await first.ready;
    const second = openCompetitor(); await second.ready;
    first.child.stdin.write('go\n'); second.child.stdin.write('go\n');
    assert.deepEqual((await Promise.all([first.done, second.done])).sort(), ['duplicate', 'recorded']);
    const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
    try { assert.equal(metadata.listEmailReaderRefreshOperations(namespace).length, 1); }
    finally { metadata.close(); }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('reader refresh receipt rejects counts, identities and unbounded failure details', () => {
  const base = receipt(firstAttempt, 'pending', '2026-09-23T01:00:00.000Z');
  for (const input of [
    { ...base, sourceNamespace: 'personal@example.invalid' },
    { ...base, captureRunId: '' },
    { ...base, batchId: 'raw-provider-id' },
    { ...base, linkedCount: 1 },
    { ...base, selectedCount: 51 },
    { ...base, detail: 'raw personal failure content' },
    { ...base, status: 'failed', failureCode: 'arbitrary-provider-error' }
  ]) assert.throws(() => recordEmailReaderRefreshReceipt({ commitEmailReaderRefreshOperation() {} }, input), /invalid/);
});
