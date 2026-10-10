import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createAcceptedChatNoteFixture, mixedChatPlan } from './support/accepted-chat-note-fixture.mjs';
import { sourceNoteOperationId } from '../src/open-loops/source-intake-tool.mjs';
import { createProducerIntakeAdapter } from '../src/open-loops/producer-intake.mjs';
import { loadIntakeSourceAccount, recordIntakeSourcePlan, recordIntakeOutcome } from '../src/open-loops/intake-accounting.mjs';
import { recordIntakeReceipt } from '../src/open-loops/intake-receipt.mjs';

const linux = { skip: process.platform !== 'linux' && 'Real Note filesystem and process-death qualification requires supported Linux' };
test('accepted Chat mixed outcomes recover real Note publication after lost response and SQLite reopen', linux, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-accepted-chat-note-'));
  let lose = true;
  const f = await createAcceptedChatNoteFixture(parent, { afterAtomicPublish() { if (lose) { lose = false; throw new Error('fictional Note response lost'); } } });
  try {
    const accepted = await f.owner().accept(mixedChatPlan(), f.runtime);
    const request = { schemaVersion: 1, planId: accepted.planId };
    await assert.rejects(() => f.owner().replay(request, f.runtime), /fictional Note response lost/u);
    const bytes = await readFile(path.join(f.root, 'Inbox/derived.md'));
    f.reopen();
    const replay = await f.owner().replay(request, f.runtime);
    assert.equal(replay.account.accounted, true);
    assert.deepEqual(replay.account.outcomes.map(item => item.status), ['pending-decision', 'applied', 'quiet', 'no-action']);
    assert.equal(f.metadata().listOpenLoops().length, 2);
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'notes.create').length, 1);
    const knowledge = replay.account.outcomes.find(item => item.kind === 'information');
    assert.equal(replay.account.sourceKind, 'chat');
    assert.equal(f.metadata().getSourceReference(knowledge.sourceReferenceId).sourceKind, 'note');
    const upstreamId = sourceNoteOperationId({ ...mixedChatPlan(), topicId: 'topic-fictional' });
    assert.equal(f.metadata().getOperation(upstreamId).operationKind, 'notes.create');
    assert.equal(f.metadata().getOperation(sourceNoteOperationId({ ...mixedChatPlan(), topicId: 'topic-fictional', sourceKind: 'note' })), null);
    await f.owner().replay(request, f.runtime);
    assert.deepEqual(await readFile(path.join(f.root, 'Inbox/derived.md')), bytes);
    // Reprocessing the derived resource must not create another Note or duplicate
    // the upstream Chat account. Its producer has a separate Note identity.
    const adapter = createProducerIntakeAdapter({
      processorVersion: 'fictional-derived-note-v1',
      extract: async () => { throw new Error('retained extraction required'); },
      loadIntakeSourceAccount: input => loadIntakeSourceAccount(f.metadata(), input),
      resolveTopic: async () => ({ topicId: 'topic-fictional' }),
      saveSourceNote: async () => { throw new Error('derived evidence must be reused'); },
      captureSourceCommitment: async () => { throw new Error('derived knowledge is quiet'); },
      captureChatCommitment: async () => { throw new Error('derived knowledge is quiet'); },
      recordIntakeSourcePlan: input => recordIntakeSourcePlan(f.metadata(), { schemaVersion: 1, ...input }),
      recordIntakeOutcome: input => recordIntakeOutcome(f.metadata(), { schemaVersion: 1, ...input }),
      recordIntakeReceipt: input => recordIntakeReceipt(f.metadata(), { schemaVersion: 1, ...input })
    });
    const { noAction: _noAction, ...extraction } = mixedChatPlan().acceptedExtraction;
    const derived = { schemaVersion: 1, sourceKind: 'note', sourceExternalId: knowledge.sourceReferenceId, sourceVersion: knowledge.sourceReferenceVersion, checkpoint: 'fictional-derived-note', acceptedExtraction: { ...extraction, obligations: [] }, existingEvidence: { topicId: 'topic-fictional', sourceReferenceId: knowledge.sourceReferenceId, sourcePath: knowledge.sourcePath, sourceReferenceVersion: knowledge.sourceReferenceVersion } };
    for (const runId of ['fictional-derived-first', 'fictional-derived-replay']) {
      const result = await adapter.process({ runId, sourceKind: 'note', records: [derived], nextExpectedAt: '2026-10-02T01:00:00.000Z' });
      assert.equal(result.status, 'healthy-processed');
      assert.equal(result.noteCount, 0);
    }
    assert.equal(loadIntakeSourceAccount(f.metadata(), derived).account.accounted, true);
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'intake-outcome.chat.v1').length, 4);
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'notes.create').length, 1);
    assert.deepEqual(await readFile(path.join(f.root, 'Inbox/derived.md')), bytes);
    const logicalOperationId = sourceNoteOperationId({ ...mixedChatPlan(), topicId: 'topic-fictional' });
    await assert.rejects(() => f.sources().notesCreate({ schemaVersion: 1, topicId: 'topic-fictional', referenceId: 'folder:fictional', sourceKind: 'note', path: 'Inbox/derived.md', text: mixedChatPlan().acceptedExtraction.knowledgeMarkdown, logicalOperationId, requestId: logicalOperationId }), { code: 'source-recovery' });
    await rename(f.root, `${f.root}-replaced`);
    await assert.rejects(() => f.owner().replay(request, f.runtime));
    assert.deepEqual(await readFile(path.join(`${f.root}-replaced`, 'Inbox/derived.md')), bytes);
  } finally { f.close(); await rm(parent, { recursive: true, force: true }); }
});

