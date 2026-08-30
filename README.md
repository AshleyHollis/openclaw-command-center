# OpenClaw Command Center

Command Center is an OpenClaw external plugin for a full-size personal command-centre interface inside OpenClaw's Control UI.

It currently provides a deliberately minimal, responsive mounted shell. Later tickets extend this baseline without replacing its isolated browser harness.

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
