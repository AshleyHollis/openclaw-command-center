---
status: proposed
---

# Preserve Space identity and create successors for topology changes

[Issue #9](https://github.com/AshleyHollis/openclaw-command-center/issues/9) is evaluating whether routine lifecycle changes should preserve a Space's stable identity and whether merge or split should create new successors. This proposal keeps source references, reminders, conversations, search history, and audit records attached through ordinary changes while using explicit lineage for topology changes.

Merging or splitting changes the topology instead. A merge creates one new successor Space; a split creates two or more new successor Spaces. Each successor receives a fresh Primary Session, predecessor Spaces are archived with explicit lineage, and Notes and Space Conversations move only as whole records. This avoids arbitrarily privileging one predecessor identity or dividing authoritative transcripts.

MVP supports archive and restore rather than permanent Space deletion. Partially completed creation remains a recoverable Provisioning Space until its conventional Note Folder and Primary Session are both bound.
