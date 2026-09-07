# Desktop keyboard batch review — issue #32

Reviewed the MVP changes from `91bb18e461c0982a3e1cb3e5aa52a41ff677ab09`
through `32ebc9aeafca3aaee23670a4c9e23fdf45968278`, plus older keyboard code
those changes depend on. Standards and Spec reviews were independent and
read-only; implementation had one writer. This is a bounded review, not a
claim that every possible accessibility defect has been found.

## Standards findings and implementation

- DOM references expired during collection refreshes and modal interactions.
  Shared `captureFocus`/`restoreFocus` resolves the exact semantic row/control
  identity or its visible, enabled owner heading. Notes, Activity and both
  Search views use the same policy. Existing Attention draft retention and
  Review/Conversation decision-specific transitions remain intact.
- Evidence, command confirmation and Note dialogs now restore semantic focus.
  A pending Note mutation keeps a visible status focus target inside its modal;
  failed writes restore the path field. Mutation guards remain in force.
- Terminal pagination, resolved Review controls and Topic entry could hide or
  disable their focused invoker. These transitions now hand focus to content.
- Delayed Topic creation/native Chat refusal could steal newer focus. Completion
  only repairs focus still owned by that operation. Notification deep-link
  focus is consumed once. The host-navigation selection freeze is unchanged.
- Repeated Activity paging could duplicate requests or append obsolete results.
  A single pending-page owner and Dashboard generation check reject those races.

## Spec findings and implementation

- The Evidence audit had an arbitrary 80-forward-Tab limit, while the shared
  navigator rejected documents with more than 240 controls regardless of the
  actual path. The audit now targets the exact acceptance card, uses real
  Tab/Shift+Tab with cycle detection and a finite path budget, then Enter/Escape.
- Already-focused targets and reverse traversal require visible, enabled,
  non-body focus. Accessible names remain mandatory along the path; element
  IDs and tag names are diagnostic identifiers, not names.
- Native command dialogs were omitted from the modal audit. Native and explicit
  modal semantics and resolved nonempty labels are now checked. A status data
  attribute alone no longer proves a color-independent cue.
- The native Chat return previously used direct URL navigation while claiming
  keyboard-only coverage. It now activates OpenClaw's declared sidebar link and
  keeps the fresh authenticated mount and exact persisted Session assertions.

## Evidence and remaining qualification

`test/keyboard-batch.test.mjs` contains 22 real-browser regression cases using
only fictional local fixtures. These passed locally, alongside the existing
focus, dialog, native navigation contract and test-selection checks. Negative
cases reject missing focus, unnamed controls, keyboard traps, disabled targets,
missing modal labels and color-only status markers. The new browser-heavy file
remains selected in the serialized ordinary browser lane.

The former complete-capture failure was reproduced with a long Activity list
without another capture. These regression passes do not count as new named
acceptance frontiers. Linux and targeted real-host evidence must be attached to
the ticket for the sealed batch before release claims. Performance qualification
stays exclusive; coherent final capture and independent evaluation remain
required. Mobile remains deferred in #216. No iframe permissions, host resolver
authority, runtime source ownership or live installation are changed by this
batch.
