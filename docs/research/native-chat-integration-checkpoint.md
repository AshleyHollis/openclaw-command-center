# Native Chat integration checkpoint

Date: 2026-09-05. Owner: #32. Implements the user's approved native Chat layout.

## Implemented

- Active Topic Conversations now expose **Open native Chat** instead of a second composer and active transcript renderer. Native OpenClaw owns messages and upload presentation; Command Center retains Notes and Conversation selection.
- The resolver accepts a closed-schema boolean `nativeChat` intent. Native Chat destinations require an open Conversation, an active non-archived Topic and no unresolved Session recovery. Exact Session/reference identity is verified before the existing host navigation capability is called. Stale selection completions are cancelled, duplicate clicks are blocked and failures permit retry.
- Closed/archived sources retain a history-only view: the current native navigation contract has no read-only mode. This does not introduce a composer or silently reopen them.
- Existing Session execution, transcript, identity and mutation-idempotency service tests remain. Component tests specific to the removed custom composer were replaced with handoff, stale-selection, identity-refusal and retry tests. Notes, search, closed history, keyboard, mobile and bridge-admission checks remain.
- The earlier Note relocation repair now consistently separates immutable Source Reference identity from the current file locator across Note reads, search snapshots and result validation. Folder and child Note locators move atomically. Duplicate destination and stale ownership checks remain.
- The archive/search fixture previously fabricated new Note identities after moves. It now asserts the same identity and the exact unchanged reference inventory through archive/restore. The production rename regression additionally checks source snapshots and authoritative path validation after adapter reopen.

## Evidence

The fixed Linux diagnostic source archive has SHA-256:

`7eaefa1fe46bf60a6537e03ecb85c21d5d5f8b0f7c2fccac58da2e4ede2e88aa`

The isolated pinned evaluator completed a build and 211/211 focused tests with no skips. Cluster: native navigation, closed bridge schema, Session adapter, Topic Page, workspace recovery, Note adapter/locator, Topic lifecycle, source service, search snapshot/service/acceptance, and test selection. Browser tests were headless and closed their browsers. No model credentials or live Gateway were used.

The preceding Linux snapshot built and passed 122/123 tests; its archive/restore failure was retained and resolved in the above cluster. An intermediate Windows run also encountered Linux-only filesystem checks and a timing-sensitive cooldown assertion; these were not waived or counted as acceptance progress. The unchanged cooldown test passed in the final Linux cluster, but that does not establish that its timing sensitivity is eliminated.

## Sealed diagnostic checkpoint — native navigation contract gap

Candidate `8232beb0b749b86fcbd539843099bf6f7f7e963f` and diagnostic-only successor `4bfd0fbdeba5cce91d455a8103098ef02940214d` have production build digest `sha256:2331be7e5e0bd01c7f3a74db0eacc0f790d81df8595bc43179a0c4b9f3f007f4`. Both were built and sealed on Linux against host `1eb7aa385dae0eb8c5b926d1288832489126f987`; diagnostic mounts are read-only.

The targeted `native-chat-handoff` scenario now drives the real Chat action, native composer, exact authoritative message readback and return to the Topic. It currently fails before reaching the composer: the host returns `SESSION_NOT_LINKED` / “Session is not linked to this tab.” Migration readiness, search projection and authenticated mount pass; browser and host cleanup complete. The latest diagnostic Job is `ticket32-native-chat-4bfd0fb`.

This is not a timeout or shell-readiness defect. The fork's documented bridge contract freezes a host-owned set of at most 200 Session keys per port. Its navigation handler requires membership in that set. The hello producer derives it from durable `pluginOwnerId`, which is not the same fact as a Command Center Topic's exact Source Reference. Migration creates ordinary Session entries without that ownership stamp; later creation also cannot enlarge an existing port's grant. The hardening history deliberately removed dynamic additions after creation, and the host tests protect the frozen-set behavior. Repeated captures, ownership stamping alone, longer waits, or accepting an iframe-supplied key do not repair this mismatch.

No existing external-tab navigation resolver hook was found in the host SDK. The proposed narrow addition is an explicitly declared same-plugin read resolver, invoked afresh by the authenticated host, whose validated exact target can be opened in native Chat. It must preserve the existing frozen history/send/search grants, sandbox, private port, bounds and authorization lifecycle; revocation during awaited resolution must prevent navigation. Arbitrary RPC responses or a replayed iframe result must never mint authority. This addition requires explicit contract approval before implementation and separate tracking under the generic host bridge owner. No host change has been made at this checkpoint.

