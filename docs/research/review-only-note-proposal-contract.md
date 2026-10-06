# Review-only Note proposal: implementation contract for #214

Status: parent-approved bounded contract for a disabled candidate; not an accepted ADR or an
implemented/activated feature. Product base: `2253d49`. The test-only Attention
successor `97a4` does not change that product baseline. No rebase is required
solely for the test-head change.

## Recommended first slice

An authenticated operator explicitly prepares a proposal for one existing
Markdown Note, using one or two selected Markdown Notes from the same Topic.
The operator generates a suggestion in the existing native Conversation and
stages that response in the proposal review surface. The operator-authenticated
publish command accepts the suggested Markdown against the prepared basis.
The proposal never applies its text to the Note.

Use operator-only prepare, context-read, publish, inspect and discard commands
first. Do not give the model a new grant or accept a model-supplied principal.
Opening native Chat is navigation, not permission to send a prompt. Display a
prepared generation brief for explicit user use; automatic model dispatch and
model-tool publication are outside this first transport contract. Parent can
later substitute a qualified generator while retaining the same frozen basis.

No automatic triggers, scheduling, filesystem writes, structural changes, new
queue, table or knowledge store. Add a candidate gate `noteProposals: false`;
leave `noteWrite`, `noteMaintenance`, `analysis` and structural gates disabled.
Only fictional tests inject the candidate capability until separate activation.

## Existing owners and admitted sources

- Extend `NoteMaintenanceService` in `src/maintenance/notes.mjs` with separate
  proposal methods. They must not call its write methods or `notesEdit/create`.
- Add dedicated metadata transactions over existing `topic_operations` in
  `src/metadata/service.mjs`; reserve operation kind `notes.proposal.v1` and
  refuse both incoming reserved kinds and replacement of existing reserved rows
  through generic `recordTopicOperation`, `completeTopicProvisioning` and generic
  recovery completion paths. Dedicated transactions check the immutable intent,
  principal, Topic, generation, prior lifecycle and current authority.
- Add a small source-owner snapshot wrapper around `sourceService.notesRead`, preserving exact
  reference/path admission, SHA-256 byte revisions, safe descriptor reads and
  Note Folder identity from `src/sources/notes.mjs` and `reference.mjs`.
- Reuse the authenticated operator runtime in `src/bridge/register.mjs`:
  host-derived `principalId`, synchronous `assertCurrent`, scope checks and
  live connection membership. Never put a caller-selected principal in a RPC.
- Preserve `topic-notes-panel.mjs`'s exact Conversation binding verifier when
  the request comes from the native Session Files replacement.

Admission is explicit: target and each source supply an existing Source
Reference ID, normalized relative path and caller-observed revision. The target
is distinct from the sources; source IDs are unique. All are `obsidian/note`,
same Topic, inside its currently verified Note Folder. Require an active Topic,
resolved Folder, read access and metadata write authority for the proposal.
The proposal is metadata, not a grant to edit Notes.

Reject missing, ambiguous, revoked, replaced, oversized or stale sources. Initial
bounds: target UTF-8 text at most 256 KiB; combined source text at most 256 KiB;
proposed text at most 256 KiB. Never truncate and then claim complete evidence.

Binary documents and Conversation history are excluded initially. Current
document reads return opaque bytes/derived extraction, and `sessions.history`
has incarnation checks but no closed immutable content-revision precondition.
Neither arbitrary URLs, pasted attachments, inbox scans nor inferred source
names are admitted. This is a small Note-to-Note suggestion, not completion of
the broader conversation/import maintenance acceptance in #214.

## Closed API and durable representation

Names below are proposed; register the final closed commands in the existing
bridge contracts and mutation-owner catalogue, behind the disabled gate.

| Command | Caller payload | Owner result |
|---|---|---|
| `notes.proposal.prepare` | UUID `proposalId`, Topic/revision, target descriptor, 1-2 source descriptors, optional exact panel binding | durable prepared snapshot or terminal refusal |
| `notes.proposal.context` | proposal ID and generation | exact prepared text, source descriptors and generation brief, after fresh checks |
| `notes.proposal.publish` | proposal ID, generation, basis digest, proposed Markdown, exact citation IDs | immutable review content and owner-computed comparison |
| `notes.proposal.inspect` | proposal ID | verified review projection or stale/blocked projection |
| `notes.proposal.discard` | proposal ID, generation | durable terminal discarded state |

The transport invokes these closed maintenance commands. It does not assemble
metadata writes. `principalId` and authority come exclusively from runtime.
Transport request IDs and model/tool/run IDs never determine proposal identity.
All five commands require proposal-metadata write scope, including context and
inspect because revalidation can persist stale state. A read-only actor gets
capability refusal; callers cannot turn a read RPC into an undeclared mutation.
Every command, including inspect and discard after restart, requires the exact
preparing principal and current Topic access. Another operator cannot acquire
ownership merely by knowing the proposal ID. No principal is replaced on replay.

Immutable `intent_json` contains contract version, original UUID, principal,
Topic ID/revision, target and source descriptors/expected revisions, generation
`1`, processor contract version, and the originating panel's exact Conversation
reference, Session key/incarnation and binding fingerprint if present.

`result_json` contains validated lifecycle status, prepared target/source
snapshots, canonical `basisDigest`, verification times, proposed content,
canonical citation descriptors, output digest and bounded failure reason. Text
is private proposal context, not an authoritative replacement for source files.
Do not copy it into Activity, public logs or issue evidence.
Keep private target, source, proposed and comparison text only while prepared or
review-required. Terminal stale, failed and discarded transitions atomically
strip all those texts, retaining identity, digests and status for replay and
no-resurrection checks. This is logical deletion from live metadata, not secure
erasure from SQLite pages, backups or earlier authorized responses.

