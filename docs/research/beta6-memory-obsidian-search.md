# Beta.6 memory, Obsidian, and conversation-search seams

Status: verified against OpenClaw `v2026.7.2-beta.6`, commit [`4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c`](https://github.com/openclaw/openclaw/tree/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c).

This report answers which OpenClaw seams Command Center can use for Space Notes, multiple conversations, Space-scoped search, and a read-only legacy conversation archive. It distinguishes facts in the pinned upstream source from architectural inferences and recommendations. No live OpenClaw state, vault, or personal data was inspected.

## Executive decision

Command Center should use OpenClaw Sessions as the only authority for conversations and Markdown files in each configured Obsidian Note Folder as the only authority for Space Notes. It should add a narrow host-side capability bridge for safe note access, exact session-set search, and a rebuildable Space-scoped search index for Notes and the legacy archive.

OpenClaw's built-in memory, dreaming, and Memory Wiki remain useful adjacent capabilities, but none is the correct authority or complete CRUD/search seam for arbitrary Space Notes. In particular, the normal memory processes do **not** automatically maintain arbitrary Markdown files in a Space's Obsidian folder.

## Verified upstream facts

### Memory writes target OpenClaw memory artifacts

OpenClaw's active memory is Markdown in the agent workspace: daily files under `memory/`, plus artifacts such as `MEMORY.md` and `DREAMS.md`. Its pre-compaction memory flush is enabled by default, and dreaming performs background consolidation into active memory. These are OpenClaw memory artifacts, not a general Obsidian-note API. ([memory model](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/concepts/memory.md#L22), [flush and dreaming](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/concepts/memory.md#L208))

The memory flush prompt explicitly directs durable writes only to `memory/YYYY-MM-DD.md` and treats `MEMORY.md`, `DREAMS.md`, `SOUL.md`, and `AGENTS.md` as read-only during that flush. ([flush plan](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/extensions/memory-core/src/flush-plan.ts#L22-L27))

The bundled `session-memory` hook is event-based rather than continuous: it runs when a conversation resets or expires, takes a bounded recent-message window, and writes a timestamped file under the workspace's `memory/` directory. ([session-memory hook](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/automation/hooks.md#L244))

**Conclusion from these facts:** automatically updating arbitrary Space Notes requires a Command Center note-writing capability or workflow. It cannot be assumed from memory flush, session-memory, or dreaming.

### External Markdown can be indexed, but not strictly Space-scoped

`memory.search.extraPaths` accepts files or directories outside the agent workspace. Directories are recursively scanned for Markdown; built-in indexing skips symlinks. ([memory search configuration](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/reference/memory-config.md#L392-L410), [file discovery implementation](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/packages/memory-host-sdk/src/host/internal.ts))

The built-in memory index is a derived SQLite keyword/vector index. Its watcher schedules re-indexing when indexed Markdown changes, and `memory_get` permits reads only within configured memory roots or extra paths after path and symlink checks. ([built-in indexing](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/concepts/memory-builtin.md), [guarded file read](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/packages/memory-host-sdk/src/host/read-file.ts))

However, the Beta.6 memory-search schemas provide query, result-count, score, and corpus controls; they do not provide an allowed-path, folder, collection, or Space filter. The Gateway `memory.search` method has the same limitation. ([memory tool schema](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/extensions/memory-core/src/tools.shared.ts), [Gateway method](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/gateway/server-methods/memory-search.ts))

**Conclusion from these facts:** `extraPaths` is suitable for optional agent recall across an Obsidian vault, but it cannot by itself guarantee correct Space-folder search. Fetching extra results and filtering afterward is not equivalent because out-of-Space results can displace relevant in-Space results before filtering.

### Memory Wiki is a separate compiled knowledge vault

Memory Wiki is a separately compiled knowledge layer; it does not replace active memory. Its supported scopes are global or agent, not Space. Managed sections can be regenerated while human sections are preserved, and `wiki_apply` performs narrow synthesis/metadata changes rather than arbitrary page editing. ([Memory Wiki overview and scope](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/memory-wiki.md#L46), [managed content](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/memory-wiki.md#L272), [tool behavior](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/memory-wiki.md#L426))

Its Obsidian render mode makes that compiled vault Obsidian-friendly and can integrate with the official Obsidian CLI, subject to scope restrictions. It does not turn an arbitrary existing Note Folder into Space-scoped editable storage. ([Obsidian mode](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/memory-wiki.md#L348))

Although source synchronization and auto-compile are enabled by default, synchronization occurs when wiki operations import sources; this is not a generic filesystem watcher for arbitrary Space Notes. ([source synchronization](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/extensions/memory-wiki/src/source-sync.ts), [compile behavior](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/extensions/memory-wiki/src/compile.ts))

**Conclusion from these facts:** Memory Wiki should be treated as an optional later synthesis view, not the MVP Note store or Space-search implementation.

### OpenClaw natively supports separate conversations and exact transcript search

`sessions.create` creates a durable session and supports labels, agent selection, visibility, and optional parent/fork lineage. If no parent or fork is supplied, the result is a root session with its own transcript. ([session creation schema](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/packages/gateway-protocol/src/schema/sessions-create.ts#L8-L34), [Gateway protocol](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/gateway/protocol.md))

`sessions_search` performs exact lexical search over user and assistant text, returning a session key, timestamp, role, and excerpt. It shares session-history visibility, searches the active transcript branch, excludes tool payloads/reasoning/images, and uses an FTS index updated transactionally with transcript writes. `sessions_history` provides the surrounding messages. ([session search behavior](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/concepts/session-search.md#L11-L43))

The underlying Gateway schema accepts an explicit list of up to 200 session keys. The agent-facing tool accepts either one `sessionKey` or the caller's visible set, so searching precisely the sessions linked to a Space is best done by the capability bridge against the Gateway method. ([Gateway search schema](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/packages/gateway-protocol/src/schema/sessions.ts#L366-L384), [agent tool](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/agents/tools/sessions-search-tool.ts))

This search seam was introduced as an exact FTS capability with the same visibility guarantees as session history. ([upstream PR #105057](https://github.com/openclaw/openclaw/pull/105057))

### Plugins can inject context and expose constrained tools

Plugins can register tools and use `before_prompt_build` to add bounded context before an agent prompt is assembled. They can also observe final messages with `agent_end`. ([plugin hooks](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/hooks.md#L143-L147), [plugin tools](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/building-plugins.md#L239-L290))

The private-conversation memory work deliberately adds recall without widening session visibility or merging transcripts. It therefore complements, rather than replaces, separate Space Conversations. ([upstream PR #100140](https://github.com/openclaw/openclaw/pull/100140))

## Architectural inferences

These points follow from the verified interfaces but are Command Center design conclusions rather than claims made by OpenClaw:

1. A Space should store the exact keys of all of its OpenClaw Sessions and designate one key as its Primary Session. New task-focused conversations should be new root sessions, not forks created merely to encode Space membership. Parent/fork fields have transcript-lineage semantics; Command Center's Space-to-session relation belongs in plugin metadata.
2. A `sessionKey -> Space` lookup plus `before_prompt_build` can give each separate conversation a small, consistent Space identity and relevant Note context without copying the Primary Session's transcript into every new conversation.
3. Session labels are useful display metadata but are not a durable foreign key. The returned session key is the binding Command Center should retain.
4. Results from session FTS and memory/vector search do not share a calibrated score. A unified result page should preserve source sections or use rank fusion, not sort raw scores as if they were comparable.
5. A rebuildable search index is not a second authority. It can contain derived chunks and offsets while the Markdown files, OpenClaw Sessions, and canonical legacy archive remain the only editable/source records.

## Recommended MVP seams

| Capability | Authoritative record | Supported upstream seam | Command Center responsibility |
| --- | --- | --- | --- |
| Multiple conversations per Space | OpenClaw Sessions | `sessions.create`, history, messages | Create independent root sessions; store exact keys; select one Primary Session |
| Search Space conversations | OpenClaw Sessions | Gateway `sessions.search` over explicit keys | Submit only that Space's linked keys; fetch history on demand |
| Browse and edit Space Notes | Markdown in configured Note Folder | Plugin tools and host filesystem access | Constrained list/get/put adapter rooted to the folder; atomic writes; no arbitrary paths |
| Search Space Notes | Markdown files | `extraPaths` is useful but lacks folder filtering | Maintain a rebuildable folder-scoped text index keyed by Space and file |
| Supply context to a fresh conversation | Notes plus Space metadata | `before_prompt_build` | Inject only bounded identity and retrieved Note excerpts, not old transcripts |
| Read/search legacy Discord history | Canonical read-only imported archive | No native arbitrary-archive session search | Maintain a rebuildable archive index keyed by Space and source message/document |
| General agent recall | OpenClaw active memory | memory tools, flush, dreaming | Use unchanged; do not treat it as the Space Note store |
| Synthesized knowledge view | Memory Wiki vault | Memory Wiki tools/compiler | Defer; optionally add later as a derived view |

### Note maintenance contract

The note adapter should expose the smallest useful operations: list, read, search, and write/replace within the Space's configured Note Folder. A write must resolve and validate the final path beneath that root, reject symlink escapes, use an atomic replacement, and preserve valid Markdown. The model may freely rewrite Notes, as requested, without a per-note approval prompt; the path boundary is the safety control.

Automatic maintenance should be explicit even when it feels natural in chat:

- During a conversation, the agent can call the constrained note tool when information becomes durable.
- A later scheduled consolidation can inspect linked sessions and propose or apply missed updates using the same tool.
- OpenClaw memory flush and dreaming continue their own jobs and must not be presented as guarantees that a Space Note was updated.

This keeps one editable copy of each Note while still allowing both Web UI and Obsidian access.

### Space Search fan-out

For a Space, the bridge should issue three scoped searches and present the source clearly:

1. Search the derived Note index restricted by Space ID or resolved Note Folder.
2. Call Gateway `sessions.search` with the exact linked session keys, in batches when a Space exceeds the upstream 200-key limit.
3. Search the derived legacy-archive index restricted by Space ID.

The UI can show Notes, Conversations, and Legacy Archive as source groups. Opening a result reads the authority: the Markdown Note, bounded session history, or the canonical archive record. Search-index rows are disposable and rebuildable.

### Legacy archive boundary

The migration should create one canonical, immutable text-first representation of each retained legacy message or document. It should retain stable source IDs or hashes, original timestamps, generic author/display fields, message text, and attachment metadata or pointers. The Web UI must expose it as read-only.

Do not replay imported messages into OpenClaw Sessions, and do not maintain parallel editable Markdown and database copies. The canonical archive is the retained source; its FTS rows are derived. Current Notes and current Session transcripts stay outside that archive. This preserves provenance and avoids creating competing authorities.

## Deferred and non-goals

- Memory Wiki integration is deferred until a synthesized cross-Space knowledge view has a concrete use case.
- Semantic search over conversation transcripts is not supplied by `sessions_search`; exact FTS is sufficient for the MVP and can later be complemented without exporting transcripts as a new authority.
- `memory.search.extraPaths` can optionally improve general agent recall, but it is not the Web UI's authorization or Space-filtering layer.
- Attachment-content extraction for the legacy archive can be added later; retain metadata and safe pointers now.
- Cross-Space search may be added later as an explicit global mode. Space pages should default to strict Space scope.

## Implications for implementation tickets

The verified seams support separate tickets for:

1. Space metadata and exact session-key bindings, including Primary Session selection.
2. Session creation, history, message subscription, and exact-key-set search through the capability bridge.
3. A path-constrained Markdown Note adapter plus atomic writes.
4. A rebuildable Space-scoped Note and legacy-archive text index.
5. A three-source Space Search API and responsive result UI.
6. A one-time, idempotent legacy archive importer with provenance and duplicate detection.
7. Prompt-context injection and an opt-in scheduled Note-consolidation workflow.

This is the smallest design that preserves the intended context boundaries: each Space groups related Notes and multiple focused conversations without mixing transcript histories, while the Dashboard remains global and OpenClaw remains authoritative for live conversations.
