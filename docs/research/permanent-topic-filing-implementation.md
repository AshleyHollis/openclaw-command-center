# Permanent Topic filing: implementation-ready owner brief (#356)

This is a source-grounded implementation plan, not feature activation or a
qualified release. Inspect source at the Attention predecessor97a4 and the
Everyday composition; filing code is identical. The existing topicDocuments
flag remains false. It is unsafe to treat code presence plus five mock tests as
F1-F3 qualification. Earlier descriptions of qualification as the only remaining
work are superseded by the concrete owner gaps below.

## Fixed product behavior; no new storage decision

A user uploads through native Chat and explicitly asks to file the original.
For an already exact-linked writable Conversation, its verified existing Topic
folder is the sole destination. Default is Documents; a requested safe subfolder
is below Documents. Preserve native intake original, original bytes and distinct
source identities. Do not infer Topic ownership from sidebar groups or names.
Unbound/ambiguous/archived/recovery destinations remain blocked: ask the user to
choose/resolve the exact Topic first, using existing assignment when eligible.
No broad vault discovery, automatic Topic creation, cross-Topic copies, new
upload UI, storage service, queue, OCR/PDF engine or synchronization is needed.

An explicit request is permission to attempt filing, not evidence it completed.
Report filed, already filed, not filed, blocked, or outcome unknown from the
owner's causal receipt. Files refresh lists the authorized original in the
existing explorer. Safe image/PDF reader or authorized original download uses
existing reads; unsupported previews say so. Filing must not imply Note updates.

No product decision blocks this narrow linked-Conversation package: owner,
folder, default path, original preservation and retry behavior are already
specified in #356/#213 and topic-document-workflow-delivery.md. Selecting a future
predecessor/activation date is release ordering, not a storage design question.
Cross-Topic copying, unbound destination browsing and automatic working Notes are
outside the slice; do not invent answers for them or expand this initial release.

## Existing chain and audited gaps

| Boundary | Existing owner | Required correction before activation |
| --- | --- | --- |
| Native upload and current turn | Native Chat/managed media; host tool context | Prove the canonical attachment belongs to this exact native Conversation and authorized message/turn. Tool description is not authorization. |
| Model action | documents/tool.mjs, plugin.mjs tool registration | Opt into host contextVersion2; require exact session incarnation and assertInvocationCurrent, carry trusted authority out of model arguments. |
| Target | SourceService.sessionTopicContext / requireTopicService | Freeze original Topic revision, Conversation incarnation, Note Folder identity/locator generation and writable policy; revalidate at effect and receipt, including across awaited work. |
| File effect | TopicDocumentFilingService -> existing Notes create/recovery | Pass final-effect authority through the actual Note publication owner. Entry checks or an awaited pre-hook alone cannot certify admission at commit. |
| Replay and receipt | Existing operation journal, topic_operations, Note recovery | Retain canonical original intent and prove the Note owner's exact operation/inode/digest, not current equal bytes. Finish source binding and receipt atomically after the verified effect. |
| Optional follow-up | SourceService.documentsFileAttachment | Filing-only release must never schedule Note maintenance merely because a host workflow API exists. Gate the follow-up independently on the held noteMaintenance policy. |

Concrete current-source evidence:

- loadExactMedia accepts any canonical media://inbound reference through generic
  runtime.media.loadWebMedia; it passes no invoking Conversation or native
  attachment proof. The tool's closed arguments prevent model Session fields,
  but that does not establish attachment membership. The five tests use a mock
  loader/coordinator/Notes/metadata; their 'foreign' case is an unbound Session,
  not another Conversation's valid managed attachment.
- tool.mjs presently accepts optional sessionId and does not carry the supported
  native context's assertInvocationCurrent. Supported fork26a9c0f and current
  upstream70a5e3762c8527d98a0532a8240fed0459924b0d expose contextVersion2,
  toolBindings and final-effect assertInvocationCurrent. These are native
  authority containers, not proof that an attachment binding producer exists.
- filing.mjs re-resolves target and reloads bytes before notes.create, but later
  file publication/attachment metadata/receipt is not guarded by original host
  invocation authority. The existing Notes create has descriptor identity,
  absence-conditioned link and inode recovery; its final synchronous authority
  admission must be explicit and proven, not replaced with another writer.
- Logical filing identity currently includes recomputed documentPath. Changed
  source filename/subfolder can therefore acquire a different operation ID.
  Intent is reconstructed from current source before journal reconciliation.
- Reconcile currently calls notes.read, compares digest and attachment metadata,
  and accepts success without consulting exact Note create recovery evidence.
  A foreign equal-byte replacement or interruption between Note publication and
  attachment binding is not fully resolved by that check.
- Cross-Topic attachment metadata is checked in ensureAttachmentReference only
  after notes.create. Admission must check foreign ownership before the effect;
  the final atomic binding must repeat the conflict check under its transaction.
- SourceService currently invokes maintenanceSchedule after applied/reconciled
  filing whenever the schedule object exists. Filing-only admission must keep
  this trigger disabled, independent of native capability availability.

