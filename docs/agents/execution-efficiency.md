# Command Center execution efficiency

Keep one reviewable outcome per batch. A focused diagnostic may answer a design or integration question, but it does not replace the release-policy evidence for the final candidate.

## Fast admission before an isolated host journey

Use a Linux-local source snapshot, Linux-installed dependencies and an isolated temporary state directory. Record the source commit, package lockfile, build digest, host commit and package digest before testing. Preserve earlier artifacts and logs; do not relabel a build after source changes. Normalize permissions on a Windows-to-Linux copy before packaging or testing. OpenClaw rejects a world-writable plugin path or entry file.

After packaging, run the read-only admission gate from the candidate root with the same environment as the intended acceptance run:

```sh
COMMAND_CENTER_ISOLATED_HOST="$(cat /path/to/isolated-host/descriptor.json)" \
COMMAND_CENTER_SEALED_CANDIDATE=1 \
COMMAND_CENTER_ACCEPTANCE_SCENARIO=diagnostic-clarification-worker \
node scripts/preflight-isolated-acceptance.mjs
```

The gate checks the exact harness host pin, checkout/receipt/installed-build identity, candidate file permissions, sealed plugin build receipt, and the installed `cron.add` schema when the journey needs a bound Reminder ID. It makes no Gateway request and does not read a mailbox or mutate state. It is a fast rejection gate, not full host-integrity verification or installed-package proof. The acceptance harness repeats the gate and stops before starting a slice if preparation fails.

Use the smallest relevant scenario after admission. Run focused tests while the code changes; run an installed journey when the package is stable; run the selected release-policy qualification on the final candidate. Do not repeat an unaffected expensive suite merely to refresh its timestamp. A dependency on an unmerged OpenClaw capability must be tested on its exact pinned candidate host and reported separately from the deployed host.

## Batch checkpoint template

- Outcome and repository: canonical path, branch, source commit, clean/dirty state, preserved worktrees.
- Authorization and scope: allowed local work; any separate personal-data, automation or deployment action.
- Evidence: focused tests, exact plugin build/archive digest, host commit/package digest, isolated scenario, UI inspection, process-death boundary, and whether external services were fictional.
- Limits: failed/skipped checks, unproven journeys, external dependencies, and live state left unchanged.
- Next action: one concrete reviewable batch and its smallest qualifying test.
