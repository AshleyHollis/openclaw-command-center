# Explicit existing-data reconciliation

## Missing-folder preparation

Before freezing the reconciliation plan, explicitly prepare a genuinely missing
Topic using `openclaw command-center prepare-topic preflight|execute|resume|verify
--plan <absolute-private-json> --digest <canonical-plan-sha256>`. This separate
one-Topic plan uses `reconciliationPlanDigest` and contains exactly
`schemaVersion: 1`, `logicalOperationId`, `topicId`, `name`, `paraCategory`,
`folderPath`, `noteVaultRoots`, and `protectedSessions`. Names and paths must already
be canonical. The single approved root must match configured `topics.noteRoot`;
the plan does not override host configuration. Protected Session tuples use the
same closed identity fields as reconciliation below.

The complete preparation digest is persisted in the existing conditional owner
before effects. Its roots and protected Sessions cannot change under an unchanged
operation ID. Preflight and verification open existing metadata read-only and
never create folders, markers or Sessions. Execute uses the existing conditional
provisioning owner; resume requires that original reservation and never
redispatches an uncertain native creation. Verification requires completed
preparation and checks exact folder/Primary identity. Normal approved metadata
startup/migration is separate from read-only inspection.

After verification, retain the Topic ID, actual revision and exact Primary from
its receipts. Omit this Topic from reconciliation `bootstraps`, assign its histories
to the existing Topic/revision, and add its Primary to `protectedSessions`. Then
freeze the reconciliation plan. Preparation and import have separate counts;
neither is live UI acceptance. The command does not enable deferred new-Topic UI.

## Import and verification

The plugin declares a lazy native `command-center reconcile` CLI. Discovery does
not start services or import data. This is a local operator command, not a new
Gateway permission, RPC, startup migration, or alternative Chat implementation.

The four commands are `preflight`, `execute`, `resume`, and `verify`. Each requires
`--plan <absolute-path>` and `--digest <canonical-plan-sha256>`. Keep the plan and
all real source information private, outside this public repository.

The closed version-1 plan contains `schemaVersion`, `logicalOperationId`,
`sourceOptions`, `bootstraps`, `mappings`, and `protectedSessions`. Its approved
SHA-256 is computed by `reconciliationPlanDigest`; whitespace and object-key
ordering are immaterial. Arrays and all identities remain significant.

- `sourceOptions` pins the preservation root, manifest and trusted public key,
  plus any exact approved attachment-disposition receipts.
- `bootstraps` are the existing Topic bootstrap owner's closed operation inputs.
  Each pins an existing folder witness and either an exact existing non-main
  Primary or the owner's conditional first-Primary creation identity.
- `mappings` cover every signed source channel exactly once, with stable history
  operation IDs, agent IDs, optional Topic IDs and original Topic revisions.
- `protectedSessions` explicitly retain existing main/reporting native identities.
  They cannot be claimed as Topic Primaries or import destinations.

Preflight verifies the complete signed source, owner-specific intents, existing
receipts, folder/Primary witnesses, native history destinations, overlaps and
protected identities before any child effect. It reserves nothing. Missing
folders are refused; this command does not silently create or adopt them.

Execution requires the exact preserved-history reader source to be configured so
that imported data has an admitted read path. One durable reconciliation receipt
pins the plan digest and claims every child operation ID. Child owners retain
their own execution, conditional writes and source-specific recovery proofs.
Other journal writers cannot consume an unstarted child's identity.

Resume requires that unchanged durable parent. It can start the parent's children
that were never reserved, but cannot recreate any dispatched-but-missing native
effect. Completed child effects are verified rather than repeated. Verification
requires a completed parent and completed children and performs no enrollment or
checkpointing. Preflight and verification open only existing, validated current
metadata read-only: creation, schema migration and pending recovery reconciliation
must happen through their separately approved normal workflow.

CLI output is limited to plan identity and accounting. Attachment-byte coverage
does not claim browser download proof. Missing archived source access, post-export
updates, shared/Notes-only content, configured reader availability and full live UI
coverage must still be accounted for in the actual deployment rehearsal.

Current evidence includes focused fictional native-host rehearsal and actual
`openclaw command-center reconcile verify` loading through the selected host's
normal launcher, discovery and CLI parser. The copied built plugin uses ordinary
Linux package permissions; no loader security guard is relaxed. Existing native
Session entries/transcripts, Notes and metadata receipts remain unchanged after
verification. Enable `COMMAND_CENTER_REHEARSAL_REAL_CLI=1` for the isolated
`reconcile` fixture; `cli-discovery` is its smaller package-discovery diagnostic.
This does not qualify real private-source execution/resume, complete private
mapping, a coherent prepared Linux artifact, deployed import or sealed acceptance.
