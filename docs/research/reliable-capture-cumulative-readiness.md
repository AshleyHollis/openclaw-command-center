# Cumulative reliable capture preparation

This preparation combines capture correctness and disabled accepted-Chat replay.
It is not a frozen release candidate or deployment approval.

## Exact inputs

- Deployed product base: `018f4aa10a52c1122f0f045063034dbef05e9d05`.
- PR361: `3a909345712621628ccf46b1180ceff384e94014` — retain immutable
  observation timestamps on tool retries instead of changing their intent digest.
- PR362: `399abaac94060f4af1fac0ff14346a2ae3a264c0` — retain upstream Chat
  lineage when the saved resource is a Note, and reuse exact derived evidence.
- PR364: `ae7f6c67d83ae22f179c9fadee38f8963d486b29` — persist an accepted,
  submitted Chat plan and replay it through existing accounting, capture and
  Note owners with fresh authenticated authority.

The deployed product does not contain these capture changes. Its conversation
incarnation, topic creation, reader and CI checks remain in this integration.
Only CI test-list conflicts required manual resolution. No compatibility pin
has been changed here; the reviewed newer compatibility base remains an input
to the final successor, whose review and exact-head CI must run afterwards.

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

Compatibility owner PR381 has published reviewed source
`c2fb192665670948fe55ca9ab62c1b237ada39d7` from the same deployed base.
Its declared native product is `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`,
package SHA256
`acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470`.
That source has been fetched for reconciliation only. Its compatibility patch
has not been duplicated or applied here. At the preparation observation,
hosted safety passed, package qualification was running and pre-commit.ci
reported a configuration error. The owner handoff and final successor checks
remain pending.

Preliminary independent Standards review found an activation blocker:
`src/sources/notes.mjs` checks accepted-Chat authority immediately before
dispatching an awaited filesystem link. Authority may retire during that
publication call; later checks refuse completion but cannot prevent the Note
publication already dispatched. The existing pre-commit revocation test does
not establish retirement safety during dispatch. The owning publication
admission contract must resolve and qualify this boundary before activation.
The disabled preparation must not be represented as satisfying that contract.

Final readiness requires the reviewed compatibility base, reconciliation of
its native/API tuple and deployed-product changes, final independent review,
exact-head safety/package CI, and the release policy's affected installed-pair
qualification. Neither earlier individual-PR CI nor preparation tests replace
those gates.
