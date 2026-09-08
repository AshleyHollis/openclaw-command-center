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
