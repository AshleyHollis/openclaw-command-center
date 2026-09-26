# Topic provisioning external-effect recovery

Conditional Topic provisioning reserves one operation, Topic ID, folder path,
Primary Session key, Session ID, lifecycle revision, and creation timestamp in
SQLite before external effects. The legacy Topic creation route lacks those
durable native Session witnesses and refuses created-Session cleanup.

## Native owners reused

- `openclaw/plugin-sdk/session-store-runtime` `getSessionEntry` and
  `patchSessionEntry` create and inspect the fixed Primary row. Creation uses
  `replaceEntry` only under an absent-row commit guard so the SQLite receipt's
  exact `sessionUpdatedAt` survives process death.
- Gateway `sessions.delete` owns Session termination, transcript and runtime
  cleanup, lifecycle hooks, and worker retirement. Command Center supplies
  `expectedSessionId`, `expectedLifecycleRevision`,
  `expectedSessionUpdatedAt`, `requireEmptyHistory: true`, and
  `deleteTranscript: true`. The Gateway requires `operator.admin` for this
  active-Session delete. Its SQLite owner rejects prior generations, archived
  or cold transcript state, transcript and trajectory events, and ACP stream
  events before commit. A plugin subagent deletion helper does not provide
  these exact lifecycle guards.
- `openclaw/plugin-sdk/file-access-runtime` exposes
  `publishDurableDirectoryNoReplace`, backed by the pinned
  `@openclaw/fs-safe/atomic` native no-replace rename. It checks the staged
  directory identity and syncs the parent. The existing durable marker stager
  and Btrfs identity reader provide the prepublication folder witness.

## Command Center guards and checkpoints

`src/metadata/provisioning-primary.mjs` owns the operation receipts. The folder
receipt records `prepared`, `identified`, and `published` with the exact stage
and final paths, Btrfs directory identity, and marker identity. Only an
identified folder can be published or removed. A matching pathname alone
never grants ownership; a pre-existing folder is adopted.

`src/topics/provisioning.mjs` starts rollback only for a provisioning Topic and
the original operation and revision. It compares the native Session key, ID,
lifecycle revision, timestamp, and plugin owner before asking Gateway to
delete. The Gateway performs the atomic empty-history check. SQLite records
`prepared`, `session-cleared`, `folder-cleaning`, and `folder-cleared` before
final `not-applied` completion. The folder is removed only after Session
cleanup, only when its physical witness matches, and only when it contains its
identity marker and no other entries. A restart resumes from the checkpoint.

## Proof and limits

Focused SQLite tests reopen the metadata database at each checkpoint. On an
isolated Linux Btrfs volume, child-process SIGKILL tests passed immediately
before folder publication, after final directory publication but before the
metadata receipt, and after native Session creation but before activation.
Native fs-safe tests passed for exact publication, occupied destination,
replaced stage, and revoked authority. Separate Linux Btrfs child-process
tests passed after the `session-cleared` SQLite checkpoint and after marker
unlink during `folder-cleaning`. Those rollback tests use a host capability
fixture and start with no Session; they prove checkpoint and folder order,
while native Session deletion is covered by the OpenClaw Gateway tests and is
not yet proven as one installed end-to-end journey.

The current plugin release pin does not contain these candidate OpenClaw SDK
changes. This source work is not a release or deployment. An unrecorded staging
directory left by a crash before its physical identity receipt fails closed;
it is not adopted or deleted. Directory cleanup checks identity around its
marker unlink and empty-directory removal under the Note filesystem owner,
but POSIX does not provide an atomic compare-and-remove of a directory inode
against a concurrent same-privilege namespace writer. Such interference must
be resolved as Source Recovery. No live Gateway or user data was used in tests.
