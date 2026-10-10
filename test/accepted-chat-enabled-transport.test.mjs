import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBridgeMethods } from '../src/bridge/register.mjs';
import { FIRST_LIVE_FEATURES } from '../src/release-scope.mjs';
import { createAcceptedChatNoteFixture, mixedChatPlan } from './support/accepted-chat-note-fixture.mjs';

const linux = { skip: process.platform !== 'linux' && 'Real Note owner requires Linux' };

async function transportFixture(options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'command-center-enabled-capture-'));
  const f = await createAcceptedChatNoteFixture(parent, options);
  const handlers = new Map();
  const client = { connId: 'fictional-connection', authenticatedOperatorId: 'fictional-operator', connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
  const connections = new Set([client.connId]);
  const service = Object.fromEntries(['Accept', 'Load', 'Replay'].map(action => [`acceptedChatCapture${action}`, (input, authority) => f.owner()[action.toLowerCase()](input, authority)]));
  registerBridgeMethods({ registerGatewayMethod(name, handler) { handlers.set(name, handler); } }, service);
  return { ...f, client, connections, async request(action, params) {
    let response;
    await handlers.get(`command-center.v1.chat-capture.${action}`)({ req: { id: randomUUID() }, params, client,
      context: { authenticated: true, getClientConnIds: predicate => predicate(client) ? connections : new Set() },
      sessionMutationAuthorization: { assertCurrent() { options.assertAuthority?.(); } },
      respond(...args) { response = args; } });
    return response;
  }, async cleanup() { f.close(); await rm(parent, { recursive: true, force: true }); } };
}

test('enabled TEST transport persists and replays real Note effects after lost response and reopen', linux, async () => {
  assert.equal(FIRST_LIVE_FEATURES.acceptedChatCapture, true);
  let lose = true;
  const f = await transportFixture({ afterAtomicPublish() { if (lose) { lose = false; throw new Error('fictional response lost'); } } });
  try {
    const accepted = await f.request('accept', { schemaVersion: 1, logicalOperationId: randomUUID(), input: mixedChatPlan() });
    assert.equal(accepted[0], true);
    const planId = accepted[1].result.planId;
    assert.equal((await f.request('replay', { schemaVersion: 1, logicalOperationId: randomUUID(), planId }))[0], false);
    f.reopen();
    assert.equal((await f.request('replay', { schemaVersion: 1, logicalOperationId: randomUUID(), planId }))[0], true);
    assert.equal((await f.request('replay', { schemaVersion: 1, logicalOperationId: randomUUID(), planId }))[0], true);
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'notes.create').length, 1);
    assert.equal(f.metadata().listOpenLoops().length, 2);
    const before = JSON.stringify(f.metadata().listOperations());
    f.client.connect.scopes = ['operator.read'];
    for (const action of ['accept', 'load', 'replay']) {
      const params = action === 'accept' ? { schemaVersion: 1, logicalOperationId: randomUUID(), input: mixedChatPlan() } : { schemaVersion: 1, planId, ...(action === 'replay' ? { logicalOperationId: randomUUID() } : {}) };
      assert.equal((await f.request(action, params))[0], false);
    }
    assert.equal(JSON.stringify(f.metadata().listOperations()), before);
    assert.equal(await readFile(path.join(f.root, 'Inbox/derived.md'), 'utf8'), mixedChatPlan().acceptedExtraction.knowledgeMarkdown);
  } finally { await f.cleanup(); }
});

test('registered transport retirement at final Note fence follows publication and refuses completion', linux, async () => {
  const ordering = [];
  let armed = false, queued = false, f;
  f = await transportFixture({ beforeAtomicCommit() { armed = true; }, assertAuthority() {
    if (armed && !queued) { queued = true; queueMicrotask(() => { ordering.push('retired'); f.connections.clear(); }); }
  }, afterAtomicPublish() { ordering.push('published'); } });
  try {
    const accepted = await f.request('accept', { schemaVersion: 1, logicalOperationId: randomUUID(), input: mixedChatPlan() });
    assert.equal(accepted[0], true);
    const replay = await f.request('replay', { schemaVersion: 1, logicalOperationId: randomUUID(), planId: accepted[1].result.planId });
    assert.equal(replay[0], false);
    assert.equal(replay[2].code, 'unauthenticated');
    assert.deepEqual(ordering, ['published', 'retired']);
    assert.equal(f.metadata().listOpenLoops().length, 0);
    assert.equal(f.metadata().listOperations().filter(item => item.operationKind === 'intake-outcome.chat.v1').length, 0);
  } finally { await f.cleanup(); }
});
