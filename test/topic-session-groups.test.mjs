import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService } from '../src/metadata/service.mjs';
import { AuthoritativeSourceService } from '../src/sources/service.mjs';
import { invokeBridgeMethod } from '../src/bridge/register.mjs';

async function fixture(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'topic-native-group-'));
  const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { sessions: true } });
  const topicId = '44444444-4444-4444-8444-444444444444';
  const sessionKey = 'agent:main:dashboard:fixture';
  metadata.createTopic({ topicId, name: 'Sample Project', paraCategory: 'project', lifecycle: 'active' });
  metadata.createSessionBinding({ reference: { version: 1, referenceId: 'fixture-ref', topicId, sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: sessionKey, observedRevision: '10' }, state: { referenceId: 'fixture-ref', sessionId: 'original', status: 'open', isPrimary: true, displayName: 'Overview' } });
  const entry = { sessionId: 'original', lifecycleRevision: 'lifecycle-one', updatedAt: 10 };
  let effects = 0;
  let beforeCommit = () => {};
  let afterCommit = () => {};
  const sessionStore = {
    listSessionEntries: () => [{ sessionKey, entry }],
    // Native owner is external to this suite. It invokes the actual domain
    // callback/commit predicate; host conformance tests own native SQLite CAS.
    async patchSessionEntry(params) {
      assert.equal(params.sessionKey, sessionKey); assert.equal(params.preserveActivity, true);
      const patch = await params.update(structuredClone(entry));
      beforeCommit(); params.assertCommitAllowed();
      Object.assign(entry, patch); effects++; afterCommit(); return { ...entry };
    }
  };
  const service = new AuthoritativeSourceService({ metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  let allowed = true;
  const runtime = { creationAuthority: { principalId: 'fixture-operator', assertCurrent() { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'unauthenticated' }); } } };
  const input = { schemaVersion: 1, topicId, logicalOperationId: randomUUID(), referenceId: 'fixture-ref', expectedSessionId: 'original', expectedLifecycleRevision: 'lifecycle-one', expectedTopicRevision: 0, name: 'Sample Project' };
  const apply = (command = input) => invokeBridgeMethod(service, 'command-center.v1.sessions.group', command, null, null, runtime);
  try { await run({ metadata, entry, input, apply, service, runtime, sessionStore, effects: () => effects, revoke: () => { allowed = false; }, before: fn => { beforeCommit = fn; }, after: fn => { afterCommit = fn; } }); }
  finally { metadata.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('explicit grouping preserves native activity and durable Topic identity; retry cannot reclaim a user-moved group', () => fixture(async ({ entry, input, apply, service, effects }) => {
  const plan = await invokeBridgeMethod(service, 'command-center.v1.sessions.group-preview', { schemaVersion: 1, topicId: input.topicId });
  assert.equal(plan.members[0].eligible, true);
  const receipt = await apply();
  assert.equal(receipt.status, 'applied'); assert.equal(entry.category, 'Sample Project'); assert.equal(entry.updatedAt, 10);
  entry.category = 'User group';
  assert.deepEqual(await apply(), receipt); assert.equal(effects(), 1); assert.equal(entry.category, 'User group');
  assert.equal((await service.sessionGroupPreview({ topicId: input.topicId })).members[0].eligible, false);
}));

for (const change of ['category', 'sessionId', 'lifecycleRevision']) test(`grouping refuses stale native ${change}`, () => fixture(async ({ entry, apply, effects }) => {
  entry[change] = 'replacement';
  await assert.rejects(apply(), /changed|grouped/); assert.equal(effects(), 0);
}));

test('grouping authority is checked again at native commit', () => fixture(async ({ before, revoke, apply, effects }) => {
  before(revoke); await assert.rejects(apply(), /revoked/); assert.equal(effects(), 0);
}));

test('a Topic revision changed during native grouping preparation prevents the effect', () => fixture(async ({ before, metadata, input, apply, effects }) => {
  before(() => metadata.setTopicName({ topicId: input.topicId, name: 'Renamed project', expectedRevision: 0 }));
  await assert.rejects(apply(), /binding changed/);
  assert.equal(effects(), 0);
}));

test('a lost native grouping reply remains unknown and never retries the effect', () => fixture(async ({ after, apply, entry, effects, metadata, input, runtime, sessionStore }) => {
  after(() => { throw Object.assign(new Error('lost reply'), { code: 'unavailable' }); });
  await assert.rejects(apply(), /ambiguous/);
  assert.equal(metadata.getOperation(input.logicalOperationId).state, 'unknown');
  entry.category = 'User group';
  const restartedOwner = new AuthoritativeSourceService({ metadata, sessionStore, capabilities: { sessions: true, notes: false, scheduler: false } });
  await assert.rejects(restartedOwner.sessionGroup(input, runtime), /ambiguous/);
  assert.equal(effects(), 1); assert.equal(entry.category, 'User group');
}));

test('an old grouping operation cannot be reused with different original intent', () => fixture(async ({ apply, input, effects }) => {
  await apply();
  await assert.rejects(apply({ ...input, expectedLifecycleRevision: 'other' }), /different intent/);
  assert.equal(effects(), 1);
}));
