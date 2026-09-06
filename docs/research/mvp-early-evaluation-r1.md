# Early whole-MVP evaluation R1

2026-09-06. User-requested early evaluation of the entire current desktop MVP, including uncommitted work. Two independent axes inspected a frozen 277-file product snapshot at base `3dc39c3e76ebaf2839c14661ff6416d1c08bf1d6`; snapshot-manifest SHA-256 `f260d1b93559d7edfab9d890f6549d3f9e80dbe7ec66e93886b805706fada3af`. Both verified every file before and after review. This is source/contract evaluation, not executed final acceptance, exhaustive bug certification or a release evaluation of the final combined host/plugin build.

The review freeze is released. Subsequent fixes must carry their own evidence. Stable work-package IDs refer to the [progress scorecard](mvp-progress-scorecard.md); these findings do not create new scope or change its denominator.

Latest follow-through: native Search freshness is now integrated after independent patch review. The root Linux Search/source-service cluster passes 40 checks using the actual built patched-host SQLite SDK through the existing isolated fixture resolver. The production dependency cutover and real native Chat-to-Search journey remain pending. This supersedes the older lane/open statements below; see the [known-issue register](mvp-known-issue-register.md) for current repair status.

Follow-through: the rollback admission repair and its independently requested provenance follow-up are now integrated. The root Linux storage cluster passes 54 checks, including actual process death at intermediate migrations and refusal of foreign recovery evidence before writes. The native Notes availability repair and its catalog-lifetime follow-up are also integrated and independently reviewed; root 27 headless checks pass. The follow-up resolves a review-detected shared-generation regression where failed early Conversation creation discarded a valid delayed Note catalog. These are scoped implementation results, not final acceptance.

## Standards and architecture

Three actionable P2 findings:

1. **A9/B11 — Topic context uses an obsolete Session locator.** `src/search/context.mjs` matched `externalSourceId`, while explicit Source Recovery changes the effective locator without rewriting provenance. The recovered Session loses Topic retrieval and the displaced key continues to match. This violates the documented Source Locator/Topic ownership contract. Use the canonical effective-locator owner and refuse ambiguous bindings.
2. **B11/C5 — Restored rollback snapshots can be migrated again.** `src/metadata/service.mjs` omitted rollback-snapshot detection in schema 3/4/6/7 startup paths, unlike schema 1/2/5. Centralize admission before any migration writer, preserving external rollback and legitimate interrupted migration recovery. The supporting repeated-branches smell is a heuristic; the actual violation is ADR 0002's rollback contract.
3. **A9/B11 — Native Chat does not refresh previously indexed Search content.** Native navigation bypasses the old custom-send invalidation path. No equivalent content-change hook is registered, and Search checks cached metadata rather than transcript freshness. A supported authoritative change/reconciliation owner is needed. This is a source-backed gap, not a real-host reproduction.

Known Structural Change and Topic Review replay gaps remain. Inspected owners included Search publication/context, Activity merging/pagination, metadata migration/recovery, Topic lifecycle/recovery/Review, approvals, startup/cleanup and native navigation. Deep notification delivery, exhaustive Note internals, legacy import execution, exhaustive native UI and acceptance tooling were not fully inspected by this axis.

## Requirements and user journeys

Two concrete findings:

1. **A1/A9 — Corroborated relinked-Session context defect.** The required on-demand retrieval uses the verified current Source Locator, not immutable provenance. Same finding as Standards item 1; do not count it twice.
2. **B8/A3 — An unavailable Notes capability hides healthy Session features.** `src/native-ui/topic-page.mjs` waits for Topic and Notes loading before enabling native Chat and creating the Conversation form. A rejected Notes browse disables otherwise valid Session use. Load independent capabilities separately while invalid Topic identity, permission loss and disposal still fail closed.

| Work packages | Source and test coverage inspected | Remaining qualification |
| --- | --- | --- |
| A1–A3 | Native Topics/Notes/creation/navigation and corresponding native UI tests | Actual packaged Chat send/readback/return and full desktop journeys |
| A4/A9 | Dashboard, Attention, Activity, Search, Topic lifecycle/recovery, Conversations and legacy controls | Native reachability of every retained operation, including read-only history and structural/recovery controls |
| A5–A8 | Registration, bridge/HTTP, Cron/Analysis, notification and compatibility owners | Coherent package and actual supported native caller qualification |
| B1/B2/B4–B6 | Notes, mutation coordination, Review application and schedule recovery owners/tests | All known interruption/restart ownership gaps |
| B7–B10 | Attention/approval, degraded-mode and Reminder owners/tests | Actual operational-source wiring and complete native degraded behavior |
| B11/C1–C5 | Migration/storage and native keyboard test presence | Complete coverage map, final coherent runtime acceptance, exclusive performance, independent evaluation and safe live release |

No attachments, mobile or automatic Note maintenance was added to MVP scope. Source/test presence in this table is not passing evidence.

Summary: **Standards: three findings; Spec: two findings, one corroborating Standards.** The strongest Standards risk is rollback admission; the strongest Spec risk is healthy Session functionality disappearing when Notes fail. Both axes remain distinct.

## Repair follow-through

- **Locator repair integrated.** A real SQLite Source Recovery → Search → Topic-context tool regression reproduced obsolete-key access after relink/restart. The policy now uses `effectiveSourceLocator`; old and ambiguous bindings are refused without changing provenance. Independent repair review found no introduced defect in that scope. All 13 affected Linux checks pass in integration. Exact Session-ID validation across `/new` or `/reset` remains open: the trusted tool context's optional `sessionId` is not yet forwarded/checked. Do not label that separate identity boundary qualified.
- **Rollback repair remains in its isolated lane.** The original admission repair passed 39 Linux checks, including process death and all supported source schemas. Independent repair review then identified a related provenance gap: a valid foreign recovery snapshot must not become associated with a different database through newly minted migration ledger rows. The lane is reproducing and repairing that shared admission invariant; its earlier pass does not certify the follow-up.
- **Notes/Session UI isolation is in an isolated coding lane.** Preserve scoped authority, stale-response suppression and draft/unknown-save ownership while fixing the independent capability load.
- **Native Chat Search freshness remains open.** Investigate a supported host change event or authoritative reconciliation seam; do not introduce a second transcript owner or assume an explicit rebuild alone satisfies freshness.
