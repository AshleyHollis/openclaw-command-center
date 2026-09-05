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

## Not yet qualified

This is a focused integration checkpoint, **not a sealed release candidate or final acceptance capture**. No unique release acceptance boundary was closed by these test passes.

The real-host journey still needs to exercise the native composer and return to the Topic instead of selecting the removed embedded composer. Preserve actual native Session message readback, keyboard/mobile checks and measured Chat-send performance; do not replace these with a navigation-only pass or a mocked host result.

After that, seal the exact pair; rerun affected non-performance clusters in the two diagnostic lanes; keep measured performance exclusive; run one coherent complete capture, independent evaluation and Linux publication gates. Verify backup/rollback before live activation. Previous-build passes are historical evidence, not qualification of these changed bytes.

Deferred attachment filing (#213) and automatic guarded Note maintenance (#214) remain outside this checkpoint. The stock agent's distinct-receipt Note-preservation failure remains recorded in #214.
