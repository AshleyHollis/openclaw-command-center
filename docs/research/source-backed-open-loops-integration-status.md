# Source-backed open loops: integration and qualification status

Status recorded 20 September 2026. All examples and tests use fictional data. This record describes isolated local development evidence; it does not authorize deployment, live-source access, messages, payments, purchases, live scheduled jobs, or notification delivery.

## Current candidate boundary

The branch builds on PR #252 head `3a51d5021ebfca2d24159f8590bed01934ac596b`. Original messages, documents, and native Sessions remain authoritative. Command Center stores immutable observations, exact identities, explicit user decisions, workflow state, and rebuildable quiet-Attention projections. [ADR 0006](../adr/0006-source-backed-open-loops-and-quiet-attention.md) defines that ownership boundary.

The package contains authenticated `command-center.v1.open-loops.*` contracts, but the build-owned first-live allowlist still withholds them pending a separately reviewed admission change. A sealed Linux package now passes authenticated mount and closed-page Reminder restart qualification. Open-loop service journeys use the real plugin, bridge validator/dispatcher, SQLite owners, and isolated source/Scheduler boundaries; the release gate intentionally prevents claiming registered public-route qualification for those new methods.

## Implemented locally

- **Actionable Attention:** readable evidence and provenance; confirm/dismiss, defer, precise or calendar-date correction, resolve, response-addressed, and non-paying payment-status controls; stable logical-operation retries; bounded full inventory with honest totals.
- **Quiet identity:** exact authority/account/invoice correlation can unite email and SMS evidence into one obligation. Sender, supplier, name, wording, and amount similarity cannot merge obligations. Historical and informational evidence remains quiet.
- **Selected document pilot:** one persisted document Source Reference is read through the existing document/Note owner. The public caller cannot provide content, source version, cursor, scope identity, or availability claims. The owner journals the caller's closed intent before reading, then persists a content-free prepared child command before applying it. An interrupted root reconciles that child without rereading source bytes; a completed retry replays the recorded outcome rather than reading a newer revision. Batches are bounded and restart-safe. Re-selecting an unchanged version is duplicate-free even at a later observation time. A read outage becomes linked, visible unavailable evidence and does not resolve the existing obligation. The [declared extraction support](selected-document-extraction-support.md) is limited to labelled UTF-8 plaintext invoices and is measured against a mixed fictional corpus.
- **Native timing:** confirmed Topic-bound obligations own one deterministic native Reminder. Corrected dates and deferrals reschedule it; paid/resolved/cancelled outcomes disable it. Historical selected documents never create overdue Reminder jobs. Calendar dates retain their IANA timezone separately from precise instants and schedule at 09:00 local time. Reconciliation rereads the authoritative job revision, preserves unknown outcomes, and does not recreate a disabled job after a late wakeup.
- **Single presentation:** Dashboard suppresses the Scheduler-owned projection for an open-loop-owned Reminder, leaving one actionable open-loop item and one badge count.
- **Renovation:** exact purchase-to-requirement confirmation and correction, separate return/refund/resale obligations, delivered-versus-installed outcomes, explicit stage activation, grouped active-stage blockers with individual controls, revised-quote and purchase-choice challenges, and explicit decision revision with retained prior evidence.

No control sends a message, makes a payment, purchases an item, or rewrites authoritative Notes.

## Source and host inventory

| Capability | Current evidence | Status |
| --- | --- | --- |
| Email/SMS | Closed normalized envelopes and exact source/version fixtures | No verified live mailbox or SMS reader; scanning remains unauthorized. |
| Selected document | Plugin integration uses an authoritative reader fixture. A bounded extraction corpus measures fourteen supported layouts against twenty negative/adversarial documents, requiring every declared result and field plus 1.0 aggregate precision, recall, and field accuracy. Strict and bounded optional-field validation omits impossible or overlong dates and invalid amounts without creating a Reminder or stranding replay. The composed descriptor-backed owner → plugin → Reminder → restart/outage test passed on Linux. | Implemented plaintext pilot; live email/SMS and exact original navigation remain unavailable. |
| Original navigation | Public evidence includes source system, kind, and version | Exact document/Session navigation contract is unavailable; UI states this honestly. |
| Scheduler | Existing Reminder adapter plus durable operation/revision/recovery owners | Packaged page-closed, completion, and two-restart quietness proof passed. |
| Device notifications | Release policy retains `notifications: false` | Disabled pending separate native authority/delivery qualification. |
| Renovation capture | Registered owner/bridge/UI contracts with fictional browser and service tests | Implemented and package-byte-correlated; public host-route proof awaits the separate release allowlist change. |

