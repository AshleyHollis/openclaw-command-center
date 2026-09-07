# MVP known-issue fix progress

## Scope-v2 notice — 2026-09-06

The approved [first live release](first-live-release-scope-v2.md) defers optional workflows to #220–#227. I4 below remains the historical all-scope known-issue baseline: 19/27 have integrated focused-tested fixes, eight lack complete passing fixes. None closes because its feature is deferred. Audit shared dependencies and prove disabled entry points before classifying any issue as non-blocking for scope v2. The later Folder provisioning transaction batch passed 49/50; its concurrent identical-retry regression is retained under I02/#221, not counted as fixed. Current candidate release qualification remains unproven.

Snapshot I4 — 2026-09-06. Companion to the [delivery scorecard](mvp-progress-scorecard.md), not a replacement for release qualification.

## What this measures

Count distinct repairable correctness issues in the reconciled current finish-plan records. This is a new baseline, not an exhaustive count of every historical bug or a prediction of undiscovered bugs. Group manifestations with the same repair owner/invariant; split genuinely different causes even when they occur on the same screen. IDs remain stable after repair. New discoveries enlarge this register explicitly, not silently.

A focused-tested fix requires evidence that tests exercise the specific defect. Unrelated green tests, a passing build, source presence, a patch alone, or a favorable review do not qualify. Partial fixes stay in the unresolved total. Focused-tested does not mean release-qualified: integration, restart, real-host, performance and final evaluation can still expose work.

## Summary

| State | Issue groups | Share of this baseline |
| --- | ---: | ---: |
| No complete implementation with passing proof | 2 | 7% |
| Partial/integration follow-through; material gap remains | 6 | 22% |
| Integrated fix has bug-specific focused passing evidence | 19 | 70% |
| Total reconciled known correctness issues | 27 | 100% |

**Primary backlog measure: 8 known issues still need complete integrated focused-tested fixes (30%).** Six have partial or integration-follow-through evidence; two still lack complete implementation. Percentages are rounded. I26 and I27 explicitly add the previously reported Scheduler and prepared Search publication groups to the old 25-group register. These are not the delivery scorecard's work packages. Unfinished features and release gates are not counted as bugs.

All 19 focused-tested fixes have recorded integrated focused evidence. No issue group closed since I3. I02 now has a reproduced partial-marker enrollment race and an integrated shared filesystem owner; three real two-process cases and the root affected lifecycle cluster pass. This is targeted repair evidence, not proof that repeated earlier passes explained the original 75/76 failure. I03 creation/reconciliation and native UI are integrated with focused evidence; I04's reviewed partial owner repair is integrated with current-SDK focused proof. Package/pin cutover and real-host acceptance remain separate.

## Issues still needing a proven fix

| ID | Issue / violated behavior | Status and specific remaining proof | Work packages |
| --- | --- | --- | --- |
| I01 | Native HTTP relay does not enforce declared server byte limits | Partial. Request and response overflow regressions and the 29-check relay cluster passed. Follow-through found passive observation must preserve existing auto-consuming callers and recognize fully received unread input before its timeout. The repaired transport cluster passes 32 checks; remaining affected suites and lifecycle review are in progress. No complete fix credit yet. | A5 |
| I02 | Recreated Note root directory can reuse the recorded inode/birth-time identity | Marker identity, atomic Folder recovery and shared enrollment/Note filesystem ownership are integrated. Targeted partial-marker and padded-reference bypass failures were reproduced and repaired. Three real two-process cases pass, including SIGKILL without silently healing a partial marker; affected identity/recovery and lifecycle clusters pass. Atomic provisioning binding follow-through, created-folder rollback and actual shared-volume qualification remain. | B1 |
| I03 | Uncertain Note saves and creations lose durable reconciliation ownership across reload/restart/principal change | Partial. Edit/create reconcile-only owners, exact create provenance, versioned pre-publication intent and native creation UI are integrated and independently reviewed. Root 68-check Note/lifecycle cluster includes actual create/edit process death followed by HTTP reconciliation; 53 headless UI/read checks pass. A published-then-deleted create cannot be resurrected by replay. Hard reload/principal-bound recovery remains unqualified. | B2 |
| I04 | Structural Change source/metadata update and completion receipt can diverge during interruption | Reviewed owner repair is integrated; root 76-check affected cluster passes with actual move/SQLite process death, immutable replay, preview ordering, legacy Primary preflight and sibling metadata/Folder/lifecycle checks. External conditional directory moves and native Session/Cron outcome recovery remain. Group manifestations under the shared operation-completion owner. | B4 |
| I05 | Topic Review replay fails to recognize its own already-applied steps | No proven fix distinguishing operation-owned progress from unrelated drift after restart. | B5 |
| I08 | A delayed notification can display after its earlier clear, including a fresh worker | No proven fix. Server ledger ordering does not establish browser display ordering. Durable browser fencing requires an explicit persistence decision. | A7/B3 |
| I26 | Scheduler reconciliation can reuse a newer base, claim unrelated effects or retry unsafe declaration upserts | Partial owner patch and normalized-response replay repair are integrated; root affected coordinator/Scheduler cluster passes 43/43. Native missing-only creation, conditional removal and uncertain-response recovery remain. Native Cron normalization is a boundary fixture here, not final native runtime qualification. | A6/B6 |
| I27 | Prepared Search can publish stale rows or clear a newer invalidation | Partial generation/receipt fencing and oversized disposable-commit repair are independently reviewed and integrated; root backend cluster passes 56/56. Legacy DOM case explicitly excluded. Cross-process publication and compare-clear ownership remain unimplemented. | A9/B11 |

