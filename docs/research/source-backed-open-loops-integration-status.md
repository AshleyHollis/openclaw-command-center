# Source-backed open loops: integration and qualification status

Status recorded 20 September 2026. All examples and tests use fictional data. This record describes isolated development evidence; it does not authorize deployment or live-source access.

## Implemented ownership and entry points

Original messages, documents and native Sessions remain authoritative. Command Center schema 9 stores immutable source observations, exact entity references, explicit user decisions, workflow state and rebuildable quiet-Attention projections. [ADR 0006](../adr/0006-source-backed-open-loops-and-quiet-attention.md) defines the ownership boundary.

The packaged plugin now registers these authenticated host methods:

- `command-center.v1.open-loops.list` and `.get` use `operator.read`, bounded paging and a closed result projection. Detail reads expose selected source facts and withhold raw bodies, attachment identifiers and private locators.
- `command-center.v1.open-loops.decide` and `.payment-status` use `operator.write`, canonical operation identifiers, optimistic revisions and the authenticated operator identity. They update Command Center workflow evidence only. They cannot send a message, submit a form or make a payment.
- `command-center.v1.dashboard.get` projects a small highlighted set, honest totals and bounded Coming-up rows. Historical-only evidence remains quiet.

The normalized message and transaction intake contracts are internal source-adapter boundaries. They are not presented as live email, SMS, attachment or bank integrations.

## Source and host inventory

| Capability | Current evidence | Status and consequence |
| --- | --- | --- |
| Email and SMS intake | Closed normalized envelope plus exact source/version identity; fictional adapter tests | **Adapter gap.** No supported live mailbox or SMS event contract has been verified or enabled. No mailbox scan is implemented. |
| Attachments | Envelope retains bounded attachment identities and evidence selectors; public detail projection withholds attachment identifiers | **Reader/navigation gap.** No authorized host attachment reader or Open-original route is wired for these sources. |
| Bills and payment requests | One obligation can correlate exact invoice/account evidence across channels; payment states and conflicts persist | **Implemented locally.** A request is evidence, not proof that the debt is accepted. No payment execution exists. |
| Reply requests | Explicit requests surface immediately; informational messages remain quiet | **Implemented locally.** The UI can record that a response was addressed. Drafting and sending remain unavailable. |
| Quote/order/delivery lifecycle | Exact quote/order identities, revisions, dispatch, partial delivery, delivery, installation, cancellation and corrected dates | **Implemented locally.** Same supplier/name/amount never provides correlation authority. |
| Decision memory | Tentative versus explicit decisions, alternatives, rationale, assumptions, revision and material challenges | **Implemented locally.** New evidence requests reconsideration without changing the decision. Human-readable Note ownership remains a later integration choice. |
| Entity correction | Exact-observation confirm/reject/replace corrections with reversible provenance | **Implemented locally.** There is no inferred automatic merge or cross-Topic expansion. |
| Scheduler | Existing native Reminder/Scheduler owner remains unchanged | **Integration gap.** Due-window projection is evaluated on Dashboard reads. No bill-specific native wakeup is created in this branch. |
| Local notifications | Release policy has `notifications: false` | **Host/release gap.** No notification binding or delivery was activated. Attention remains available in the native page. |
| Incremental source checkpoints | Immutable source versions and operation replay are durable | **Adapter gap.** A live adapter must own a bounded cursor/checkpoint contract before backfill is enabled. The common intake does not claim this work is complete. |

## Batch evidence

