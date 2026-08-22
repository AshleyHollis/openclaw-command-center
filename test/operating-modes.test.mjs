import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCommandCenterMetadataService as openMetadataService } from '../src/metadata/service.mjs';
import { resolveCommandCenterDatabasePath } from '../src/metadata/path.mjs';
import { evaluateOperatingMode } from '../src/metadata/modes.mjs';

const openServices = new Set();
function openCommandCenterMetadataService(options) {
  const service = openMetadataService(options);
  openServices.add(service);
  return service;
}

async function withState(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-center-modes-'));
  try { return await run(stateDir); } finally {
    for (const service of openServices) service.close();
    openServices.clear();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function seedSources(stateDir) {
  const service = openCommandCenterMetadataService({ stateDir });
  service.createTopic({ topicId: 'topic-modes', paraCategory: 'area', lifecycle: 'active' });
  service.close();
}

const sourceCases = Object.freeze([
  { capability: 'notes', referenceId: 'ref-folder', sourceSystem: 'obsidian', sourceKind: 'note_folder', externalSourceId: 'folder-modes' },
  { capability: 'sessions', referenceId: 'ref-session', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'session-modes' },
  { capability: 'scheduler', referenceId: 'ref-schedule', sourceSystem: 'scheduler', sourceKind: 'reminder_schedule', externalSourceId: 'schedule-modes' }
]);

test('Ready and every single or combined Degraded capability report gate only mapped source mutations', async () => {
  const capabilitySets = [
    [], ['notes'], ['sessions'], ['scheduler'],
    ['notes', 'sessions'], ['notes', 'scheduler'], ['sessions', 'scheduler'],
    ['notes', 'sessions', 'scheduler']
  ];
  for (const unavailable of capabilitySets) {
    await withState(async (stateDir) => {
      seedSources(stateDir);
      const capabilities = Object.fromEntries(unavailable.map((capability) => [capability, { available: false }]));
      const service = openCommandCenterMetadataService({ stateDir, capabilities });
      const status = service.getOperatingStatus();
      assert.equal(status.mode, unavailable.length === 0 ? 'ready' : 'degraded');
      assert.deepEqual(status.unavailableCapabilities, unavailable);
      assert.deepEqual(status.diagnostics.map((item) => item.capability), unavailable);
      assert.ok(status.diagnostics.every((item) => item.explanation.length > 0 && item.remediation.length > 0));

      service.createTopic({ topicId: 'topic-core', paraCategory: 'resource', lifecycle: 'active' });
      service.setPresentationPreferences({ topicId: 'topic-core', displayLabel: 'Core metadata', sortOrder: 1, collapsed: false });
      service.setProposalState({ proposalId: 'proposal-modes', topicId: 'topic-core', state: 'pending' });
      service.setPolicyVersion({ policyId: 'policy-modes', version: 'v1', digest: 'digest-modes' });
      service.setProjectionBookkeeping({ projectionId: 'projection-modes', sourceRevision: 'revision-modes', inputDigest: 'digest-modes' });
      service.linkAttentionActivity({ linkId: 'link-modes', attentionId: 'attention-modes', activityId: 'activity-modes', topicId: 'topic-core' });

      for (const sourceCase of sourceCases) {
        const { capability, ...reference } = sourceCase;
        const create = () => service.createSourceReference({ ...reference, topicId: 'topic-modes' });
        if (unavailable.includes(sourceCase.capability)) {
          assert.throws(create, (error) => error.code === 'capability-unavailable' && error.capability === capability);
        } else {
          assert.equal(create().sourceKind, sourceCase.sourceKind);
        }
      }
      assert.equal(service.getTopic('topic-core').paraCategory, 'resource');
      service.close();

      const reopened = openCommandCenterMetadataService({ stateDir });
      assert.equal(reopened.getPolicyVersion('policy-modes').version, 'v1');
      assert.equal(reopened.getProjectionBookkeeping('projection-modes').sourceRevision, 'revision-modes');
      for (const sourceCase of sourceCases) {
        assert.equal(reopened.getSourceReference(sourceCase.referenceId)?.sourceKind ?? null, unavailable.includes(sourceCase.capability) ? null : sourceCase.sourceKind);
      }
      reopened.close();
    });
  }
});

test('Recovery-only rejects every public mutation path and remains unchanged across reopen', async () => {
  await withState(async (stateDir) => {
    const databasePath = resolveCommandCenterDatabasePath(stateDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const incompatible = new DatabaseSync(databasePath);
    try {
      incompatible.exec('CREATE TABLE fictional_future_marker (id TEXT) STRICT; PRAGMA user_version = 99;');
    } finally {
      incompatible.close();
    }
    const before = await readFile(databasePath);
    const beforeMtime = (await stat(databasePath)).mtimeMs;
    const beforeSiblings = (await readdir(path.dirname(databasePath))).sort();

    const service = openCommandCenterMetadataService({ stateDir });
    assert.deepEqual(service.getOperatingStatus(), {
      mode: 'recovery-only', schemaVersion: null, unavailableCapabilities: [],
      diagnostics: [{
        code: 'future-schema', mode: 'recovery-only', capability: null,
        summary: 'The Command Center database uses a newer schema version.',
        explanation: 'The Command Center database uses a newer schema version.',
        remediation: 'Upgrade Command Center to a compatible version; no automatic migration is attempted.'
      }]
    });
    const mutations = [
      () => service.createTopic({ topicId: 'blocked-topic', paraCategory: 'area', lifecycle: 'active' }),
      () => service.updateTopic({ topicId: 'blocked-topic', paraCategory: 'archive' }),
      () => service.deleteTopic('blocked-topic'),
      () => service.createSourceReference({ referenceId: 'blocked-ref', topicId: 'blocked-topic', sourceSystem: 'openclaw', sourceKind: 'session', externalSourceId: 'blocked-source' }),
      () => service.updateSourceReference({ referenceId: 'blocked-ref', updatedAt: '2026-08-22T00:00:00Z' }),
      () => service.deleteSourceReference('blocked-ref'),
      () => service.setSourceConventionState({ referenceId: 'blocked-ref', aspect: 'name', state: 'managed' }),
      () => service.setPresentationPreferences({ topicId: 'blocked-topic', displayLabel: 'Blocked', sortOrder: 0, collapsed: false }),
      () => service.linkAttentionActivity({ linkId: 'blocked-link', attentionId: 'blocked-attention', activityId: 'blocked-activity' }),
      () => service.deleteAttentionActivityLink('blocked-link'),
      () => service.setProposalState({ proposalId: 'blocked-proposal', topicId: 'blocked-topic', state: 'pending' }),
      () => service.setPolicyVersion({ policyId: 'blocked-policy', version: 'v1', digest: 'blocked-digest' }),
      () => service.setProjectionBookkeeping({ projectionId: 'blocked-projection', sourceRevision: 'blocked-revision', inputDigest: 'blocked-digest' }),
      () => service.setConventionState({ referenceId: 'blocked-ref', aspect: 'name', state: 'managed' }),
      () => service.createAttentionActivityLink({ linkId: 'blocked-alias-link', attentionId: 'blocked-attention', activityId: 'blocked-activity' }),
      () => service.upsertPolicyVersion({ policyId: 'blocked-alias-policy', version: 'v1', digest: 'blocked-digest' }),
      () => service.upsertProjectionBookkeeping({ projectionId: 'blocked-alias-projection', sourceRevision: 'blocked-revision', inputDigest: 'blocked-digest' })
    ];
    for (const mutate of mutations) assert.throws(mutate, (error) => error.code === 'recovery-only');
    service.close();

    const reopened = openCommandCenterMetadataService({ stateDir });
    assert.equal(reopened.getOperatingStatus().diagnostics[0].code, 'future-schema');
    assert.throws(() => reopened.setPolicyVersion({ policyId: 'still-blocked', version: 'v1', digest: 'blocked' }), (error) => error.code === 'recovery-only');
    reopened.close();
    assert.deepEqual(await readFile(databasePath), before);
    assert.equal((await stat(databasePath)).mtimeMs, beforeMtime);
    assert.deepEqual((await readdir(path.dirname(databasePath))).sort(), beforeSiblings);
  });
});

test('unsupported capabilities are rejected rather than becoming policy', async () => {
  await withState(async (stateDir) => {
    assert.throws(() => openCommandCenterMetadataService({ stateDir, capabilities: { archives: { available: false } } }), /Unsupported capability/);
  });
});

test('unknown core mode inputs fail closed instead of defaulting to Ready', () => {
  const status = evaluateOperatingMode({ core: { mode: 'unexpected', schemaVersion: 1, diagnostics: [] }, capabilities: {} });
  assert.equal(status.mode, 'recovery-only');
  assert.equal(status.diagnostics[0].code, 'unknown-core-state');
  assert.deepEqual(status.unavailableCapabilities, []);
});