## Implementation sequence and contracts

1. **Native attachment proof, in the existing producer/read owner.** Bind upload
   identity to the exact host-selected agent/Session incarnation and authoritative
   user message/turn. Carry an opaque trusted proof via native toolBindings or a
   supported scoped native resolver. It must resolve canonical managed media and
   its source identity/generation, with bounded reads and live invocation guard.
   Model text, a guessed ID, media-root access or a URL scheme is insufficient.
   Use the existing public transcript identity/visible-delta owner for message
   verification only where its native media mapping is actually available; do
   not parse display text into authority or build a CC transcript/upload store.
   The audited SDK supplies transcript readers and authority containers but no
   demonstrated Conversation-scoped attachment proof to this filing caller.
   If the configured native upload owner cannot supply one, the prerequisite is
   a narrow generic native owner contract, separately tracked/tested/packaged;
   fail closed rather than assume generic loadWebMedia provides it.
2. **Closed filing command through the current owner.** Tool parameters remain
   mediaRef and optional safe subfolder. Host runtime supplies mandatory exact
   Conversation incarnation, attachment proof and synchronous authority guard.
   Freeze target and source basis once. Enforce actual loaded size against the
   existing100MiB bound, retain optimizeImages:false and original-byte digest.
   Check existing foreign attachment ownership before preparing any file effect.
3. **Original intent in existing persistence.** Use the current journal and
   topic_operations/source-specific recovery, never a second operation store.
   Identify one filing by exact Topic/Conversation incarnation/native source
   identity; freeze safe destination, bytes revision and conditional absence
   base in its canonical intent. An unchanged explicit retry recovers that
   intent; a changed destination/attachment under the retained ID is conflict.
   Do not select a new ID merely because a filename changed or reread a newer
   Topic/folder revision to force a stale attempt through. Keep old disabled
   owner receipts readable/reconcile-only or reject them explicitly; no silent
   reinterpretation of persisted IDs during a future transition.
4. **Existing Note publication/recovery integration.** Derive its stable child
   operation from the filing intent and use the existing host exclusion and
   conditional no-replace effect. Carry original invocation/source/target checks
   through the final synchronous publication admission and receipt transaction.
   The public host staging/retained-directory primitive remains the effect owner;
   verify its actual guard support on the sealed host, and add only a generic
   guarded admission seam if necessary. An awaited beforeAtomicCommit callback
   is not that proof. Reconcile only consults retained inode/source operation
   evidence and never dispatches another write. Missing effect after an attempted
   publication is unknown; foreign replacement is conflict, including equal bytes.
5. **Causal completion.** After the Note owner proves its effect, atomically bind
   the native source and exact filed document to the existing filing receipt in
   metadata, repeating ownership/identity conflicts. Interruption after file
   effect but before metadata completion resumes from that causal effect, without
   duplicate publication or equal-content inference. Return only safe relative
   path, exact document/source reference/revision and operation outcome. Source
   intake remains untouched. Retired tool invocation cannot publish stale user
   success; retained recovery evidence remains inspectable by an authorized retry.
6. **Narrow exposure, last.** Review mutation catalogue, registration and
   FIRST_LIVE_FEATURES together. Only topicDocuments can become an independently
   selected later release policy. noteWrite/noteMaintenance and all capture/Notes
   triggers remain disabled. No maintenance schedule is armed by filing alone.

These are implementation obligations, not assumed available APIs. Native proof
and final-effect guard support are actual technical admission prerequisites;
there is no user choice that can waive them or replace them with another store.
This source-only task neither adds a native patch nor enables the filing tool.

## Exact failure acceptance and stop boundaries

Run through the registered model tool/public source owner with real isolated
SQLite, Note filesystem/recovery and pinned native media/turn proof:

- F1: actual native fictional PDF upload -> explicit file -> verified original
  bytes/document receipt -> existing Files read; repeat with a distinct image.
  Unbound/ambiguous destination prompts for exact resolution without a write.
- F2: same intent/retry/restart; same names/different source identities; changed
  filename/subfolder/content/Topic revision; concurrent competing filings; death
  before effect, after publication, before source binding and after receipt;
  retained original, no foreign overwrite/duplicates, no false success from
  equal-byte foreign file. Unknown recovery never enters execution.
- F3: valid inbound ID from another Conversation, forged/stale native proof,
  replaced/closed/protected Session, Topic/Folder rebind, revoked invocation during
  media loading/staging/publication, foreign ownership before effect, traversal,
  unsupported preview and original download authorization. No maintenance trigger
  when filing-only policy is selected.

Package the exact native/plugin predecessor; independently review both authority
and recovery paths; inspect the coherent two-document filing-only Files journey.
N1-N3 automatic maintenance are explicitly excluded. Do not claim F1-F3/E1 from
service mocks, ordinary upload success or source/CI packaging. No NAS jobs,
production reads, merge, deployment, activation or backup redesign occurs here.