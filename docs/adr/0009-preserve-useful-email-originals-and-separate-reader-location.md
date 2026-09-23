---
status: accepted
date: 2026-09-23
issues: [260, 273]
---

# Preserve useful email originals and separate reader location

Useful correspondence remains in Outlook. An ordinary resolved message may be
archived; an outstanding action or review message remains accessible through the
existing folders. Resolving an Attention item does not delete its original
email, Topic Note or selected attachment. Existing junk and marketing rules keep
their current scope; this decision adds no deletion rule.

An email-derived obligation has three distinct identities: the upstream message
and source revision used for extraction, the retained Topic Note reference and
revision, and the current Outlook reader destination. A folder move can change
the last one without creating another obligation or changing a user decision.
The reader destination is recorded only for an already accepted source revision.
Each exact lookup adds an immutable reader observation; the newest observation
is the current-location projection and can also report that the original was
unavailable at the last lookup. It never rewrites an accepted intake receipt.
Command Center accepts a bounded, validated provider `webLink` and exposes it
only through an operator-authorized Attention read. The browser opens Outlook in
a separate tab; Outlook remains responsible for access. A link is explicitly
unverified until the user opens it. Missing or stale original access does not
invalidate a separately verified supporting Note.

The email collector's metadata and extracted body text may be truncated and are
not a complete archive. The source email remains the authoritative original;
Topic Notes retain selected useful knowledge, and the existing attachment store
retains selected important attachments.

Raw processing-file cleanup is a later, separate lifecycle decision. Before any
file is pruned, its owner must inventory and preserve the durable source plan,
accepted extraction and processor version, all outcome and run receipts,
resumable input/checkpoint needed after interruption, reader-location repair
evidence, and every user confirmation, correction, deferral and payment
assertion. A cleanup policy needs an explicit retention period, backup and
restore verification, reconciliation of incomplete runs, and a dry-run inventory.
This decision sets no retention period and authorizes no pruning.
