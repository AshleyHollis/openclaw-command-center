import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { intakeSourcePlanToolFactory } from '../src/open-loops/source-intake-tool.mjs';
import { createAcceptedChatNoteFixture, mixedChatPlan } from './support/accepted-chat-note-fixture.mjs';

const linux = { skip: process.platform !== 'linux' && 'Real Note publication uses Linux descriptor-relative ownership.' };
function submittedPlan() {
  const { schemaVersion, sessionKey, sessionId, ...plan } = mixedChatPlan();
  return { ...plan, chatCommand: 'accept', enumeration: { scope: 'bounded', scannedCount: 1, remainingCount: 0, failedReadCount: 0, scanCapReached: false, scopeId: 'fictional-submitted-turn', resumeCursor: 'fictional-submission-boundary' } };
}
const request = (chatCommand, planId) => ({ sourceKind: 'chat', chatCommand, planId });
function nativeTool(f, { current = () => {}, runtime = () => f.runtime, scopes = ['operator.write'] } = {}) {
  const commands = Object.fromEntries(['Accept', 'Load', 'Replay'].map(action => [`acceptedChatCapture${action}`, (input, authority) => f.owner()[action.toLowerCase()](input, authority)]));
  const original = runtime();
  return intakeSourcePlanToolFactory({ getOwners: () => ({ metadata: f.metadata() }), acceptedChatCommands: commands })({
    authenticatedOperator: Object.freeze({ profileId: original.principalId, scopes: Object.freeze([...scopes]) }),
    sessionKey: 'agent:main:fictional-chat', sessionId: 'fictional-session-v1', assertInvocationCurrent() { current(); original.assertCurrent(); }
  });
}
async function fixture(action, options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-native-chat-tool-'));
  const f = await createAcceptedChatNoteFixture(parent, options);
  try { await action(f); } finally { f.close(); await rm(parent, { recursive: true, force: true }); }
}

test('native plan tool recovers its submitted mixed extraction through real owners after reopen', linux, async () => {
  await fixture(async f => {
    let guards = 0;
    const tool = () => nativeTool(f, { current: () => { guards++; } });
    const accepted = await tool().execute('fictional-accept', submittedPlan());
    assert.equal(accepted.details.status, 'pending');
    assert.equal(accepted.details.coverage, 'accepted-plan-only');
    assert.equal(accepted.details.sourceCoverage, 'unknown');
    assert.equal(f.metadata().listOpenLoops().length, 0);
    f.reopen();
    const loaded = await tool().execute('fictional-load', request('load', accepted.details.planId));
    assert.equal(loaded.details.planId, accepted.details.planId);
    const replayed = await tool().execute('fictional-replay', request('replay', accepted.details.planId));
    assert.equal(replayed.details.status, 'pending');
    assert.equal(replayed.details.outcomes.length, 4);
    assert.deepEqual(replayed.details.outcomes.map(outcome => outcome.status).sort(), ['applied', 'no-action', 'pending-decision', 'quiet']);
    assert.equal(f.metadata().listOpenLoops().length, 2);
    const note = path.join(f.root, 'Inbox/derived.md');
    await writeFile(note, '# Fictional user edit\n');
    const before = f.metadata().listOperations().length;
    f.reopen();
    assert.deepEqual((await tool().execute('fictional-retry', request('replay', accepted.details.planId))).details, replayed.details);
    assert.equal(f.metadata().listOperations().length, before);
    assert.equal(await readFile(note, 'utf8'), '# Fictional user edit\n');
    assert.ok(guards > 6);
    assert.equal(JSON.stringify(replayed).includes('knowledgeMarkdown'), false);
    assert.equal(JSON.stringify(replayed).includes('fictional-operator'), false);
  });
});

test('unavailable canonical profile refuses before submission despite generic owner and sender facts', async () => {
  let writes = 0;
  const tool = intakeSourcePlanToolFactory({ getOwners: () => ({ metadata: {} }), acceptedChatCommands: {
    acceptedChatCaptureAccept() { writes++; throw new Error('unreachable'); }
  } })({ sessionKey: 'fictional', sessionId: 'fictional', senderIsOwner: true, requesterSenderId: 'fictional-client', assertInvocationCurrent() {} });
  await assert.rejects(() => tool.execute('fictional', submittedPlan()), error => error.code === 'unauthenticated' && /before Chat submission.*unknown/u.test(error.message));
  assert.equal(writes, 0);
});

test('projected read-only operator cannot submit or recover Chat work', linux, async () => {
  await fixture(async f => {
    const accepted = await nativeTool(f).execute('fictional', submittedPlan());
    const readonly = nativeTool(f, { scopes: ['operator.read'] });
    for (const input of [submittedPlan(), request('load', accepted.details.planId), request('replay', accepted.details.planId)])
      await assert.rejects(() => readonly.execute('fictional', input), error => error.code === 'unauthenticated' && /capture write authority/u.test(error.message));
    assert.equal(f.metadata().listOpenLoops().length, 0);
  });
});

