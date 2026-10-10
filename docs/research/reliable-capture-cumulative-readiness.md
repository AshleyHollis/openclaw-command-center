# Cumulative reliable capture preparation

This candidate combines capture correctness and disabled accepted-Chat replay.
It is not deployment approval or installed-host qualification.

## Exact inputs

- Deployed product base: `018f4aa10a52c1122f0f045063034dbef05e9d05`.
- Reviewed compatibility base: PR381
  `d3f3295ffa736b3010b46986126034c0b8a6a812`, retaining the complete deployed
  product and the owner's single frozen native 2026.9.9/API tuple.
- PR361: `3a909345712621628ccf46b1180ceff384e94014` — retain immutable
  observation timestamps on tool retries instead of changing their intent digest.
- PR362: `399abaac94060f4af1fac0ff14346a2ae3a264c0` — retain upstream Chat
  lineage when the saved resource is a Note, and reuse exact derived evidence.
- PR364: `ae7f6c67d83ae22f179c9fadee38f8963d486b29` — persist an accepted,
  submitted Chat plan and replay it through existing accounting, capture and
  Note owners with fresh authenticated authority.

The deployed product does not contain these capture changes. Its conversation
incarnation, topic creation, reader and CI checks remain in this integration.
Only CI test-list conflicts required manual resolution. The compatibility patch
is reused from its owner rather than duplicated. Final successor review and
exact-head CI remain separate from the compatibility base's qualification.

## Boundaries

This is a Class 3 mutation-owner change under the release policy.
`acceptedChatCapture` and `noteMaintenance` remain false. There is no new queue,
integration, schema, native acknowledgement barrier or unsubmitted-message
coverage claim. Accepted Chat owns submitted frozen plans; legacy unscoped Chat
tools and producers cannot manufacture that authority. Email timestamp replay,
ordinary Note lineage and existing deployed behavior remain separately tested.

PR360 packaging cleanup is independent and unnecessary for this integration,
so it is excluded. Review-only Note maintenance and measured performance work
are separate candidates and are not included.

## Preparation evidence and remaining gates

The initial combined Linux owner run passed 25 of 31 tests with no skips. Its
six failures were legacy Chat fixtures that attempted unscoped effects before
the accepted-plan authority guard. The integration fixtures now require refusal
there, seed legacy persisted accounting directly for non-migration checks, and
assert accepted Chat retains upstream identity while its resource remains a
Note. The completed expanded Linux run passed all 142 tests with no skips in
68.61 seconds using Node 24.16.0 and cached SDK dependencies. It includes
accepted Chat to derived Note followed by ordinary Note producer processing
and replay, preserving one Note creation, original bytes and upstream outcomes.
Independent review accepted the fixture changes. These preparation results
do not qualify the newer native/API pairing.

Compatibility owner PR381 first handed off reviewed source
`c2fb192665670948fe55ca9ab62c1b237ada39d7` from the same deployed base, then
published `d3f3295ffa736b3010b46986126034c0b8a6a812` with a test-only correction
to the stale host-pin expectation and explicit rejection of that obsolete pin.
Independent review accepted that delta before it was reused.
Its declared native product is `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`,
package SHA256
`acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470`.
The restacked candidate consumes that exact successor. Its hosted safety and
package checks passed; pre-commit.ci reported a configuration error. Source
validation after the publication fix passed all 143 affected Linux tests with
no skips in 51.14 seconds, using cached 2026.9.8 SDK dependencies and Node
24.16.0. Exact-head hosted CI must use the frozen 2026.9.9 SDK and Node24.21.0;
the cached local checks are not newer-pair qualification.

Preliminary independent Standards review found a publication race:
`src/sources/notes.mjs` checks accepted-Chat authority immediately before
dispatching an awaited filesystem link. Authority may retire during that
publication call; later checks refuse completion but cannot prevent the Note
publication already dispatched. The Note owner now uses a conditional
synchronous link only for an exactly validated accepted-Chat scope. The final
synchronous authority/binding fence and physical publication have no JavaScript
yield between them, matching the existing SQLite admission pattern. Ordinary
Note calls retain asynchronous publication. Recoverable attempt ownership,
EEXIST handling and subsequent verification/authority fences remain intact.

A real filesystem regression schedules retirement at the final fence and
requires publication before queued retirement, then refusal of later accounting
and capture effects. The old awaited variant fails with retirement before its
publication callback; the fixed variant passes. Precommit revocation still
refuses publication. The measured final fence through conditional publication
was 1.139 ms on the isolated Linux filesystem, not an installed-host latency or
performance-improvement claim. Independent review accepted this bounded fix.
This establishes ordering for authority retirement in the existing JavaScript
realm, not cross-process atomicity for external Session or Folder replacement.
Affected installed-pair qualification and filesystem measurements remain
required before any separately approved activation.

Final readiness requires final independent review,
exact-head safety/package CI, and the release policy's affected installed-pair
qualification. Neither earlier individual-PR CI nor preparation tests replace
those gates.
