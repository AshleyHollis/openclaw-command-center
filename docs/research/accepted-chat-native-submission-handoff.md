# Native accepted-plan Capture preparation

This Class 3 source-only successor adapts the existing plan tool and configured
conversation hook to the existing accepted-plan accept/load/replay commands.
Recovery begins after successful plan submission. Original-message custody,
capture of every acknowledged message and automatic background replay are not
promised. No new service, queue, source scan or access grant is introduced.

The plan tool uses a Native V2 registration and combines its invocation guard
with the original operator runtime at owner checks and final result delivery.
Conversation identity comes from trusted context. Load/replay accept only the
saved plan ID; their extraction and authority cannot be replaced by tool input.
Email and Note inputs retain their existing accounting behavior.

The hook submits one frozen mixed extraction, replays that plan, and reports
unknown coverage when submission fails. Missing/failed/unknown effects remain
pending recovery. Durably recorded pending decisions can keep the overall plan
pending; they are not missing effects or resolved user decisions. A successful
health receipt requires every expected outcome to be durably recorded.

## Canonical profile boundary

The source adapter consumes Native V2's `authenticatedOperator` projection:
canonical `profileId` and the original admitted operator's frozen `scopes`.
Native's existing invocation guard retains source/profile/role and plugin
lifetime checks. Every closed command requires the existing write/admin scope;
the projected identity alone grants nothing. Generic sender IDs, device IDs,
Conversation facts and owner booleans cannot replace this binding.

Older hosts, V1 contexts, unprofiled and read-only callers refuse before
acceptance with explicit unknown-coverage behavior. This source-only successor
depends on the separately reviewed Native SDK projection and remains TEST only.
Affected installed Chat admission and supported-package qualification are still
required. No interpretation-only authority is repurposed and no new grant,
runtime permission, credential access or broader Native admission is introduced.

## Evidence and release boundary

Base fixture is `390c2e0e370abb3d0efd8690be5ca342d57a1a93`. Its passing
installed bridge rehearsal used frozen TEST product
`63ceca9e2b192102c458cc92f9f958731f206266`, archive
`9c13f0f2a82944f07ed558269eb9d40a79713112a2deef3f7ab21aaaac0ac800`, build
`ca5dfc89a8d6345acb6b47f7df83b190765846d81bb4f141e328501fac7a53b9`, Native
`ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`. Preserve that immutable evidence;
it qualifies the unchanged owners, not this new native caller.

Accepted-plan/accounting/Note publication owners and release feature flags are
unchanged. The inherited enabled policy remains explicitly TEST only. The
conversation configuration remains opt-in; no production configuration,
activation, personal source access, maintenance trigger or deployment changes.

New focused tests exercise the adapter through real SQLite/Note owners, reopen,
later user edits, combined lifetime retirement, final-delivery retirement,
original-principal refusal, closed-input refusal, registration and hook failure
instructions. Synthetic runtime injection does not prove Native profile
forwarding. Exact supported SDK package CI, final independent review, identified
artifact and affected installed native-tool qualification remain required.
Reuse unchanged-owner evidence; do not repeat expensive qualification merely
for a newer timestamp. Performance and target-filesystem evidence follow the
repository's affected-path and identity reuse policy. No NAS work is launched.
