# First live release — approved scope v2

## Approved first-live release scope v2 — 2026-09-06

The user explicitly approved reducing the first live release to existing Topics, read-only Notes, and exact native Topic conversations. This section supersedes broader feature requirements below for the first release only. Deferral is not a passing test or a fixed issue. Native OpenClaw 2026.9.2 operator-authority integration remains approved; qualify one coherent exact plugin/host pair, not historical pins.

### Task-specific implementation approval

The user approved autonomous necessary code, test, and documentation changes for this MVP, including exact test-inventory updates that reflect already-approved contracts. Ask for new scope, permissions, data/schema changes, spending, destructive actions, or weakened checks. This standing approval does not change upstream repository governance or waive release verification, independent evaluation, backup/rollback, or live smoke checks.

### Required first-live outcomes

- Browse existing Topics and safely resolve their existing Note Folder and Session bindings. Empty newly created metadata is not proof that the user's existing Topics are available. Verify any necessary bootstrap/import separately; do not infer or silently replace ownership.
- Browse/read Notes, including large content, with exact identity/revision checks and stale-result fencing. Command Center Note authoring is disabled; existing external authoring remains untouched.
- Open an exact existing linked native conversation, send through the native composer, and start a new conversation within an existing Topic. Verify authoritative Session readback and correct Topic association after refresh/restart.
- Finish applicable ETags/conditional writes and all four safeguards for every retained owner: durable operation ownership; recovery/publication fencing; real-owner failure-contract tests; mutation inventory/automated enforcement. Reuse native host guarantees where verified; read-only operations still require identity, freshness and authority checks.
- Show clear unavailable/recovery states. Never silently recreate, relink or overwrite missing sources; existing archived/closed records must not become writable.

### Deferred and held follow-ups

- [ ] #228 — Audit and improve broader web accessibility after MVP; preserve existing basic desktop keyboard checks and working accessibility, without adding a new broad qualification gate now.
- [ ] #220 — Enable Note editing and creation with durable recovery
- [ ] #221 — Enable Topic creation and provisioning recovery
- [ ] #226 — Enable indexed Topic Search and safe rebuilds
- [ ] #222 — Enable Topic structural and Conversation lifecycle controls
- [ ] #224 — Enable rich Dashboard Attention and Activity workflows
- [ ] #223 — Enable Command Center Reminders and scheduling controls
- [ ] #225 — Enable Topic Analysis and Review with restart-safe application
- [ ] #227 — Enable notifications with durable dismissal ordering

Existing attachments #213, automatic Notes #214, mobile #216 and strategic review #219 remain deferred. The new tickets group existing findings and preserve partial code/evidence; do not duplicate every historical bug or dispatch these tickets automatically.

### Required implementation and release gates

1. Add one explicit first-release capability policy. Optional notifications, Search, analysis, scheduling and rich Dashboard must not be startup prerequisites. Reject deferred commands before effects across UI, HTTP, bridge, tools and background entry points; no no-op success. Preserve existing native Cron jobs/automations and user data.
2. Prove the retained real-owner paths and all shared dependencies. Conditional creation and unknown Session outcomes remain core work. Any Search/context or provisioning helper reachable from a retained path remains in scope until safely separated. Do not hide a shared defect behind a deferred label.
3. Align the executable acceptance/performance matrix with this explicit scope version. Preserve old evidence and thresholds; defer only feature-specific journeys/metrics. Retained performance stays measured and exclusive.
4. Seal the coherent candidate, run two independent non-performance diagnostic lanes, exclusive performance, one final coherent capture and independent evaluation. Perform normal publication/admission, backup/rollback and live smoke verification. Do not bypass or resume the held historical controller merely because this scope was approved.

### Progress accounting

Historical scope-v1 snapshot remains S7: approximately 40% finish-plan milestone score, 19/27 integrated focused-tested issue groups, eight lacking a complete passing fix. New scope percentages require a dependency/coverage audit; removing requirements must not be reported as fixes. No new acceptance frontier or deployment is certified by this scope decision. First-live release is not completion of all deferred app functionality.

## Current prioritization map — approved scope v2, 2026-09-06

#32 now targets existing Topics, read-only Notes, and exact native Topic conversations first. Its current scope section supersedes the broader historical checklist below for first-release qualification. All retained paths still require applicable conditional writes and all four safeguards. The independent evaluation, exclusive performance, coherent final capture and normal safe release remain required.

### Held follow-up tickets

- [ ] #220 — Enable Note editing and creation with durable recovery
- [ ] #221 — Enable Topic creation and provisioning recovery
- [ ] #226 — Enable indexed Topic Search and safe rebuilds
- [ ] #222 — Enable Topic structural and Conversation lifecycle controls
- [ ] #224 — Enable rich Dashboard Attention and Activity workflows
- [ ] #223 — Enable Command Center Reminders and scheduling controls
- [ ] #225 — Enable Topic Analysis and Review with restart-safe application
- [ ] #227 — Enable notifications with durable dismissal ordering

Suggested ordering: Note authoring and Topic creation first; Search and lifecycle controls next; Dashboard, Reminders, Analysis/Review and notifications after that. This is a prioritization proposal, not implementation dispatch. Every ticket is needs-triage + agent:hold. Existing #213/#214/#216/#219 remain separate. Historical issue links and useful partial repairs are preserved within each umbrella.

### First-release critical path

- [ ] Establish one default-deny first-release feature policy across native UI, transport, tools and background work; remove optional startup prerequisites without altering native automations.
- [ ] Audit/verify existing-data bindings and retained Notes/native Session journeys. New conversation creation remains in scope; new Topic creation does not.
- [ ] Finish the retained owner conditional-write/recovery/generation contracts and failure tests, including principal changes, source replacement and unknown outcomes.
- [ ] Reconcile shared Search/context, metadata/provisioning and recovery dependencies; deferred callers do not exempt shared code still reached by core paths.
- [ ] Version the executable acceptance matrix; seal, run two independent diagnostic lanes, exclusive retained performance, one coherent capture and independent evaluation.
- [ ] Publish/admit normally, verify backup/rollback and live Topics/Notes/native conversation use.

No fixes, controller activity, release readiness or new percentage is claimed by moving scope. Historical S7/I4 remain retained. See #32 for the approved release contract.
