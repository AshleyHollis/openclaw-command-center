---
status: proposed
date: 2026-09-26
issues: []
---

# Receive bounded Developer Work evidence from a separate DEV Gateway

DEV owns its work, request, session and source-event sequence. LIVE Command
Center owns only a bounded receipt and its local Attention, Activity and
notification projections. A work ID does not create a Topic or duplicate an
issue tracker. The receiver derives its producer identity and allowed projects
from a separately configured machine credential, never from the request body.
Controller deployment outcomes require a controller principal distinct from
ordinary DEV workers. The machine route grants no Gateway method, operator
identity, Attention action or push privilege.

One DEV owner assigns consecutive revisions within each work and commits an
immutable event with its durable outbox entry. LIVE stores the canonical event
digest, `(producer, eventId)` receipt and work cursor together. Exact replay
returns the original receipt; changed replay or a revision reused for another
intent conflicts. A gap returns the expected revision. Each attention request
also retains its own current revision, immutable kind and terminal state, so
an event for request B cannot supersede a waiting request A.

LIVE commits an accepted event before projecting it. A pending projection is
durable and recoverable after restart; acceptance alone does not claim that
Attention, Activity, notification or deployment succeeded. Projection uses
the existing owners with deterministic identities. This source is ordered by
verified work/request revision at the Attention commit, while `occurredAt`
remains source evidence. Other Attention sources keep their existing time
ordering. Replayed create-and-resolve backlogs establish a catch-up watermark
before any notification candidate is emitted.

The v1 contract accepts bounded human requests, exact request transitions,
three controller deployment incident updates and selected aggregate outcomes.
Ordinary coding progress stays on DEV. LIVE derives reason, severity and
presentation; senders cannot set them. One deployment incident request covers
failure, rollback and availability recovery, with explicit human resolution
needed to close the review. An exact DEV session handoff must verify agent,
session key, session ID and lifecycle revision at navigation time and report
stale context instead of silently opening a replacement.

The contract and local implementation are reviewable without provisioning
DEV, granting personal context, enabling notifications or changing LIVE.
