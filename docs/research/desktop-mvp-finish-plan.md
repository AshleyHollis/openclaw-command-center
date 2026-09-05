# Desktop-first MVP: finish plan

## Stabilization update (supersedes the pending implementation notes below)

Candidate `0cac7f0` passed 136 Linux affected checks, all 16 independent non-performance slices in two lanes, and the desktop keyboard real-host journey. Its exclusive scale replay newly passed `verified-activity-readback`, including the exact Reminder Complete receipt. The remaining original desktop frontier is `scale-performance`; mobile remains deferred/unpassed. Full release qualification is not claimed by these diagnostic results.

The same replay then exposed a Review Snooze transport mismatch: the HTTP dispatcher forwarded its `action` field into the closed service input, yielding a conflict even with the current revision. A real HTTP-handler/SQLite Review regression reproduced the rejection in 0.3 seconds. The dispatcher now strips only that transport field; stale revisions, mismatched replay intents, unknown fields and the closed service contract remain rejected. Ten Review checks pass. The focused fresh Review fixture now exercises the same keyboard Snooze helper as scale, checking the POST response and exact durable readback with a short error bound instead of waiting for a success message after a rejected request.

Publication source-lineage ambiguity is resolved: freshly fetched main and original immutable snapshot `91bb18e` share exact tree `b55c05c2bad4179665b696333d2beabb6c7fe103`. A normal publication branch can preserve main history and apply the candidate delta without reset, force-push or an unrelated-history merge.

The Reminder root fix is committed in `9011ee4`: successful native one-shot delivery no longer acknowledges Attention, and Snooze re-enables the exact native schedule. Its original real-host reproduction passed, and the Linux affected cluster passed 121 tests. This is a closed diagnostic defect, not a new original acceptance-frontier pass.

The bounded architecture follow-up centralizes native Reminder interpretation and action verification in `src/sources/reminder-lifecycle.mjs`. Existing Source callers and real SQLite Attention tests cross the same interface; no scheduler, store, or permissions were added. A deterministic browser regression also reproduced an older Dashboard response resurrecting a removed card. Dashboard refresh now applies only the latest request and owns card focus/draft restoration in one rendering function.

Desktop acceptance is now executable: report and performance contracts are version 2, canonical review/keyboard journeys use the desktop viewport, and mobile remains opt-in under #216. Shared real-browser keyboard/audit policy lives in `test/support/keyboard-accessibility.mjs`. The nine non-mobile performance measurements remain required. Historical v1 baseline bytes are untouched; the v2 baseline must come from a successful coherent capture, so its persisted-baseline test remains pending until that capture exists.

Local affected checks passed 38 tests. Next: seal these changes, run the two non-performance lanes, requalify desktop keyboard, then run scale/Activity exclusively. Final coherent capture, independent evaluation/review, Linux/publication, host-profile migration and backup/rollback/live smoke checks are still required. No new original frontier pass or live deployment is claimed by this update.

