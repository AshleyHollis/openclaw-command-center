// A claim names the production owners and the exact installed journey that
// can establish it. A focused fake-host test is useful diagnosis, not proof.
export const JOURNEY_CLAIMS = Object.freeze({
  'accounted-mixed-email': Object.freeze({
    scenario: 'diagnostic-accounted-mixed-email',
    owners: Object.freeze([
      'src/open-loops/commitment-capture.mjs', 'src/open-loops/intake-accounting.mjs',
      'src/open-loops/intake-receipt.mjs', 'src/open-loops/producer-intake.mjs',
      'src/open-loops/source-intake-tool.mjs', 'src/open-loops/email-reader-plan.mjs',
      'src/open-loops/reminder-coordinator.mjs', 'src/dashboard/service.mjs',
      'src/metadata/service.mjs', 'src/native-ui/attention-page.mjs',
      'src/plugin.mjs', 'src/plugin-service.mjs', 'src/migration/reconcile-cli.mjs'
    ]),
    real: Object.freeze(['installed-plugin', 'pinned-host', 'sqlite', 'native-control-ui', 'registered-intake-commands']),
    mocked: Object.freeze(['fictional-model', 'fictional-outlook'])
  })
});

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/u;

export function selectAffectedJourneyClaims(paths) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new TypeError('Changed paths must be strings');
  return Object.freeze(Object.entries(JOURNEY_CLAIMS).filter(([, claim]) =>
    paths.some(path => claim.owners.some(owner => matchesOwner(path, owner)))
  ).map(([id, claim]) => Object.freeze({ id, scenario: claim.scenario })));
}

function matchesOwner(path, owner) { return owner.endsWith('/') ? path.startsWith(owner) : path === owner; }

export function planAffectedJourneyEvidence(paths) {
  const claims = selectAffectedJourneyClaims(paths);
  const unmatchedPaths = paths.filter(path => !Object.values(JOURNEY_CLAIMS).some(claim =>
    claim.owners.some(owner => matchesOwner(path, owner))));
  return Object.freeze({ claims, unmatchedPaths: Object.freeze(unmatchedPaths) });
}

export function assessJourneyClaim({ id, scenario, sourceCommit, buildDigest, hostCommit, hostPackageDigest,
  runtimeCapabilityDigest, fixtureDigest, execution, evidence, outcome = 'passed' } = {}) {
  const claim = JOURNEY_CLAIMS[id];
  if (!claim) throw new TypeError(`Unknown journey claim: ${id}`);
  const identities = { sourceCommit, buildDigest, hostCommit, hostPackageDigest, runtimeCapabilityDigest, fixtureDigest };
  const validIdentities = SHA.test(sourceCommit) && SHA.test(hostCommit)
    && [buildDigest, hostPackageDigest, runtimeCapabilityDigest, fixtureDigest].every(value => DIGEST.test(value));
  const installed = execution?.runner === 'test/real-host.acceptance.test.mjs'
    && execution?.package === 'installed'
    && execution?.host === 'pinned-isolated'
    && execution?.failureMode === 'process-termination-and-restart'
    && JSON.stringify(execution.real) === JSON.stringify(claim.real)
    && JSON.stringify(execution.mocked) === JSON.stringify(claim.mocked);
  const proof = evidence?.kind === 'accounted-email' && evidence.assertionsCompleted === true
    && evidence.actualTermination === 'SIGKILL' && evidence.installedNativePage === true
    && evidence.installedReaderCommand === true && evidence.installedRetryCommand === true
    && evidence.inspectedDashboard === true && evidence.inspectedEvidence === true
    && evidence.inspectedRetainedNote === true && evidence.supportingNoteTargetRetained === true
    && evidence.supportingNoteUpdated === true && evidence.inspectedPaidFollowUp === true
    && evidence.nativeReminderCreatedAndCancelled === true
    && typeof evidence.sourceVersion === 'string' && evidence.sourceVersion.length > 0
    && DIGEST.test(evidence.noteVersion) && evidence.sourceVersion !== evidence.noteVersion
    && JSON.stringify(evidence.outcomeStatuses) === JSON.stringify(['clarified', 'applied', 'applied', 'quiet']);
  const status = outcome === 'failed' ? 'failed' : outcome === 'skipped' ? 'skipped'
    : scenario === claim.scenario && validIdentities && installed && proof && outcome === 'passed' ? 'passed' : 'unproven';
  return Object.freeze({ schemaVersion: 1, id, scenario: claim.scenario, status,
    ownerPaths: claim.owners, identities, execution: Object.freeze({
      runner: execution?.runner ?? null, package: execution?.package ?? null, host: execution?.host ?? null,
      failureMode: execution?.failureMode ?? null, real: execution?.real ?? [], mocked: execution?.mocked ?? []
    }) });
}
