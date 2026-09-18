# Topic Notes: reuse-first implementation direction

Research date: 2026-09-13. This supersedes the bespoke presentation and visual-qualification requirements in `topic-notes-ux-correction-plan.md`, following the user's instruction to prioritize open-source reuse and minimum delivery effort over usability polish. This is research and a revised handoff, not implementation or a live-upgrade result.

## Recommendation

Keep the existing qualified host for this correction. Reuse native Chat, Session groups, panes and the current exact Topic/Note transport. Replace the planned hand-written explorer with a packaged tree component, and use packaged Markdown parsing/sanitization for Reading plus Source. Accept component-default appearance. Implement only the small adapter from the existing authorized catalog/read contract into those components.

An upgrade is allowed if it actually removes required work, but source inspection does not establish that 2026.9.4 does that for Topic Notes. Do not replace a small browser repair with a host-fork migration without a demonstrated saving. Confidence is high in the API gaps below; integration effort remains an estimate until a packaged component runs in the actual host.

## OpenClaw release and modular UI findings

The latest published stable GitHub release is **v2026.9.4**, published 2026-09-11T03:46:22Z, neither draft nor prerelease. This is newer than the app's exact 9.2-based host pin. [Release](https://github.com/openclaw/openclaw/releases/tag/v2026.9.4), [official notes](https://docs.openclaw.ai/releases/2026.9.4).

The likely previously discussed modular-UI work is **#134943, experimental plugin UI customization**, merged 2026-09-04. It exposes native pages, panels, actions and replacements, while the host retains Chat/session ownership. It is already in v2026.9.2: GitHub's comparison places that release 399 commits ahead of the merge, with zero commits behind. Our app already uses its native panel architecture. This is an extension framework, not a complete file-browser/Notes application. Native UI remains trusted operator-authority code, not a plugin sandbox. [PR](https://github.com/openclaw/openclaw/pull/134943), [ancestry comparison](https://github.com/openclaw/openclaw/compare/6a97159ececbf6c0f5a2180b97d761ba1c5fe4df...v2026.9.2).

Another literal match, **#20498, modularize control UI architecture and normalize spacing**, was closed without merging. It reorganized UI source/style files, not Topic Notes capabilities. Do not wait for or adopt that old patch as a product solution. The user did not supply a PR number, so identification of the earlier reference remains a likely match, not certainty. [PR](https://github.com/openclaw/openclaw/pull/20498).

### Exact public API comparison

Both inspected public declarations are unchanged between upstream v2026.9.2 and v2026.9.4:

| File | Identical Git blob |
| --- | --- |
| `src/plugin-sdk/control-ui.ts` | `02370f25bb54ec13efaa618de2a233d9995584cf` |
| `src/plugin-sdk/control-ui-components.ts` | `5d092216f8bc1e7bb5a2f0a94d0c8f2d59039a7a` |

The component contract supplies dialog, agent picker and dashboard mounting, not a Markdown reader or file-tree mount. There is no new public file/Markdown component to consume by merely changing the host version. [9.4 components](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/plugin-sdk/control-ui-components.ts), [9.4 UI contract](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/plugin-sdk/control-ui.ts), [9.2 components](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/plugin-sdk/control-ui-components.ts).

Stock 9.4 also lacks the current fork's `context.panel.showInMain`, native `host.httpRequest`, and public `tryAcquireExclusiveSqliteCoordinator` export. The app uses these for panel promotion, existing mutations, and filesystem/recovery coordination. An upgrade must retain, replace, or deliberately retire those dependencies; changing the version string is not sufficient. This is a confirmed subset, not a complete fork audit. [Stock UI SDK](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/plugin-sdk/control-ui.ts), [stock SQLite SDK](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/plugin-sdk/sqlite-runtime.ts); app owners: `src/native-ui/mutations.mjs`, `src/native-ui/topic-page.mjs`, `src/sources/note-filesystem-owner.mjs`.

## Can native Files replace all of this?

It is the strongest whole-feature reuse candidate. **#143854**, merged September 10 and included in the 9.4 release notes, fixes crowded native Files lists using a fixed filter toolbar, collapsible sections and one list scroll area. It directly addresses a similar layout failure pattern, but in OpenClaw's Files surface—not this plugin's current panel. [PR and source-backed evidence](https://github.com/openclaw/openclaw/pull/143854).

Two ownership/behavior differences prevent treating it as a drop-in replacement:

- File browsing roots come from the Session's `spawnedWorkspaceDir`, then `spawnedCwd`, then its agent workspace. They do not come from Command Center's verified Topic Note Folder binding. Changing these fields can also affect agent execution, not just presentation. No live folder/session remapping was performed or assumed. [Root owner](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/gateway/session-workspace-roots.ts), [file route owner](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/gateway/server-methods/sessions-files.ts).
- Native text Review is CodeMirror/source-oriented, not the newly approved formatted Reading view. Admin connections can receive Edit mode; the documented file-write path has a 256 KiB cap. Native Files therefore changes the read-only/document experience and may expose different actions. It cannot be described as the same Topic contract simply because the user can see a file. [Exact-release Chat/Files documentation](https://github.com/openclaw/openclaw/blob/v2026.9.4/docs/web/control-ui/chat.md).

Native Files is worth reconsidering if the product changes to ordinary Session workspaces with source-text reading. It is not the minimum-effort way to retain the current exact Topic bindings and Reading/Source decision. Do not add a symlink farm, duplicate Note copies, altered Session execution roots, or a generic filesystem bridge merely to make it appear compatible.

## Reuse choices

| Need | Reuse | Small adapter still required |
| --- | --- | --- |
| Chat, groups, layout, swap | Existing native OpenClaw integration | Preserve exact linked Conversation context; no custom composer/layout manager. |
| Folder browsing | Free Web Awesome `wa-tree` / `wa-tree-item`, subject to the one packaging proof below | Map the authorized catalog into items; selection calls the existing reader. Use package keyboard behavior/styles rather than a custom tree state machine. |
| Filename/path filter | Native search input and simple in-memory catalog filtering | No Fuse/index/search server required for substring matching. Use a native result list if simpler than filtering a tree. |
| Formatted read-only document | `markdown-it` plus DOMPurify | One conservative renderer with raw HTML disabled, sanitized HTML-only output, safe URLs and no automatic remote resource loads. |
| Source view | Native `pre` and `textContent` | Toggle the same verified text, with no editor or save path. |
| Packaging | Existing plugin sealed-asset build plus a narrow esbuild step | Bundle required dependencies and CSS locally before digesting; no runtime CDN or entire component-library import. |

Web Awesome supplies framework-independent Web Components, avoiding a React migration. Research verified npm Web Awesome 3.12.0 (MIT), markdown-it 15.0.2 (MIT), and DOMPurify 3.4.15 (Apache-2.0 or MPL-2.0; choose Apache-2.0 and retain notices). Pin the accepted versions and verify transitive browser assets. Use only tree/tree-item and required dependencies/styles. Reference: [Tree documentation](https://webawesome.com/docs/components/tree). See the [plugin/package research](openclaw-notes-plugin-reuse.md) for inspected alternatives and licensing evidence. Package publication is not a passed integration test.

Memory-wiki is not a direct filesystem browser: it compiles a separate knowledge representation. A separate web file manager or alternative OpenClaw frontend adds another service/authentication/deployment surface. Those may be useful products, but replacing the entire knowledge store or frontend is not a shortcut for this patch. No installable native Topic Notes replacement was verified in this bounded research; this is not proof none exists.

## Work removed from the previous plan

- Exact mock-up matching, custom themes/typography, and six mandatory visual baselines.
- Hand-written tree keyboard, focus and selection behavior where the package supplies it.
- New persisted multi-Topic UI state/sessionStorage layer and custom cross-reload scroll restoration. Refresh may return to the file browser.
- New internal Markdown Note-link resolver. Render unsupported local references as inert text for now; external HTTP(S) links require explicit clicks and safe isolation.
- The mandatory 500-item performance fixture, broad visual/zoom matrix and separate UI polish pass.

Basic ability to browse/select/read is still the feature, not a polish project. Keep a simple bounded browser plus readable document, ordinary keyboard operation inherited from components, and no content pushed behind an enormous administrative form. Do not recreate the previous broken layout while claiming the user waived the need to read Notes.

## Revised execution: three steps, five checks

1. **Package proof:** in isolated local fixtures, bundle only the chosen tree and Markdown dependencies through the real native asset boundary. Confirm assets load, stock styles render, selection returns an exact catalog descriptor, and package behavior works without a framework migration. Inspect license/asset closure and byte limits. If this specific package requires substantial patching or fails the bound, use native `details`/buttons with simple filtering rather than building another component framework. Do not enter an open-ended library comparison.
2. **Thin integration:** replace the panel's embedded administration page with the package-backed browser/reader; leave management on the existing Topic page. Reuse current cancellation/revision/identity safeguards and native pane promotion. No new backend or host APIs, editing, recovery changes, view-storage subsystem, or upgrade required by default.
3. **Focused qualification and handoff:** run affected tests, one clean packaged build, and one actual-host browse/filter/read/Source/swap journey with fictional data. Include one representative screenshot or short walkthrough as evidence, not pixel-match approval. Report ready to deploy with remaining limitations. Actual activation remains a separate operation; this research does not change live state.

The denominator is now **five release checks**, replacing the proposed twelve-outcome design programme. Removed scope is deferred, not completed progress:

| ID | Required result |
| --- | --- |
| R1 | Installed sealed browser assets include the pinned dependencies/CSS, load under the real host's authentication/asset rules, and cause no plugin activation errors. |
| R2 | A fictional 120-Note multi-page catalog with nested folders and duplicate names supports browse, filename/path filter, exact selection, Reading and Source; the document is visible and administration no longer precedes it. Package keyboard interaction and ordinary buttons work. |
| R3 | Actual native pane promotion/swap keeps the same Chat/Session and unsent fictional draft. Linked Conversation context remains exact; no transcript/history mutation occurs. |
| R4 | Current Topic/reference/path/revision checks, late-response cancellation, disconnect/permission loss, changed binding and large/chunked Note reads retain the existing safety contract. No fallback by name or sidebar group. |
| R5 | Untrusted Markdown cannot execute scripts, make automatic remote requests, traverse folders, or trigger writes; Source equals authoritative text. One clean candidate/build receipt and the coherent journey match. |

Keep one implementation owner. Reuse #236 rather than create a competing delivery. No broad independent improvement round or Atomic Lite work. After two failed fixes in one area, use one focused diagnosis. Continue to preserve pre-existing source changes and private-data boundaries.

## Upgrade decision

**Recommendation: do not put 9.4 migration on this correction's critical path.** Upgrade separately for its native Files/session/reliability improvements, or bring it forward only when an isolated proof shows it removes more required integration than it introduces. Preserve backup/rollback and qualify the exact resulting host/plugin pair. No downloaded source was installed or run, and no live upgrade, configuration change, ticket mutation or app-code change occurred during this investigation.
