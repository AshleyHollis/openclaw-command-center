# OpenClaw Command Center

Command Center is an OpenClaw external plugin for a full-size personal command-centre interface inside OpenClaw's Control UI.

The first-release scope provides existing Topics, read-only Notes, preserved Imported History, and linked Conversations in OpenClaw's native Chat. Deferred features remain disabled.

## Native Topic workspace

This integration requires the matching host build with native plugin panels and the optional main-pane promotion contract; it is not enabled by installing an arbitrary upstream package with the same version label.

1. Open **Topics** and choose **Organize Conversations in native group** for a Topic. Setup groups its existing ungrouped linked Conversations, preserves manually assigned groups, and does not change Notes ownership.
2. Expand the Topic-named group under native **Sessions** and select a Conversation to continue in native Chat.
3. Choose **Topic Notes** from the native side-panel selector. The panel resolves that exact Conversation's existing Topic binding.
4. Click a Note to read it in the main pane, with Chat alongside. Use native swap, focus, and resize controls to arrange the panes.

Groups are presentation, not an ownership boundary. A new Chat created with the native group **+** is not automatically linked to a Topic. Use the Topic's **New Conversation** form for a linked Conversation, then run group setup again. Unbound Chats show an explanation rather than guessing a Notes folder. Notes remain read-only; grouping does not create, move, or rename folders.

## Intended direction

- A global Home dashboard
- PARA categories for projects, areas, resources, and archived material
- Context-aware messaging through OpenClaw sessions
- Views over work, agenda, routines, and operational attention items
- Navigation into authoritative OpenClaw and Workboard records rather than duplicated stores

Product fixtures such as Cooking, Household, Vehicle, and Technology are fictional examples. They do not represent private user configuration.

## Safety

This is a public repository. Do not add real configuration, credentials, conversations, identifiers, infrastructure details, logs, screenshots, databases, or absolute personal filesystem paths. See `docs/fixtures-and-privacy.md` and `AGENTS.md`.

## Development

Issue #19 resolved the initial licensing decision: this repository is MIT-licensed. Contributions are accepted under the same MIT terms (inbound equals outbound). The isolated test harness uses only disposable fictional fixtures and does not discover or connect to live OpenClaw state.

## License

MIT. See [LICENSE](LICENSE).
