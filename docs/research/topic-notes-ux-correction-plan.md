# Topic Notes workspace: usability correction plan

Status: historical detailed-design proposal, 2026-09-13. The subsequent user priority is minimum effort through open-source reuse, not bespoke usability work. **Read [reuse-first direction](topic-notes-reuse-first.md) instead for the current delivery scope and five-check acceptance set.** The twelve outcomes, six visual checkpoints, persisted UI state and bespoke tree requirements below are not additional current gates. No application implementation or deployment is authorized by this document alone. All examples and test datasets must be fictional. Private visual references are supplied separately, outside this public repository.

## Outcome and decisions

Make finding and reading a Topic Note the main task of the native Topic Notes panel. Preserve native Chat alongside the document. This is a focused correction of #236, not another platform or recovery programme.

Confirmed product decision: **formatted Reading view by default, with a Source toggle**. This supersedes the raw-Markdown rendering choice in the earlier first-delivery plan; it does not authorize Note editing, creation, or maintenance. Record that narrow amendment in the applicable scope documentation when implementation starts.

A Topic owns one Note Folder and linked Conversations. A native sidebar group is presentation only. Selecting a native linked Conversation supplies context through the existing exact resolver. Expanding a group does not establish Topic ownership or select a Chat.

## Why the current implementation misses the intended experience

Source inspection identified these linked problems:

1. `topic-notes-panel.mjs` mounts `mountTopicPage(..., { panel: true })`. The latter still includes Topic administration, conversation creation, and Conversation/history inventories. The panel flag removes only a few navigation controls, rather than defining a Notes workspace.
2. The folder list is part of the same unbounded vertical flow as the document. Top-level folders reopen during rendering. More files move the reader further down instead of scrolling within a bounded navigator.
3. Opening a Note promotes the entire oversized page, then focuses its content. Native pane promotion already exists; the promoted content is the wrong layout.
4. Existing tests establish exact reads, filter matches, and pane promotion, but do not establish that a person can see the navigator and document together. Small fixtures and programmatic focus/click scrolling can conceal the problem.

These findings do not invalidate the existing recovery and authorization work. Preserve that foundation. The correction is a dedicated presentation boundary plus task-level and visual acceptance.

## Target experience

The approved reference has two states; use the actual native host shell in both:

```text
Browse:  native groups/Conversations | native Chat       | Topic Notes browser
Read:    native groups/Conversations | Topic Notes       | SAME native Chat
                                      compact browser
                                      formatted document
```

Do not implement a simulated Chat, a second session sidebar, or a new outer layout manager. Use the existing host pane promotion, swap, focus, resize, and restore behavior.

### Notes-only surface

- Compact header: Topic name, “Notes”, read-only indicator, Refresh, and a secondary “Topic details” action using the existing plugin page navigation. Keep creation, grouping, and Conversation inventories on the Topic details page, not above the Note browser.
- Place a visibly labelled **Filter filenames and paths** input immediately below the header, with a clear button and concise result/loading status. This is a local catalog filter, not indexed or semantic search. Do not read Note bodies to filter.
- Display folders and filenames, not a repeated “Read path” command. Sort folders before files, naturally within each level; do not infer special ownership or preferred Notes from names such as `Overview`.
- Folders start collapsed; remember explicit expansion during the browsing session. Show a selected file's ancestors when restoring it. Use compact rows of approximately 2rem, with clear focus and selection, a complete accessible name, and relative-path context for duplicate filenames. Long names may truncate visually but must remain discoverable without hover alone.
- The unfiltered hierarchy follows the full tree interaction contract. Filtering produces a flat result list with filename and relative path, avoiding a misleading partial tree. Clearing restores the earlier expansion state and does not close the current document. Announce the count and distinguish empty catalog from no matches.
- Complete catalog loading through the existing cursor contract. Show partial loading explicitly; do not label a partial count as the full result or silently omit later pages. Abort catalog work on context/lifetime changes.

### Browser and document geometry

Keep the reference's browser-above-document arrangement, rather than introducing another full-height pane.

