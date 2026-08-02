---
status: accepted
---

# Preserve Space identity and create successors for topology changes

[Issue #9](https://github.com/AshleyHollis/openclaw-command-center/issues/9) established that routine lifecycle changes preserve a Space's stable identity: renaming, PARA recategorization, Note Folder relocation, Primary Session replacement, archiving, and restoration all change attributes or bindings rather than the Space itself. This keeps source references, reminders, conversations, search history, and audit records attached predictably.

Merging or splitting changes the topology instead. A merge creates one new successor Space; a split creates two or more new successor Spaces. Each successor receives a fresh Primary Session, predecessor Spaces are archived with explicit lineage, and Notes and Space Conversations move only as whole records. This avoids arbitrarily privileging one predecessor identity or dividing authoritative transcripts.

MVP supports archive and restore rather than permanent Space deletion. Partially completed creation remains a recoverable Provisioning Space until its conventional Note Folder and Primary Session are both bound.
