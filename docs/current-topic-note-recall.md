# Current-Topic document recall — disabled source candidate (#226)

The user experience remains conversation-first. Native `sessions_search` and history own original Conversation recall. Native memory and consolidation remain unchanged. Topic Notes are explicit durable artifacts: this supplemental path answers an on-demand request about those artifacts, without requiring a Note copy of every Conversation.

## Implemented boundary

`command_center_recall_topic_notes` accepts only `query` and `limit`. The native tool context supplies the Session key/incarnation and cancellation signal. The exact current CC Session binding selects one Topic; caller/model parameters cannot grant a Topic, folder, Session, or cross-instance authority. It retrieves root/shared and nested Note candidates through the existing Topic-prefiltered lexical projection. It never queries Conversation projections, invokes rebuild, scans production data, creates an index, writes Notes, or injects context automatically.

The separately build-owned `FIRST_LIVE_FEATURES.topicNoteRecall` remains **false**. General Search, context/rebuild HTTP/tool routes, and the native compatibility pin stay disabled/unchanged. No native67 dependency is introduced.

Each candidate is reread through the existing authoritative Note owner at the indexed revision. The owner retains file/witness descriptors and permission-relevant directory snapshots until tool serialization. Publication checks the Session incarnation/binding, folder reference/locator generation, source availability, exact Note reference/path/revision, held/named filesystem identities, permissions, and cancellation after awaits. A changed previously selected Note rejects publication. A stale/inaccessible unselected candidate can produce `partial`; a missing committed projection returns `unavailable`. `no-matches` means only no matches in an available committed discovery projection, never proof that no relevant Note exists in source. New/unindexed Notes remain a discovery limitation.

Output is limited to eight excerpts, 320 Unicode code points each, 12 KiB total. Citation `start`/`end` are end-exclusive **UTF-16 string offsets** into the exact original Note text at `revision`, including CRLF. Excerpts are derived from fresh source sections, not indexed snippets. `redacted` explicitly marks credential redaction; a redacted excerpt is not a verbatim quote. Existing exact navigation descriptors carry Topic, reference, path, heading and observed revision. Ambiguous duplicate sections fail closed.

## Existing navigation and qualification gap

Earlier pinned native source `26a9c0faa4124e53ae2eab34291d68a7245f630c` supports ordinary internal plugin links. Its source-browser evidence is historical: the current compatibility base pins `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2` (native 2026.9.9), which requires its own installed qualification. The existing route to verify is:

- `ui/src/plugins/control-ui-host.ts` `pageLocation`/`navigation.pageHref` builds canonical plugin routes with `p.*` parameters.
- `ui/src/pages/plugin/route.ts` forwards those parameters to the registered page.
- `ui/src/components/markdown.ts` preserves same-origin Control UI links; `ui/src/app/native-conversation-bridge.ts` handles non-Chat links through dashboard navigation.
- CC `src/native-ui/topic-page.mjs` accepts `topicId`, `sourceReferenceId`, `sourcePath`, `evidenceSourceVersion` and refuses stale evidence before opening the current Note.

Thus a source link can reuse the existing Topic reader using `host.navigation.pageHref({ id: 'topic', params: { topicId, sourceReferenceId, sourcePath, evidenceSourceVersion } })`. A new Chat citation renderer is not inherently required. A canonical trusted route/base-path handoff into model-visible links and the actual installed click journey are not implemented/qualified in this source batch. Do not treat the existing JSON navigation descriptor as proof of a clickable Files-pane citation.

Generic Markdown file links are different: `ui/src/components/markdown-file-links.ts`, Chat workspace navigation, and the native `workspace-files` owner resolve files inside the Session workspace and carry only path/line, not CC Note reference/revision. They cannot authorize a CC Note-folder read. The existing CC Files replacement in `src/native-ui/topic-notes-panel.mjs` passes only `topicId` to its reader; it does not consume a tool-result citation target. Installed source-link navigation, exact selection and Chat draft preservation remain required before activation, and UX expansion is held pending the architecture review.

## Evidence and remaining admission

Release-policy class: **Class 3**, because this adds a model-visible authorization/publication boundary. No write owner or schema is added. Independent local review found and prompted fixes for lease lifetime across tool publication, handle cleanup, CRLF offsets, permission fencing and empty-result authority. No external review service was used.

`test/current-topic-note-recall.test.mjs` uses isolated fictional SQLite projections and the real Note/source owners on Linux. It covers two Topics; root/shared/nested Notes; exact fresh excerpts/revision/ranges and existing navigation; bounds; Session reset; simulated binding successor; folder locator change/physical replacement; earlier-file edits during a later read; root/nested permission loss; simulated reference removal; cancellation; tool-publication reset; no-match owner denial; projection unavailability. The two simulated metadata successor/removal seams are distinguished from real filesystem and SQLite tests; deployed metadata does not allow reassignment of an already linked Session.

These are source tests, not installed-package proof. Activation still requires final pinned-host packaging/qualification, current source-link routing and draft-preservation evidence. Existing projection publication/recovery and native recall owners remain separate dependencies, not claims established by this slice. No live Gateway, personal corpus or NAS data was read.
