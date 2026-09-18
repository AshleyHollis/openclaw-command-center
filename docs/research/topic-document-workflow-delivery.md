# Topic document workflow: implementation contract

## Active scope supersession — 2026-09-14

This section supersedes conflicting scope, acceptance and completion language below while
retaining the detailed filing/maintenance material as deferred implementation context.

The active supervised reader-MVP release is limited to existing Topics and exact linked
native Conversations; a complete Note browser with filename/path filtering; formatted Reading
plus authoritative Source; centre-pane Notes beside native Chat; native pane swap preserving
the selected Conversation and draft; unchanged read-only imported history; and ordinary
keyboard/loading/error/disconnected states. R1-R5 are its active reader evidence ledger.

F1-F3 (permanent native-upload filing), N1-N3 (automatic maintenance/catch-up/status/resume),
and the full E1 two-document rehearsal are deferred historical work, not release gates and not
passes. Keep their new entry points/triggers disabled through existing release controls; native
Chat uploads must not imply permanent filing or automatic Note maintenance. #236 owns reader
delivery; #213 owns deferred filing; #214 owns deferred maintenance; #218/#217/#32 retain
native/dependency/release tracking.

The active release gates are: (1) Reader fixes, (2) focused verification plus one inspected
desktop journey, (3) artifact/focused review/rollback readiness, and (4) NAS deployment/live
verification. The active journey opens an exact native Conversation, finds a Note beyond the
first catalog page, opens formatted content in the centre, switches Reading/Source, swaps panes
without losing Chat/draft, and opens existing read-only history. Performance is a gate only when
measured behavior makes that journey unusable.

Gate evidence is recorded separately from implementation: a deployed plugin is not a completed
release until the authenticated private reader journey has been inspected. Repeated test passes
do not advance a gate. Deferred filing and maintenance rows remain deferred, never passed.

Prepared 2026-09-13 for the next Terra implementation goal. This document specifies a candidate to build and qualify, not a completed feature or permission to deploy. All examples below are fictional.

## Outcome and scope precedence

A user opens an existing Topic Conversation in native OpenClaw, uploads documents, asks the agent to file them and maintain working Notes, reads those Notes beside native Chat, and can resume later from the saved documents and Notes.

Retain existing Topic records, Note Folder bindings and Conversation identities. A native sidebar group is presentation, not ownership, shared memory, an agent or a filesystem root. Do not migrate data to Session workspaces, change agent execution roots, merge histories, or recreate Topics for this delivery.

This extends the read-only correction in `topic-notes-reuse-first.md` with two previously deferred features. Its five reader checks remain R1-R5; seven additional checks cover filing, maintenance and integration. Twelve checks are the fixed delivery denominator, not twelve discovered bugs. The older detailed twelve-outcome UX programme remains superseded; do not combine its retired requirements with this checklist.

The current ADR 0004 describes the already-scoped first release. When implementation starts, record this next-delivery decision and its precise capability scope in the appropriate issue/ADR and `CONTEXT.md`; do not silently reinterpret the old first-release flags. This contract is not a request to enable every deferred feature.

## Tickets and ownership

| Step | Existing ticket | Deliverable |
| --- | --- | --- |
| 1 | #236, reopen/reuse for the correction | Package-backed file browser and formatted read-only Notes in native panes. |
| 2 | #213 | Native upload to verified permanent Topic document, with truthful receipt and safe retry. |
| 3 | #214 | Source-linked ongoing Note maintenance using native execution facilities, plus integrated qualification. |

Link #218 for native reuse and #215 for existing exact navigation; retain their proven contracts. Do not reopen successful recovery/grouping work just to accumulate this delivery's progress. Keep #220 manual editor/create UI, #226 indexed retrieval, #230 slow-history work, mobile expansion, Atomic Lite and backup redesign outside scope. Agent-side Note creation/update is necessary here; a user-facing editor is not.

Read each ticket and its dependencies before implementation. Maintain one checklist across the three tickets; do not create duplicates. If a broader ticket has unresolved acceptance beyond this delivery, explicitly leave that remainder open rather than closing it based on a narrower test.

One Terra implementation owner integrates changes. NAS is for bounded isolated builds/tests, not an Atomic Lite autonomous loop. A bounded read-only independent reviewer may assess the candidate; it does not write competing fixes. Preserve all existing staged/unstaged work. No broad improvement rounds or universal workflow framework.

## Step 1 — what the user must see

### Entry and layout