The independent `diagnostic-security-recovery` lane passed these 12 unique slices on the sealed production digest: `host-tuple-refusal`, `build-variant`, `plugin-api-variant`, `bridge-protocol-variant`, `binding-mismatch`, `foreign-database-restoration`, `secure-origin`, `degraded-bridge-grants`, `degraded-source-availability`, `combined-degraded`, `recovery-only-compatibility`, and `destructive-migration-restoration`. Job: `ticket32-security-recovery-8232beb`. Its 14 Node test results are not 14 acceptance frontiers. Performance was not qualified, and these diagnostic passes do not close final coherent release rows.

## Approved navigation-only repair — implementation checkpoint

The user approved the narrow generic host resolver contract, tracked separately in [#215](https://github.com/AshleyHollis/openclaw-command-center/issues/215). The earlier approval requirement above describes the preceding sealed checkpoint, not a current permission blocker.

The host now projects `ui.session.navigateResolved` only for a declared, available, same-plugin read resolver. The resolver is an internal dependency, excluded from iframe-callable methods; independent review found that omission in the first implementation, and a failing projection regression reproduced it before the correction. Frozen Session grants, exact-key matching, request expiry, supersession and revocation protections remain in place. Review of the corrected candidate and Linux build qualification are pending.

The plugin registers a dedicated resolver through its real service proxy, forces native Chat lifecycle validation and verifies the expected Session ID. Its mounted UI freezes local selection during host navigation, announces the pending action and restores focus. Focused tests cover the actual registration, closed/archived/recovery/replaced targets, stale selection, retries and the pending-state focus contract. The cooldown regression now pauses its test clock explicitly before advancing to the one-millisecond boundary; it no longer depends on elapsed wall time between browser calls.

The reviewed host change is committed as `d2ef96f4466d253f32fc48a666a4573b2ee98444`; the plugin compatibility mirrors and harness now require that exact commit. The final host review is scoped-clean through P2. The affected Linux plugin cluster passed 121 tests, and the repinned compatibility/harness cluster passed 21 tests. Host core/UI type checks, scoped lint, SDK surface, protocol generation and the Linux build passed. The broader host check sequence remains in progress. Its stale assertion allowances were pruned by the repository generator, reducing rather than increasing the grandfathered allowance.

The retained fixture archive has source digest `sha256:c0e913313d99c92368d608d48b21a2d38924a2811c07d7081b847e0492cfa846` and contains the verified Git bundle plus its exact-commit manifest. The wrapper digest is unchanged. This is not yet a sealed or real-host-qualified pair. The Windows build encountered a dependency reparse-point failure; broader filesystem tests require Linux. Neither failure was waived. The existing Linux evaluator is being used for qualification. No additional unique final release boundary is claimed by these focused tests. The checked-in historical performance capture still fails the current identity gate and must be replaced only by actual exclusive final measurement, never by changing its recorded values to fit the new candidate.

## Real-host progress — 18:25 AEST

The exact clean host `d2ef96f4466d253f32fc48a666a4573b2ee98444` is now built and sealed. Plugin harness `50e91a8a715cd207edb3123868c4112950efa760` retains production digest `sha256:c12b682a2c2b42032245c6b74741100253e57e6644ebb34c69a2344f90922316`. This section supersedes the pending sealing and navigation evidence above.

- `ticket32-native-chat-pointer-259ac10` passed `focused-native-chat-pointer-handoff`: actual native composer send acknowledgement, exact authoritative Session user-message readback, and return to the Topic. The fixture has no model credentials; this is not assistant-inference proof.
- `ticket32-ui-state-259ac10` passed `focused-ui-state-regression`: desktop focus restoration and 320px Conversation create/select/close with accessibility checks.
- `ticket32-security-recovery-970270c` requalified the same 12 security/recovery slices on the current production digest. These are repeated capabilities, not 12 new frontiers.
- `ticket32-native-chat-50e91a8` confirms the remaining keyboard failure is the native `.chat-thread` log: focusable for keyboard scrolling, but its shipped stylesheet explicitly removes its outline without a replacement. The full path to the composer found only that missing indicator in normal desktop mode.
- The parallel `ticket32-mobile-50e91a8` found the same transcript issue plus workspace and Session-title buttons whose background-only focus treatments disappear under forced colors. This is a shared focus-presentation issue, not a navigation or permission failure. Neither keyboard gate was waived.
- Complete journeys now call the native round trip, preserve exact message readback/send timing, and propagate the newly mounted frame through all callers. Closed Conversations must expose only the disabled native Chat action and retained history. These changed journeys still require real-host qualification.
- Host broad checks stopped on two transcript test TypeScript nullability errors. Test-only correction `d9355d8399a166b6093f5f582166dd76d8bbe87a` passed the owning regression and services/UI-other test type checks; the whole broad sequence is not yet green.

New unique diagnostic closures since the previous checkpoint: two. New closures of the original six journey frontiers: zero. New final release rows: zero. The six remain `focused-native-chat-handoff`, `desktop-primary-journey`, `mobile-accessibility-journey`, `desktop-primary-journey-review`, `scale-performance`, and `verified-activity-readback`.

## Keyboard handoff qualified — 18:54 AEST

Host `2309e6542d0ba631178c8e647a2dc8b4763651bd` repairs transcript keyboard focus and supplies a shared light-DOM forced-colors outline without changing component-owned offsets. The regression failed on the original CSS and passed after the fix; independent review was scoped-clean through P2. The exact clean-source Linux build and integrity seal succeeded. Fixture source digest: `sha256:d4fe44584a584d68b18924edf0c16964b8ac90e9be1c5d6286f8ac0817dcd4fe`.

Plugin `e1ad8fca67e04551d19da2ef929bb0c6af258203` pins that host in all compatibility mirrors. Harness successor `61056b90a99626dce91c2fa3737a59a6c7b36b6f` retains the same production digest, `sha256:815f0b48d3fd660147c912c6036e5fb73c440230b70f1a0f77ad89a8f1b8db48`. It fixes the verifier's incomplete tag list by using native tab-index semantics, including the model picker's implicit `summary` control. The preceding real-host replay reached that visibly focused picker before the verifier rejected it; no product or security rule was relaxed.

`ticket32-native-chat-61056b9` passed `focused-native-chat-handoff`: keyboard-only open/send, native acknowledgement, exact authoritative user-message readback and return to the Topic. All cleanup and traffic/digest finalizers passed. `ticket32-mobile-61056b9` independently passed `fresh-mobile`, including the adapted Notes/Conversation journey and actual 200% zoom. The fixture does not prove assistant inference without model credentials.

This closes one original journey frontier and one independent mobile diagnostic slice, not final release rows. Five original frontiers remain: `desktop-primary-journey`, `mobile-accessibility-journey`, `desktop-primary-journey-review`, `scale-performance`, and `verified-activity-readback`. The fuller coherent mobile scenario remains required despite the independent slice's pass.

Current diagnostic lanes are `ticket32-ui-data-61056b9` and `ticket32-security-recovery-61056b9`, against the same sealed pair. Existing mobile/security passes repeated by those lanes are requalification, not new unique progress. Broader host checks in `ticket32-native-focus-green` have passed all type-check and lint phases but final repository guards are still running. No complete acceptance capture or performance qualification has been repeated during this repair.

## Focus evidence timing repaired — 19:07 AEST

Both broader diagnostic lanes completed. `ticket32-ui-data-61056b9` passed `fresh-mobile` and `fresh-review`; desktop, scale and scale-analysis failed on the same native header focus samples. `ticket32-security-recovery-61056b9` passed ten slices; `host-tuple-refusal` and `build-variant` failed consecutive startup readiness. The broader host check sequence `ticket32-native-focus-green` completed successfully. New independent diagnostic closure since 18:54: `fresh-review`. No additional original journey frontier or final coherent release row closed.

A headless probe using actual host styles reproduced the desktop evidence error in 20/20 samples: immediately focused controls reported the transparent transition start color; after paint they reported the expected background with focus unchanged. Harness `5385caa1f8556f51ac33fcfa8f1bb4f8fc5e55fd` synchronizes focus evidence to a paint opportunity without disabling styles or retrying failed indicators. Its regression failed before the fix and passed afterward, including a negative control with no indicator. This recognizes a rendering mechanism, not contrast qualification.

The clean Linux candidate build and 46 affected tests passed; production digest remains `sha256:815f0b48d3fd660147c912c6036e5fb73c440230b70f1a0f77ad89a8f1b8db48`. Only affected clusters are replayed in `ticket32-ui-desktop-5385caa` and `ticket32-compatibility-startup-5385caa`, against the unchanged sealed host. Startup limits are unchanged; its cause is not yet established. No complete capture or performance qualification has run during this repair.

## Desktop and review frontiers closed — 19:23 AEST

`ticket32-ui-desktop-5385caa` passed all three affected desktop, scale and scale-analysis slices. `ticket32-compatibility-startup-0a758c2` passed both previously failing startup checks with unchanged limits; prior timing failures remain retained, not declared fixed. All 17 independent non-performance slices have passing evidence against the current production bytes. The readiness helper now retains safe attempt/refusal/success counts on failure; the temporary late-startup observation was removed without ever changing the original failed verdict.

Two additional original frontiers closed: `desktop-primary-journey` in `ticket32-desktop-primary-0a758c2`, and `desktop-primary-journey-review` in `ticket32-review-journey-587c65d`. The latter now explicitly establishes the production analyzer's quiet first-run baseline through the public authenticated API before creating the two changed-Topic proposal fixtures. It no longer depends on successful earlier scale setup. Host behavior is unchanged.

The intermediate `ticket32-combined-journey-0a758c2` failed after desktop passed: scale lost keyboard focus after closing a Conversation, mobile lost focus when starting its second Topic journey, and Activity lacked the prior scale receipt. Its missing review proposals were caused by skipped initial analysis setup, repaired and independently verified above. Both lightweight and full-corpus two-Topic diagnostics subsequently passed, so they do not establish a fix for the remaining focus-loss pattern. The exact scale-only path runs as `ticket32-scale-frontier-587c65d`, with detailed focus identity before and after paint and no competing diagnostic lane.

Sealed harness `587c65d0728535387211aeeaff8d50186e9cd047` retains production digest `sha256:815f0b48d3fd660147c912c6036e5fb73c440230b70f1a0f77ad89a8f1b8db48`. The pending performance identity source digest now matches the actual host seal; no historical measured baseline value was edited. Three original frontiers remain: `mobile-accessibility-journey`, `scale-performance`, and `verified-activity-readback`. Final coherent release rows newly closed: zero. All final evaluation/publication/live gates remain required.

## Scale observation deadline corrected — 19:28 AEST

`ticket32-scale-frontier-587c65d` progressed beyond the prior focus-loss point, then failed at the pending-source-action observer. The observer's ten-second deadline started concurrently with `activate`, which includes sequential keyboard traversal; that traversal was still running when failed-test cleanup closed its page, producing an unhandled rejection. Harness `8075fcd3b2fdd8daa2b13626995480dac8a2f882` awaits activation before starting the observer deadline. The MutationObserver remains installed beforehand and retains brief pending states. No timeout or assertion is relaxed.

The scale selector now includes its dependent `verified-activity-readback` assertion in the same run. A separate full-corpus mobile selector retains the complete existing mobile journey, including Reminder actions and second-Topic 200% zoom. Targeted selection, finalization and paint checks passed locally. Real-host verification remains required; three original frontiers and all final release gates remain open. The intermittent earlier focus-loss pattern is retained as unresolved, not inferred fixed from passing smaller replays.

## Focus lifecycle root causes — 19:54 AEST

The full mobile job `ticket32-mobile-frontier-8075fcd` proved that a Dashboard refresh detached the focused Attention Snooze select during the second Topic journey. Production fix `c75329c6b5500deaebfc862301fd08e73bb0ca0e` preserves the same episode/control and Snooze draft, falls back to the Attention heading when removed, and does not steal focus that moved outside Attention. Its browser regression reproduced the actual detached-control symptom before the fix and passed at 320px and 1440px afterward. The Linux build passed 53 focused tests. New production digest: `sha256:cd18df03e772f5102fbfaf896a569c6d5336a9ed9b750c2f506672149bc2b89d`.

On these bytes, `ticket32-review-journey-c75329c` passed the original desktop and review journeys. `ticket32-mobile-frontier-c75329c` failed earlier at the Conversation filter. A sub-second real-DOM reproduction with the exact acceptance keyboard driver showed the app correctly restoring filter focus after close readback while the test retained its earlier reverse-traversal snapshot, then tabbed past the filter and outside the frame. Commit `661ee703408bf2c2e0537730613b266e46e6643d` makes the shared close journey await actual removal from the open list, using the existing operation budget, before further keyboard traversal. The regression fails if the journey returns while the close response is held; a negative case retains failure when removal never happens. All keyboard indicator, hidden/inert, modal and frame-boundary assertions are unchanged.

Its Linux builder passed that regression but failed the earlier two-animation-frame paint assumption (54/55 checks). Commit `6646b6c4ecdb2227650457e0b563fe63a211d33c` now waits for actual CSS transition completion with a strict one-second deadline before sampling. A delayed transition reproduces the same transparent-focus failure before the fix and passes afterward; missing indicators still fail and a non-settling transition is rejected. These two corrections affect test code only. The replacement builder and real-host requalification are pending at this checkpoint; neither earlier failed job is treated as active or successful.

The replacement `ticket32-candidate-6646b6c-build` passed all 55 checks and sealed the same production digest above. `ticket32-mobile-frontier-6646b6c` and `ticket32-security-recovery-6646b6c` are the next two non-performance diagnostic lanes. Scale/Activity remains prepared but unlaunched until both terminate. The issue dashboard now names these jobs and preserves the retained controller checkpoint verbatim.

Unique original frontier closures since the preceding checkpoint: zero. Three remain: `mobile-accessibility-journey`, `scale-performance`, and `verified-activity-readback`. The 17 earlier independent slice passes belong to the old production digest and require affected requalification. Desktop/review re-passes are not new frontiers. The held Atomic checkpoint and live system remain unchanged.

## Readback boundaries and current security evidence — 19:59 AEST

`ticket32-security-recovery-6646b6c` passed all 12 independent security/recovery slices on production digest `cd18df03e772f5102fbfaf896a569c6d5336a9ed9b750c2f506672149bc2b89d`. This requalifies existing capabilities, not new original frontiers.

`ticket32-mobile-frontier-6646b6c` passed the earlier Conversation-close boundary, then reproduced the second-Topic focus interruption. Unlike the original detached-body failure, focus now correctly landed on `attention-heading` when the completed Reminder card disappeared. The harness began its next keyboard path after the source acceptance announcement but before the following Dashboard readback. Test-only `2e7387546be53cb103d34f42f5c55d80ae4b80b8` waits for both exact fixture Reminder cards to be absent before the next journey, using the existing operation budget. The Snooze path already required its corresponding card-removal readback. No focus assertion was weakened to accept the asynchronous interruption.

The common cause at both repaired journey seams is that input/receipt acknowledgement is not visible operation completion. These are explicit readback waits, not retries, sleeps or longer acceptance budgets. The next mobile job and remaining five independent UI/data slices must use the same newly sealed test candidate; scale/Activity stays exclusive afterward. All three original frontiers remain open until those actual results arrive.

## Native date/time focus repair — 20:05 AEST

`ticket32-ui-data-2e73875` passed all five independent UI/data slices; together with the preceding security lane, all 17 independent slices passed on production digest `cd18df03e772f5102fbfaf896a569c6d5336a9ed9b750c2f506672149bc2b89d`. The full mobile journey passed Conversation close, Reminder completion and its second Topic at 200% zoom, then failed the final keyboard audit on the Quiet Hours Start field.

A half-second browser reproduction with the actual product stylesheet showed the browser-owned picker button retaining `:focus-within` on the time input while `:focus` and `:focus-visible` are false. The existing outer outline disappeared at this internal keyboard stop. Production fix `759539760a1e4ce99d5461c2bdd0bce510c43208` applies the same outline to `input:focus-within`, without replacing native controls, adding event handlers or relaxing the audit. Its regression traverses time, date and datetime-local controls in both directions at 320px/1440px, with forced colors on/off, checks the internal picker path, and verifies the outline disappears after leaving the input.

The Linux build passed 56 checks and sealed new production digest `sha256:a398327cf913a9cd98057062f278c767f588d7b64b0db27dbf637429df2870f2`. The affected full mobile and desktop/review journeys run in `ticket32-mobile-frontier-7595397` and `ticket32-review-journey-7595397`. Their results are pending; prior slice passes remain historical evidence for the earlier digest. All three original remaining frontiers and the final coherent release/evaluation/publication/live gates remain open.

## Final keyboard fixture and exclusive scale diagnostic — 20:09 AEST

`ticket32-review-journey-7595397` passed original desktop and review on production digest `a398327cf913a9cd98057062f278c767f588d7b64b0db27dbf637429df2870f2`. The mobile job passed the native time-picker focus audit, then failed its requirement to reach View evidence after both of its Reminder fixtures had deliberately left Attention. Harness-only `f777a9fbff708f78c86cfd2dcc6627f209f197c7` gives the final audit a separate active Reminder, verifies its exact episode through the public Dashboard readback and requires its Evidence action to be visible. Both original Snooze/Complete tests and the final keyboard/dialog/reflow assertions remain. The correction is not yet real-host-qualified.

After verifying both diagnostic lanes terminal and no competing worker pods active, `ticket32-scale-frontier-7595397` runs alone against the unchanged sealed production bytes. It includes exact dependent Activity readback. The successor builder/mobile/security manifests are only prepared; they must not start until this exclusive diagnostic ends. Three original frontiers still remain and no complete capture has run.

## Shared Reminder disappearance — 20:29 AEST

The exclusive `ticket32-scale-frontier-7595397` failed at its unchanged 240-second scenario deadline while the keyboard driver awaited the Reminder Complete locator. Dependent Activity readback had no source-action receipt. Both browser and host cleanup completed; no measured baseline was produced.

`ticket32-mobile-frontier-f777a9f` also failed: its separately created final-audit Reminder had disappeared before the explicit Evidence-control precondition. During this still-running fictional fixture, read-only inspection of the native scheduler store showed the untouched audit Reminder disabled, the snoozed fixture enabled with its new future date, and the explicitly completed fixture disabled. The runtime status was stored separately and was not captured before cleanup, so automatic native execution is a hypothesis to verify, not a claimed proven cause. The app currently treats disabled scheduler rows as resolved Reminder Attention. Creating another fixture did not fix this shared lifecycle boundary and is not considered a completed repair.

`ticket32-security-recovery-f777a9f` passed all 12 independent slices on current production digest `a398327cf913a9cd98057062f278c767f588d7b64b0db27dbf637429df2870f2`. No new original frontier closed. The diagnostic builder now fetches the exact Git commit rather than a floating branch: the earlier f777a9f builder correctly refused the later documentation tip. Its fresh pinned replacement passed all 56 checks without modifying the failed directory.

Harness `8bfe5bbe0e07a3e8380e67ca3b88e0c5d7a26e06` adds diagnostic-only `diagnostic-reminder-lifecycle`: a fresh real host and public Topic journey, exact Reminder creation/readback, native `cron.run`, bounded read-only runtime-state observation, and a check that the untouched due Reminder remains actionable. It is deliberately excluded from the canonical 17-slice release map. Its build and focused replay are next; do not repeat mobile or scale to discover this lifecycle cause. The final complete capture remains prepared but unlaunched.

## Scheduler-only hypothesis rejected — 20:34 AEST

`ticket32-reminder-lifecycle-8bfe5bb` completed successfully in 29 seconds: native `cron.run` alone did not reproduce disappearance in the fresh fixture. This is diagnostic evidence against that simple hypothesis, not a new acceptance frontier or proof that the full lifecycle is correct. The full mobile and scale jobs remain stopped with their original failures.

Diagnostic-only successor `7a6d030a36a61e45c6a3ae74c26e5e2238d7bbf5` adds the second Topic/native Chat round trip and retains bounded scheduler enabled/runtime state before and afterward plus related Activity actor, operation and outcome. It remains excluded from the canonical release matrix and changes no production bytes. Verify the exact new builder/replay result before deciding which source or UI contract to change.

## Not yet release-qualified

The original 211-test snapshot above was focused integration evidence. The later sealed diagnostic candidate is **not a final acceptance capture or release-qualified build**. No unique final release acceptance boundary was closed by these focused or diagnostic passes.

Inspect the two remaining diagnostic-lane results and repair only remaining affected owner boundaries. Preserve actual native Session message readback, keyboard/mobile checks and measured Chat-send performance; do not replace these with a navigation-only pass or a mocked host result.

After that, seal the exact pair; rerun affected non-performance clusters in the two diagnostic lanes; keep measured performance exclusive; run one coherent complete capture, independent evaluation and Linux publication gates. Verify backup/rollback before live activation. Previous-build passes are historical evidence, not qualification of these changed bytes.

Deferred attachment filing (#213) and automatic guarded Note maintenance (#214) remain outside this checkpoint. The stock agent's distinct-receipt Note-preservation failure remains recorded in #214.
