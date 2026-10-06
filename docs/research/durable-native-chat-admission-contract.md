# Durable native Chat admission: implementation contract for #260/#262

Status: recommended bounded core/plugin contract for parent review. It is not an
existing SDK capability, accepted ADR, implemented feature or activation. Native
audit: `26a9c0faa4124e53ae2eab34291d68a7245f630c`; product base `2253d49`.
The test-only `97a4` successor does not require rebasing the retained drafts.

## Recommended seam and scope

Use a configured generic input-admission consumer in the existing native
`session_pending_inputs` custody owner. Reuse Command Center's existing
intake-accounting/producer/capture owners. Add no queue, table, transcript store,
universal workflow runner or scheduling service.

First scope is text-only approved external-user native Gateway Chat input in a
currently exact Command Center-owned or explicitly linked Conversation. Include
an already owned Conversation with broken/unresolved Topic matching; that is a
coverage problem, not permission to forget the input. Exclude foreign Sessions,
internal/synthetic/goal-resume input, slash commands, hidden messages, images and
attachments. Do not infer membership from names, sidebar groups or message text.
The scope resolver must use existing exact catalog/link ownership under current
host authority; an unresolved Topic is different from absent capture authority.

The consumer remains opt-in and disabled in candidate builds. No source scan,
capture activation, schedule or notification change follows from this design.

## Verified existing native owners

At the exact audited host:

- `src/gateway/server-methods/chat-send-handler.ts:304-348` stages approved
  external input through `stageApproved` before accepted Chat acknowledgement.
- `src/gateway/server-methods/chat-user-turn-recorder.ts` and
  `src/config/sessions/session-accessor.pending-inputs.ts` bind stable `input_id`,
  exact Session, stored `request_hash`, `message_json` and `accepted_at`.
- `session-accessor.sqlite-pending-inputs.ts` retains originals for collected
  inputs, but deletes singleton rows on consumption and exact rows on completion.
  Logical Session deletion clears all custody rows.
- `user-turn-transcript-admission-write.ts` and `user-turn-transcript.ts` already
  coordinate admission waiting. Compose the new barrier; do not replace the
  existing admission handler used by the context-engine owner.
- `before_prompt_build` optional current-user fields are not universal durable
  delivery. `message_received` is fire-and-forget. `before_agent_run` fails closed
  but has no original immutable input descriptor/consumer acknowledgement.

These are source findings, not runtime qualification. The new API below must be
generic native code; Topic policy remains in the Command Center consumer.

## Exact identity and proposed API

Use the host-persisted identity, not a model reconstruction:

```ts
type ApprovedChatSource = {
  version: 1;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  sourceInputId: string;       // existing input_id
  sourceRevision: string;      // exact stored request_hash
  acceptedAt: number;          // exact stored accepted_at
  sourcePrincipalId: string;  // authenticated admission principal
};
```

Canonical CC external identity uses a fixed native/account namespace plus agent,
exact Session incarnation and input ID. Reuse `producerSourceExternalId`'s
namespace primitive. `sourceVersion` is the exact stored request fingerprint.
`request_hash` includes admitted request/binding/owner parameters; it is not a
pure content digest. Never recompute it from a prompt, falsify it to change a
processor, or include a new run/tool ID or retry clock. Database/process/lifecycle
generations fence live authority; they are not stable semantic source identity.

Proposed generic SDK registration:

```ts
api.session.events.registerInputAdmissionConsumer({
  id: 'command-center.chat-capture.v1', contractVersion: 1,
  consume: async (event, authority) => { /* closed CC intake command */ }
});
```

Host authority supplies synchronous `assertCurrent`, an exact approved-source
reader, a scoped set of original input descriptors for the current turn, and
receipt acknowledgement. Serialized descriptors convey no permission. The
registered consumer's bounded opaque scope basis contains the existing CC
Conversation reference/binding and original Topic resolution; native core must
not embed CC Topic types or treat plugin-supplied scope data as host authority.