- The user reaches the existing Topic's Primary Session or another exact linked Conversation through native navigation. The native group remains the normal Conversation presentation. A Topic-scoped New Conversation action must create/link through the existing owning contract, not infer membership from its name or group.
- Do not automatically claim an unrelated Session created or moved inside a native group. An unlinked Session must not silently show/write another Topic's Notes. Explain that it is not linked and direct the user to the existing Topic-scoped action; do not add a new adoption framework.
- The Notes panel is a Notes-only surface: Topic identity, labelled filename/path filter, Refresh, file browser, selected document and a compact read-only/status message. Topic administration, creation forms and full Conversation/history inventories remain on the existing Topic details page, not above the browser.
- Before selecting a Note, the filter and initial file entries are visible without scrolling past administration. Use a bounded, independently scrolling tree with collapsed folders. The entire catalog must be reachable, including later pages; filtering is filename/path substring matching, not indexed content search.
- Selecting a Note calls the exact existing reader, shows selection/loading clearly, then uses native promotion to put the document in the centre pane. Native Chat remains beside it with the same Session and unsent draft. Keep the file picker accessible within the Notes surface; do not build a second global sidebar or layout manager.
- In the promoted view the document heading and start of its body are visible immediately. File lists must not push the reader thousands of pixels below the viewport. If the file picker is above the reader, constrain its height; a compact sibling column or collapsible picker is also acceptable. Do not collapse away the only way to select another file without an obvious control.
- Use the host's existing swap/resize controls. Swapping panes must not recreate the Chat or change Conversation ownership. Refresh may return to the browser; persistent per-Topic scroll restoration is not required.

### Reading and interaction

- Reading is the default. Render headings, paragraphs, lists, tables and code as a readable document. Long prose wraps; wide tables/code may scroll inside their own container, not expand the whole page.
- Source displays the same authoritative text with `textContent`, not an editor. Keep the external-authoring message and no Save/Create/Edit controls for users.
- Prefer Web Awesome's free tree/tree-item components, markdown-it and DOMPurify as researched in `openclaw-notes-plugin-reuse.md`. Verify/pin versions and license closure. Bundle only needed local assets before sealing; no CDN, framework migration or entire library import. If one bounded package proof fails the asset contract, use native disclosure/buttons and a simple filter rather than an open-ended package search.
- Stock appearance is acceptable. Labels, visible focus, ordinary package keyboard navigation and sensible tab order are required; no bespoke theme, pixel-match exercise or mobile redesign.
- Show distinct loading, empty folder, no filter matches, unavailable/unsupported file, denied/disconnected and changed-binding states. Do not leave an old Note appearing to belong to a newly selected Topic. Cancel stale reads on selection, lifetime, binding, connection or authority change, including after awaited work.
- Preserve Topic/reference/path/revision and large/chunked-read protections. Names, groups, matching text and paths alone never establish ownership.
- Treat Markdown and uploaded content as untrusted. Disable raw HTML, sanitize the rendered HTML, restrict links, prohibit script/event/iframe execution and automatic remote resource loads. Source links must not become arbitrary local-path reads, traversal or write actions. Prefer structured source-ID actions through verified owners; a general Markdown relative-link resolver is not required.

### Visual checkpoint, before moving to broader integration

Exercise a fictional 120-Note paginated catalog with nested directories and duplicate filenames in the actual native host at 1366x768 and 1440x900. Inspect browser-rendered images, not only DOM assertions. Check browse/filter/select, Reading/Source, keyboard focus, centre promotion and swap. Same Chat and draft must survive. Capture sanitized evidence of (a) browsing and (b) centre Reading with Chat beside it. No forced clicks or direct focus calls may conceal an unreachable control in the user-journey proof.

This is a bounded functional visual check, not six golden screenshots or exact historical mock-up matching. Failure of visibility, selection or reading blocks Step 1 even if transport tests pass. Continue without requiring another user approval when these agreed requirements pass.

## Step 2 — permanent filing of native uploads

### User experience

Use the existing native Chat attachment control. The user may say: "File these documents in this Topic under Case 2025-26 and keep working Notes up to date." No second upload composer or desktop sync prerequisite.

Chat attachment storage and permanent Topic filing are distinct states. Show/report a durable result per source: filed, already filed, not filed, or blocked with its reason. A successful Chat send is not a filing receipt. A successful filing is not proof that Notes are updated.

For an exact linked Topic, use its verified Note Folder. Respect a user-requested safe subfolder; otherwise use a Documents subfolder without moving existing files. If the main agent has no unambiguous authorized Topic, retain the source in its managed intake location, propose the destination and ask before filing. Do not adopt a folder or create a Topic by display name. Never automatically delete/move the upload's original intake source.

### Owning operation

Inspect and reuse native managed-media resolution and the existing import/filesystem/recovery owners. Register an actual production-callable agent action; testing a service method that the configured agent cannot invoke is insufficient.

Resolve and check the exact invoking Conversation, Topic binding, source attachment identity, authorized readable bytes and destination identity. No arbitrary client URL/path ingestion, broad vault discovery or cross-Topic authority by default. Recheck relevant authority and identity at effect/publication, not only at request entry.

