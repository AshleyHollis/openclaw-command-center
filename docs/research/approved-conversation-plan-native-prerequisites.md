# Native prerequisites for approved Conversation plan v1

Exact source inspected: AshleyHollis/openclaw `26a9c0faa4124e53ae2eab34291d68a7245f630c`; consumer CC #370/#371, baseline `2253d49b5b90c8c1c8c506a0a38efe300c389da4`. This is an implementation brief, not an implemented native API, permission change or deployment request. Official 2026.9.8 is not equivalent to this fork's guarded create/update admission.

## Bounded visible-message admission

The published `src/plugin-sdk/session-transcript-runtime.ts` exports stable visible message entries and a transcript write lock. The writer queue in `src/config/sessions/session-accessor.sqlite-transcript-write.ts` is explicitly process-local. A selected message can change or leave the active branch in another process after CC's asynchronous read and before Workboard create. The existing synchronous Session reset fence does not detect that same-session change.

Add a generic bounded synchronous read/assertion for one currently visible message, not a Conversation-plan-specific native operation:

- Implement beside `src/config/sessions/session-accessor.sqlite-active-events.ts`, reusing `withCurrentProjectionSnapshot` (`session-accessor.sqlite-active-projection.ts`), `readActiveTranscriptEntryIdentityInSnapshot`, and `selectMessagePayload`/`parseActiveTranscriptMessageRow` (`session-accessor.sqlite-projection-read.ts`) in the same directory.
- Require exact Session key/id, stable entry ID, active-path membership, projection generation and a canonical digest of the publicly visible message. Preserve the existing `projectVisibleMessageEntry` redaction behavior. Read-only, bounded, no async callback, cold restore or rebuild inside an admission guard; missing/stale projections fail closed.
- Export the owner through the Session accessor and public transcript runtime SDK. Define/version digest canonicalization explicitly so a consumer cannot compare raw storage to a redacted public payload by accident.
- CC must use this owner inside the host-prepared Workboard create guard, alongside authenticated authority, current Topic ownership and exact Session identity. Existing Workboard admission kernel/worker invokes the guard at transaction and commit. The guard is a predicate, not a serialized client assertion.

Qualification must run actual fork SQLite owners in two processes. Pause at both admission stages, then reset the Session, edit the same entry's payload, switch/remove its visible branch or replace its projection generation. No card may be accepted from obsolete source evidence. Also test unchanged digest, redacted content, bounded reads, principal revocation, wrong tenant, response loss, restart and concurrent idempotent create. A callback spanning separate transcript/card databases does not itself prove atomic cross-database exclusion; explicitly document and test the guarantee. If that race cannot be closed through the current guard, the native owner must supply a shared transaction/lock primitive rather than claiming the process-local queue is enough.

CC's current production Track refuses the absent synchronous capability before reserving an operation or writing native state. Local source tests verify that refusal. Do not activate the flag to bypass it.

## Exact Workboard card navigation

`src/plugin-sdk/control-ui.ts` defines page targets without plugin ownership. `ui/src/plugins/control-ui-host.ts` resolves against the caller's descriptors. Workboard route/route-location select a board; `extensions/workboard/browser/pages/workboard/view-card-details.ts` opens details only through internal view state. Session accessories also open boards, not an exact card.

Smallest generic change: support an optional explicit plugin owner on a page target, resolved only against advertised active plugin pages. Extend the native Workboard target with exact card ID and expected board/tenant. Load and verify the target through the native owner before invoking the existing card-details state. Missing, wrong-scope or changed cards yield an unavailable destination; do not choose a nearby card or silently change boards.

Preserve existing draft/save guards, routing history, focused control and Start/review controls. Test cold/warm navigation, refresh, back/forward, reconnect, unavailable/wrong-tenant cards, draft-preserving defer, focus return and no implicit Start/specify/decompose. Consumer CC should invoke the declared native target, never construct a guessed path or simulate a DOM click.

## Human requests and remaining CC work

Native questions and execution approvals already have authenticated pending-list contracts. CC has a read adapter for exact linked session/run and expiry; ordinary progress/completion/blocked/review is quiet. The disabled CC candidate now wires these identities into the existing Attention episode service with stable native request identity, verified withdrawal/resolution, final commit authority, and durable terminal receipts. question.get verifies terminal question state; pending-list absence never proves resolution, especially for execution approvals. Native Done, immutable expiry or an exact terminal linked attempt withdraws obsolete relevance without claiming a response. Scoped episodes are exposed only through freshly authorized plan projection, not generic notifications/actions. This source work still requires real native qualification after source admission. Navigation returns to existing native controls; no duplicate execution is created. No explicit requested-result-review envelope was verified in this pinned Workboard contract, so that subtype stays unavailable pending a separately specified native owner. Do not widen email/payment semantics or treat a review status as a request.

Multi-card decomposition, automatic Start, scheduling, progress queues and native reliability package #65 deployment remain outside v1.
