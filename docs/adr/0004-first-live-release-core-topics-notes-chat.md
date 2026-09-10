---
status: accepted
---

# Ship existing Topics, read-only Notes and native conversations first

On 2026-09-06 the user approved a smaller first live release to reach useful operation sooner: browse existing Topics and their Notes, open exact linked native Chat, and start conversations in existing Topics. Note authoring, new Topic creation, structural/lifecycle controls, indexed Search, rich Dashboard/Attention/Activity, Reminders, Analysis/Review and notifications are deferred to held follow-up tickets, not considered fixed or passed.

Finish applicable conditional-write contracts and all four safeguards for retained operations. Optional features must not block core startup or execute through hidden transport/tool/background paths. Preserve existing native automations, data, source identities and clear recovery states. Any shared dependency still used by the retained paths remains subject to correctness and release qualification.

This deliberately supersedes the broader first-release feature scope, not ADR 0001 identity or ADR 0002 recovery guarantees. ADR 0003 native operator-authority integration remains. Keep desktop usability, measured exclusive performance for retained functionality, final coherent capture, independent evaluation and normal backup/rollback/live admission. Historical progress remains historical; reduced scope is not additional completion credit.

The executable matrix must be aligned before qualification. See [scope and deferred tickets](../research/first-live-release-scope-v2.md) and [release ticket #32](https://github.com/AshleyHollis/openclaw-command-center/issues/32).

## Native transcript presentation exception — 2026-09-08

The user approved retaining native OpenClaw's intentional absence of a focus
outline on its keyboard-scrollable Chat transcript for this MVP. Track its
visible-focus improvement in #228; do not report it as fixed or accessible.
Only that exact intermediate native transcript stop is exempt from the
indicator assertion, with each observation explicitly recorded. Native Chat
remains tabbable; the composer and all other controls still require visible
focus. Names, visibility, keyboard traversal, modal containment, focus return,
forced colors, reduced motion and all eight retained keyboard states remain
required. No host runtime change or general focus-check waiver is authorized.

## Performance qualification allowance — 2026-09-08

The user approved replacing the first-observation-only ceiling with a documented
variance-aware engineering budget. Preserve the v3 baseline byte-for-byte,
including its original observations, ceilings, identities and first-capture
provenance. For qualification only, use the fixed policy
`bounded-relative-allowance-v1`: `ceil(B + min(2000, max(50, 0.20 * B)))`
milliseconds, where B is the original observation. This policy was frozen before
collecting new timing results. It is not an estimated variance or confidence
interval; the allowance is a deliberate tradeoff, not a demonstrated speedup.

Report v4 includes the separately identified budget and its baseline identity
and observation digests. Recompute every limit on read; reject caller-selected
limits, stale identities and older report versions. Retain all failed attempts
and all eight numeric comparisons. No retry-until-green, baseline replacement,
deadline extension, scope reduction or runtime permission change is authorized.
Exclusive performance, final coherent nine-boundary acceptance, independent
evaluation and protected live admission remain required. See the
[research and fixed limits](../research/release-performance-budget-policy.md).
