import assert from 'node:assert/strict';
import test from 'node:test';
import { assessJourneyClaim, JOURNEY_CLAIMS, planAffectedJourneyEvidence, selectAffectedJourneyClaims } from '../src/qualification-evidence.mjs';

const claim = JOURNEY_CLAIMS['accounted-mixed-email'];
const fixture = () => ({
  id: 'accounted-mixed-email', scenario: claim.scenario,
  sourceCommit: 'a'.repeat(40), buildDigest: 'b'.repeat(64), hostCommit: 'c'.repeat(40),
  hostPackageDigest: 'sha256:' + 'd'.repeat(64), runtimeCapabilityDigest: 'sha256:' + 'e'.repeat(64),
  fixtureDigest: 'sha256:' + 'f'.repeat(64),
  execution: { runner: 'test/real-host.acceptance.test.mjs', package: 'installed', host: 'pinned-isolated',
    failureMode: 'process-termination-and-restart', real: claim.real, mocked: claim.mocked },
  evidence: { kind: 'accounted-email', assertionsCompleted: true, actualTermination: 'SIGKILL',
    installedNativePage: true, installedReaderCommand: true, installedRetryCommand: true,
    inspectedDashboard: true, inspectedEvidence: true, inspectedRetainedNote: true,
    supportingNoteTargetRetained: true, supportingNoteUpdated: true, inspectedPaidFollowUp: true,
    nativeReminderCreatedAndCancelled: true, sourceVersion: 'fictional-upstream-1',
    noteVersion: 'sha256:' + '1'.repeat(64), outcomeStatuses: ['clarified', 'applied', 'applied', 'quiet'] }
});

test('changed production owners select the installed mixed-email journey once', () => {
  assert.deepEqual(selectAffectedJourneyClaims(['src/open-loops/intake-accounting.mjs', 'src/dashboard/service.mjs']),
    [{ id: 'accounted-mixed-email', scenario: 'diagnostic-accounted-mixed-email' }]);
  assert.deepEqual(selectAffectedJourneyClaims(['docs/agents/release-policy.md']), []);
  assert.deepEqual(planAffectedJourneyEvidence(['src/open-loops/intake-accounting.mjs', 'src/unknown-owner.mjs']), {
    claims: [{ id: 'accounted-mixed-email', scenario: 'diagnostic-accounted-mixed-email' }],
    unmatchedPaths: ['src/unknown-owner.mjs']
  });
});

test('complete installed evidence records exact identities, real and mocked boundaries', () => {
  const result = assessJourneyClaim(fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.identities.sourceCommit, 'a'.repeat(40));
  assert.deepEqual(result.execution.mocked, ['fictional-model', 'fictional-outlook']);
});

test('fake host, exception-only interruption and missing installed proof remain unproven', () => {
  const original = fixture();
  for (const change of [
    { execution: { ...original.execution, host: 'fake' } },
    { execution: { ...original.execution, failureMode: 'exception-only' } },
    { evidence: { ...original.evidence, actualTermination: 'exception' } },
    { evidence: { ...original.evidence, inspectedDashboard: false } },
    { evidence: { ...original.evidence, noteVersion: original.evidence.sourceVersion } },
    { sourceCommit: undefined }, { scenario: 'diagnostic-ui-desktop' }
  ]) assert.equal(assessJourneyClaim({ ...original, ...change }).status, 'unproven');
  assert.equal(assessJourneyClaim({ ...original, outcome: 'skipped' }).status, 'skipped');
  assert.equal(assessJourneyClaim({ ...original, outcome: 'failed' }).status, 'failed');
});
