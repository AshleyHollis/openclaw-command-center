# Native reuse: model-backed execution checkpoint

Date: 2026-09-05. Related: #32 (core release), #213 (attachments), #214 (automatic Notes).

## Approved sequence

Evaluate stock capabilities in isolation; map reuse/retain/remove; agree any changed product contracts; implement proven replacements; qualify the core app; deploy the exact tested pair with backup/rollback; then implement the deferred document workflow. Do not expand #32 acceptance automatically to include #213/#214.

## New runtime evidence

The published `openclaw@2026.9.1` archive was independently verified against the npm registry's SHA-512 integrity value:

`sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==`

Its CLI reports `OpenClaw 2026.9.1 (ad6fe23)`. This is published-package proof, distinct from the source-tag inspection in the earlier capability report. The experiment used disposable fictional state, a dedicated loopback Gateway, native authenticated CLI requests and a headless browser. The subsequent model-backed phase used the official `@openclaw/codex@2026.9.1` plugin and authorized ephemeral test authentication. No credentials or production data are included in this report.

Passed through the running stock Gateway:

- Create a native Session group and save its folder/worktree defaults.
- Create two Sessions with the same agent, group and folder.
- Rename the group, then restart the Gateway.
- Assert that both exact Session keys/IDs, their folder settings, renamed memberships and the group's defaults persist.
- Assert that group rename/restart does not change the fictional original Note's bytes.
- Redeem the native one-time browser handoff; with the official runtime installed, the native Control UI displays both Sessions under their renamed group.
- Upload two fictional text receipts through the native Chat file input, and request an actual agent update to the existing Note.
- Verify saved receipt fields and a source link, then restart and read back the completed assistant reply and inactive run state through native Session/history methods. The native UI also reopens the completed conversation.
- Verify both uploaded originals byte-for-byte and resolve the latest Note's original-attachment link. The first receipt remains stored as managed media even though its Note entry was replaced.

**Failed preservation check:** on the second distinct receipt, the agent replaced the earlier receipt fields and link in the Note, despite a prompt to preserve existing text. The original heading and introductory text survived; the first receipt entry did not. The readback diagnostic deliberately exits nonzero for this failure while recording the independent successful checks. This is evidence that prompting alone is not a guaranteed preservation policy, not evidence of a broken uploader. Retain guarded Note maintenance and add the distinct-document regression to #214.

Proof limitation: the initial driver stopped after observing the file write, before the response finished. A later event observer was not scoped to the exact newly sent run. Those early observations are not terminal-completion proof. The final verdict instead uses authoritative history after restart/recovery, the reply identifying the second receipt, exact Session identity, inactive native Session run state, and independent file-byte checks. The inspected final screenshot shows the saved reply plus a background-task indicator; that indicator's lifecycle is not independently qualified. This is a recovered workflow proof, not an uninterrupted end-to-end completion or performance qualification.

Not proven: permanent filing into the Topic folder, automatic Note-update triggers, robust multi-document preservation, arbitrary attachment formats/previews, or plugin-to-native-Chat handoff. The initial credential-free Model Setup block was resolved through normal native auth/runtime installation, not a bypass. These findings do not qualify the Command Center app.

These are native-reuse diagnostics, not new closures of the Command Center release acceptance frontier.

## Reuse / retain / remove assessment

| Area | Decision supported so far |
| --- | --- |
| Chat execution and transcript storage | Already native in `src/sources/sessions.mjs`; retain exact identity and Topic-policy checks. |
| Custom embedded Chat presentation | User approved opening the linked native Chat instead of retaining an embedded Topic chat panel. Native Chat/upload/model execution is now demonstrated. Remove the duplicate presentation in `src/ui/app.js` with exact-Session navigation, lifecycle restrictions, and focused regression proof. |
| Native Session groups | Runtime grouping/default persistence verified. Retain a stable Topic association: native names are mutable, and source inspection shows rename-to-existing-group can merge membership. Not equivalent to Topic identity/lineage/archive contracts. |
| Upload transport | Reuse stock Control UI; actual text-file upload and original-byte preservation passed. Do not build another uploader. Durable Topic filing and wider format coverage belong to #213. |
| Cron execution | Already native in `src/sources/scheduler.mjs`; retain ownership/revision verification. |
| Analysis timing | `src/topics/analysis-schedule.mjs` contains duplicate next-due/catch-up calculations. Candidate for removal only after native missed-run/completion behavior proves the required outcomes. |
| Notes and documents | Existing Topic folders remain authoritative. Retain safe access, original preservation, conflict handling and identity/recovery. Memory-wiki remains optional. |
| Host fork | Generic capability bridge and notification emitter are not a duplicate chat/scheduler engine. Retain until equivalent stock contracts are demonstrated; do not move plugin-specific code into core. |

## Outstanding choices and release sequence

1. Native model-backed evaluation completed with the preservation failure above explicitly retained for #214; it is not an all-green app acceptance result.
2. Implement the approved native-Chat navigation layout. Command Center retains Topic overview and Notes; its Chat action opens the exact linked OpenClaw conversation. Preserve closed/archived restrictions, recovery and truthful navigation errors. Update the originating layout specification and tests together; the approval changes presentation, not these guarantees.
3. Preserve the existing Topic rename/folder relocation contract unless explicitly changed. The partial Note locator fix is still unqualified; native groups do not repair that bug.
4. After approved implementation, use one writer and targeted regressions. Run independent non-performance diagnostics in two lanes against one sealed candidate; qualify performance exclusively.
5. Preserve the final coherent complete capture, independent evaluation, exact-build release gates, and verified backup/rollback before live activation. Changed builds invalidate affected earlier evidence.

No production code was removed or changed during this checkpoint. Earlier uncommitted Note identity repair work is preserved. No acceptance guarantees or deferred-ticket holds were changed.