- Before a Note is selected, the browser uses the available panel space, with a small “Select a Note to read” hint.
- After selection, header/filter remain reachable; the browser has its own scroll area bounded to `min(15rem, 30% of the Notes surface height)`. The document has a separate scroll area and fills the remaining height. Use explicit constrained flex/grid sizing with `min-block-size: 0`, not an expanding page.
- At the agreed desktop test sizes, the reader begins within the visible Notes surface and occupies at least 45% of its height. Adding more files must not move the reader down. The Notes root must not require scrolling past the catalog to reach the document.
- Selecting a Note highlights it and shows a local loading state immediately. After exact successful retrieval and final context validation, use `context.panel.showInMain()` to promote the same panel. Never promote for a stale, denied, or failed read.
- Focus the document heading after explicit activation, without scrolling the whole shell. Provide a visible “Back to files” control which restores focus to the selected row, or filter if the row is currently filtered out. Filtering alone never steals focus or opens a document.
- Preserve native swap/focus/restore and resizing. Do not manufacture duplicate controls using private host DOM. If an existing native control is genuinely broken, isolate that evidence before proposing a separately scoped host fix.
- In a narrow native pane, controls wrap without clipping. A 320 CSS-pixel Notes surface must remain usable; this is component reflow testing, not a new mobile application project. At reduced heights or high zoom, allow an explicit Files/Document mode rather than crushing the reader. Both modes retain a visible way back.

### Reading and Source

- Default to formatted Reading: headings, paragraphs, ordered/unordered lists, blockquotes, inline/fenced code, and tables. Use approximately 1rem text, 1.6 line height, and a maximum prose width of 75ch; normal prose wraps. Tables/code may have local overflow, never expand the shell.
- Show filename and relative-path breadcrumb above the document. Offer a labelled Reading/Source toggle; Source shows the exact authoritative text through `textContent`, wrapping long lines. Switching modes must not refetch, save, alter the revision, or change Chat.
- Retain the existing external-authoring explanation in a compact, discoverable location. Diagnostic revisions belong in expandable details, not the primary reading hierarchy.
- Non-Markdown text uses the Source presentation. Unsupported attachments show the existing truthful unsupported state; do not add attachment preview/import/download capabilities in this correction.
- Rendering failure provides a visible explanation and safe Source fallback, never an empty pane or a falsely successful Reading state.

### Continuity and authority

- Preserve the selected Note, filter, expansion, reading mode, and appropriate scroll hints when switching linked Conversations within the same verified Topic. Native Chat remains independently owned by OpenClaw.
- On a different Topic, clear old content immediately. Resolve the new exact context before showing its filenames or restoring hints. Unbound, replaced, closed, denied, and unavailable contexts have explicit states with no fallback by name or group.
- Store only bounded view hints in tab-scoped `sessionStorage`, versioned and keyed by exact Topic/folder binding. No bodies, credentials, authorization results, drafts, or durable operation state. Treat every hint as untrusted; storage unavailability is nonfatal. Keep at most 20 recent Topic entries, with expansion hints limited to the current catalog.
- On reload/Refresh, retrieve current authorized context and catalog, then match the saved exact reference and relative path before requesting the current revision. Missing/replaced references clear selection; a matching filename does not authorize rebinding. Revision changes require a fresh authoritative read, not stale body reuse.
- Clear in-memory content immediately on disconnect, lost read permission, hidden/disposed lifetime, or changed context. Abort pending work and reject delayed responses/rendering at publication. Permission loss also clears saved view hints. Reconnect requires fresh authorization and retrieval. Browser refresh does not promise more Chat draft persistence than the native host provides.

## Implementation seams and native reuse

One Terra owner integrates this bounded correction. No Atomic Lite loop or broad hardening round.

| Owner / file | Responsibility |
| --- | --- |
| `topic-notes-panel.mjs` | Keep exact session-to-Topic resolution and lifecycle/permission invalidation. Mount a dedicated Notes workspace instead of the whole management page. |
| New `notes-workspace.mjs` | Coordinate catalog, selection, loading, read-only document, and promotion. One owner for publishing current results. |
| New `note-browser.mjs` | Tree/filter presentation, expansion, roving keyboard focus, selected-row visibility. No authority decisions or filesystem discovery. |
| New `note-document.mjs` | Safe formatted rendering, Source mode, readable content and internal document navigation. No writes or direct filesystem/HTTP access. |
| New `note-view-state.mjs` | Bounded untrusted view hints and exact-key restoration. Not a Note cache or recovery framework. |
| New namespaced workspace CSS | Native-compatible light/dark styling and constrained scrolling; no global reset or reliance on generic `.btn` styling. |
| Existing `note-read.mjs`, Topic/source owners, native navigation | Retain exact authenticated transport, revisions, ownership, and resolver-authorized Chat navigation. |

The named modules are responsibility boundaries, not a demand for extra abstraction layers. The ordinary Topic page may reuse the read-only browser/reader component; management controls remain outside it. Do not accidentally activate dormant editing paths.