| Batch | Commit | Evidence |
| --- | --- | --- |
| Ownership and domain contracts | `3170542` | ADR, closed observation/open-loop contracts and quiet projection tests |
| Persistence and recovery | `7ba5a36` | Additive schema 9 migration, recovery ledger, restart-safe operation receipts and packaged modules |
| Messages, bills and native projection | `8305b4e` | Informational silence, immediate reply requests, future bills, exact cross-channel invoices, payment lifecycle, dashboard and browser tests |
| Transactions and corrections | `c9d4164` | Quote revisions, split delivery, delivery versus installation, corrected dates, cancellation and exact-order isolation |
| Decision memory | `fe93039` | Tentative/explicit choices, retained rationale, changed assumptions and explicit supersession |
| Entity identity corrections | `e89191a` | Same-name isolation and reversible exact-observation correction |
| Registered host paths and UI actions | `792f19b` | Authenticated bridge reads/writes, bounded projections, public-result redaction, native evidence review and non-executing payment/response status forms |
| Restart and noise hardening | `666a745` | Restart/replay convergence, 500 historical bills with zero active Attention, five current requests with three highlights and honest count, 1,000 informational messages with zero loops |

The repository check passes. The focused open-loop, dashboard, bridge, plugin-startup and browser clusters pass. The broader Windows storage/build runs pass all executable cases; three existing fixtures fail before product code because the current Windows account cannot create symbolic links (`EPERM`). Linux or Developer Mode qualification remains required for those symlink cases.

## Acceptance status

| Case | Status | Local evidence or remaining proof |
| --- | --- | --- |
| Bill across email and SMS | Locally verified | Exact invoice identity produces one loop and two immutable observations; same supplier/account/amount alone does not merge. |
| Future and missing bill dates | Locally verified | Future bill stays Coming up until the due window; a missing date remains unknown and actionable without an invented deadline. |
| Payment lifecycle | Locally verified | Partial and pending stay open; explicit paid evidence resolves; a later reminder creates reconciliation; dismissing a confirmed bill cannot imply cancellation. |
| Message requiring reply | Locally verified | Explicit request is active; informational message is quiet; native outcome recording states that it sends nothing. |
| Historical import noise | Locally verified | Large fictional baseline produces no new urgent backlog; 1,000 informational messages create no loops. |
| Revised quote | Locally verified | Versions remain distinct; a total with a different tax basis is flagged for comparison without asserting an increase. |
| Order and delivery | Locally verified | Partial delivery stays open; delivery and installation remain distinct; unrelated same-supplier delivery cannot close the order. |
| Appointment revisions | Contract implemented; final UI proof pending | Exact appointment revisions use material-change handling. A dedicated browser fixture remains useful. |
| Decision change | Locally verified | Old rationale/choice remain; contradictory assumption evidence does not reverse the decision; explicit revision does. |
| Same-name entity correction | Locally verified | Correction affects one exact observation and can be explicitly reversed. |
| Live email/SMS/attachment intake | Blocked by missing verified source contracts | Requires a separately authorized adapter and bounded checkpoint proof. |
| Native due wakeups and device notifications | Awaiting host/release qualification | Must reuse Scheduler and notification owners after final host compatibility is pinned. |

## Compatibility and staged integration

This branch retains the repository's pinned host tuple: OpenClaw `2026.9.4`, commit `9eb16e01c14dd7eaf654aa2d2a9121b9e9f74b84`, Command Center package `0.4.0`, capability bridge protocol 1 and schema 9. It deliberately does not edit host/plugin version or commit pins.

The separate upgrade task reported candidate OpenClaw `2026.9.5` at `8490d8016bdd46c8e29301efbc91f99eaab7de8d`, based on upstream `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`. That pair has not been qualified by this branch and must not be inferred compatible from version strings.

Later integration should proceed in this order:

1. Rebase or merge after the host upgrade lands, resolve only source-level conflicts, and pin the exact candidate pair.
2. Run schema 8-to-9 migration and rollback rehearsal on copied fictional state; retain recovery material and ledger evidence.
3. Build the package and run registered bridge/native browser journeys on the exact isolated host, including stale revisions and restart replay.
4. Add one source adapter at a time only after its authorization, attachment, deletion, cursor and bounded-backfill contracts are verified. Keep the normalized envelope as the seam.
5. Wire due resurfacing through native Scheduler and qualify notification delivery separately. A missing notification capability must leave the native Inbox readable.
6. Deploy in a later authorized batch with pre-deployment backup, health checks and rollback criteria. This branch performs none of those production actions.
