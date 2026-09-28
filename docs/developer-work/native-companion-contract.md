# Native Developer Work companion: pending host contract

This is a source preparation, not an enabled submission. The fixed package subpath
`openclaw-command-center/native-developer-work-companion` resolves to the built
`dist/developer-work/native-library.mjs`, not the plugin entry. It is an importable
library; merely importing it registers no tool, RPC, Cron job or CC runtime
plugin. The installation owner must pin its sealed artifact identity and must
not accept a module path, SQL, shell command, ledger path or authority from a
model/request. The existing `native-companion.mjs` continues to reject
`localSource` and exposes no `submit`.

The trusted installation owner calls `openInstalledNativeDeveloperWorkCompanion`
with its fixed state directory, source environment, producer ID, role and
allowed projects. The factory validates the scope, opens/validates the fixed CC
metadata ledger and closes it with the companion. Opening may initialize or
migrate storage, so it must finish **before** any host admission; it cannot
happen inside the final held callback. The owner must bind producer identity
to that environment/store across restarts, refuse policy drift under the same
identity without an explicit migration, and verify the exact built package
and compatible SDK identity. The companion's `check` and `chatTarget` are
read-only; the latter requires an exact work and request ID and rechecks the
current authenticated session incarnation. The read-only `reconcile` returns
only the same producer/operation/intent receipt, conflicts on changed intent,
and never falls through to submission.

After Main freezes the generic SDK contract, a maintained Gateway invocation
must own the authenticated caller and the **Gateway process's** authoritative
source selection. It must obtain the held host admission for trusted agent,
session key, session ID, lifecycle revision, selected source environment/store
and physical database owner. The CC adapter then constructs `draft.session`
from that binding (never a draft-supplied session), checks the fixed producer
and allowed project, and calls the synchronous `producer.commit` / owning
`metadata.submitDeveloperWork` inside the host's synchronous final callback.
The callback compares the normalized event session to the admitted binding,
may not await or return a thenable, and contains no flush/network work.
The host holds admission through the CC SQLite COMMIT; rejected stale state
must leave no new CC cursor, request or outbox row. Network delivery via
`producer.flush` happens later outside that section.

These are separate host and CC databases, not an atomic distributed transaction.
After an uncertain result, reconstruct the **original** canonical draft and
logical operation ID and call read-only reconciliation first. A matching row
is applied, absence is unknown/not-applied according to the proven failure
boundary and is not permission to silently execute; changed intent conflicts.
A post-commit loss of reply must not be reported as failure or retried with a
new ID. The final host implementation needs real Gateway invocation and
selection/reset/deletion-journal contention tests before enabling a submit
route. This file does not authorize deployment, personal-data reads, live
notifications or producer activation.
