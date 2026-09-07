# Mutation ownership and failure contracts

Required for changes to commands, recovery, or delayed publication. The user approved these safeguards on 2026-09-06. See [researched rationale](../research/recovery-ordering-patterns-research.md).

## Owning commands

Each domain owner owns preparation, source effects, verification and completion. UI, HTTP and bridge callers delegate closed domain commands. They must not assemble low-level writes or infer completion from matching current values.

Preserve the authenticated scope, durable target identity, caller's original expected revision, logical operation ID and canonical intent. A retry must keep them unchanged; a changed intent under an old ID is a conflict. Never reread a newer revision merely to make the old command succeed. Conditional creation requires an absence precondition at the source's actual commit; a pre-list followed by an upsert is not equivalent.

For one database, use a closed owning transaction to commit local state and its operation/step evidence together. For filesystem or native Cron effects, first record recoverable intent, then verify source-specific causal evidence before completion. An operation ID passed only to the transport is not durable deduplication. Use the existing host exclusion primitive where needed; do not invent PID, age-stealing, heartbeat or reentrant authority.

Checks must be effective at commit/publication, including after awaited work. An earlier permission check, lock acquisition, matching content, path or Session key is insufficient. A completed receipt describes that exact operation; it must not acquire a later unrelated source revision. Compensation may touch only the still-owned effect, never restore an obsolete snapshot over another writer.

Explicit outcomes distinguish applied, not-applied, conflict, and unknown. A timeout is not proof of failure. Reconciliation must never silently enter the execution path. Notification dismissal and projection generations must survive the required restart boundary; local memory alone cannot prove durable ordering.

## Shared mechanics, domain-specific proof

Reuse existing operation-journal identity validation, metadata transactions, host conditional-write contracts and generation/exclusion primitives. Do not create another universal workflow runner. Filesystem provenance, Cron revisions, Topic Review step evidence and browser delivery lifetimes remain source-specific.

## Mandatory tests

Every affected owner must exercise the applicable scenarios through its real public interface:

- stale base and source replacement;
- unchanged retry versus changed intent under the same ID;
- lost response and interruption before/after the external effect and local receipt;
- simultaneous competing owners;
- revoked authority or replaced activation during awaited work;
- late completion attempting to replace newer state;
- absent effect versus unknown evidence;
- compensation after an unrelated edit.

Use real SQLite, filesystem semantics and process death where the claim requires them. Share scenario vocabulary/harness mechanics, not mocks of the correctness owner. An in-memory journal test is not restart proof. Record skipped or unsupported cases as gaps, not passes. Reruns are not new acceptance progress.

## Catalogue and CI

Update [mutation-owners.json](../architecture/mutation-owners.json) when adding or moving a registered write. Each bridge write and declared native HTTP action must have exactly one owner and existing regression files. `scripts/check.mjs` runs `checkMutationArchitecture` before build; the ordinary tests include its rejection fixtures.

The initial guard rejects direct effect imports, owner implementation imports, metadata mutations and raw native mutation names in transport/UI modules. It is a lexical architecture guardrail, not a JavaScript sandbox, complete call-graph analysis, or proof of transactional correctness. Computed/aliased dispatch must not be used to evade it. Independent source review and the behavioral suite remain required.

The catalogue checks registered bridge commands and all five declared native HTTP write routes against the handlers' actual closed action vocabularies. Include reconcile-only and preview actions: neither is permission to execute a fresh mutation, and previews may currently record recovery. `$request` is an inventory-only name for Search's whole-body command, not a new HTTP field. HTTP modes describe ownership intent, not runtime authorization; the actual domain owner must still enforce its contract.

Internal background commands and host-side counterpart coverage must be added before calling the app-wide catalogue complete. File existence is only traceability, never a passing-proof claim. Current `gaps` retain unresolved issue/work-package IDs; no owner is release-qualified by the architecture check.