test('projected operator revocation during source resolution refuses before acceptance', linux, async () => {
  await fixture(async f => {
    const sources = f.sources(); const resolve = sources.sessionTopicContext;
    sources.sessionTopicContext = async input => { const value = await resolve.call(sources, input); f.revoke(); return value; };
    await assert.rejects(() => nativeTool(f).execute('fictional', submittedPlan()), { code: 'unauthenticated' });
    assert.equal(f.metadata().listOperations().length, 0);
    assert.equal(f.metadata().listOpenLoops().length, 0);
  });
});

test('missing Native V2 guard refuses before resolving operator authority', async () => {
  let resolved = 0;
  const tool = intakeSourcePlanToolFactory({ getOwners: () => ({}) })({ get authenticatedOperator() { resolved++; } });
  await assert.rejects(() => tool.execute('fictional', submittedPlan()), { code: 'unauthenticated' });
  assert.equal(resolved, 0);
});

test('asynchronous invocation guards cannot admit native Chat work', async () => {
  let resolved = 0;
  const tool = intakeSourcePlanToolFactory({ getOwners: () => ({}) })({ get authenticatedOperator() { resolved++; }, async assertInvocationCurrent() {} });
  await assert.rejects(() => tool.execute('fictional', submittedPlan()), { code: 'unauthenticated' });
  assert.equal(resolved, 0);
});

test('queued retirement after closed command completion refuses native result delivery', linux, async () => {
  await fixture(async f => {
    const accepted = await f.owner().accept(mixedChatPlan(), f.runtime);
    let active = true, armed = false, queued = false;
    const original = { principalId: f.runtime.principalId, assertCurrent() {
      f.runtime.assertCurrent();
      if (armed && !queued) { queued = true; queueMicrotask(() => { active = false; }); }
    } };
    const tool = intakeSourcePlanToolFactory({ getOwners: () => ({}),
      acceptedChatCommands: { acceptedChatCaptureLoad(input, authority) { const result = f.owner().load(input, authority); armed = true; return result; } }
    })({ authenticatedOperator: Object.freeze({ profileId: original.principalId, scopes: Object.freeze(['operator.write']) }), assertInvocationCurrent() { if (!active) throw Object.assign(new Error('fictional retired before delivery'), { code: 'unauthenticated' }); original.assertCurrent(); } });
    await assert.rejects(() => tool.execute('fictional', request('load', accepted.planId)), { code: 'unauthenticated' });
    assert.equal(queued, true);
    assert.equal(f.metadata().listOpenLoops().length, 0);
  });
});

test('native turn retirement during real Conversation resolution leaves no accepted plan or effects', linux, async () => {
  await fixture(async f => {
    let active = true;
    const sources = f.sources(); const resolve = sources.sessionTopicContext;
    sources.sessionTopicContext = async input => { const value = await resolve.call(sources, input); active = false; return value; };
    const tool = nativeTool(f, { current() { if (!active) throw Object.assign(new Error('fictional Native turn closed'), { code: 'unauthenticated' }); } });
    await assert.rejects(() => tool.execute('fictional', submittedPlan()), { code: 'unauthenticated' });
    assert.equal(f.metadata().listOperations().length, 0);
    assert.equal(f.metadata().listOpenLoops().length, 0);
  });
});

test('retired native tool cannot replay; fresh original authority can recover the saved plan', linux, async () => {
  await fixture(async f => {
    let active = true;
    const stale = nativeTool(f, { current() { if (!active) throw Object.assign(new Error('fictional Native turn closed'), { code: 'unauthenticated' }); } });
    const accepted = await stale.execute('fictional', submittedPlan()); active = false;
    await assert.rejects(() => stale.execute('fictional', request('replay', accepted.details.planId)), { code: 'unauthenticated' });
    assert.equal(f.metadata().listOpenLoops().length, 0);
    const wrong = nativeTool(f, { runtime: () => ({ ...f.runtime, principalId: 'fictional-other-operator' }) });
    await assert.rejects(() => wrong.execute('fictional', request('replay', accepted.details.planId)), { code: 'unauthenticated' });
    const recovered = (await nativeTool(f).execute('fictional', request('replay', accepted.details.planId))).details;
    assert.equal(recovered.status, 'pending');
    assert.deepEqual(recovered.outcomes.map(outcome => outcome.status).sort(), ['applied', 'no-action', 'pending-decision', 'quiet']);
  });
});

test('closed native commands reject replacement extraction, caller authority and Conversation fields', linux, async () => {
  await fixture(async f => {
    const tool = nativeTool(f);
    for (const chatCommand of ['load', 'replay']) {
      for (const field of ['acceptedExtraction', 'principalId', 'sessionKey'])
        await assert.rejects(() => tool.execute('fictional', { ...request(chatCommand, 'fictional-plan'), [field]: 'fictional' }), { code: 'invalid-request' });
    }
    for (const field of ['sessionKey', 'sessionId', 'acceptedChat', 'principalId'])
      await assert.rejects(() => tool.execute('fictional', { ...submittedPlan(), [field]: 'fictional' }), { code: 'invalid-request' });
    const { chatCommand, ...legacyChat } = submittedPlan();
    await assert.rejects(() => tool.execute('fictional', legacyChat), { code: 'invalid-request' });
    for (const chatCommand of ['constructor', '__proto__'])
      await assert.rejects(() => tool.execute('fictional', { ...submittedPlan(), chatCommand }), { code: 'invalid-request' });
    assert.equal(f.metadata().listOperations().length, 0);
  });
});