Preserve original bytes. Verify source and stored byte digests and the final owned source reference before publishing success. Display safe filenames/relative locations, not private server paths. Keep distinct documents with colliding names; never overwrite an existing original. Repeating the same logical source operation is idempotent; identical bytes alone are not proof that two source identities are the same operation.

Use the existing durable intent/apply/verify/completion pattern and source-specific recovery. Preserve operation ID, canonical intent and conditional-write base on retries. Handle interruption before effect, after effect and before receipt without duplicate files, false success or overwriting foreign changes. Block replaced/missing identity rather than repairing by name.

List non-Markdown originals in the same file browser with type and truthful preview capability. Reuse a safe native preview where available; otherwise provide an authorized original open/download action and clear preview limitation. Verify PDF/image interpretation through native agent capabilities on fictional fixtures; do not introduce another OCR/PDF engine or claim support based only on filename extension.

## Step 3 — ongoing source-linked Notes

### Native execution, narrow integration

Inspect the existing instructions, hooks, tasks, maintenance owner and relevant #199/#214 evidence before choosing the small adapter. Reuse native execution and cron facilities. Inventory existing maintenance jobs before creating any candidate configuration so deployment does not duplicate them. Do not build another scheduler or enable the held scheduler/analysis/dashboard surface.

The intended behavior is automatic maintenance for the linked Topic's meaningful work, not a manual import command required every turn. File completion and meaningful completed Conversation turns should mark work pending, coalesced per Topic rather than one LLM invocation per streamed token. Use a native catch-up schedule for missed/interrupted work; target every 15 minutes while the gateway/provider is available, or preserve an existing schedule that meets that bound. Document queue/retry limits and actual freshness; this is an attempt cadence, not a false guarantee of completion during outages.

Use durable processed-source checkpoints and existing operation ownership. Do not reprocess all historic Conversations or the whole vault on every run. First activation may establish its checkpoint after explicitly reading the selected working Notes and relevant case files; it must not silently rewrite all legacy Notes. User-requested backfill remains explicit.

Expose only the precise agent maintenance/import capabilities required. Current `noteWrite`, `noteMaintenance`, search and scheduler release flags are not blanket permission to enable all held routes/UI. In particular, keep the manual editor disabled while qualifying agent-side conditional creation/update through the real production entry point.

### Content and correctness

- Create/update readable working Notes inside the exact bound folder. Record useful facts, decisions, open questions and next steps with provenance to filed originals and the relevant Conversation source positions.
- Preserve previously recorded source information and human edits unless the user supplies an explicit correction/supersession. Appending a second receipt must not erase the first receipt's facts. A prompt saying "preserve previous content" alone is not sufficient protection: source checkpoints, conditional writes and verification must demonstrate it.
- Each write goes through its domain owner with durable identity, expected revision, operation intent and restart-safe completion evidence. Creation uses an absence precondition. Never obtain a newer revision merely to force an old proposed write through; reread and deliberately rebase/recompute a new operation or show a conflict.
- Completion/status publication is generation-aware and based on verified saved files plus accepted source checkpoints, not "job launched", an agent promise or equal current text. Preserve source-specific recovery; no equal-content-only claim of ownership after a lost response.
- Present compact status in the Notes surface: Pending, Updating, Saved with last successful time, Needs review/conflict, or Failed. Show pending new work alongside the last successful time. Persist enough evidence for status to survive reload/restart; do not build the deferred global Attention feature.
- On resuming a linked Conversation, provide its exact Topic context and read the relevant saved working Notes/document index through existing authorized reads. Do not assume every Conversation in a group shares transcript memory. No semantic index or full-history merge is needed.
- Never treat instructions embedded in receipts/documents as authority to disclose files, change Topic ownership, or write outside the verified folder.

## Fixed acceptance ledger

Track each row as Pending / Implemented-unverified / Passing / Blocked, with exact evidence and candidate identity. Passing means the specified user outcome and relevant fault cases passed, not just a test file exists.