Approved 2026-09-05. Canonical scope: [MVP #19](https://github.com/AshleyHollis/openclaw-command-center/issues/19), [completion #32](https://github.com/AshleyHollis/openclaw-command-center/issues/32). Mobile qualification is [deferred to #216](https://github.com/AshleyHollis/openclaw-command-center/issues/216), not passed. Attachments #213 and automatic Notes #214 remain deferred.

## Scope

Deliver the existing Command Center inside OpenClaw on desktop, with native Chat and Command Center Topics/Notes/overview. Keep typing, Tab/Shift+Tab navigation, visible focus, labelled controls, usable dialogs/focus return and status announcements. Keep source identity, sandbox/grants, recovery, privacy and rollback contracts unchanged. Do not remove existing responsive implementation or disable zoom.

Defer mobile-specific layouts, touch interactions/target-size qualification and mobile zoom/reflow. This is an approved acceptance-scope change, not permission to hide desktop defects or mark old failures passed.

## Remaining work and exit evidence

| Work package | Smallest next action | Done when |
| --- | --- | --- |
| Reminder correctness | Add small owner regressions around native successful one-shot delivery and existing Attention acknowledgement; repair that boundary | The delivered Reminder stays actionable across refresh and Topic/native Chat navigation; explicit Complete stays terminal across refresh/restart; Snooze re-enables the exact native schedule with revision/idempotency checks preserved; focused real-host reproduction passes |
| Desktop acceptance alignment | Separate desktop requirements from embedded mobile checks before another full run | Canonical report requires desktop keyboard evidence, mobile paths remain opt-in, review uses the desktop viewport, scale has no mobile detour, and the versioned measured baseline excludes only mobile-specific observations |
| Candidate qualification | Seal repaired bytes; rerun affected non-performance clusters in two lanes, then performance alone | Exact Activity receipt/readback and actual scale measurements pass; one coherent final desktop-first capture and independent evaluation/review pass on the same plugin/host pair |
| Release and live use | Resolve publication lineage and perform the normal host-fixture/profile transition | Linux checks/publication complete, controller uses the approved exact host, backup/rollback is verified, and the live deployment passes its smoke checks |

One writer owns fixes. Diagnostic lanes do not qualify measured performance. Keep performance exclusive. Use fictional real-host fixtures, headless owned browsers and cleanup. Do not repeat full captures to discover a known small failure. The held Atomic checkpoint is not a shortcut around release admission.

## Verified blocker

`ticket32-reminder-lifecycle-7a6d030` is terminal Failed. Its approximately 35-second real-host reproduction observed native `lastRunStatus: ok`, `enabled: false`, and then system `attention.resolved` after a Topic/native Chat round trip. `src/sources/service.mjs` currently uses scheduler enabled state to decide whether a due Reminder remains active. Delivery is therefore being confused with user acknowledgement. The scheduler-only predecessor's immediate Dashboard read did not cover this later refresh boundary and does not disprove the root cause.

`src/sources/scheduler.mjs` currently changes only the schedule during Snooze, so the regression must also cover Snooze after native auto-disablement. Use native scheduler run state and the existing Attention lifecycle; do not create another scheduler or duplicate Reminder store. The root fix is not implemented at this checkpoint.

## Scope alignment review

The ticket changes do not yet alter executable acceptance. Required owner edits are concentrated in:

- `src/test-selection.mjs`: separate deferred mobile selectors from canonical diagnostic lanes.
- `test/real-host.acceptance.test.mjs`: canonical mobile scenario and fresh-mobile slice, 320 px review setup, mobile detour within scale, and required mobile evidence during finalization. Preserve real native sends and authoritative Session/Activity readback.
- `src/acceptance-report.mjs`: replace the mobile release requirement with truthful desktop keyboard evidence and version the changed report contract.
- `src/performance-baseline.mjs` and owner tests: mobile reflow is currently a required metric. Version the scoped measurement contract; capture the retained desktop metrics from actual observations. Do not edit a historical baseline into a new passing result.

No executable gate has been disabled or reported passed by this planning update. Do not launch the old full-capture manifest as if it implements the amended scope.

## Frontier accounting

Of the original six named journey frontiers:

- Historical passes: `focused-native-chat-handoff`, `desktop-primary-journey`, `desktop-primary-journey-review`.
- Required and still unpassed: `scale-performance`, `verified-activity-readback`.
- Deferred and still unpassed: `mobile-accessibility-journey` (#216).

Zero new frontier passes result from this amendment. Desktop keyboard qualification still needs retained coverage on the aligned candidate. These counts are not a completion percentage: coherent release, independent evaluation, publication and live activation remain separate gates. Repeated passes and old-build evidence are not new progress.

## Release integration risks found during review

- The inspected controller route still pins a 2026.8.2 fixture, while the candidate pins OpenClaw 2026.9.1 at host `2309e6542d0ba631178c8e647a2dc8b4763651bd`. Use the normal reviewed fixture/profile migration; do not remove the hold or mutate durable controller state to force admission.
- The direct candidate branch and the inspected `origin/main` have no merge base. Confirm remote refs and prepare a reviewed publication route that preserves both histories/changes; do not reset, force-push or merge unrelated histories merely to produce a green status.
- Open transferred-test ownership tickets remain historical risk, not proof of current failure or permission to exclude broad Linux checks. Resolve actual failures in the owning suite if requalification exposes them.

This update changes planning and ticket scope only. It does not start jobs, modify application behaviour, activate the live system or declare the MVP complete.