## Focused-tested fixes

Counts below identify issue groups, not the number of passing tests. Cluster totals are shared evidence and must never be summed as unique acceptance progress.

| ID | Repaired issue | Recorded focused evidence / integration state | Work packages |
| --- | --- | --- | --- |
| I06 | Settings persist before Cron reconciliation and completion receipt, losing retry ownership | Reviewed durable intent, closed metadata completion and host-owned exclusion integrated. Root Linux Settings cluster passes 32/32 including two actual process-death cases against an immutable actual built host SDK. A run resolving a different current build through the mounted filesystem missed a child startup deadline; final exact packaged-host qualification remains unproven. | B6 |
| I09 | Emitter declarations falsely deduplicate a shared plugin-wide emission ID | Intended pre-fix failure reproduced. Integrated ledger now requires matching declaration and intent; plugin-wide identity contract retained. Root host notification cluster passes 25/25, including concurrent/reopened ledger evidence. | A7/B3 |
| I07 | Topic-context retrieval omitted exact supplied Session identity and could publish after replacement | Two pre-fix identity regressions; independently reviewed three-file repair integrated; root Linux context/Search contract cluster passes 41 checks. Supplied identity is checked before and after retrieval; absent optional host ID retains documented key-only compatibility. Packaged `/new` and `/reset` journeys remain unqualified. | A1/A9/B11 |
| I10 | Attention ownership used noncanonical authenticated-profile identity | Four pre-fix failures; affected Attention cluster passes; integrated and independently reviewed. | B7 |
| I11 | Native Session startup depended on the obsolete Gateway availability gate | Eight integrated capability checks cover native catalog access, explicit disablement and authority lifetime. | B8 |
| I12 | Native Session calls lacked correct request-local adapter/error handling | Nineteen affected Linux dispatch/source-service checks; integrated, independent review. Same-process proof only. | A3 |
| I13 | Optional native creation envelope accidentally admitted unsupported WebSocket creation | Fail-fast regression failed before repair; bridge and exact native/unsupported-WS checks pass after integration. | A3/A5 |
| I14 | Session creation readback treated absence from the first catalog page as absence of the Session | Regression passes using exact latest `getSessionEntry`; integrated. | A3 |
| I15 | HTTP work retained authority after request or plugin retirement | Three pre-fix SDK/router failures and integrated 79-check proof. Follow-through reproduced a real TCP client-disconnect-before-Session-commit gap; response/socket lifetime is now composed into the authority resolver and the 29-check relay cluster passed. Byte-guard follow-through remains I01. | A5 |
| I16 | Overlapping notification clear completion could overwrite newer durable outcome and return false success | Original ordering reproduced; 23 affected checks, core types and focused lint pass; integrated and reviewed. Browser ordering is separate I08. | A7/B3 |
| I17 | Note recovery lost filesystem proof or trusted a substituted restoration claim | Three real Linux crash regressions; 51-check integrated recovery cluster passes. Root reincarnation remains I02. | B1 |
| I18 | Topic context used immutable provenance instead of the explicitly recovered Session locator | Real SQLite relink/restart regression and 13 affected Linux checks; integrated and reviewed. Exact reset identity remains I07. | A9/B11 |
| I19 | Rollback snapshots could be migrated again or acquire foreign recovery provenance | Integrated, independently reviewed, 54 Linux checks including actual intermediate process death. | B11/C5 |
| I20 | Unavailable Notes and shared catalog cancellation disabled otherwise healthy Topic/Chat controls | Both reviewed availability/catalog-lifetime patches integrated; 27 headless checks pass. | B8/A3 |
| I21 | Native transcript changes and missed startup events left Search stale | Two targeted pre-fix failures; six new cases and 40-check lane cluster pass, independent approval. Integrated; root 40-check Linux cluster also passes with the actual patched-host SQLite SDK. | A9/B11 |
| I22 | Routine noise incorrectly appeared in Dashboard approvals | Integrated real-SQLite/public-action regression and shared 19-check Dashboard cluster; independent review. | B9 |
| I23 | Recurring Reminder dates read the wrong native scheduler field | Integrated native `state.nextRunAtMs` projection tests and shared Dashboard cluster; independent review. | B10 |
| I24 | Explicitly clearing a schedule's next-due time retained its stale value | Real-database RED then owner fix; affected Windows/Linux scheduling/storage checks pass; integrated. | A6/B6 |
| I25 | CLI metadata discovery acquired runtime-only authority during registration | Actual 9.2 metadata API reproduction repaired; plugin contract/integration cluster passes. Full runtime activation remains a release dependency. | A8 |

