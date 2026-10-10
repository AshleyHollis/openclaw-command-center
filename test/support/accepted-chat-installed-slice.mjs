import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { loadIntakeSourceAccount } from '../../src/open-loops/intake-accounting.mjs';
import { requestAuthenticatedGateway } from './real-host-runtime.mjs';

// One slice in the existing isolated acceptance runner, not another host launcher.
export async function exerciseInstalledAcceptedChat({ world, fixture, restartHost, signal }) {
  const call = async (action, params, scopes = ['operator.read', 'operator.write']) => {
    const response = await requestAuthenticatedGateway({ gatewayUrl: world.gateway.url, credential: world.gatewayCredential,
      method: `command-center.v1.chat-capture.${action}`, params, scopes, signal, responseTimeoutMs: 15_000 });
    return response.result ?? response;
  };
  const plan = { schemaVersion: 1, sessionKey: fixture.sessionKey, sessionId: fixture.sessionId,
    sourceKind: 'chat', sourceExternalId: 'fictional-installed-accepted-chat', sourceVersion: 'fictional-v1',
    checkpoint: 'fictional-installed-checkpoint', observedAt: '2026-10-01T01:00:00.000Z', processorVersion: 'fictional-installed-v1',
    acceptedExtraction: { schemaVersion: 1, proposedTopic: fixture.name, notePath: 'Captured.md',
      knowledgeMarkdown: '# Fictional captured knowledge\nKeep this reference.\n', knowledgeOutcomeId: 'fictional-information',
      obligations: [{ obligationId: 'fictional-reply', title: 'Reply with fictional reference', provenance: 'explicit', classification: 'obligation' }] },
    outcomes: [{ outcomeId: 'fictional-reply', kind: 'obligation' }, { outcomeId: 'fictional-information', kind: 'information' }] };
  const sourceBytes = await readFile(path.join(fixture.folder, fixture.notePath));
  const accepted = await call('accept', { schemaVersion: 1, logicalOperationId: randomUUID(), input: plan });
  assert.equal(accepted.coverage, 'accepted-plan-only');
  assert.equal(accepted.sourceCoverage, 'unknown');
  const planId = accepted.planId;
  // Real process termination after durable acceptance, before any source effect.
  await restartHost();
  assert.equal((await call('load', { schemaVersion: 1, planId })).planId, planId);
  for (const action of ['accept', 'load', 'replay']) {
    const params = action === 'accept' ? { schemaVersion: 1, logicalOperationId: randomUUID(), input: plan }
      : { schemaVersion: 1, planId, ...(action === 'replay' ? { logicalOperationId: randomUUID() } : {}) };
    await assert.rejects(() => call(action, params, ['operator.read']), /(?:unauthenticated|unauthorized|scope|permission)/iu);
  }
  const replay = () => call('replay', { schemaVersion: 1, logicalOperationId: randomUUID(), planId });
  const firstReplay = await replay(); // Completed effects; lost response is a separate owner fixture.
  const beforeRestart = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw'), readOnly: true });
  let ownerIdentities;
  try { ownerIdentities = JSON.stringify({ operations: beforeRestart.listOperations(), loops: beforeRestart.listOpenLoops() }); }
  finally { beforeRestart.close(); }
  await restartHost();
  const resumed = await replay();
  assert.deepEqual(resumed, firstReplay);
  assert.deepEqual(resumed.outcomes.map(item => item.status), ['applied', 'quiet']);
  await assert.rejects(() => call('accept', { schemaVersion: 1, logicalOperationId: randomUUID(), input: { ...plan, acceptedExtraction: { ...plan.acceptedExtraction, knowledgeMarkdown: 'Changed fictional intent' } } }));
  const metadata = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw'), readOnly: true });
  let originalOperations;
  try {
    assert.equal(JSON.stringify({ operations: metadata.listOperations(), loops: metadata.listOpenLoops() }), ownerIdentities);
    const account = loadIntakeSourceAccount(metadata, plan).account;
    assert.equal(account.accounted, true);
    assert.equal(metadata.listOperations().filter(item => item.operationKind === 'notes.create').length, 1);
    assert.equal(metadata.listOpenLoops().length, 1);
    assert.equal(metadata.listOperations().filter(item => item.operationKind === 'intake-outcome.chat.v1').length, 2);
    originalOperations = JSON.stringify(metadata.listOperations());
  } finally { metadata.close(); }
  assert.deepEqual(await readFile(path.join(fixture.folder, fixture.notePath)), sourceBytes);
  const notePath = path.join(fixture.folder, plan.acceptedExtraction.notePath);
  assert.equal(await readFile(notePath, 'utf8'), plan.acceptedExtraction.knowledgeMarkdown);
  const edited = '# Fictional user edit\nPreserve after accounted replay.\n';
  await writeFile(notePath, edited);
  await replay();
  assert.equal(await readFile(notePath, 'utf8'), edited);
  const after = openCommandCenterMetadataService({ stateDir: path.join(world.root, '.openclaw'), readOnly: true });
  try { assert.equal(JSON.stringify(after.listOperations()), originalOperations); } finally { after.close(); }
  const displaced = `${fixture.folder}-displaced`;
  await rename(fixture.folder, displaced);
  await assert.rejects(replay);
  assert.equal(await readFile(path.join(displaced, plan.acceptedExtraction.notePath), 'utf8'), edited);
  return Object.freeze({ schemaVersion: 1, acceptedDurableBeforeRestart: true, replayAfterProcessTermination: true,
    changedIntentRefused: true, readOnlyScopeRefused: true, stablePrincipalAcrossConnectionsAndRestart: true,
    noteCount: 1, loopCount: 1, outcomeCount: 2, userEditPreserved: true, sourceBytesPreserved: true,
    replacedFolderRefused: true, sourceCoverage: 'unknown', ownerRetirementProof: 'separate-real-owner-regression',
    fixtureDigest: `sha256:${createHash('sha256').update(JSON.stringify(plan.acceptedExtraction)).digest('hex')}` });
}
