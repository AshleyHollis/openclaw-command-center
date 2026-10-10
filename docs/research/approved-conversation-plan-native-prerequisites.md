# Native prerequisites for approved Conversation plan v1

## Current cumulative TEST assessment

Accepted native 9.9 `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2` incorporates the authenticated external source-custody and exact-navigation successors described below. The cumulative TEST chain starts from frozen Notes+Recall PR391 `b2e1b213c8fea5720967f6daa39d530816c34608`, then adds Filing PR393 and Track PR394. Enabled TEST gates establish neither production admission nor installed qualification. Mandatory hosted package tests use the exact accepted native artifact rather than a substituted SDK.

The accepted package still lacks an explicit durable result-review owner. Separately prepared [native draft PR93](https://github.com/AshleyHollis/openclaw/pull/93) and CC prerequisite #387 address that gap. This CC source implements the closed authenticated read consumer and exact-card review navigation described in [the current result-review contract](approved-conversation-plan-result-review.md). Missing owner fails closed for result-review eligibility. Full native checks, required UI screenshots and the newly paired installed host remain unqualified; no native rebuild or deployment is authorized here.

Remaining sections preserve historical source-admission evidence and proposals. Disabled-state and missing-consumer statements refer to those older pinned candidates, not this isolated enabled TEST chain.

## Historical entitled external dispatcher at 21de16b

Native [#74](https://github.com/AshleyHollis/openclaw/pull/74), exact `21de16b150d589f50c28ac0fa2e0c91e824d24ac`, tree `53a217a245f1d144a55bb9ca43db7d64fa33f9aa`, supplies source custody through the public `dispatchGatewayMethod` contract. Actual package SHA256 is `fff2327dc805c2024748759003b0126b0150d17789cd5ecd65d7f945a8d4ed0d`; producer [37708626650](https://github.com/AshleyHollis/openclaw/actions/runs/37708626650) passed. Native full CI remains separately pending.

CC production imports that public dispatcher directly. It requires the actual host's `authenticatedSessionTranscriptSourceAdmissionVersion === 1`, the original source-admission SDK contract, and current synchronous authority before journal reservation. Missing new marker fails closed even when the older trusted-runtime marker is 1. The host-only `sessionTranscriptSource: { selection, assertCurrent }` option is never RPC JSON. CC unwraps the public response envelope, preserves sent-timeout uncertainty for exact readback, and never calls trusted `runtime.gateway.request` for creation. Bill-action dispatch is unchanged.

Native captures the original entitled scope/client/principal and source guard before callbacks, retains source writer custody through actual Workboard transaction/COMMIT, preserves the native write guard and joins cleanup. Exact agent/Session and immutable snapshot/destination/generation/digest remain bound to one manual todo acceptance. No Start, specify, decomposition or scheduler is introduced.

Six private tests passed through the production CC adapter, Source.withSource/transcript-lock composition, real CC Session adapter/Topic binding and SQLite journal against the same actual compiled TGZ graph, with external `config` origin and the exact create/list allowlist: concurrent create/replay and changed-intent refusal; source writer exclusion at native transaction and COMMIT; principal replacement at actual COMMIT rolls back; lost response recovers by exact readback and replay after CC metadata restart without another create; absent new marker refuses with zero journal/native effects; revoked principal before admission leaves zero journal/native effects. A separate case proves the trusted runtime request still refuses external origin. The concurrency case checks writer exclusion, so these are six test cases total, not seven independent suites. No bundled origin, adapted runtime facade or native source substitution qualifies this successor.

These are isolated in-process authenticated-scope fixtures, not live HTTP authentication, registered plugin-loader/bridge composition or an installed production journey. Native [#66](https://github.com/AshleyHollis/openclaw/pull/66) navigation at `6b4702dd57a94f9e425113bfa0a9ce8418587cb1` remains separate. Require a combined navigation/source package and installed draft/focus/owner qualification before activation. Explicit requested-result-review still lacks a qualified native owner. The feature stays disabled and release-unqualified.

## Historical runtime-only handoff at 9241376d

Native [#66](https://github.com/AshleyHollis/openclaw/pull/66), exact `6b4702dd57a94f9e425113bfa0a9ce8418587cb1`, supplies cross-plugin targets and fresh scoped card-detail navigation. CC now invokes its declared host target, preserving the exact board/card/tenant. Native draft/save defer and scope verification stay with Workboard. Installed-pair proof is still pending.

Native [#67](https://github.com/AshleyHollis/openclaw/pull/67), exact `9241376d656e372ac1ce0c4a48fc432cf48a4c9b`, supplies the public digest/transcript admission SDK and the authenticated Gateway handoff. Selection is `{ agentId, sessionKey, sessionId, entryId, generation, digest }`, digest version `sha256-public-message-v1`. Native source/destination workers retain source writer custody through actual Workboard COMMIT. Captured guards check current identity/revocation synchronously, without querying the paused source worker.

The actual runtime Gateway advertises `sessionTranscriptSourceAdmissionVersion === 1`, but this marker does **not** establish external-plugin entitlement. In exact #67, `src/gateway/server-plugins.ts` rejects `runtime.gateway.request` unless the plugin is bundled or trusted official, before handling source custody. CC is external. Its existing entitled authenticated public dispatcher, `src/plugin-sdk/gateway-method-runtime.ts`, accepts only `expectFinal` and `timeoutMs` and drops source admission. A real native integration fixture reproduced this refusal with external origin and no card created.

**Required native correction:** extend the entitled authenticated public dispatch contract with host-only source selection/current-authority options and actual host support admission. Preserve its scoped client, method allowlist, original principal, native Workboard guards, retained source custody through COMMIT and joined cleanup. Capture authority before callbacks. Do not widen official-plugin trust or serialize capabilities. CC must establish support for this external path before reserving a journal entry. At CC e8924ba, production Track refused that missing external contract before journal/native effects, including on a version-1 host.

The previous CC adapter exercised #67's existing runtime contract for qualification only. Its retained guard checks CC authority and binding without querying the paused source worker; card input binds the same `agentId` and `sessionKey`. Three private real-native tests passed with **bundled fixture origin**: concurrent creation/replay yielded one manual todo, principal replacement at actual COMMIT rolled back the card, and lost response after COMMIT recovered by exact readback. These prove custody mechanics, not CC entitlement or production source composition.

Actual SDK tests passed against #67 package SHA256 `6d7bb215255fab6c8e17cbe4d85ba8660f2375f8bdfdcda07e49fabd0da1c915`, including legacy-host refusal and principal replacement after the guard. Hosted tests without that explicitly configured package skip the actual-SDK cases; no fake SDK is used. #66 and #67 remain separate. Full native CI, external dispatch correction, combined package and installed pair remain unqualified. The feature stays disabled. Requested result review has no verified native owner.

## Historical baseline design brief

The sections below document the original `26a9c0f` gap. The inspected successor above replaces the proposed synchronous predicate with native retained writer-lock custody; these historical proposals are not additional APIs to invent.

Exact source inspected: AshleyHollis/openclaw `26a9c0faa4124e53ae2eab34291d68a7245f630c`; consumer CC #370/#371, baseline `2253d49b5b90c8c1c8c506a0a38efe300c389da4`. This is an implementation brief, not an implemented native API, permission change or deployment request. Official 2026.9.8 is not equivalent to this fork's guarded create/update admission.

## Bounded visible-message admission

The published `src/plugin-sdk/session-transcript-runtime.ts` exports stable visible message entries and a transcript write lock. The writer queue in `src/config/sessions/session-accessor.sqlite-transcript-write.ts` is explicitly process-local. A selected message can change or leave the active branch in another process after CC's asynchronous read and before Workboard create. The existing synchronous Session reset fence does not detect that same-session change.

Add a generic bounded synchronous read/assertion for one currently visible message, not a Conversation-plan-specific native operation:

- Implement beside `src/config/sessions/session-accessor.sqlite-active-events.ts`, reusing `withCurrentProjectionSnapshot` (`session-accessor.sqlite-active-projection.ts`), `readActiveTranscriptEntryIdentityInSnapshot`, and `selectMessagePayload`/`parseActiveTranscriptMessageRow` (`session-accessor.sqlite-projection-read.ts`) in the same directory.
- Require exact Session key/id, stable entry ID, active-path membership, projection generation and a canonical digest of the publicly visible message. Preserve the existing `projectVisibleMessageEntry` redaction behavior. Read-only, bounded, no async callback, cold restore or rebuild inside an admission guard; missing/stale projections fail closed.
- Export the owner through the Session accessor and public transcript runtime SDK. Define/version digest canonicalization explicitly so a consumer cannot compare raw storage to a redacted public payload by accident.
- CC must use this owner inside the host-prepared Workboard create guard, alongside authenticated authority, current Topic ownership and exact Session identity. Existing Workboard admission kernel/worker invokes the guard at transaction and commit. The guard is a predicate, not a serialized client assertion.

Qualification must run actual fork SQLite owners in two processes. Pause at both admission stages, then reset the Session, edit the same entry's payload, switch/remove its visible branch or replace its projection generation. No card may be accepted from obsolete source evidence. Also test unchanged digest, redacted content, bounded reads, principal revocation, wrong tenant, response loss, restart and concurrent idempotent create. A callback spanning separate transcript/card databases does not itself prove atomic cross-database exclusion; explicitly document and test the guarantee. If that race cannot be closed through the current guard, the native owner must supply a shared transaction/lock primitive rather than claiming the process-local queue is enough.

At the historical baseline, Track refused before journal/native effects because the source capability was absent. The successor supplies native custody mechanics, but the external dispatch gap above preserves the production before-journal refusal; the feature flag remains disabled.

## Exact Workboard card navigation

`src/plugin-sdk/control-ui.ts` defines page targets without plugin ownership. `ui/src/plugins/control-ui-host.ts` resolves against the caller's descriptors. Workboard route/route-location select a board; `extensions/workboard/browser/pages/workboard/view-card-details.ts` opens details only through internal view state. Session accessories also open boards, not an exact card.

Smallest generic change: support an optional explicit plugin owner on a page target, resolved only against advertised active plugin pages. Extend the native Workboard target with exact card ID and expected board/tenant. Load and verify the target through the native owner before invoking the existing card-details state. Missing, wrong-scope or changed cards yield an unavailable destination; do not choose a nearby card or silently change boards.

Preserve existing draft/save guards, routing history, focused control and Start/review controls. Test cold/warm navigation, refresh, back/forward, reconnect, unavailable/wrong-tenant cards, draft-preserving defer, focus return and no implicit Start/specify/decompose. Consumer CC should invoke the declared native target, never construct a guessed path or simulate a DOM click.

## Human requests and remaining CC work

The [explicit human-action/result-review contract](approved-conversation-plan-result-review.md) defines current native signals, durable CC episode deduplication/terminal proof, the current UI, and the exact missing completed-result-review prerequisite. An explicit `ask_user` review question remains a question; Workboard review/completion never creates a result-review request. The fictional injected verifier does not establish native support.

Native questions and execution approvals already have authenticated pending-list contracts. CC has a read adapter for exact linked session/run and expiry; ordinary progress/completion/blocked/review is quiet. The disabled CC candidate now wires these identities into the existing Attention episode service with stable native request identity, verified withdrawal/resolution, final commit authority, and durable terminal receipts. question.get verifies terminal question state; pending-list absence never proves resolution, especially for execution approvals. Native Done, immutable expiry or an exact terminal linked attempt withdraws obsolete relevance without claiming a response. Scoped episodes are exposed only through freshly authorized plan projection, not generic notifications/actions. This source work still requires real native qualification after source admission. Navigation returns to existing native controls; no duplicate execution is created. No explicit requested-result-review envelope was verified in this pinned Workboard contract, so that subtype stays unavailable pending a separately specified native owner. Do not widen email/payment semantics or treat a review status as a request.

Multi-card decomposition, automatic Start, scheduling, progress queues and native reliability package #65 deployment remain outside v1.
