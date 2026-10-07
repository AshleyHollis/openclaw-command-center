# Everyday Topic workspace: focused assignment and creation

Candidate source slice for #358 and the narrow exception in #222. Implementation
is authorized by the user's next-batches instruction. No deployment or feature
activation is selected. #358, #222 and #344 remain open.

## User experience

Inbox assignment begins at **Choose a Topic…**, including when one Topic exists.
Assign remains disabled until the operator selects an eligible destination.
The supported native searchable picker uses PARA category and the full Topic ID
to distinguish equal names. Older hosts retain a labelled HTML select. A refresh
resets the choice; a removed or revoked destination never becomes another Topic.
An uncertain unchanged retry keeps its original operation ID and Topic revision.

The sidebar's **New Conversation** opens **New conversation in [Topic]** using
the supported native dialog. Its existing creation form accepts an optional
label and preserves inspect/reconcile/open/acknowledge controls. Cancel closes
the dialog without changing Chat or its draft. Reopening checks the server-owned
operation before enabling creation. Success verifies the created reference in
the current Topic catalog and resolves its exact Session incarnation before
opening native Chat. Later navigation, Cancel or authority loss fences an older
lookup. Sidebar action labels wrap at narrow desktop widths.

## Existing capabilities and independence

The native dialog and searchable-picker contracts exist in supported fork
`26a9c0f` and current upstream `b0eecb9`; fork main was `4ee6774` at audit.
This candidate adds no host seam, private DOM access, composer, transcript,
creation/assignment backend, operation store or queue. It shares the existing
activation-owned creation state with the Topic page and reuses the durable
creation/reconciliation and conditional assignment owners.

The existing authenticated HTTP creation/reconciliation and owning inspection
projections additionally expose the saved Session incarnation. The dialog
compares that immutable receipt value to the catalog and passes it to the exact
resolver; a same-reference rebind cannot substitute a newer incarnation. No
locator, principal or journal is exposed, and no persisted representation or
effect changes.

Base: published Attention head `97a4b08`, whose product bytes retain the
`2253d49` baseline. PRs #360–365 remain independently selectable and untouched;
none is a dependency. Selecting a different predecessor requires packaging and
qualification of that actual combination.

## Acceptance and evidence boundaries

- Browser contracts cover explicit single-Topic selection, zero/multiple
  destinations, duplicate names, refreshed/revoked choices, write-access loss,
  original-intent assignment retry, Cancel/focus return/draft preservation,
  uncertain creation/reopen/reconciliation and exact created navigation.
- Existing real-owner suites retain Topic/Session revision and permission
  refusal, concurrent assignment, creation interruptions and durable recovery.
- Files routing and its exact native navigation tests remain unchanged. This
  batch does not reimplement #344 or qualify its installed continuation journey.
- Repository safety, architecture, browser and package checks are candidate
  evidence. Native component doubles and fictional screenshots do not qualify
  actual packaged-host rendering, modal behavior or native unsent drafts.
- Installed desktop journey remains required: assignment, creation, focus,
  Files continuity and the remaining dock/swap/resize/scroll/image/PDF rows.
  Mobile and home-screen relaunch remain explicitly unpassed.

Release policy: Class 3 conservatively applies to the small owning receipt and
write-response projection change, alongside the UI. Real creation/recovery and
assignment failure suites cover the unchanged owners. Installed-package journeys and
visual inspection on the selected supported pair remain admission gates.

## Non-goals and next boundary

No broad Topic lifecycle/provisioning, Note editing, maintenance, permanent
filing activation, native upload changes, host pin changes or deployment.
#356 already has a filing implementation with its gate false. Its next useful
work is independently selected exact-pair filing qualification, not a new filing
engine. The sole operations slot and autonomous-release qualification are
untouched.