An available event reads only the exact original `message_json`. Collected turns
expose each original input separately; their combined prompt/event is not a new
source identity. Wrappers may select an input only from the host-scoped set and
derive its external ID/revision themselves. A model cannot substitute another
source ID, binding, principal or version. After promotion retain exact original
transcript linkage; verify it when switching the source reader to transcripts.

## Custody phases, delivery and cleanup

Extend bounded consumer metadata on the same custody row with registered owner,
consumer/version, immutable source/scope basis, phase, exact receipts and original
transcript linkage. Do not add this metadata to authored message text.

| Phase | Meaning | Next phase |
|---|---|---|
| pending | original custody and consumer marker durably committed together | admitted or unavailable |
| admitted | CC durably owns a pending source descriptor; classification incomplete | accepted or unavailable |
| accepted | existing immutable accepted extraction/plan saved in CC | ordinary eligible custody cleanup |
| unavailable | source body purged, content-free coverage tombstone retained | unavailable-delivered |
| unavailable-delivered | CC acknowledged exact source loss | tombstone cleanup under existing retention owner |

Commit the marker atomically with approved custody before native accepted ACK.
ACK means native input custody, not completed capture. Before foreground provider
or tools start, await only the CC descriptor admission receipt. Classification
does not block that barrier. A consumer/DB failure leaves explicit pending/blocked
coverage and prevents silent provider progression for opted-in inputs. Other
Sessions and disabled consumers retain ordinary native behavior.

The same owner needs a bounded consumer reader for marked queued **and consumed**
rows. The current display-oriented pending reader filters consumed rows, so it
cannot supply recovery unchanged. Drain descriptors on startup, consumer
activation and current-input processing, using native execution/delivery owners.
Do not introduce a plugin timer or require the user to resend the original turn.
Use bounded pages and preserve a remaining count; a cap is not a complete pass.

Three cleanup paths must honor the marker: singleton consume, processing
completion (including handled turns without transcript append), and logical
Session deletion/reset. Ordinary consumption records exact transcript linkage
and retains unresolved consumer metadata/body. Remove an accepted singleton only
when the exact original remains readable through verified native linkage. If a
handled turn has no such transcript anchor, retain custody under the existing
native retention owner; do not invent a transcript entry to permit deletion.

Reset/deletion purges source bytes immediately. Preserve only a content-free
unavailable tombstone until delivery to the existing CC destination. Fresh,
limited maintenance authority may report loss to that exact former destination;
it grants no body read, classification, Note creation or new Session authority.
If even that destination authority is unavailable, retain the inaccessible
tombstone and expose blocked delivery. This closes the crash/reset gap before
CC has recorded its first row. Do not weaken deletion to retain readable bodies.

## CC pending admission and accepted-plan linkage

Current `recordIntakeSourcePlan` requires accepted extraction and at least one
known outcome. It cannot honestly represent pre-model admission. Extend the same
intake-accounting owner with `admitChatSourceRevision`, using a stable
`intake-admission.chat.v1` operation in existing `operation_journal`.

The immutable admission intent holds the exact source descriptor, namespaced
identity, original scope/binding, admission principal, processor contract version
and stored acceptance time. Its result is pending classification, with no model
text, made-up outcome or no-action label. Persist descriptor and receipt in one
metadata transaction; verify current host authority at commit. Replays return the
same receipt. A different source/scope intent under the same ID conflicts.

Add a dedicated accepted-plan command that references this admission and invokes
the existing accepted-extraction owner inside its closed transaction. It checks
source/revision/binding/principal/processor against admission, persists the real
extraction and expected outcome identities before effects, and records linkage.
Existing plan identity/digest and retries remain immutable. Do not overwrite a
plan, silently change processors, or implement deliberate reclassification here.
This is a new kind in the existing owner, not a competing ledger.

