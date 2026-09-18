# Recovery and ordering patterns: scoped research

Research date: 2026-09-06. Recommendation, not an implementation or acceptance claim. Primary sources only. The five groups below organize the retained owners; they do not replace the domain model.

## Recommendation

Use one shared **command contract**, implemented inside the existing domain owners: authenticated owner + immutable target/base + stable logical operation ID + canonical intent + durable outcome evidence + publication generation. Do not introduce a generic workflow platform, event-sourcing rewrite, separate database, cloud service, or browser intent store.

The mechanisms answer different questions:

| Mechanism | Question answered | What it cannot establish |
| --- | --- | --- |
| Conditional write / compare-and-set (CAS) | Is this still the version I was authorized to change? | Whether an earlier timed-out command caused the current state |
| Idempotency identity and intent digest | Is this the same command, with unchanged meaning, from the same permitted scope? | Safe retry unless the authoritative effect and deduplication are coupled |
| Durable intent and step state machine | Which exact steps were prepared, applied, or remain uncertain after interruption? | Current write permission or exclusive ownership |
| Commit-time fencing / generation | Does this worker still own the right to commit or publish? | Restart recovery by itself |
| Outbox/inbox and clear tombstone | What must still be delivered, and which older events must no longer be shown? | End-to-end exactly-once display on an independently restarting device |

This composition is our engineering inference from the sources below, not a requirement to adopt their infrastructure.

## Verified distinctions

1. HTTP `If-Match` uses strong entity-tag comparison and protects against lost updates; `If-None-Match: *` expresses conditional creation. Check the precondition before the mutation. RFC 9110 permits some apparent-already-applied successes, but also warns about concurrent non-cooperative updates; our operation receipts require stronger causal proof than equal current content. [RFC 9110, sections 13.1–13.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)

2. A client-provided operation identity distinguishes retries from separate identical requests. Store its parameters and reject changed intent under the same identity. AWS specifically couples recording the token and creating resources atomically; a request ID attached only to transport is insufficient. Late requests also require an explicit retention horizon. [AWS Builders’ Library: Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

3. For effects within one database, commit the business change and delivery intent together. A relay can redeliver, so consumers must deduplicate and preserve the relevant entity order. An outbox solves the dual-write gap, not arbitrary remote-effect atomicity. [AWS transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

4. A saga organizes independently committed local steps; compensation is domain-specific and cannot blindly restore old state because another writer may have changed it. Keep step evidence and make compensation conditional on still owning the exact effect. [Microsoft Saga pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga), [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)

5. A lock can expire while an old caller still runs. etcd exposes a lock-ownership key usable inside transactions and an election creation revision for ownership comparison. The applicable principle is to validate ownership at the actual write boundary—not to install etcd or assume its lock fences an unrelated filesystem/HTTP service. [etcd concurrency API](https://etcd.io/docs/v3.6/dev-guide/api_concurrency_reference_v3/)

6. CQRS can separate command and query models while sharing one store; neither a second database nor event sourcing is required. A displayed projection is not automatically a valid command base. [Microsoft CQRS pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)

7. Service workers may terminate between events, so module memory is not a durable clear fence. Durable keyed delete markers are a proven log technique, but retention must cover consumer delay: Kafka explicitly warns that lagging consumers can miss expired tombstones. For this app, the exact notification owner/sequence and supported push lifetime must determine retention, not an arbitrary timeout. [W3C Service Worker lifetime](https://www.w3.org/TR/service-workers/#service-worker-lifetime), [Apache Kafka log compaction guarantees](https://kafka.apache.org/35/design/design/#compaction)

## Mapping to the existing owners

| Owner group | Narrow application; reuse first | Decisive failure test |
| --- | --- | --- |
| Notes | Existing NoteRecovery journal and filesystem identity witness; immutable original revision; reconcile-only after ambiguity; separate authoritative Note from private draft. Never infer ownership from matching bytes. | Kill after inode publication but before receipt; reopen; verify the exact operation without executing it again. Unrelated equal bytes must not satisfy it. |
| Structural Change / Topic Review | Existing structural operation and step journal as a small domain saga. Distinguish already-applied own steps from unrelated drift using the saved effect identity; condition compensation on that identity. | Kill between a source step and step receipt; competing edit before restart; resume only owned work and preserve the competitor. |
| Settings / Scheduler / Reminders | Same-store Settings+intent transaction; existing exclusive SQLite owner; native Cron CAS. Scheduler add needs missing-only semantics rather than declarative upsert; rollback needs caller-revision conditional removal. No automatic retry when native evidence is inadequate. | Lost reply, later external Cron edit, same-ID retry: neither overwrite nor claim the newer revision. Concurrent initial creation must have one winner. |
| Search and native UI publication | Query projections remain separate from commands. Capture the source/invalidation generation at preparation and reject publication when changed; UI checks activation, principal, selected target, and attempt identity after every await. Reuse existing generations rather than another store. | Prepare A, edit source to B, then publish A; stale data must not clear B’s invalidation. Old-principal response cannot update the replacement view. |
| Attention / notifications | Existing Attention identity and host delivery/clear ledger; outbox semantics where state and intent share a DB; per-owner notification ordering and a durable clear watermark or authoritative receipt verification before display. Existing association/revocation owner remains authoritative. | Emit delayed; clear; terminate worker; deliver old emit after restart: no resurrection. Revoked association cannot deliver or recover private content. |

Suggested invariant suite shared as test vocabulary, not a new abstraction layer: stale base; same-ID altered intent; process death before/after effect; competing owner; authority revocation while awaiting; late result after replacement; absent versus unknown evidence; compensation after unrelated edit. Each test must exercise the real owning persistence/CAS boundary.

## Scope and unresolved contracts

Current inspected native Cron `cron.add` converges a declaration-keyed job (upsert). Public `cron.remove` has no caller-supplied expected revision. An adapter pre-read cannot supply the missing atomic guarantee. These are narrow host-contract questions, not justification for a product-owned scheduler or hidden retry.

Notification restart fencing still requires an approved durable receiver mechanism or supported authoritative verification path; an in-memory queue is only a same-worker ordering improvement. No new IndexedDB storage is approved by this recommendation.

Private browser draft recovery across reload/principal replacement remains a separate security/product decision. The server can recover an authorized durable operation without promising restoration of an unpersisted browser draft.

No new schema, permission, dependency, live write, migration, or rollout is authorized by this research. Keep independent final evaluation and coherent real-host acceptance.
