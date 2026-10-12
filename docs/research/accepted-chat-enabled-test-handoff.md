# Accepted Chat enabled TEST candidate

This separate candidate enables only `acceptedChatCapture` for isolated qualification. Production PR386 remains disabled at `c0ceacd1100843fa5db1c0f2f5cbb12b231341de`. Note maintenance and its triggers remain disabled. Do not install this TEST package into production or activate a personal producer.

The feature durably accepts an explicitly submitted, frozen Chat extraction and replays it through the existing Note, commitment and intake accounting owners. Native Chat acknowledgement is unchanged. Unsubmitted-message coverage remains unknown; this is not automatic capture of every native Chat message.

## Existing installed-pair journey

`diagnostic-accepted-chat` selects one slice in `test/real-host.acceptance.test.mjs`, using the existing isolated fixture, real native `sessions.create`, host launcher/restart/cleanup, bridge transport and admission gate. `test/support/accepted-chat-installed-slice.mjs` supplies fictional extraction content. No replacement host framework or queue is introduced.

The installed slice requires successful accept, process termination before effects, load after restart, write-scope loss refusing all three commands, replay, a second process termination after effects, unchanged replay, changed-intent refusal, one Note creation/one loop/two outcomes, preserved source bytes, preserved edited Note and unchanged journals, and displaced Note Folder refusal. Each request uses a fresh socket: successful load/replay must prove the host-attested principal remains stable across reconnects and restarts. Never substitute a connection ID or caller-supplied principal.

The registered transport/real Note owner regression separately injects a lost response after atomic publication, reopens SQLite and checks exactly-once effects. Another regression retires authority at the final fence: publication occurs without yielding, then completion refuses without loops or accounted outcomes. The installed restart-after-effects test does not simulate a lost response or prove in-flight permission revocation.

## Admission and bounded execution

Only the qualification owner may execute this handoff after assembling and sealing the exact pair. From its Linux-local candidate copy, with the descriptor referring solely to an owned isolated host:

```sh
export COMMAND_CENTER_ISOLATED_HOST="$(cat /path/to/owned-isolated-host/descriptor.json)"
export COMMAND_CENTER_SEALED_CANDIDATE=1
export COMMAND_CENTER_ACCEPTANCE_SCENARIO=diagnostic-accepted-chat
node scripts/preflight-isolated-acceptance.mjs
node --test test/real-host.acceptance.test.mjs
```

Use the existing controller's bounded acceptance invocation and lifecycle receipt for this command. The existing runner bounds this slice to 240 seconds and cleanup to 15 seconds; readiness/restart operations also have explicit deadlines. A timeout is failed/unknown evidence, never successful recovery. Do not kill unrelated processes or restart shared WSL. This handoff has not executed that journey.

The source harness pins OpenClaw `2026.9.9`, commit `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`, host package SHA-256 `acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470`. These expected pins are not an observed installed-host identity. The qualification owner must provide the authentic schema-2 descriptor, checkout/runtime/executable identities and digests, runtime contract digest, matching controller image/source receipts, and stable authenticated operator capability. Do not reuse the separate Native26a9 descriptor or invent missing values.

Use Linux-installed dependencies and private, non-world-writable candidate directories. Verify the sealed TEST archive/build receipt and source commit before admission. Verify Note directories support the existing same-directory exclusive hard-link publication, no-follow/physical folder checks and SQLite WAL/recovery. Source tests on temporary Linux storage do not qualify NAS/Btrfs durability, crash recovery or measured filesystem latency; retain the final target-filesystem receipt separately. No production data, credentials or personal content belongs in the evidence packet.

## Release boundary

Source tests, exact-head hosted CI, archive auditing and independent review establish a prepared TEST candidate. A deployable activation release still requires the authentic installed pair, passing lifecycle and filesystem evidence under the release policy, and a concrete backup/rollback and GitOps smoke handoff. No installed result, deployment, NAS job, feature activation or automatic original-message admission is claimed here.
