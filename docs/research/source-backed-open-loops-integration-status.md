# Source-backed open loops: integration and qualification status

Status recorded 20 September 2026. All examples and tests use fictional data. This record describes isolated local development evidence; it does not authorize deployment, live-source access, messages, payments, purchases, live scheduled jobs, or notification delivery.

## Current candidate boundary

The branch builds on PR #252 head `3a51d5021ebfca2d24159f8590bed01934ac596b`. Original messages, documents, and native Sessions remain authoritative. Command Center stores immutable observations, exact identities, explicit user decisions, workflow state, and rebuildable quiet-Attention projections. [ADR 0006](../adr/0006-source-backed-open-loops-and-quiet-attention.md) defines that ownership boundary.

The package contains authenticated `command-center.v1.open-loops.*` contracts, but the build-owned first-live allowlist still withholds them until a sealed Linux package passes isolated-host qualification. Local tests invoke the real service, bridge validator/dispatcher, SQLite owners, native UI module, and isolated fake host/Scheduler boundaries. They do not constitute a packaged OpenClaw-host run.

## Implemented locally

- **Actionable Attention:** readable evidence and provenance; confirm/dismiss, defer, precise or calendar-date correction, resolve, response-addressed, and non-paying payment-status controls; stable logical-operation retries; bounded full inventory with honest totals.
- **Quiet identity:** exact authority/account/invoice correlation can unite email and SMS evidence into one obligation. Sender, supplier, name, wording, and amount similarity cannot merge obligations. Historical and informational evidence remains quiet.
- **Selected document pilot:** one persisted document Source Reference is read through the existing document/Note owner. The public caller cannot provide content, source version, cursor, scope identity, or availability claims. The owner journals the caller's closed intent before reading, then persists a content-free prepared child command before applying it. An interrupted root reconciles that child without rereading source bytes; a completed retry replays the recorded outcome rather than reading a newer revision. Batches are bounded and restart-safe. Re-selecting an unchanged version is duplicate-free even at a later observation time. A read outage becomes linked, visible unavailable evidence and does not resolve the existing obligation.
- **Native timing:** confirmed Topic-bound obligations own one deterministic native Reminder. Corrected dates and deferrals reschedule it; paid/resolved/cancelled outcomes disable it. Historical selected documents never create overdue Reminder jobs. Calendar dates retain their IANA timezone separately from precise instants and schedule at 09:00 local time. Reconciliation rereads the authoritative job revision, preserves unknown outcomes, and does not recreate a disabled job after a late wakeup.
- **Single presentation:** Dashboard suppresses the Scheduler-owned projection for an open-loop-owned Reminder, leaving one actionable open-loop item and one badge count.
- **Renovation:** exact purchase-to-requirement confirmation and correction, separate return/refund/resale obligations, delivered-versus-installed outcomes, explicit stage activation, grouped active-stage blockers with individual controls, revised-quote and purchase-choice challenges, and explicit decision revision with retained prior evidence.

No control sends a message, makes a payment, purchases an item, or rewrites authoritative Notes.

## Source and host inventory

| Capability | Current evidence | Status |
| --- | --- | --- |
| Email/SMS | Closed normalized envelopes and exact source/version fixtures | No verified live mailbox or SMS reader; scanning remains unauthorized. |
| Selected document | Plugin integration uses an authoritative reader fixture. A composed descriptor-backed owner → plugin → Reminder → restart/outage test is authored and explicitly skipped on Windows. | Implemented pilot, pending Linux execution and packaged real-owner proof. |
| Original navigation | Public evidence includes source system, kind, and version | Exact document/Session navigation contract is unavailable; UI states this honestly. |
| Scheduler | Existing Reminder adapter plus durable operation/revision/recovery owners | Implemented locally; pending packaged page-closed/process-restart proof. |
| Device notifications | Release policy retains `notifications: false` | Disabled pending separate native authority/delivery qualification. |
| Renovation capture | Registered owner/bridge/UI contracts with fictional browser and service tests | Implemented locally; pending packaged-host proof. |

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
| Packaged plugin, page closed, process restart, real source owner, and exact original navigation | Not yet qualified |

## Exact local evidence

- Foundation: PR #252 head `3a51d5021ebfca2d24159f8590bed01934ac596b`.
- Reviewed code candidate: `1b63670` on `feature/actionable-attention-milestone`.
- Milestone command: `node --test test/message-intake.test.mjs test/native-ui-attention.test.mjs test/open-loop-bridge.test.mjs test/open-loop-contracts.test.mjs test/open-loop-hardening.test.mjs test/open-loop-reminder-coordinator.test.mjs test/open-loop-storage.test.mjs test/plugin-integration.test.mjs test/reminder-runtime-lifecycle.test.mjs test/renovation-follow-through.test.mjs test/selected-source-intake.test.mjs test/transaction-intake.test.mjs test/dashboard-payload.integration.test.mjs test/dashboard-service.test.mjs` — **135 passed, 1 explicitly skipped on Windows, 0 failed**. The skipped test is the descriptor-backed real-owner composition intended for Linux qualification.
- Native browser command: `node --test test/native-ui-attention.test.mjs` — **30 passed, 0 failed**. Inspected screenshots: `C:\Users\ashle\Source\OpenClaw\output\attention-bill.png` and `C:\Users\ashle\Source\OpenClaw\output\attention-renovation-stage.png`.
- `npm run check` passed. `npm run build` passed with digest `fe2bc08420bf8c003fde57dd4f342fca3b2fe6f820de5526fa153b564c8211ac`. `git diff --check` passed.
- The earlier broad Windows run remains non-green: 1,076 passed, 206 failed, and 79 skipped. Platform identity, symlink, `fsync`, signal, and unavailable host-coordinator failures prevent treating it as a passing lane.
- `node scripts/package-candidate.mjs --output <empty-directory>` returned `artifact-linux-required`. No archive was fabricated. Packaged migration/rollback rehearsal therefore remains unperformed.

## Required handoff

1. Produce a sealed candidate on Linux from the exact reviewed commit and retain its digest. The packaging script intentionally refuses Windows with `artifact-linux-required`.
2. Install that archive into a disposable host pinned to OpenClaw `2026.9.4` / `9eb16e01c14dd7eaf654aa2d2a9121b9e9f74b84`, using fictional state and no live source or Scheduler bindings.
3. Exercise the registered bridge and native page for the bill, source outage, timing, payment, deduplication, and renovation journeys. Close/remount the page and restart the host between steps.
4. Prove the real selected-document owner and record the remaining exact-navigation contract gap. Rehearse migration/rollback against copied fictional state.
5. Only after those receipts exist, prepare a separate release-manifest admission change and seek deployment approval.