test('revocation at real Note publication refuses the effect and preserved source bytes', linux, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-accepted-chat-note-revoke-'));
  let f;
  f = await createAcceptedChatNoteFixture(parent, { beforeAtomicCommit: () => f.revoke() });
  try {
    const accepted = await f.owner().accept(mixedChatPlan(), f.runtime);
    await assert.rejects(() => f.owner().replay({ schemaVersion: 1, planId: accepted.planId }, f.runtime), { code: 'unauthenticated' });
    await assert.rejects(() => readFile(path.join(f.root, 'Inbox/derived.md')), { code: 'ENOENT' });
    assert.equal(f.metadata().listOpenLoops().length, 0);
  } finally { f.close(); await rm(parent, { recursive: true, force: true }); }
});

test('edited accounted Note refuses a missing Chat obligation after the awaited authoritative read', linux, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-accepted-chat-note-edit-'));
  let interrupt = true;
  const f = await createAcceptedChatNoteFixture(parent, { assertCurrent(metadata) {
    if (interrupt && metadata.listOperations().some(item => item.operationKind === 'intake-outcome.chat.v1')) { interrupt = false; throw new Error('fictional interruption after quiet outcome'); }
  } });
  try {
    const accepted = await f.owner().accept(mixedChatPlan(), f.runtime);
    const request = { schemaVersion: 1, planId: accepted.planId };
    await assert.rejects(() => f.owner().replay(request, f.runtime), /fictional interruption/u);
    const edited = '# Fictional user edit\nKeep the edit.\n';
    await writeFile(path.join(f.root, 'Inbox/derived.md'), edited);
    f.reopen();
    await assert.rejects(() => f.owner().replay(request, f.runtime));
    assert.equal(f.metadata().listOpenLoops().length, 0);
    assert.equal(await readFile(path.join(f.root, 'Inbox/derived.md'), 'utf8'), edited);
  } finally { f.close(); await rm(parent, { recursive: true, force: true }); }
});

test('authority revoked during exact Note read refuses the missing capture after await', linux, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-accepted-chat-capture-revoke-'));
  let interrupt = true;
  const f = await createAcceptedChatNoteFixture(parent, { assertCurrent(metadata) {
    if (interrupt && metadata.listOperations().some(item => item.operationKind === 'intake-outcome.chat.v1')) { interrupt = false; throw new Error('fictional quiet checkpoint interruption'); }
  } });
  try {
    const accepted = await f.owner().accept(mixedChatPlan(), f.runtime);
    const request = { schemaVersion: 1, planId: accepted.planId };
    await assert.rejects(() => f.owner().replay(request, f.runtime), /checkpoint interruption/u);
    const bytes = await readFile(path.join(f.root, 'Inbox/derived.md'));
    const read = f.sources().notesRead.bind(f.sources());
    f.sources().notesRead = async input => { const result = await read(input); f.revoke(); return result; };
    await assert.rejects(() => f.owner().replay(request, f.runtime), { code: 'unauthenticated' });
    assert.equal(f.metadata().listOpenLoops().length, 0);
    assert.deepEqual(await readFile(path.join(f.root, 'Inbox/derived.md')), bytes);
  } finally { f.close(); await rm(parent, { recursive: true, force: true }); }
});

for (const boundary of ['accept', 'note', 'capture', 'outcome']) {
  test(`SIGKILL at accepted Chat ${boundary} boundary resumes the same frozen mixed plan`, { ...linux, timeout: 30_000 }, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-accepted-chat-death-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/accepted-chat-process-restart.mjs', import.meta.url));
    const start = mode => {
      const child = spawn(process.execPath, [fixturePath, parent, mode, boundary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      const errors = []; child.stderr.on('data', value => errors.push(value));
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, errors: Buffer.concat(errors).toString('utf8') })));
      const message = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('process boundary timed out')), 15_000); child.once('error', reject); child.on('message', value => { if (['boundary', 'completed', 'failed'].includes(value.type)) { clearTimeout(timer); value.type === 'failed' ? reject(new Error(value.message)) : resolve(value); } }); });
      return { child, exited, message };
    };
    let crash, resume;
    try {
      crash = start('crash');
      const reached = await crash.message;
      assert.equal(reached.type, 'boundary');
      crash.child.kill('SIGKILL');
      const killed = await crash.exited;
      assert.deepEqual([killed.code, killed.signal], [null, 'SIGKILL'], killed.errors);
      resume = start('resume');
      const completed = await resume.message;
      const exited = await resume.exited;
      assert.equal(exited.code, 0, exited.errors);
      assert.equal(completed.account.accounted, true);
      assert.equal(completed.loops.length, 2);
      assert.equal(completed.noteOperations, 1);
      assert.equal(completed.account.outcomes.find(item => item.kind === 'information').status, 'quiet');
      if (['capture', 'outcome'].includes(boundary)) {
        const choice = completed.account.outcomes.find(item => item.kind === 'decision');
        assert.equal(choice.status, 'clarified');
        assert.equal(completed.loops.find(loop => loop.loopId === choice.loopId).state, 'resolved');
      }
    } finally {
      for (const running of [crash, resume]) if (running?.child.exitCode === null && running.child.signalCode === null) { running.child.kill('SIGKILL'); await running.exited; }
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
