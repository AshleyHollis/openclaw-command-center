# Accepted Chat capture replay: bounded contract for #260/#262

Status: parent-approved bounded design for a disabled plugin candidate. This supersedes
the earlier proposal for native consumers, custody markers, barriers and deletion
tombstones. None of that native implementation is in scope. Audited host:
`26a9c0faa4124e53ae2eab34291d68a7245f630c`; product base `2253d49`.

## One recommended scope

Make submitted and durably accepted Chat capture commands or accepted intake
plans replayable through the existing producer, capture, intake-accounting and
receipt owners. Native Chat acknowledgement retains its existing behavior and
meaning. Add no native dispatcher, marker, consumer, transcript store, queue,
timer, tombstone or admission barrier.

For multi-outcome recovery, the boundary is the exact accepted plan committed by
the existing intake-accounting owner before effects, containing the submitted
accepted extraction and expected outcome identities. A prompt, native ACK, model
completion or unsaved tool argument is not this boundary. A committed single
capture command retains its existing logical operation and receipt; do not invent
an aggregate plan or scan receipt around it.

This is accepted-tool/accepted-plan replay, not capture coverage for every user
message. Inputs with no submitted command or plan have **unknown capture coverage**.
Do not label them quiet, no-action, captured or lost. No source scan or new native
message identity is inferred. All new command availability/activation remains disabled.

## Existing owners and immutable acceptance

Reuse `intake-accounting.mjs` for accepted extraction, plan digest and expected
outcomes; `producer-intake.mjs` for retained-plan processing; `commitment-capture.mjs`
and `metadata.applyOpenLoopChange` for capture effects; `source-intake-tool.mjs`
for source wrappers; `intake-receipt.mjs` for health/retry receipts; and existing
Notes, operation-journal and metadata owners for conditional effects and causal
verification. All paths above are under `src/open-loops` except metadata/Notes.
Do not introduce a competing ledger or universal workflow runner.

Freeze at durable acceptance:

- Submitted source kind/external identity/version, logical operation ID and plan
  digest; these are submitted identities, not proof of host-issued message IDs.
- Exact submitted accepted extraction and every expected outcome identity/kind.
- Processor contract version and original acceptance/observation timestamps.
- Authenticated principal and exact Topic/Conversation reference, Session
  incarnation and binding revisions needed by effects.
- Exact source Note identity/path/revision and derived lineage when relevant.

Dedicated methods in the existing accounting/metadata owner record scoped
acceptance and its receipt together. Preserve existing plan/effect digest and
receipt semantics; do not overwrite earlier records. Legacy records lacking
verifiable principal/binding basis must not acquire it from today's caller merely
to enable missing effects. Existing unchanged-command receipt replay may remain
supported; missing effects require complete checked scope or explicit existing-owner
reconciliation.

Tool retries preserve the existing logical operation identity. A changed native
Chat tool ID is not a retry of the earlier capture command. A new transport/run ID
may identify a retry attempt but cannot replace source/operation identity, scope,
processor or original timestamps. Use saved acceptance/immutable observation time,
not the retry clock. Deliberate reclassification or processor changes require a
separate accepted-generation/predecessor contract and are deferred.

## Plan before effects and current authority

The closed owner accepts the exact submitted plan and authenticated scope in one
metadata transaction before effects. An unchanged request returns its saved
receipt; changed intent under the same ID conflicts. Do not represent pre-model
admission using a made-up extraction or no-action outcome.

Before every missing-outcome effect, its existing closed wrapper verifies:

1. Exact accepted plan/digest, processor, submitted source tuple and original scope.
2. Outcome membership and current eligibility under that plan/accounting contract.
3. Matching effect intent: Topic, obligation and exact source reference/path/revision.
4. Fresh authenticated authority matching the persisted principal and exact binding
   and Session incarnation, checked again after awaits and at effect/metadata commit.

Serialized plan data and model-supplied principal/source fields grant no permission.
An operator-prepared plan does not implicitly authorize an agent principal. If the
native tool context cannot supply enforceable matching principal and current-binding
authority, refuse missing-effect execution through it. The first retry candidate
uses an operator-authenticated existing command facade with this matching scope;
there is no new implicit agent grant. Tool-factory context limitations are reported
as blockers, not repaired by trusting a Session key or owner label.

Distinct obligations, decisions, quiet information and no-action remain separate
expected outcomes. Pending decisions cannot suppress other accepted outcomes.
Unresolved Topic outcomes remain unresolved; a later link cannot reinterpret the
accepted plan silently. Source loss is not an obligation Drop.

## Stored-receipt retry

The current batch admitted-retry path supports email only and requires scan and
health context that accepted Chat commands do not possess. Add a bounded accepted
Chat processing entry in the existing producer owner, called by the authenticated
accepted-plan facade with the guards above. Keep the email batch retry unchanged;
do not invent a Note source, next scan time or healthy producer receipt. Do not
broaden it to arbitrary Chat history. Read the saved accepted extraction and select
only eligible missing outcomes through existing causal effect/accounting owners.

