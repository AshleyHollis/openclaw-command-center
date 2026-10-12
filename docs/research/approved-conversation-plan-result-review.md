# Explicit human action and result review contract

## Current cumulative TEST contract (supersedes historical sections below)

Accepted native 9.9 `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2` supplies authenticated source custody and exact Workboard navigation. It does **not** supply the explicit requested-result-review owner. [Native draft PR93](https://github.com/AshleyHollis/openclaw/pull/93), tracked by [CC prerequisite #387](https://github.com/AshleyHollis/openclaw-command-center/issues/387), implements that owner separately. Its final source identity and qualification evidence belong in the exact handoff receipt. No new native package is built or installed by this CC candidate.

The current CC source consumes schema-1 `workboard.resultReviews.list/get` through the existing authenticated dispatcher. Both are scoped reads; the bridge does not expose native resolve, Start, specify or decompose. An unsupported owner hides result-review eligibility while preserving verified native questions and approvals. Fictional injected verifiers establish no native capability.

Native completion explicitly opts in with `completion.resultReview={logicalOperationId}`. The native owner checks current authority, exact card revision and the active producing Session/run, then freezes `{summary,proof,artifacts}` with immutable result and completion-intent digests. Routine completion, review status, progress, proof, artifacts and prose never issue a human request. Native SQLite owns request identity, lifecycle, history and terminal receipts; the producing attempt completes and the card enters review atomically. Native Mark reviewed checks current authority and revision and preserves existing Done/dependency rules. Done/archive/delete withdraw pending requests atomically. Retry cannot change the accepted intent or issue another request.

Schema 1 binds stable request ID, tenant/board/card, original Session/run, immutable result digest and request revision, creation time and `expiresAt:null`. Mutable positive receipt revision is separate from immutable identity. CC validates the closed payload and recomputes native digests. List discovers pending requests only for the exact current review card/run. Get verifies original scope and identity, including durable reviewed/withdrawn receipts after Done, a later run or card removal. Missing records remain unknown. Generic terminal-run relevance rules for questions/approvals never substitute for a result-review receipt.

CC reuses the existing Attention transaction/occurrence owners. Immutable identity is `{id,kind,createdAtMs,expiresAtMs,requestRevision}`; nullable expiry is accepted only for requested-result-review. Concurrent reads and restart retain one episode; verified terminal receipts suppress stale pending replies. Changed identity fails closed. Missing proof hides eligibility without inventing resolution. Source custody, current Topic/Session binding and principal authority fence asynchronous reads and final publication. Generic notification/Attention mutation APIs do not expose these scoped episodes.

The current Topic/dashboard shows accepted plan, authoritative card status and attributable linked-session progress. **Review native human request** re-verifies questions/approvals and opens native Chat. **Review requested result** reconciles exact card, Session/run, request and episode revision before opening the declared exact native Workboard target. Native owns Mark reviewed and Start. Stale, revoked, terminal or unknown requests provide no actionable row. **Open native card** remains ordinary authorized navigation. CC never resolves, dispatches or manufactures a request from status; draft/focus/navigation stay with the native host.

Current tests use real CC metadata/Attention owners and cover immutable native digests, nullable-expiry restart, terminal receipts after producing-run completion, stale replay, wrong scope/run/digest, revoked authority, missing-owner fallback and rendered exact-card navigation without dispatch. The prepared installed Track diagnostic verifies one todo and preserved draft, and explicitly records `resultReviewQualified:false`. Native source tests, fictional RPC renderers and archive audits do not qualify the newly paired installed host. Full native checks, required UI screenshots and the release owner's sealed pairing remain separate prerequisites. No NAS job, activation, deployment or accepted-native package change is authorized.

## Historical inspected contract (older pinned candidates)

The sections below preserve the original gap assessment and test history. Statements about absent CC discovery, the question-only UI, disabled policy and the provisional compatibility base describe those earlier source heads. The current cumulative TEST contract above supersedes them.

Owner: [CC #370](https://github.com/AshleyHollis/openclaw-command-center/issues/370), disabled candidate [#371](https://github.com/AshleyHollis/openclaw-command-center/pull/371). Inspected native #74 at `21de16b150d589f50c28ac0fa2e0c91e824d24ac`, CC production consumer `00d33a8c35a2467da31157bef1e23ac2e280d5a7`. This document specifies existing behavior and the missing native prerequisite; it does not introduce an RPC, queue, response command or activation.

## Existing authoritative signals

| Signal | Human action eligibility | Clearing proof |
| --- | --- | --- |
| `question.list` candidate, verified by `question.get` | Exact pending question ID, current card Session/run, immutable payload digest and unexpired lifetime | Exact `answered` resolves; `cancelled`/`expired` withdraws |
| `exec.approval.list` | Exact pending `exec` approval, nested `request.sessionKey`/`runId`, immutable request digest and unexpired lifetime | List disappearance is unknown. Current adapter withdraws obsolete relevance on native Done, immutable expiry or exact terminal linked attempt; it does not claim an approval decision |
| Workboard `review`, `done`, completed notification/event, proof or artifacts | None by themselves | Done can withdraw existing relevance; it never creates a request |
| Linked run running/succeeded/failed/blocked/stopped; replaceable `progress_card`; prose asking for review | None by themselves | Exact terminal attempt can withdraw question/approval relevance; an unrelated attempt cannot |

Native event arrival is a reason to read current owner state, not admission evidence. Native questions are transient, with short-lived terminal records (`question-manager.ts` retains resolved entries for 15 seconds); missing records, reconnect and native restart are therefore unknown, not answered. Request candidates always require fresh authorized verification, exact card reread and final CC publication admission.

An agent can explicitly ask the user to review through the existing `ask_user` question machinery. That is a native **question**, including when its prompt says "Review this result". CC does not classify prose or convert the request into a completed-result-review subtype. Question/approval relevance ends with the exact run; this machinery does not provide a durable review request that remains pending after that run completes.

## Attention identity and lifecycle

The existing owner computes `planKey = digest({ source, destination, cardId, principalId })`, then the stable subject `digest({ planKey, kind, id })`. Immutable request identity is `{ id, kind, createdAtMs, expiresAtMs, requestRevision }`. `requestRevision` is the digest of native immutable request facts, not a later card revision or a newly inferred intent. A changed identity under the same native ID fails closed.

One verified pending request admits one owner-scoped Active episode in the existing Attention transaction/occurrence tables. Repeated and concurrent reads retain its episode ID/revision; restart uses the durable receipt. Occurrence identity includes stable subject and verified state. Verified `resolved` becomes Resolved; verified `withdrawn` becomes Withdrawn. Native Done means obsolete relevance, not proof that the user reviewed a result. Terminal-before-pending and terminal receipts suppress all later pending replays, even beyond the delivery window. A new human request needs a new native ID. Missing native proof hides eligibility while retaining an unresolved receipt.

These records are available only through freshly authorized plan projection. Generic Attention actions, notification projection and activity do not expose them, including after restart before capability registration. CC supplies navigation; native owns answering, approval, review and execution. A CC click never creates a second card, starts execution or records a native review decision.

## Current UI

The Topic and dashboard show the accepted outcome, authoritative native card status, exact card/board and attributable linked-run status (or unavailable progress). Only eligible verified requests produce **Review native human request** in the plan human-request area. The button reconciles again and compares exact card, Session/run and original request/episode revision before opening native Chat, where native question/approval controls remain authoritative. Unknown/withdrawn/resolved requests do not retain an actionable row after refresh. An outdated click says **This native human request changed. Refresh tracked plans.** Authority loss clears the scoped rows.

**Open native card** remains available for authorized tracked cards, including native `review` status with no explicit request. It performs a fresh exact-card read and uses the declared native Workboard target. That normal navigation is not Attention. Native draft/focus/save deferral remains owned by the native host. No completed-result-review action is advertised by the current production adapter.

## Missing native prerequisite

No explicit completed-result-review envelope was found in `packages/workboard-contract/src/index.ts` (card/event/notification types), `extensions/workboard/src/tools.ts` (`workboard_complete`), or native question protocol/manager at the inspected source. The CC `verifyResultReview` injection is a fictional test seam only: production does not supply it or discover result-review candidates. Combining #66 navigation and #74 source custody does not establish this absent contract.

The smallest native prerequisite is an explicit authenticated request owned by existing native Workboard review/history controls. Reuse an existing native request owner if it can supply these semantics; otherwise specify a narrow request record on the native owner. Do not infer a request from status or add a CC scheduler/queue. Required semantics:

- An explicit requester action establishes a versioned request with stable native ID, exact tenant/board/card, originating Session/run, immutable result/proof revision (or digest), created time and native-owned expiry if any. Completion alone never issues it.
- An authenticated read returns the exact immutable identity and authoritative pending/reviewed/withdrawn state. A terminal receipt survives the supported restart/reconnect boundary long enough for consumer reconciliation. List absence remains unknown; native revocation, cancellation or result replacement supplies withdrawal proof.
- Native existing review controls own resolution and concurrency. The request states whether completion of its producing run preserves pending review; a generic succeeded/failed/stopped signal cannot substitute for this decision. CC must not reuse question/approval terminal-run withdrawal for result review.
- Done must either withdraw obsolete pending review with explicit native proof or have an explicitly documented native state relation. A late event cannot revive the same terminal request. Reviewing a replacement result requires a new request ID bound to that result.
- The native target opens that exact current result/request in existing Workboard controls, verifies its scope/revision and preserves draft/focus/navigation. CC would show **Review requested result** only after this owner is qualified, then reverify the original request before navigating. It would never resolve or dispatch from CC.

Qualification must cover explicit issuance versus routine completion/review, immutable result revision, exact card/tenant/run scope, current principal loss, native review/withdrawal, pending-list absence, response loss, reconnect/restart, concurrent CC observations, terminal-before-pending and stale replay, unrelated later turns/runs, and one user action without duplicate execution. Native owns its durable request lifecycle; CC reuses the existing episode adapter. The final native shape/version and generic owner belong in a separately tracked native source issue before implementation; these requirements are not invented existing capabilities.

## Evidence boundary

`test/conversation-plan-attention.test.mjs` exercises current production read/verify functions and real CC SQLite episode owners, including no status inference, an explicit review-worded question remaining a question, absent result-review owner refusing without RPC, and no Attention receipt without owner proof. Injected result-review fixtures prove only consumer deduplication/resolution mechanics. They do not qualify a native request, registered plugin/bridge or installed browser pair. The feature remains disabled and release-unqualified.

## Accepted native 9.9 dependency assessment

Inspected exact accepted product `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2` during cumulative release preparation. The included native custody/navigation changes do not supply completed-result-review requests. Workboard `lifecycle-sync.ts` moves succeeded execution to review; `store-workflow.ts` completes cards and emits routine notifications. The closed Workboard metadata and approvals schemas still do not bind a human result request to a card and immutable proof/result revision. Native plugin approvals derive an active run and expire within ten minutes; they are execution approval records, not this result-review contract. The same missing prerequisite therefore applies to native 9.9. Independent source review confirmed it; no installed qualification or new native mechanism was performed.

The CC018f-to-9.9 compatibility base remains a separate owner dependency. Provisional cumulative filing/Track compositions on CC018f are preparation only. Neither build is a frozen 9.9 release candidate.