Classification uses the exact original reader and existing producer adapter.
During the current foreground turn, the scoped descriptor replaces tool-call
identity in capture/accounting wrappers. Every capture, accounting and derived
Note effect boundary must require the matching durable admission and accepted
plan, verify that the effect is an expected outcome, and refuse missing or
changed linkage. Prompt guidance alone cannot enforce this ordering. These
checks belong in the existing closed owner wrappers and must also cover a model
that skips the plan command. Restart drains automatically recover descriptors
and accepted plans, but do not rerun foreground Chat or launch a model merely
because a descriptor is pending. Pending unclassified inputs remain visible.
An explicit **Retry capture** uses the existing authenticated native turn facade
for a capture-only attempt with the same scoped original input; it may not
re-execute the user's earlier task. Its dispatch needs current exact source
authority. Direct unattended classification is a separately qualified reuse of
native execution, not implied scheduling activation in this first slice.

The current admitted-retry producer and tool validator support email only.
Extend those existing commands narrowly to Chat admission, requiring this exact
descriptor, current native source authority and accepted-plan linkage. This is
new candidate work, not a claim that Chat recovery already exists. After plan
acceptance, those extended missing-outcome commands reuse the existing causal
capture/accounting owners. Distinct obligations, unresolved decisions, quiet information and
genuine no-action are separate expected outcomes; apply clear outcomes without
waiting for an unrelated unresolved decision. Preserve later Complete/Drop and
other user choices. Source loss/deletion is not an obligation Drop.

An unresolved Topic remains an admitted source, with real unresolved outcomes
after classification. It is never counted as quiet success. Preserve original
resolution basis; a later Topic link must go through an explicit existing-owner
resolution contract. Do not reinterpret an accepted plan under the new link.

## Recovery, authority and UX

| Crash/failure boundary | Required behavior |
|---|---|
| before custody+marker commit | no accepted ACK or coverage claim |
| custody committed, CC row absent | bounded native drain delivers the same descriptor |
| CC admission committed, acknowledgement lost | exact admission receipt replay |
| admitted, extraction absent | pending classification; original source stays available; no task rerun |
| plan saved, final native acknowledgement lost | reuse accepted extraction; no second classification |
| effect committed, outcome/response absent | existing causal owner reconciliation and stable outcome ID |
| Complete/Drop after capture | replay preserves current user decision |
| reset/delete before acceptance | body purge plus unavailable tombstone; never regenerate source |

Each callback/ack after await and each restart drain reacquires current loaded
consumer registration, source principal/grants, exact Session identity and CC
scope/binding, fresh database claim and exact input/revision. Repeat authority
checks at publication/effect commit. Re-registering does not inherit an expired
callback. Process/database incarnation is a live fence, never a new source ID.
Unavailable delivery has only the limited tombstone authority described above.

Coverage distinguishes **Input admitted; classification pending**, **Topic needs
resolution**, **Capture blocked**, **Source unavailable**, and actual accounted
outcomes. Never label native accepted ACK, model completion or aggregate counts
as completed source capture. Original-source links resolve via the current
verified native original reader. Logs/Activity remain content-free.

## Parent decisions and implementation sequence

Recommendation: accept the scoped, short fail-closed **descriptor** barrier and
native singleton retention until accepted extraction/exact transcript linkage.
This couples opted-in Chat progression to durable admission, not to model
classification. It is a parent technical/product tradeoff; no new human
permission is needed for disabled candidates. Activation remains separate.

Before core coding, parent must review the generic API, custody marker/schema,
all three cleanup paths, tombstone maintenance authority and current-input
injection. This is a bounded native contract change and needs its own core issue,
tests and draft PR; no CC-specific policy belongs in core. No native source or
compatibility pin is changed by this contract document.

Unambiguous plugin preparation is the disabled admission DTO/receipt owner and
accepted-plan linkage, with explicit native-contract fixtures. It cannot claim
durable original-message capture until the actual native seam is qualified.

Required core tests: real SQLite/process death around every custody/receipt ACK;
singleton/collected originals; handled/no-append completion; concurrent drains;
reset before CC admission; deletion after admission; source/grant/binding
revocation during await; substituted descriptors; bounded pagination; and
composition with existing context-engine admission. Required CC tests: mixed
outcomes; unresolved Topic; changed run/tool IDs; changed intent refusal; accepted
plan/effect lost responses; two original inputs; derived Note lineage; and later
Complete/Drop preservation. Native and CC changes are Class 3; installed exact
host/plugin proof remains separate from fixtures. No NAS/performance claim.
