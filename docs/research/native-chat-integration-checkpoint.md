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

## Not yet release-qualified

The original 211-test snapshot above was focused integration evidence. The later sealed diagnostic candidate is **not a final acceptance capture or release-qualified build**. No unique final release acceptance boundary was closed by these focused or diagnostic passes.

First repair and qualify the native keyboard focus presentation. Then qualify the adapted desktop/mobile journeys. Preserve actual native Session message readback, keyboard/mobile checks and measured Chat-send performance; do not replace these with a navigation-only pass or a mocked host result.

After that, seal the exact pair; rerun affected non-performance clusters in the two diagnostic lanes; keep measured performance exclusive; run one coherent complete capture, independent evaluation and Linux publication gates. Verify backup/rollback before live activation. Previous-build passes are historical evidence, not qualification of these changed bytes.

Deferred attachment filing (#213) and automatic guarded Note maintenance (#214) remain outside this checkpoint. The stock agent's distinct-receipt Note-preservation failure remains recorded in #214.
