# Command Center persistence

Command Center owns exactly one SQLite metadata database at:

```text
<OpenClaw resolved state directory>/plugins/command-center/metadata.sqlite
```

The persistence service requires that resolved directory as an explicit input. In production, Command Center registers the pinned OpenClaw `registerService` lifecycle and receives its resolved `stateDir` there. It never discovers state from the working directory, home directory, configuration, or a running Gateway.

The database holds only Command Center metadata: Topic identity and PARA classification, opaque Source References, convention and presentation state, Attention/Activity links, Structural Change Proposal state, policy versions, migration ledger data, and rebuildable projection structures. Authoritative Note contents, Session contents/history, and scheduler definitions stay in their owning systems.

Migrations are ordered, forward-only transactions. If a declared destructive migration is ever added, the service requires a receipt verified by OpenClaw's normal broad-archive bridge before executing any migration statement. The pinned SDK currently exposes no public receipt bridge at the plugin-service lifecycle, so the deployed bridge explicitly rejects destructive migrations until that host contract is available. Command Center does not create a backup format or down-migrate. Recovery diagnostics direct operators to a verified broad-archive snapshot and the prior compatible plugin release.

Initialization is closed by default. Only a full validation pass (SQLite integrity, durable constraints and indexes, Source Reference invariants, migration state, supported schema and policy versions, plugin build, and archive-bridge protocol) enables metadata mutations. Missing optional projections produce Degraded mode and can be rebuilt from durable metadata; a durable validation failure produces Recovery-only mode.