Host inspection found public pane promotion but no public Markdown-reader component. Do not import private host modules or copy host source. The plugin's current build copies native UI files verbatim, so bare browser package imports will not work without a packaging change.

Use `markdown-it` and DOMPurify as explicit, pinned plugin dependencies, with a small browser bundle for the renderer and its dependencies. Verify maintained versions and licenses at implementation time, record the versions in the lockfile, and bundle into the already-declared native asset directory before the existing digest is sealed. Declare the scoped CSS through the native UI manifest. No CDN, undeclared asset path, or new host permission/SDK extension is needed. Test the installed sealed package, not only source modules.

The libraries supply parsing and sanitizing primitives, not a complete application policy. Configure Markdown with raw HTML disabled; use a conservative HTML-only sanitization allowlist. No scripts, handlers, forms, embedded HTML, iframes, SVG/MathML, executable URLs, or automatic remote-image/network fetches. Images initially render inert alt-text placeholders. External HTTP(S) links require an explicit click and safe new-tab isolation. Fragment links stay inside this document. Relative Note links may open only an exact match in the current authorized Topic catalog through the same selection/read contract; reject absolute filesystem paths, traversal outside the bound catalog, unsupported schemes, and missing/ambiguous references. Other unsupported links remain visible inert text. Do not loosen this policy to improve a screenshot. See [markdown-it](https://markdown-it.github.io/markdown-it/) and [DOMPurify](https://github.com/cure53/DOMPurify).

## Ticket structure and exclusions

After this plan is accepted, reuse/reopen **#236** as “Topic Notes workspace — approved-design usability correction”, with four checklist work packages below. Link **#234** as the original delivery parent and record that functional delivery did not establish this visual acceptance. Do not erase earlier evidence or reopen every completed child.

1. Dedicated Notes layout, bounded browser, native styling, and tree/filter controls.
2. Safe Reading/Source component and sealed asset packaging.
3. Exact-context continuity, stale-read protections, and real native pane integration.
4. Realistic task/visual qualification and user review package.

Link #218's native-reuse decision and #215's existing navigation contract. Keep #235 recovery and #237 grouping work intact unless a focused regression demonstrates a defect. Editing/creation #220, automatic maintenance #214, indexed retrieval #226, history performance #230 (including fix 64.1), broader mobile/accessibility expansion, backups, and Atomic Lite stay outside this correction.

## Fixed acceptance register: 12 outcomes

Each outcome is Pending, Implemented/unverified, Passing, or Blocked. Count unique outcomes, not assertions, retries, files changed, or screenshots. Report passing/12 and separately user approval/deployment status. This plan does not assert any of the new outcomes already pass.

| ID | Required proof |
| --- | --- |
| U01 Notes-only entry | Selecting an exact linked native Conversation reveals its Topic Notes, with header/filter visible immediately and no creation form or Conversation/history inventory occupying the panel. Native group expansion alone does not change binding. |
| U02 Scalable browsing | Fictional 120-Note catalog over multiple pages, nested folders, duplicate basenames, long/Unicode names: every eligible item is reachable. Selection, expansion, count, loading, and independent scrolling remain correct. Repeat geometry with 500 Notes. |
| U03 Filtering | Filename and relative-path matches, zero matches, clear, and catalog loading preserve focus and the open Note. No body reads for filtering; no silent truncation after the first page. |
| U04 Visible document | Explicit Note activation displays matching path/content, promotes the real panel, and satisfies the viewport/45%-reader geometry without auto-scrolling past the navigator. Another Note is selectable while a long document is open. |
| U05 Reading/Source | Markdown structures are genuinely formatted; Source equals authoritative text, Unicode included. Toggle, long content, non-Markdown text, rendering failure, and external-authoring message work without any Note write. |
| U06 Rendering safety | Malicious HTML, handlers, unsafe/encoded schemes, remote images, embedded resources, and malformed Markdown cannot execute or auto-fetch. Exact internal links work; foreign, escaped, unsupported, and ambiguous links refuse safely. Test through the real browser bundle. |
| U07 Keyboard and access | Starting from a normal page focus point, use Tab, tree arrows, Home/End, type-ahead, Enter, filter/clear, toggle, and Back to files. Focus stays visible and selection is distinct. Newly changed controls have names, status announcements, contrast, and suitable targets. |
| U08 Native pane continuity | Actual host promotion, swap, focus/restore, and resize preserve the same native Session and an unsent fictional Chat draft. Test linked Primary/other Conversation context; imported history remains separate/read-only. No fake promotion callback qualifies this outcome. |
| U09 View restoration | Same-Topic Conversation changes, Refresh, browser reload, storage denial, and restored hints behave as specified. A different Topic/reference never inherits the previous document or silently rebinds by path/name. |
| U10 Delayed work and availability | Out-of-order catalog/read/render completion, rapid Note/Topic switching, replaced/closed Session, hidden/disposed panel, disconnect, permission loss and reconnect cannot publish stale or unauthorized content. Existing revision/chunk-identity tests still pass. |
| U11 Visual conformance | All six visual checkpoints below pass design review and layout checks on the sealed actual host candidate. Test component reflow and 200% zoom; do not expand this into an unrelated whole-host accessibility audit. |
| U12 Coherent candidate handoff | One clean Linux/NAS build, focused regression results, asset digest/dependency closure, isolated full journey, independent review, and reviewable screenshots/walkthrough all identify the same candidate. No real content in public evidence. |

### Six fixed visual checkpoints

Use deterministic fictional data, the actual host theme/styles, fixed browser/fonts/device scale, and no browser extensions. Full-shell screenshots prove native integration; crop detail additionally if useful, not instead.

1. 1440 x 900, light: Chat centre, Notes browser side, meaningful folder hierarchy.
2. 1440 x 900, dark: selected formatted Note centre, native Chat side; navigator and document both visible.
3. 1366 x 768, dark: long document scrolled, browser still reachable, keyboard focus visible.
4. 1366 x 768, light: filtered duplicate basenames and relative paths, then zero-result behavioral assertion.
5. 1440 x 900, dark: Source mode for the same Note; wrapping and native pane swap verified.
6. 1366 x 768, light: native Notes side pane resized to approximately 320 CSS pixels; controls and document navigation usable without shell overflow.

Add 1920 x 1080 and 200% zoom geometry/interaction checks without growing the six-screenshot denominator. A 500-item fixture is a bounded scale check, not a new performance qualification project. If rendering all rows measurably blocks interaction, fix the browser rendering owner rather than changing acceptance to fewer files.

Use a thin Playwright visual suite compatible with the repository's pinned Playwright version, reusing the existing host fixture. Browser snapshots require the same rendering environment. Accept the initial baseline only after comparing it to the approved design and this contract; after that, fail changed pixels by default, with any narrowly necessary anti-alias tolerance documented. Never auto-update snapshots or mask the Notes surface to make a run pass. [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)

Task journeys must not jump directly to a hidden Note with `.focus()` or force-click it. Assert that the intended browser/document is in the current viewport before activation; use genuine keyboard traversal or ordinary visible clicks. Assert scroll containment and native identity in addition to screenshots. The tree contract follows [WAI APG Tree View](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/); apply relevant [WCAG 2.2](https://www.w3.org/TR/WCAG22/) requirements to changed controls. Do not claim full application WCAG conformance from this bounded check.

## Execution and completion gates

1. **Pin and align:** preserve all existing uncommitted work; record the exact source snapshot, host revision, approved private mock-up hash, and this contract. Update #236 and the raw-Markdown scope amendment after plan approval. Establish realistic fixtures and a failing layout/task regression before repair.
2. **Build the correction:** integrate packages 1-3 through one owner. Use local focused tests continuously. Do not mix deployment, backup optimization, recovery rewrites, or an Atomic Lite change into this branch. After two failed fixes in one area, request one focused diagnosis and classify product/test-setup/infrastructure/requirement before another attempt.
3. **Qualify once coherent:** freeze the candidate, run the clean Linux/NAS build and complete journey after focused checks pass. Independent reviewer checks the approved reference, all U01-U12 evidence, and the actual UI—not just the implementation author's assertions. Rerun affected clusters after fixes, then final coherent proof on the final digest.
4. **Present for approval:** provide before/after explanation, six sanitized screenshots, short browse/filter/read/swap walkthrough, exact candidate and test results, remaining limitations, and status for every U-ID. Mark “ready for user visual review”, not “deployed” or “user accepted”. Obtain user visual acceptance before live activation for this correction.

No deployment or active autonomous goal is started by preparing this plan. Following user acceptance, deployment uses the existing qualified backup/readiness and rollback procedure; do not restart backup engineering. Afterwards verify the real Topic Notes/Chat journey privately without changing Note content or sending messages, and close the correction only when both candidate proof and user-visible outcome are satisfied.

## Research record

See [primary-source findings](topic-notes-ux-primary-sources.md). The research informed a bounded navigator, genuine tree keyboard behavior, readable document layout, and visual checks that cannot substitute for task usability. The approved visual reference and private live observations are deliberately not copied into this public repository.
