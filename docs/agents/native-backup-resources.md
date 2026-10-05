# Native backup participation

Command Center declares its authoritative state-relative `metadata.sqlite` and
the complete `recovery/migrations` tree in `openclaw.plugin.json`. The released
OpenClaw `backupResources` owner plans and captures these resources without
loading plugin runtime. An activated, loadable declaration opts SQLite into
verified online capture, committed WAL preservation and offline compaction.

External Notes remain with the configured file/workspace backup owner. This
declaration does not include them as plugin state, add a backup engine, exclude
projections, change schema, activate a scheduler, or weaken offsite policy.

Native archive verification/restore does not validate plugin-specific contents.
After an isolated restore, reopen metadata and recovery material through the
existing Command Center owners and check exact Topic/source links and recovery
receipt identities. Native captures are per-database, not an atomic snapshot of
all application resources. Exact package/image matching, exclusive writer
custody, application-consistent rollback selection and deployment qualification
remain separate release gates.
