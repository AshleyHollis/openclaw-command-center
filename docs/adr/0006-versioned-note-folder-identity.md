---
status: accepted
---

# Persist Note Folder identity independently of mount device numbers

Linux `stat.dev` identifies the current mounted device namespace. It can change after a host restart or remount even when the Btrfs subvolume and every filesystem object are unchanged. Command Center therefore uses device numbers only for descriptor-held checks during one operation, never as durable identity.

Durable Note Folder identity version 2 binds the reserved marker UUID to the Btrfs filesystem UUID and containing subvolume ID, plus directory and marker inode/birth-time evidence. OpenClaw reads the filesystem and subvolume identity from a held directory descriptor with `BTRFS_IOC_FS_INFO` and the unprivileged `BTRFS_IOC_INO_LOOKUP` containing-subvolume special case. This identifies nested subvolumes and snapshots directly and excludes the volatile mount device number. A different filesystem or subvolume, recreated directory, replaced marker or copied marker remains a different identity.

Existing version-1 bindings are never upgraded merely because a path or name matches. They advance through the existing private, digest-pinned Note Folder Source Recovery batch, with their original Topic/source/locator revisions and stable operation IDs. This makes migration conditional, resumable and auditable. Unsupported or ambiguous witnesses remain in Source Recovery.

Persisted Note-operation inode witnesses use version 2 and ignore device renumbering only after the enclosing Note Folder binding generation has been verified. Descriptor and same-operation checks continue to compare device identity. Legacy interrupted operations retain their prior fail-closed evidence.

A Notes recovery condition no longer removes its Topic or independently verified Conversations from the native sidebar. The Topic remains in its PARA category with an explicit Notes recovery message, while Notes-dependent reads and writes remain blocked by their source owner.
