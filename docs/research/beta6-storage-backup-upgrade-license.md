# OpenClaw beta.6 storage, backup, upgrade, and licensing constraints

Status: resolved research for the Command Center architecture

OpenClaw baseline: [`v2026.7.2-beta.6` at `4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c`](https://github.com/openclaw/openclaw/tree/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c)

Research date: 2026-08-02

This report describes upstream constraints, not the contents of any live OpenClaw installation. All conclusions are based on the pinned upstream tree and linked upstream pull requests.

## Executive answer

Command Center should store its authoritative relational state in a dedicated, ordinary SQLite database beneath OpenClaw's resolved state directory, for example `plugins/command-center/command-center.sqlite`. It should obtain the base directory through the documented `api.runtime.state.resolveStateDir()` API, but must not depend on OpenClaw's shared plugin keyed/blob stores: in beta.6 those stores are restricted to bundled plugins and trusted official installations.

That placement makes the database eligible for OpenClaw's broad state archive and online SQLite snapshot handling. The plugin still owns its schema, migrations, integrity checks, and restore validation because OpenClaw treats dedicated plugin schemas as opaque. Managed plugin code and dependency directories are rebuildable rather than authoritative state; restored installations may need the plugin to be reinstalled or updated.

Compatibility should be explicit and fail closed. The first release should declare a beta.6 host floor and plugin API compatibility metadata, use documented focused SDK entry points, probe optional bridge capabilities at runtime, and be tested as a plugin-and-host pair. A fork-side capability bridge should expose its own versioned protocol so the plugin can degrade safely when the bridge is absent or incompatible.

OpenClaw is MIT licensed. A separately authored public plugin may use a permissive license without a copyleft obligation. Any copied or adapted OpenClaw code must retain the required copyright and permission notice, and relevant third-party notices. This research does not select the Command Center license; that remains an explicit repository decision.

## 1. Durable storage

### Upstream facts

- The documented runtime exposes `resolveStateDir`, keyed stores, blob stores, and leases. Keyed stores are durable but bounded; blob rows with a TTL are deliberately excluded from backup and restore. Most importantly, beta.6 restricts the keyed/blob/lease APIs to bundled plugins and trusted official installations. An ordinary third-party or local plugin is denied access ([runtime state API](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/sdk-runtime.md#L729-L790), [enforcement in the runtime registry](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/registry-runtime.ts#L537-L582)).
- The lower-level `plugin-state-runtime` SDK subpath is marked private-local after July 2026. Command Center should not bypass the runtime restriction by importing that implementation directly ([SDK subpath inventory](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/sdk-subpaths.md#L250-L257)).
- OpenClaw's bundled Workboard demonstrates a plugin-owned relational SQLite database under the resolved state directory. It is a useful architectural precedent, but its bundled status does not grant the same private APIs to an external plugin ([Workboard storage contract](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/workboard.md#L392-L405), [Workboard path construction](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/extensions/workboard/src/sqlite-store.ts#L32-L48)).

### Constraint and recommendation

Use a dedicated database at a plugin-owned relative path below `resolveStateDir()`, such as:

```text
<resolved-state-dir>/plugins/command-center/command-center.sqlite
```

The exact relative path becomes part of the plugin's stable storage contract. Do not:

- write into OpenClaw's shared state database;
- import private state-runtime modules;
- place authoritative data under installer-managed `npm/`, `git/`, `dev/`, or `tools/` roots; or
- assume that becoming an installed plugin makes it a “trusted official installation.”

Use ordinary SQLite features that OpenClaw's backup process can open without plugin-defined extensions, custom VFS support, or runtime-only functions. If the chosen Node SQLite library has native binaries, package and test those binaries for every supported platform; OpenClaw does not repair plugin dependencies at startup ([dependency resolution](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/dependency-resolution.md)).

Obsidian notes remain files in their vault. Store only Command Center metadata, indexes, mappings, and workflow state in the plugin database. The vault's own backup remains the authority for note contents unless that vault is also intentionally included as an OpenClaw workspace backup.

## 2. Schema migration and lifecycle

### Upstream facts

- `registerConfigMigration` runs lightweight plugin configuration migrations before the plugin runtime loads. It is not a database migration facility ([SDK overview](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/sdk-overview.md#L194-L217)).
- Plugins can register a service with `start` and `stop` lifecycle methods. This is the appropriate lifecycle boundary for opening and closing plugin-owned resources ([plugin service types](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/plugin-registration.types.ts)).
- The tree contains a doctor contract and bundled-plugin state migration machinery, but it is not documented as a stable general-purpose external-plugin schema migration API ([doctor contract registry](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/doctor-contract-registry.ts)).

### Constraint and recommendation

Command Center owns its database lifecycle. On service start it should:

1. open the database with the expected safety pragmas;
2. read a schema version (`PRAGMA user_version` or a dedicated migration ledger);
3. reject an unknown future schema rather than guessing;
4. apply ordered forward migrations inside transactions; and
5. run plugin-level integrity and invariants before accepting writes.

On service stop it should drain in-flight writes and close the connection. Migrations must be restart-safe and idempotent at the migration-ledger level. Destructive or irreversible migrations should require a verified pre-upgrade backup and should not silently downgrade.

Use `registerConfigMigration` only when plugin configuration keys change. Treat the observed doctor-contract migration hook as an implementation seam, not a dependable external API, unless upstream formally documents it for third-party plugins.

## 3. Backup and restore

### Upstream facts

- `openclaw backup create` includes the resolved state directory, active config, an external credentials directory, and discovered workspaces unless workspace inclusion is disabled ([backup source planning](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/cli/backup.md#L77-L91)).
- SQLite databases under the state directory are captured with SQLite's online backup API, compacted offline, and archived without copying live WAL/SHM files. A plugin database that requires unavailable owner-defined SQLite capabilities fails closed rather than being copied unsafely ([archive SQLite behavior](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/cli/backup.md#L99-L104)).
- Archive verification validates canonical OpenClaw databases, but dedicated plugin schemas remain opaque. OpenClaw cannot validate Command Center's domain invariants ([archive verification scope](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/cli/backup.md#L29-L35)).
- Plugin source and manifests under `extensions/` are included, but nested `node_modules` and managed runtime roots are skipped as rebuildable. The documented recovery step is to update or reinstall a plugin whose dependencies are missing after restore ([rebuildable plugin artifacts](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/cli/backup.md#L104-L110)).
- The narrower `openclaw backup sqlite` command supports the shared OpenClaw database or one per-agent database. It does not advertise arbitrary plugin databases as named sources, and restore writes only to a fresh target for explicit offline activation ([SQLite snapshot and restore](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/cli/backup.md#L37-L75)).
- The online backup implementation was hardened against WAL growth before beta.6 in [upstream PR #113385](https://github.com/openclaw/openclaw/pull/113385).

### Constraint and recommendation

A standard SQLite file under the state directory is covered by the normal broad OpenClaw archive. No Command Center-specific export UI is needed for MVP backup coverage. However, “included in an archive” is not equivalent to “application-valid after restore.” Command Center should provide an internal validation command or doctor check that confirms:

- SQLite integrity and foreign keys;
- the supported schema version;
- required indexes and uniqueness constraints;
- space/session/note mapping invariants; and
- bridge compatibility after the plugin is reinstalled.

The restore runbook should be offline and explicit: restore the broad archive, reinstall or update the exact compatible plugin build if dependencies were skipped, start Command Center so migrations/validation run, and only then resume writes. Backups can contain private conversations, note metadata, reminders, and credentials-adjacent state, so they require the same access controls and retention discipline as the live state directory.

## 4. Host compatibility and upgrade behavior

### Upstream facts

- For non-bundled plugins, `package.json#openclaw.install.minHostVersion` is an enforced host floor. `openclaw.compat.pluginApi` is separately enforced for plugin API compatibility; `peerDependencies.openclaw` is npm metadata and is not OpenClaw's compatibility decision ([manifest compatibility fields](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/manifest.md#L1200-L1253), [installer enforcement](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/src/plugins/install-shared.ts#L42-L103)).
- OpenClaw's plugin authoring guide shows plugin API compatibility, host compatibility, peer dependency, and build-provenance metadata together ([plugin package example](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/building-plugins.md#L61-L81)).
- Exported SDK APIs are not automatically frozen. Upstream explicitly distinguishes stable documented SDK surfaces from evolving capability registration helpers and recommends focused SDK subpaths for external plugins ([external-plugin boundary](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/architecture.md#L58-L68)).
- Fail-closed plugin API negotiation was introduced in [PR #87477](https://github.com/openclaw/openclaw/pull/87477). That PR also records that automatic selection of the best compatible package version was not implemented, so resolving “latest” can still end in a compatibility rejection.
- Compatibility windows are real but finite. The policy describes adapters, warnings, and migration windows ([compatibility policy](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/compatibility.md#L20-L69)); [PR #111451](https://github.com/openclaw/openclaw/pull/111451) removed expired compatibility surfaces, while [PR #113101](https://github.com/openclaw/openclaw/pull/113101) restored SDK compatibility after shipped plugins broke.
- Managed plugin dependencies are installed or repaired only by explicit install/update operations, not during ordinary gateway startup ([dependency resolution](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/docs/plugins/dependency-resolution.md)).

### Constraint and recommendation

The first supported release should:

- declare `openclaw.install.minHostVersion` and `openclaw.compat.pluginApi` with a beta.6 floor (`2026.7.2-beta.6` or the exact syntax confirmed by packaging tests);
- declare the OpenClaw peer dependency expected by the SDK import contract;
- publish compiled JavaScript and use only focused, documented SDK entry points;
- record build provenance and the tested OpenClaw commit;
- recommend an exact plugin version for this beta deployment rather than an unbounded `latest` install;
- fail closed for writes on an unsupported database schema or incompatible required bridge; and
- degrade read-only or hide only the affected feature when an optional capability is absent.

The fork-side capability bridge should negotiate its own semantic protocol independently of the OpenClaw package version, for example:

```json
{
  "protocolVersion": 1,
  "capabilities": ["spaces.read", "spaces.write", "sessions.spawn", "notes.index"]
}
```

This is an architectural recommendation, not a claim about an existing OpenClaw API. Every privileged operation should check the negotiated capability. The plugin and fork patch should have separate release identities, but CI must test them as a compatibility matrix against each supported OpenClaw commit. Each OpenClaw upgrade should re-run install, startup, bridge negotiation, database migration, backup creation/verification, restore validation, and a minimal end-to-end space/chat/notes flow before promotion.

## 5. Licensing and contribution constraints

### Upstream facts

- OpenClaw's package metadata declares MIT and the repository license grants permission to use, copy, modify, distribute, sublicense, and sell, subject to retaining the copyright and permission notice ([package metadata](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/package.json), [MIT license](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/LICENSE)).
- The license points to repository third-party notices. Copied or redistributed material may therefore carry notice obligations beyond merely naming MIT ([third-party notices](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/THIRD_PARTY_NOTICES.md)).
- Upstream's contribution guide asks substantial features and architectural changes to start with an issue or Discord discussion, and notes that many features are better delivered as third-party plugins ([contribution guide](https://github.com/openclaw/openclaw/blob/4d6bdbdbf33fe3ece3c53853fab9931882ff3f3c/CONTRIBUTING.md)).

### Constraint and recommendation

Keep the public Command Center plugin independently authored and maintain a dependency/notice audit. If code is copied or adapted from OpenClaw, preserve the applicable OpenClaw copyright and MIT permission notice in copies or substantial portions and include any relevant third-party attribution. A patch committed to the OpenClaw fork remains within that repository's existing MIT and notice regime; it should not introduce a conflicting nested license.

No copyleft constraint in OpenClaw forces a particular Command Center license. The repository owner should make a separate recorded choice among suitable permissive licenses after dependency review. MIT aligns most simply with upstream; Apache-2.0 adds an express patent grant and more notice mechanics; BSD-2-Clause is another short permissive option. This report deliberately leaves that decision open.

Before proposing the generic capability bridge upstream, open or link an upstream issue and follow the contribution guide. Keep personal deployment details, private vault structure, live data, and credentials out of both the public plugin repository and any upstream submission.

## Implementation acceptance constraints

The storage and bridge tickets derived from this research should require all of the following:

- a stable plugin-owned database path derived from `resolveStateDir()`;
- no dependency on trusted-official state APIs or private SDK imports;
- transactional, forward-only schema migrations with future-schema refusal;
- standard SQLite compatibility with OpenClaw's online archive snapshot process;
- plugin-owned integrity and restore validation;
- documented reinstall/update recovery for skipped dependencies;
- explicit beta.6 host and plugin API metadata;
- compiled JavaScript and focused documented SDK imports;
- a versioned, capability-based bridge handshake with safe degradation;
- an upgrade test matrix covering plugin, fork patch, database, backup, and restore; and
- a separately recorded permissive-license decision plus notice audit before public release.

These constraints preserve the intended product model: OpenClaw's normal backups cover Command Center state, while the plugin retains clear ownership of its schema and can survive host evolution without relying on private or official-only internals.
