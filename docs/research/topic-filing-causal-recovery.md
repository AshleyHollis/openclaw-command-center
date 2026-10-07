# Disabled Topic filing causal recovery candidate (#356)

This isolated prerequisite is based on frozen Everyday Topic composition
018f4aa10a52c1122f0f045063034dbef05e9d05. It does not enable topicDocuments,
change native/SDK pins or qualify installed filing. Class3 applies because the
existing document write owner's reconciliation contract changes.

The narrow invariant is that a filing retry can report success only when the
existing Note create owner proves that exact operation's retained publication,
including inode, source reference, bytes and Note Folder binding. Equal current
bytes are insufficient. An absent destination without causal absence proof stays
unknown. Recovery consults existing Note recovery and the current mutation journal;
it never substitutes a second writer, storage service, queue or workflow system.

The previous implementation accepted an equal-byte foreign replacement after
SQLite restart (red test6e2ecb2/run37587881850). It also rejected a proven Note
publication when an interruption left attachment metadata absent (red test
4a20198/run37588614907). Reconciliation now consults the Note owner's existing
exact-operation recovery, repairs only this proven document's missing binding,
and retains conflict/unknown when causal evidence cannot establish completion.
It does not update an existing binding with a different observed revision.
An already foreign-owned attachment is refused before media loading or document
publication; its ownership is checked again after awaited media reads. This fixes
copy-before-rejection for known foreign bindings (red16428e3/run37589358246).
These admission checks do not close the final publication race: native invocation
and target authority at the effect still require the separate guarded owner seam.
The existing coordinator retains the operation receipt and performs no fresh
create during unknown reconciliation; no schema or new operation store is added.
Tests enter the public SourceService.documentsFileAttachment boundary with real
isolated SQLite, enrolled Note Folder and real descriptor-relative Note writes.
Only external native Session catalogue/media and host filesystem contracts use
fictional fixtures. They do not establish native upload membership authority.

Remaining admission prerequisites in permanent-topic-filing-implementation.md
remain material: native Conversation/turn attachment proof and final-effect
invocation authority; frozen original intent and path-independent filing identity;
atomic source binding plus filing receipt; independently held maintenance trigger.
No existing native attachment-proof producer is demonstrated to this caller.
Current native context authority containers are not a substitute. Those gaps
prevent activation, but do not prevent this CC-only causal recovery correction.

All actual native two-document upload/explicit-file/Files journeys, revoked-turn
and final-publication cases, Btrfs/installed pinned pair qualification and F1–F3
remain open. No production reads, NAS job, shared WSL restart, merge, deployment,
feature activation or unrelated performance measurement occurs here. Local work
is limited to lightweight checks; hosted Linux runs the owner/filesystem lane.


