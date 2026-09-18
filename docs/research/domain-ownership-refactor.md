# Domain ownership refactor

Scope: the existing single-context plugin, desktop-first MVP (#32). No new
framework, service, database schema, host contract or Session permission.

## Owners and invariants

- `createNoteDraftStore` in `src/ui/app.js` owns text, base content/revision,
  read ordering, in-flight save identity and relocation. Views receive immutable
  snapshots. Dirty reads never rebase; completed saves retain later edits; create
  never transfers a draft. Relocation uses the mutation receipt, not a later
  listing's revision. It remains a pure closure in the existing classic script
  to preserve the inline sandbox shell and avoid a new loading contract.
- `src/notifications/service.mjs` orders reconciliation through one queue and
  applies one category policy to immediate and queued delivery. It rechecks
  lifecycle/settings after external delivery and journals compensating clears,
  including retries after an ambiguous clear. OpenClaw still owns device delivery.
- `src/metadata/service.mjs` commits Session relink binding, Topic revision,
  recovery state and operation receipt in one transaction. The recovery service
  verifies authority; it does not independently commit that local binding.
- `effectiveSourceLocator` remains the common location rule. Session navigation
  and both transcript snapshot paths use it without replacing Source Reference
  identity. Search filters/navigation reject obsolete locations. Native Chat
  rechecks Topic write policy after awaiting Session authority; its existing
  host resolver remains mandatory.

## Regression evidence

Targeted tests first reproduced draft refresh/reselection/create/save races,
notification delivery/clear and category races, partial relink completion, and
Topic-policy changes during native Chat resolution. Permanent suites include
`note-drafts`, `notification-lifecycle.integration`, `recovery-ownership`,
`native-chat-navigation`, and the Topic Page acceptance suite.

The recovery ownership test restarts real metadata, retries the same operation,
reads both authoritative transcript paths, rebuilds actual projections and
navigates their results. Filesystem/projection durability requires Linux; a
Windows filesystem refusal is not a product pass and must not be bypassed.

## Release boundary

This refactor is not MVP acceptance or deployment. HTTP authentication transport,
Note filesystem process-death/rollback safety, body-limit consistency and
fail-closed diagnostic evidence remain separate review findings. Preserve the
final coherent acceptance capture, exclusive performance qualification and
independent evaluation. No live controller/checkpoint or installation change is
part of this refactor.
