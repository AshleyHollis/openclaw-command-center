# Topic Notes usability: primary-source findings

Research date: 2026-09-13. Planning evidence only; no implementation or live-state inspection. All examples below are fictional. Four external primary sources were fetched directly. The proposed acceptance checks are engineering recommendations, not claims that a standard prescribes this product's layout.

## Product boundary

The current release supports browsing existing Topics and read-only Notes, with exact linked native Chat. Note authoring and indexed Topic Search remain deferred. A local filename/path filter must be described as a filter, without implying full-text or conversation search. Preserve the Note Folder boundary and stable Topic identity. Sources: [domain vocabulary](../../CONTEXT.md#knowledge-and-conversation), [release scope ADR](../adr/0004-first-live-release-core-topics-notes-chat.md), [native integration ADR](../adr/0003-use-native-openclaw-ui-for-tactical-mvp.md), [identity ADR](../adr/0001-preserve-topic-identity.md).

## Source findings and their practical implications

### 1. A file tree is an interaction contract

WAI APG describes trees as hierarchical lists with expandable parent nodes. Its keyboard pattern includes arrows for traversal/expansion, Home/End, and Enter activation; type-ahead is recommended. Focus and selection are distinct concepts. The documented semantics include a named `tree`, `treeitem` nodes, nested `group` containers, expansion state only on parents, and explicit selection state for selectable items. This is implementation guidance, not a mandate to use a tree for every list. [WAI APG Tree View](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)

Recommendation: use this contract if the approved design exposes nested folders. Keep arrow-key focus separate from opening a Note; Enter or clicking the row opens it. Make the selected Note and keyboard focus independently visible. A flat filtered-results list can instead use native links/buttons with relative paths; do not attach `role="tree"` unless the full tree interaction is implemented.

### 2. Adjustable panes need more than a draggable line

APG's splitter guidance uses a focusable `separator`, accessible pane label, current/minimum/maximum value, and `aria-controls`. Arrow keys resize variable splitters; Enter collapses/restores the primary pane. Home/End and F6 are optional. The page explicitly says its review is not complete pending a functional example; treat it as qualified pattern guidance. [WAI APG Window Splitter](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)

Recommendation: retain a visible resize affordance, meaningful minimum pane widths, collapse/restore controls, and a way to recover the previous split. If resizing is included, provide pointer-click width presets or increase/decrease buttons as well as keyboard resizing. Prevent either pane becoming an unusable sliver.

### 3. Accessibility constraints are independently testable

For WCAG 2.2 AA, relevant criteria include keyboard operation (2.1.1), visible focus (2.4.7), focus not entirely hidden by author content (2.4.11), reflow at 320 CSS-pixel width with specified exceptions (1.4.10), and programmatically exposed status messages without moving focus (4.1.3). Drag functionality needs a single-pointer alternative without dragging, subject to exceptions (2.5.7); keyboard support alone does not provide that alternative. Pointer targets have a 24-by-24 CSS-pixel minimum or an applicable exception, including spacing (2.5.8). [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

Recommendation: keep a labelled filter above navigation, retain its focus while results update, expose a concise result count, and offer a visible clear control. Distinguish “No Notes in this folder,” “No matching Notes,” loading, and source unavailable. At narrow widths, use one readable pane with explicit navigation back to Notes. Do not rely on tiny chevrons as the only click targets.

### 4. Screenshot tests compare appearance, not usefulness

Playwright supports `expect(page).toHaveScreenshot()` and compares subsequent captures with a reference image. Rendering differs across environments, so baseline and comparison environments should match. Baseline generation waits for consecutive matching captures. Snapshot updates and pixel-difference tolerances are explicit mechanisms, not a design approval process. [Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)

Recommendation: first compare the implementation with the approved mockup at the same viewport and inspect actual browse/filter/read interactions. Only then accept a sanitized baseline. Review visual diffs; do not regenerate baselines merely to make checks pass. Combine screenshots with behavioral and geometry assertions, since a stable screenshot can preserve an unusable layout.

## Proposed bounded acceptance set for the repair plan

These checks translate the findings into a product-specific proposal; they do not establish that the existing UI has failed them. The implementation owner should reconcile dimensions and visual hierarchy with the approved mockup before coding.

| Scenario | Observable acceptance |
| --- | --- |
| Browse and orient | A fictional Topic with 40 Notes across nested folders shows meaningful filenames and relative-path context. Opening `Research/Overview.md` makes its row selection and reader title agree; another `Overview.md` elsewhere is distinguishable. |
| Filter and recover | Filename/path matching is explicit. Matching descendants retain understandable parent context. Zero results include clear/reset recovery. Clearing restores navigation without silently changing the open Note. |
| Read long content | A long Note remains readable while its navigator stays reachable. Pane scrolling does not unexpectedly move the whole shell. Long filenames and Markdown content do not cover controls. |
| Resize and narrow layout | At agreed desktop sizes, the reader has usable width. Pointer and keyboard controls can resize and recover panes. At 320 CSS-pixel width, Notes and reader remain reachable without losing functionality. |
| Keyboard | Traverse folders, open a Note, filter, clear, enter the reader, and return using only the keyboard. Verify focus visibility and continuity after collapse, filtering, and rerender. |
| Visual acceptance | Capture the complete Topic Notes surface, selected Note, zero-result state, narrow layout, and focused splitter/control using fictional fixtures. Compare with the approved design and inspect clipping, hierarchy, spacing, selection, and readable content. |

Passing route checks, text assertions, or existing screenshots alone should not mark the usability repair complete. The handoff should include the reviewed visual evidence and a short recorded walkthrough of finding, opening, and reading a Note, alongside the relevant automated checks.