## Approved owner-level implementation scope

The user explicitly requested the full shared-invariant repair, not only the first Settings defect. Keep these within the existing issue/work-package denominator:

- **Durable operation ownership (I03–I06):** strengthen existing Notes, Structural Change, Topic Review and Settings owners. Local metadata changes and their ownership/completion records commit atomically. Filesystem and Cron effects retain source-specific verification and reconcile from frozen durable intent. Callers delegate this sequence; do not assemble it themselves or introduce a universal workflow framework. Settings is first, Structural Changes next, and Topic Review depends on their reliable replay.
- **Publication ordering (I03/I08/I15 and affected callers):** verify exact operation identity, binding generation and current authority immediately before a visible or durable effect. Older work cannot publish into a newer activation, principal, source binding or clear generation. Existing focused fixes are retained; no blanket qualification from their test counts.
- **Identity versus location (I02/I07/I18):** a path, Session key or filesystem tuple is not durable identity. Supplied Session identity is now checked. The user explicitly approved a reserved folder marker backed by existing metadata. Implementation must preserve content on missing/mismatched identity, never recreate the marker during ordinary access, and never authorize old destructive recovery from a copied marker alone. Marker-backed reincarnation protection is integrated; provisioning, rollback and shared-volume follow-through remain open.
- **Shared transport compatibility (I01/I15):** native passive ingress observation preserves existing auto-consuming SDK callers, genuine upload timeouts and large Note bodies. The request owns its byte guard through EOF/close; handler completion retires authority, not unfinished upload enforcement. Early responses must not allow an abandoned upload or later pipeline through.

Implementation proof includes interruption before/after each external effect and local commit, same-ID retry, changed-intent rejection, competing operations, stale completion, source replacement, and actual restart/process death where required. Repeated passes do not advance issue counts. No new stores, schema changes or strategic ownership changes are implied by this scope.

## Keep separate from the correctness percentage

- **Two unresolved tooling issues:** legacy Search DOM test uses an unavailable `HTMLElement` global; host pre-publication autoreview rejected its source attributions and therefore produced no certified verdict. Neither is counted as an additional product defect without cause verification.
- **Acceptance harness repair:** native activation's new finalizer now waits for final host output. Selector/finalization checks pass, but the actual targeted real-host activation remains unrun; no acceptance credit.
- **Unfinished implementation:** remaining native Dashboard/Topic workflows, notification preferences/binding, coherent package and host pins. See A4/A7/A8/A9 rather than inflating the bug count.
- **Unqualified risks/gates:** shared-volume exclusion, remaining recovery and degraded journeys, production approval wiring, packaged journeys, exclusive performance, coherent final capture, independent final evaluation and NAS deployment.

Evidence sources: [early evaluation and follow-through](mvp-early-evaluation-r1.md), [native migration evidence](native-ui-migration-checkpoint.md), [stable work-package scorecard](mvp-progress-scorecard.md), and the exact frozen patch/run records retained in the private validation checkpoint. Older narrative statements are historical; the newest integration and test outcomes govern this register.

## Status updates from now on

Lead with: **known issues needing a proven fix**, **focused-tested fixes awaiting integration verification**, **integrated focused-tested fixes**. Report the change since the previous issue snapshot: newly discovered, moved to proven fix, or reopened, using named IDs. Always show counts with percentages and retain earlier snapshots. Never call the changing known-issue percentage overall app completion. Include the delivery scorecard and release blocker separately.

| Snapshot | No passing fix proof | Partial | Focused-tested | Still need complete proven fix | Change |
| --- | ---: | ---: | ---: | ---: | --- |
| I1 | 8 | 1 | 16 | 9 | New reconciled baseline; no historical delta asserted. |
| I2 | 7 | 1 | 17 | 8 | I07 moved to integrated focused-tested. I01 remains partial; additional transport failures are not separate issue-group credit. I15's additional disconnect regression repaired and focused-tested. |
| I3 | 3 | 5 | 19 | 8 | Explicitly added I26/I27 already reported in conversation; I06/I09 moved to integrated focused-tested. I02 integrated with a newly exposed affected provisioning failure, not closed. I03/I26/I27 partial progress does not earn complete-fix credit. |
| I4 | 2 | 6 | 19 | 8 | No closures or new denominator. I03 backend/HTTP/native creation integrated and focused-tested; I02 concurrent enrollment repaired with process evidence; I04 partial owner repair integrated with focused evidence; external-operation gaps remain. |