| ID | Required result |
| --- | --- |
| R1 | Pinned packaged components, styles and renderer load through the actual authenticated sealed native asset contract; license/asset closure and activation pass. |
| R2 | The complete 120-Note fixture supports visible browsing, filename/path filtering, duplicate-name disambiguation, exact selection, Reading/Source and keyboard operation at both desktop sizes. Administration does not bury the files/reader. |
| R3 | Real native centre promotion/swap retains the exact Chat/Session and unsent draft; no Imported History or transcript mutation. |
| R4 | Existing identity/revision/chunked-read protections and stale-read cancellation survive selection changes, replaced binding, disconnect and permission loss. |
| R5 | Untrusted Markdown cannot execute code, auto-fetch external resources, escape the folder or trigger writes; Source is the authoritative text. Evidence refers to the sealed candidate. |
| F1 | Actual native uploads reach the production agent filing action; originals are byte-verified in the exact Topic folder, visible/openable with truthful receipts. Unknown destination asks rather than guesses. |
| F2 | Repeat, collision and interruption scenarios preserve originals and causal receipts without duplicates or foreign overwrite; changed intent and replaced identity are refused. |
| F3 | Unauthorized/foreign attachments, cross-Topic/path traversal attempts and revoked/replaced targets cannot be filed or opened; unsupported previews remain truthful. |
| N1 | Meaningful work triggers source-linked saved Notes through the real native execution path; status and catch-up remain truthful, bounded and free of duplicate schedules/runs. |
| N2 | Two successive documents both remain represented; human edits, stale revisions, concurrent work, lost acknowledgements and restart recovery cannot silently erase facts or publish stale success. |
| N3 | Resuming after restart retrieves the correct durable working Notes and pending state; source actions resolve originals exactly, without shared-chat-memory assumptions or indexed retrieval. |
| E1 | One coherent isolated desktop rehearsal on the clean sealed host/plugin candidate proves the full story below; an independent review finds no unresolved in-scope release blocker. |

For each affected mutating owner, use the applicable cases from `docs/agents/mutations.md`, including real filesystem/SQLite/process interruption where the claim requires it. Reuse these tests in F2/N2 rather than invent a second hardening programme. Mock tests supplement but never replace the real native upload/agent/tool/Notes/browser chain.

## Coherent rehearsal and stopping rule

1. Create fictional Topic Sample Records with an exact linked Conversation Case 2025-26, a separate unrelated Topic, and preserved read-only history. Use only isolated data and a test host.
2. Upload a fictional receipt PDF using native Chat. Ask for permanent filing and working Notes. Verify original bytes, exact Topic location, source-linked facts and saved status through real public entry points.
3. Upload a different receipt image in a later turn and add a factual correction plus an open question. Verify both original files and both still-relevant sets of facts remain, the correction is explicit, and the question is recorded. Use fixed fixture facts to check outcomes; do not rely on the agent saying it succeeded.
4. Browse/filter the files, open the formatted working Note in the centre, toggle Source, open a source through its authorized action, use keyboard controls and swap panes. Inspect screenshots and confirm native Chat/draft preservation. Retain one additional sanitized screenshot showing source filing/maintenance status.
5. Restart the isolated host, resume the Conversation and confirm it rereads saved context and reports the open question. Retry the same filing/update operation. Verify no duplicate original, schedule, completed operation or unintended other-Topic write. Preserve imported history unchanged.
6. Run focused fault clusters locally, one clean Linux/NAS build, and the final coherent journey against that exact sealed pair. Seal again and rerun affected checks if fixes change it. Diagnose with focused reproduction rather than repeatedly running the entire journey to discover failures.

After two unsuccessful fixes in the same area, pause that area for one focused Astra diagnosis: product defect, test/setup defect, infrastructure defect or ambiguous requirement. Do not retry indefinitely or broaden scope. Continue independent safe work where possible. Keep performance qualification exclusive if required by the retained release checks; do not change existing release thresholds or admission requirements to force completion.

The historical candidate-only terminal condition in this section is superseded by the active
supervised reader-MVP release gates above. Do not count screenshots that nobody inspected as
visual verification. If real model access or host integration is unavailable, report the affected
checks as unverified rather than substituting an invented pass.

Report each step's passing fraction and percentage: reader R1-R5 /5, filing F1-F3 /3, maintenance N1-N3 /3, final E1 /1. Also report total /12 and the named remaining checks. These are acceptance coverage percentages, not elapsed-time estimates. Preserve failed-attempt evidence; repeated passes add zero progress. Any newly found defect maps to one of these checks or to an explicit deferred ticket, not a silently growing denominator.

## Authority and exclusions

No live deploy, host upgrade, live automation change, real Chat send, Note rewrite, Session regrouping or migration is authorized by this handoff alone. Use existing repository/configuration artifacts first. Ask before inspecting live private content if implementation actually requires it. Keep all public fixtures, issues and screenshots fictional; private references remain outside the repository.

Keep the existing qualified OpenClaw fork by default. An isolated proof that a stable upgrade removes more work than it introduces can support a separate proposal, but do not turn this goal into an upgrade project. Do not expand runtime permissions or storage roots silently.

The personal-tax example is a document-assistance workflow, not autonomous tax advice or lodgement. Reuse native browser capabilities; building an ATO connector is excluded. Real browser reachability, user sign-in/MFA and approval of any tax submission remain separate human-assisted readiness checks. Do not store login secrets in Notes or use real financial documents in tests. Explain that documents supplied to the agent may be processed by its configured model provider; NAS storage alone does not mean local-only processing.

Before any later approved activation, use the existing qualified backup/rollback admission and confirm the retained folders remain covered. Do not start another full backup redesign or offsite qualification cycle as an implementation dependency.
