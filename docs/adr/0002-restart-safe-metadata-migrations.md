---
status: accepted
---

# Keep metadata migrations forward-only and recoverable

[Issue #35](https://github.com/AshleyHollis/openclaw-command-center/issues/35) establishes an ordered, transactional ledger for Command Center metadata migrations. Before a destructive migration, Command Center publishes and verifies a source-schema SQLite snapshot inside its normal plugin state directory. That location makes the database, manifest, and snapshot part of OpenClaw's existing broad state archive without introducing a separate export format.

Migrations move forward only. A failed transaction leaves the prior schema usable and Command Center enters Recovery-only. If the process stops after the SQLite commit but before the recovery manifest is marked committed, the next startup verifies the ledger and snapshot, completes that manifest transition, and only then permits mutations.

Rollback is an external recovery operation: restore the verified snapshot and install the exact prior compatible plugin release. Command Center never performs a down-migration. Snapshot hashing and application-data fingerprinting are streamed so verification remains bounded-memory as the metadata store grows.

The snapshot content digest is also its identity in the migration ledger, preventing valid recovery material from one store being substituted for another. Publication and every later recovery read validate each existing directory component without following links, so recovery material cannot escape the plugin state tree or be omitted from a broad archive.
