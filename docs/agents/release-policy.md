# Risk-based delivery policy

This policy selects release evidence from the behavior a change can affect.
It replaces the blanket assumption that every plugin deployment needs the
complete storage, performance, and host-runtime qualification suite. Correctness
requirements in [mutation policy](mutations.md) still apply whenever their
owner changes.

Record the selected class and the files or behavior that caused it in the pull
request. A mixed pull request uses its highest applicable class. Split changes
that can be deployed independently when doing so lowers the class of an earlier
useful release. Do not split one invariant, migration, or recovery contract
across releases merely to obtain a lower class.

## Class 1 — presentation and read-only delivery

Use Class 1 when the change can affect only presentation, client-side
interaction, static assets, read-only projections, or documentation. It must
not change a write command, persisted representation, producer, background
worker, permission boundary, OpenClaw compatibility pin, package lifecycle, or
deployment configuration.

Required evidence:

- repository safety and architecture checks;
- focused unit and browser tests for the changed surface;
- a successful candidate package build;
- one installed-package journey for every materially changed page, at the
  relevant desktop or phone viewport; and
- visual inspection when layout, styling, focus, responsive behavior, or
  information hierarchy changed.

Class 1 does not require the full real-host performance scenario, Btrfs crash
suite, two independent diagnostic lanes, or a new host receipt. Existing host
evidence may be reused while the exact OpenClaw commit, image digest, plugin API
contract, and runtime capability contract remain unchanged.

Target: a qualified candidate within 30 minutes of green CI.

## Class 2 — compatible plugin behavior

Use Class 2 for plugin behavior that remains inside an existing public contract
and storage schema, including read adapters, projections, classifiers, and
changes to an already qualified owner that do not add or alter an external
effect or recovery boundary.

Required evidence:

- all Class 1 evidence that applies;
- focused integration tests through the real public plugin interface;
- real SQLite or filesystem tests when the changed behavior reads those
  boundaries;
- restart or concurrency tests only for guarantees the change claims; and
- installed-package proof of the changed journey on the pinned supported host.

Run performance qualification only when startup, page-load, search, projection
volume, polling, or another measured path changed materially. Run a particular
failure-contract scenario only when its owner or shared dependency changed.

Target: a qualified candidate within 60 minutes of green CI.

## Class 3 — protected state or platform change

Use Class 3 for any change to:

- a write command, external effect, conditional update, operation journal,
  recovery or compensation behavior;
- database schema, migration, durable source identity, Note filesystem write,
  initial population, or backfill application/withdrawal;
- authentication, authorization, source scanning, notifications, automation,
  producer activation, or live routing;
- OpenClaw compatibility, host image, runtime capability, package installation,
  startup, or deployment configuration; or
- a shared dependency whose failure could corrupt or misattribute user state.

Class 3 retains the affected real-owner failure-contract tests from
[mutation policy](mutations.md), Linux/Btrfs evidence where filesystem or crash
semantics require it, installed-package qualification, independent final review,
and the normal backup, rollback, GitOps, and live smoke-test admission. Run the
full performance scenario only when a measured path or its pinned identity
changed; otherwise carry forward the still-valid performance receipt and name
its exact candidate and host limits.

Personal-data reads, producer activation, backfill application, message sending,
payments, notification cutover, and automation changes remain separate operator
actions. A successful Class 3 plugin deployment does not authorize them.

Target: affected qualification in 1–3 hours after green CI. External review,
runner availability, and deployment reconciliation are reported separately.

## Evidence reuse and invalidation

Evidence is reusable only when every identity relevant to its claim is
unchanged. Record the source commit, plugin build digest, OpenClaw commit and
image digest, runtime capability digest, fixture or baseline digest, and
scenario name as applicable.

Reuse is invalid when the changed files or dependency graph can affect the
scenario, when a pin changes, or when the earlier result has an unresolved
failure. A timestamp alone neither validates nor invalidates evidence. Never
rerun an unaffected expensive suite only to make its timestamp newer.

One final review of the complete candidate replaces repeated independent review
of every intermediate batch. Intermediate batch reviews remain useful for a
high-risk owner or when they unblock parallel work, but they are not a default
release gate.

Only checks required by the repository ruleset or named by the selected class
are release gates. An optional third-party integration that is not configured
for this repository is advisory; record its configuration error, confirm that
it is not required, and continue using the repository-owned safety and package
workflows. Do not add duplicate tooling solely to turn an advisory status green.

## Deployment sequence

1. Classify the diff before implementation and again on the final diff.
2. Run focused checks while developing, then the selected class once on the
   exact candidate.
3. Build and identify the package once. Deployment consumes that exact artifact;
   it does not rebuild from an unverified checkout.
4. Merge after required review and CI, update the reviewed GitOps pin, and wait
   for reconciliation.
5. Run the class-appropriate live smoke test. Roll back to the previous package
   pin if it fails.

For combined milestones, prefer this order when the pieces are independently
useful: Class 1 workspace UI, Class 2 read-only intake/preview, then Class 3
producer activation or state mutation. This makes visible progress available
without weakening the later mutation gate.
