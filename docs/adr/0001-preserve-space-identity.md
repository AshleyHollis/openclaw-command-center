---
status: accepted
---

# Preserve Space identity through lifecycle changes

[Issue #9](https://github.com/AshleyHollis/openclaw-command-center/issues/9) established that renaming, recategorization, source relocation, Primary Session replacement, archive, and restore preserve a Space's stable identity. This keeps references, reminders, conversations, search history, and audit records attached predictably.

A merge explicitly chooses an existing or newly provisioned continuing destination; absorbed Spaces become terminal Retired Spaces with lineage to it. A split preserves the original identity when a meaningful core remains, but retires it and creates all-new successors when the original concept is dissolved. Every resulting Space explicitly selects a Primary Session, and transcripts are never concatenated or divided.

Notes and Space Conversations move only as whole records, while a nested folder subtree may batch multiple whole Notes. Merge and split must account explicitly for Reminders and schedules. Structural Changes use previewed, idempotent steps and truthful recovery because authoritative filesystem, Session, scheduler, and metadata effects cannot share a genuine transaction.