The basis includes target/source external identities, effective locators and
locator versions, Folder reference/stable identity/locator generation, Topic
revision and Conversation binding. Freeze these from the actual successful
owner reads, not a later browse result or generation response. Preserve exact
source identities/revisions and existing lineage; do not invent original
document identities from prose. Source links resolve their current exact
reference rather than trusting a generated URL.
The snapshot wrapper must retain the verified Folder identity and locator,
per-file locator generation, Topic and complete panel Conversation basis;
`notesRead` alone does not freeze all of them. Separate reads cannot prove
detection of byte-identical inode replacement, and no such guarantee is claimed.
An ordinary `notesRead` result does not provide generic original-document
lineage. The mandatory citation is the selected Note's own exact reference and
revision. Retain optional intake plan/outcome evidence only when the existing
intake-accounting owner verifies that its saved source-reference ID and revision
equal the selected Note basis. Otherwise report imported lineage as unavailable;
do not fabricate it or imply that the selected Note proves an upstream attachment.

## Lifecycle and atomic checks

| Proposal status | Existing SQL state | Permitted transitions |
|---|---|---|
| `reading` | `pending` | prepared, stale, failed, discarded |
| `prepared` | `pending` | review-required, stale, failed, discarded |
| `review-required` | `applied` | stale, discarded |
| `discarded` | `not-applied` | terminal |
| `failed` | `not-applied` | terminal |
| `stale` | `conflict` | terminal |

Here `applied` means only that the proposal result was recorded. UI and receipts
must never label that as a saved Note or a completed maintenance write.

Preparation records `reading` with immutable admission intent before awaited
reads. Read all exact revisions, verify their identities and bindings, then
revalidate runtime authority after each await. Recheck the basis before saving
`prepared`. Publish preparation through one metadata transaction comparing
intent, generation and previous status; invoke synchronous authority checks
inside that transaction. A concurrent identical preparation returns the saved
snapshot; different intent under the same UUID conflicts.

Generation uses the prepared snapshot. Context-read verifies its basis again;
it never substitutes newer text/revisions. Publication requires generation `1`
and its exact basis digest. Re-read target and sources through their owners,
check current Folder/Topic/panel binding and runtime, then atomically transition
from prepared to review-required. Persist output digest/content and the exact
selected source citation descriptors. Reject missing/invented citations.
The owner computes the deterministic comparison from frozen target text;
caller-supplied diffs are never authoritative.

Identical publication replays the frozen result. Different proposed content or
citations under the same proposal ID conflicts, even if both appear reasonable.
Changing the proposal requires explicit discard and a new UUID/generation.
The new UUID starts at generation `1`; this slice does not advance generations
inside an existing request or reinterpret an accepted basis.
Discard, stale and failure prevent late generation from publishing. A new
request cannot silently resurrect an old terminal operation.
Malformed staged Markdown or citations leave prepared state intact. Discard
requires current ownership and authority but does not require source rereads to
succeed; it can remove snapshots whose sources have become unavailable.

External file reads and SQLite publication are distinct boundaries. There is
no claim of one linearizable transaction across external edits and metadata.
Store the last successful verification time/revisions. On every review open or
refresh, re-read the exact authoritative basis; detected edits/replacement make
the proposal stale before rendering its review projection. An external edit
immediately after verification remains possible. Display the checked revision
and time; there is no Apply action that could overwrite such an edit.

Temporary access loss refuses context/review publication and returns a blocked
projection without saved text. Confirmed revision or binding drift records
terminal stale when current authority permits that metadata change. Do not
return private saved proposal text to a revoked actor merely because it exists.
Authority loss produces a text-free blocked projection without destroying the
saved operation. Revalidate the source basis on identical replay and fence
authority immediately before returning private context or review content. Add
all proposal methods to the bridge's final-response authority checks.

## Recovery and UX

Interrupted reading retries the same UUID and original expected revisions.
It can resume safe reads; it cannot advance its basis. Prepared and published
snapshots survive SQLite reopen. After restart, show prepared as waiting for a
suggestion; do not launch a model or task automatically. Lost responses replay
the persisted state. A failed or stale preparation offers a new explicit
preparation, rather than an automatic retry against newer files.

The existing Note reader gains a gated **Prepare suggestion** action and source
selector. Prepared view shows the target/source revisions and generation brief,
an **Open Conversation** navigation action, and an explicit staging field for
the response. **Review suggestion** publishes against that basis. Review shows
original/proposed content, comparison, canonical source references and checked
time. Its only lifecycle action is **Discard**. Stale/failed states explain the
reason and offer a new explicit preparation. There is no Apply, Save Note,
automatic send, schedule, file creation or authoritative-copy action.

## Implementation and proof boundaries

Implement owner/metadata transitions first, then closed bridge wiring and gated
native review. Follow existing transaction/recovery patterns, but do not reuse
structural `topic_proposals`, generic proposal decisions or a model tool's ID.

Required fictional tests: SQLite reopen/identical and changed replay; concurrent
preparation/publication; interruption after admission/read/before result;
generation and review edits; source removal/revocation; Folder replacement;
Conversation reassignment; discarded proposal versus late completion; two
source references/citations retained; original target/source bytes unchanged;
no write/apply/task action; and disabled activation flags. Run actual Linux
Note/Folder owners and installed native review separately from mock authority
tests. Durable proposal changes are Class 3 despite no Note write.

No new user permission is needed for this parent-approved disabled candidate
design. A later direct generator/model-tool handoff needs
an enforceable supported host authority contract, not inferred Session access.
