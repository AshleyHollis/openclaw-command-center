# Permanent Topic filing: feature candidate plan

## Supported user journey

From the exact selected Conversation, open its existing Files pane, choose an
attachment from accepted native user messages, review the linked Topic name and
Documents destination (with an optional safe relative subfolder), and explicitly
file the original. Reopen the resulting document through the existing Topic Files
reader; retain the exact Conversation incarnation and native message entry as
source lineage. An unbound Conversation requires the existing Topic assignment
flow before filing. This is the narrow workflow in #356, not a combined text
capture, automatic Note maintenance, or cross-Topic copy feature.

## Inputs and ownership

The candidate starts from Attention 97a4b084d2825ee2c461a25a996e52e761eb4868
(the published identity for product2253). PR #368 presentation changes are
optional and independent. Reuse the causal-recovery correction from PR #369,
with its exact final predecessor recorded after CI. Capture #364 and lineage #362
are not prerequisites for this native attachment workflow: they concern other
accepted sources, while native message media facts and the existing filing
receipt provide this source lineage. No new upload, queue, transcript mirror,
writer, database, or integration is introduced.

Risk: Class 3, because the filing intent, Note publication admission, and source
binding/recovery change. All topicDocuments, noteWrite, noteMaintenance and
capture/trigger feature flags stay disabled. This source candidate cannot claim
installed native qualification or authorize activation.

## Implementation sequence

1. Prove on the pinned real SDK that bounded exact-Session visible transcript
   pages retain accepted user message.__openclaw.media facts, canonical inbound
   media URLs and stable entry IDs. Ignore assistant media, display text, legacy
   top-level media and arbitrary URLs. Bound pages and bytes and fail closed on
   missing, reset, generation change, unavailable, or oversized entries. No
   unbounded scan or background polling.
2. Add selection/review preparation to the existing filing SourceService owner.
   Resolve the selected native entry/media pair against the exact current
   Conversation binding. Review only safe filename, content type/size, linked
   Topic and relative Documents destination. Freeze source digest, native entry,
   Session incarnation, Topic revision, folder locator generation and original
   safe path once in existing topic_operations under a stable random UUID. The
   Note child operation derives from that UUID, never from a changed filename.
3. Carry authenticated request/invocation runtime separately from JSON. Recheck
   native accepted source and exact destination after awaited work, then retain
   the synchronous lifetime/target fence at conditional file publication and
   metadata completion. Reuse the existing Note filesystem exclusion and owner;
   add a narrow guarded admission seam only after testing its actual syscall
   semantics. A beforeAtomicCommit async callback alone is not the fence.
4. Complete native attachment binding and causal filing receipt together in
   existing metadata. Reconciliation consults the retained original intent and
   Note inode evidence, never dispatches new create, guesses success from equal
   content, or chooses a fresh ID after unknown. Old v1 records remain explicitly
   legacy/reconcile-only; do not silently reinterpret IDs.
5. Integrate closed list/prepare/file/reconcile/lineage actions with existing
   authenticated public APIs and the existing native Topic Files pane. Preserve
   review drafts on ordinary errors, block duplicate pending submission, show
   unknown with an explicit Check result action, refresh the existing reader on
   success, and reopen the exact document and source Conversation. Entry IDs are
   retained lineage; do not invent an unsupported native message navigation API.
6. Independently review authority and recovery, run exact-head hosted owner and
   browser checks, inspect a fictional PDF/image journey and publish one coherent
   draft PR with explicit predecessor evidence. Installed matching-host F1-F3,
   Btrfs durability, deployment and activation remain separately gated.

## Demo and failure acceptance

- Fictional PDF and image accepted by the native upload owner; select each from
  the exact Chat, review the linked Topic/Documents path, explicitly file, reopen
  original bytes in Files and inspect Conversation/message lineage.
- Cancel review creates no file. Unbound/ambiguous Topic requires assignment.
  Unsupported previews retain authorized original download behavior.
- Reject guessed/other-Conversation/assistant/legacy media, replaced Session,
  protected history, changed Topic/folder, source generation reset, revoked
  invocation during staging, traversal and foreign ownership before publication.
- Same frozen intent, retry, restart and concurrent submission yield one causal
  document. Equal-byte foreign replacement conflicts. Death before effect,
  after publication and before metadata binding recover only the original
  attempt. Unknown and proven not-applied checks never execute a fresh create.
- Filing alone never starts Note maintenance, a producer or an automation.

## Evidence status

Native 26a9 source audit found structured media facts persisted by the existing
chat upload owner and preserved by the public visible-message delta reader.
That makes a resolver feasible; it is not yet a passing real native SDK test,
actual upload demo, final synchronous publication proof or installed admission.
The old implementation brief's missing mapping concern is superseded only after
that test passes. No API availability is inferred from a service double.