Retry never reruns foreground Chat or the user's earlier task, invokes extraction
again, scans history, activates a producer, schedules a model turn or synthesizes
a native message identity. Restart must reacquire matching current authority.
Revoked grants, changed principal/binding/incarnation, missing source evidence and
ambiguous effects remain blocked/conflict/unknown until existing-owner reconciliation.

A completed effect replays its exact stored receipt without reapplying the effect.
Preserve later Complete/Drop, edits, importance and planning choices. Historical
receipt state describes that operation, not today's loop state. Do not advance a
receipt to a newer unrelated source revision.

For Note effects retain the original expected revision and lineage, existing
absence-precondition/recovery owner and source-specific causal evidence. Matching
current bytes/path alone is insufficient. Legacy partial Chat Notes created under
the old Note-kind operation ID remain an explicit reconciliation boundary; never
relabel, overwrite or migrate them automatically.

## Outcomes and reviewable UX

| Boundary | Required presentation/behavior |
|---|---|
| No submission or durable acceptance unproven | capture coverage unknown |
| Accepted plan committed, response lost | exact saved acceptance receipt replay |
| Accepted plan has absent outcomes | show missing/blocked outcomes; eligible explicit retry |
| Effect committed, receipt/outcome absent | existing causal reconciliation with original IDs |
| Expected outcomes accounted | exact accounted outcomes; pending decisions remain distinct |
| User Complete/Drop/edit follows an effect | replay preserves later user state |
| Authority, binding or source changes | refuse missing effects; no reinterpretation |

Offer **Retry missing capture outcomes** only for an exact accepted plan under
matching current operator scope. Show the submitted capture work being resumed,
expected missing outcomes and blockers. Do not advertise recovery of all Chat
messages. Completed receipt inspection is separate from executing missing effects.
Original-source navigation uses current verified references; Activity/health is
content-free. An admitted-retry receipt does not claim a new producer enumeration.

Keep retry availability behind its own disabled candidate gate. Commands can be
inventoried in the existing Gateway catalogue while the gate refuses access
before acquiring authority or owners. No activation of
Note writes, maintenance, structural changes, notifications or scheduling follows.
No native compatibility pin or acknowledgement semantics change.

## Native audit: rationale for the deferred broader guarantee

At the exact audited host, `before_prompt_build` has optional current-user text/ID
fields, but embedded preparation supplies only prompt/history and catches hook
failure (`src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:123`). The
harness helper can derive an ID from persisted user-turn `idempotencyKey`; the
inspected ACPX caller does not pass that field. The key is private transcript
correlation and expressly does not authorize execution
(`src/sessions/user-turn-transcript.types.ts:44`).

`src/auto-reply/reply/message-received-hooks.ts` uses `fireAndForgetHook`;
optional transport identities do not establish durable plugin acknowledgement or
restart replay. `before_agent_run` is fail-closed but has no immutable original
message descriptor/consumer receipt. Existing native pending-input/transcript
owners do not by themselves prove delivery to Command Center before tools or
after process death.

These are source findings, not runtime qualification. They justify the accepted-plan
boundary; they do not authorize changes to native custody, deletion/reset,
consumers or dispatch. The earlier broader seam design is superseded and deferred.

## Candidate tests and evidence limits

Use real closed owners with fictional fixtures:

- Real SQLite reopen/process death around accepted plan and effect/outcome receipt;
  lost responses replay receipts without duplicate effects.
- Same-ID unchanged retry versus changed extraction, outcome list, processor,
  principal or binding intent. A later acceptance attempt preserves the first
  stored observation timestamp under existing plan identity semantics; it never
  replaces that timestamp with the retry clock.
- Concurrent plan/missing-outcome owners converge or conflict explicitly through
  existing transaction/exclusion primitives.
- Authority revocation, principal mismatch, Session incarnation/Topic binding and
  source revision changes during awaits and before effect publication.
- Two obligations, one pending decision, quiet information and explicit no-action;
  independent expected outcomes remain accounted correctly.
- Later Complete/Drop and edits preserved; exact derived Note lineage has no
  duplicate creation and all originals remain byte-identical.
- Legacy partial effects or incomplete authority basis refuse automatic repair.
- Not-submitted coverage stays unknown; retry performs no scan, classification,
  Chat/task rerun, scheduling activation or native acknowledgement change.

Timestamp replay and Chat-to-Note lineage candidates are supporting bounded fixes,
not completed Chat missing-outcome recovery. Pre-tool admission, universal native
message coverage, implicit recovery by reconstructing changed tool IDs and
reclassification remain excluded. An explicit saved receipt/plan reference can
be retried from a different transport run or tool call under fresh matching
authority; that transport identity never changes the accepted source intent.
Implementation changing persisted scope/effects/recovery is Class 3. Exact-head CI
and installed-host qualification remain separate from fixtures. No NAS/performance
claim or deployment is implied.
