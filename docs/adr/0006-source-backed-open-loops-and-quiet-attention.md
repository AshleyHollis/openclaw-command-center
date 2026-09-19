---
status: accepted-for-isolated-development
date: 2026-09-19
issues: [246, 247, 248, 249]
---

# Source-backed open loops and quiet Attention

## Context

Command Center already owns durable Attention episodes and Activity while native
OpenClaw owns Sessions, Workboard, Tasks and scheduling. The next product slice
must track unresolved commitments found in authorized messages and documents,
including bills and requests that need a reply. Most tracked work must remain
quiet until the user has a concrete reason to act.

The source remains authoritative. Extraction is an observation, not a fact or an
authorization. A payment request does not prove a valid debt; opening a payment
page does not prove payment; an unrelated delivery message does not prove receipt
of a particular order. Initial historical ingestion must not create a fresh
overdue backlog.

## Decision

Add one deep `open-loops` module. Its interface accepts bounded source
observations and confirmed or suggested loop state, and returns stable public
snapshots plus a quiet Attention projection. The implementation owns:

- canonical source observation identity and exact replay detection;
- explicit correlation using source identifiers such as invoice, account,
  transaction or order references;
- suggested versus user-confirmed loops;
- payment, response, order, decision and general loop kinds;
- waiting, monitoring, decision-needed, terminal and uncertain states;
- evidence links and user assertions with provenance;
- suppression until a review time or materially newer evidence; and
- the deterministic decision between Suggested, Waiting, Coming up, Needs
  attention, In progress and terminal presentation.

The module will persist lightweight workflow metadata in the existing Command
Center SQLite database. Original message bodies, attachments, transcripts and
Note content are not copied into this store. Evidence links identify the
authoritative source and revision. Derived interpretations are rebuildable;
explicit user confirmations, corrections, deferrals and payment assertions are
durable workflow decisions.

An observation and an open loop are different records. Several observations may
support one loop only when exact shared identifiers establish that relationship.
Sender, amount, subject similarity or nearby dates alone never correlate them.
Entities are initially typed references with evidence; no graph database or
independent editable entity authority is introduced.

Attention remains a projection. A loop qualifies only for a closed reason:

- an explicit response or decision is currently requested;
- an accepted due date has entered its configured lead window or passed;
- material evidence changed an assumption that requires review; or
- it blocks an explicitly activated stage.

Every qualifying item carries a human-readable `whyNow` and at least one safe
next action. Age and confidence alone never qualify. Historical-baseline evidence
is quiet unless later current evidence or an explicit user confirmation makes the
condition current. Critical existing Attention policy remains authoritative and
is not capped by ordinary priority presentation.

Payment lifecycle distinguishes potential, unpaid, partially paid,
payment-pending, paid, disputed, cancelled and uncertain. Settlement requires an
authoritative receipt or an explicit user assertion whose provenance remains
visible. A later conflicting reminder creates reconciliation evidence; it does
not silently reopen or dismiss the bill.

## Ownership map

| Concern | Owner |
| --- | --- |
| Original email, text, attachment or conversation | Native source / OpenClaw Session |
| Source Reference and current access | Existing Command Center source owner |
| Observation, evidence link and loop workflow metadata | New `open-loops` module in Command Center metadata SQLite |
| Actionable work already suited to Workboard | Workboard |
| Timing and recurrence | Native Scheduler |
| Attention episode/action execution | Existing Attention owner |
| Activity outcome | Existing Activity owner |
| Human-readable Topic Notes and decision Notes | Existing Note owner |
| Notification delivery and operator binding | Native notification owner |

## Interface

The external seam stays small:

- `ingestObservation(input)` records or replays one bounded observation.
- `reconcileLoop(input)` creates or conditionally advances one loop using exact
  observation identities and the caller's original expected revision.
- `listLoops(query)` and `getLoop(id)` return public snapshots.
- `projectAttention(options)` returns deterministic presentation groups without
  changing lifecycle state.

Source adapters translate email, text, documents or Sessions into this interface.
They do not gain direct database or Attention access. Tests and production callers
cross the same seam.

## Consequences

The first isolated implementation can prove useful and quiet behavior without a
live mailbox. Real email/SMS support remains an adapter and permission question;
a normalized fictional fixture is not live-integration proof. No payment,
message, approval or external side effect is added by this decision.

Adding durable tables requires a new schema migration with the existing recovery
snapshot and contiguous-ledger guarantees. Migration and feature activation stay
local until the final upgraded host/plugin pair is qualified. Public fixtures,
screenshots and tests use fictional data only.

