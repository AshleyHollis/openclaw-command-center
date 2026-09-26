# Installed journey evidence map

Use `node scripts/plan-affected-journeys.mjs origin/main` on a candidate branch to
see which declared production owners changed. The planner reports the matching
focused scenario and lists unmatched paths for manual review. Apply the release
class in [release policy](release-policy.md) to the actual behavior changed;
this map selects a journey, not a cheaper release class or a gate waiver.

| Claim | Production entry and invariant owners | Required scenario | Real and mocked boundaries |
| --- | --- | --- | --- |
| Accounted mixed email | Registered intake commands in `src/plugin.mjs`, the email intake/receipt and recovery owners in `src/open-loops/`, Dashboard/Attention projections and native UI, installed reader/retry command in `src/migration/reconcile-cli.mjs` | `diagnostic-accounted-mixed-email` | Real installed plugin, pinned isolated host, SQLite, native Control UI and registered commands; fictional model and fictional Outlook response |

The scenario in `test/real-host.acceptance.test.mjs` emits a
`qualification-claim=` diagnostic only after its public and durable assertions
pass. The record includes the source commit, plugin build digest, host commit,
host package digest, runtime contract digest and fixture digest. It names the
real and mocked boundaries and the actual `SIGKILL`/restart proof. The
assessment returns `unproven` for fake-host evidence, exception-only simulation,
missing identities, missing UI inspection, or an upstream revision confused
with the Note revision. `failed` and `skipped` remain separate statuses.

The synthetic provider and registered-command unit tests remain useful focused
diagnostics. They cannot be cited as installed-host or process-death proof.
Unmatched changed paths require manual owner mapping before making a journey
claim. Reuse an earlier passed record only while its source, build, host,
runtime contract, fixture, owner dependencies and selected release profile
remain applicable. Preserve failed and unproven records rather than replacing
them with aggregate suite counts.