## Acceptance status

| Case | Local status |
| --- | --- |
| One bill across exact email and SMS identity; distinct invoices remain distinct | Verified |
| Missing, corrected, precise, and date-only due timing | Verified locally |
| Partial, pending, paid, and paid-plus-later-conflict lifecycle | Verified |
| Native Reminder create/reschedule/cancel, restart replay, lost response, repeated evidence, stale stored revision, and payment/wakeup race | Verified at isolated owner/service boundaries |
| Explicit reply request and later addressed outcome | Verified without sending |
| Historical baseline, informational messages, and unavailable source | Verified quiet/visible as applicable |
| Exact renovation purchase, incorrect-link correction, replacement follow-up, split fulfilment, activated blocker, and revised-quote challenge | Verified through owners and native UI module |
| One presentation when an owned Reminder also fires | Verified in Dashboard projection |
| Packaged plugin, page closed, process restart, and real source owner | Qualified with fictional isolated state; exact original navigation remains unavailable |

## Exact local evidence

- Foundation: PR #252 head `3a51d5021ebfca2d24159f8590bed01934ac596b`.
- Sealed code candidate: `e7dadbb` on `feature/actionable-attention-milestone`.
- Milestone command: `node --test test/message-intake.test.mjs test/native-ui-attention.test.mjs test/open-loop-bridge.test.mjs test/open-loop-contracts.test.mjs test/open-loop-hardening.test.mjs test/open-loop-reminder-coordinator.test.mjs test/open-loop-storage.test.mjs test/plugin-integration.test.mjs test/reminder-runtime-lifecycle.test.mjs test/renovation-follow-through.test.mjs test/selected-source-intake.test.mjs test/transaction-intake.test.mjs test/dashboard-payload.integration.test.mjs test/dashboard-service.test.mjs` — **137 passed, 1 explicitly skipped on Windows, 0 failed**. The skipped test is the descriptor-backed real-owner composition intended for Linux qualification.
- Native browser command: `node --test test/native-ui-attention.test.mjs` — **30 passed, 0 failed**. Inspected screenshots: `<workspace-output>/attention-bill.png` and `<workspace-output>/attention-renovation-stage.png`.
- Clean Linux `npm run check` passed. `npm run build` passed with digest `a25877340c67d932c08b9b4f2093b9febc4416b2d9afe04866ba59b3775a7a2d`. `git diff --check` passed.
- Linux plugin integration passed 24/24, including the previously Windows-skipped descriptor-backed owner composition.
- Archive SHA-256: `992863d0dc0bd06653543b66bd0f294f90d1e97e12dc3f5ccc85f78ab5bfea97`. Installed `dist` matched the clean build byte-for-byte.
- The isolated pinned-host journey passed 8/8: authenticated package mount, page closed, same due episode after restart, native Scheduler completion, and continued quietness after a second restart.
- Final authenticated bridge and native Attention browser regression passed 51/51. The bridge no longer acquires deferred notification reconciliation after an in-app Attention mutation.
- The earlier broad Windows run remains non-green: 1,076 passed, 206 failed, and 79 skipped. Platform identity, symlink, `fsync`, signal, and unavailable host-coordinator failures prevent treating it as a passing lane.
- An earlier legacy restoration slice still observed zero restored rows where one was expected. Migration/rollback remains unqualified despite the green package mount and restart journey.

## Required handoff

1. Review the sealed candidate and the notification-independent Attention fix at `e7dadbb`.
2. Prepare a separate release-manifest admission change for the exact open-loop methods intended for release.
3. Rebuild and reinstall the resulting archive in a fresh disposable pinned host, then rerun the 24 plugin-integration tests, 51 focused bridge/browser tests, and 8-check restart journey.
4. Exercise registered public routes for the bill and renovation journeys only after that reviewed admission change exists.
5. Repair or clarify the restoration-row mismatch and rehearse migration/rollback against copied fictional state.
6. Present the package, host, traffic, restart, restoration, and known-adapter evidence for deployment approval.
