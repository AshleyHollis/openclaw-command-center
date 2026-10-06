# Following Attention package qualification

This is a Class 3 successor to the withheld Attention implementation at
`0d4a5d03b582733d284a672b7bfc9adc09d4fce4`. That baseline and its package receipt
remain valid evidence of withheld exposure; they are not evidence that the new
public bill actions were exercised.

The successor enables only `billActions` and its six existing closed Gateway
methods: list, read, admit, handle, defer and reconcile. Notifications remain
disabled. The native prerequisite was implemented and independently reviewed at
`26a9c0faa4124e53ae2eab34291d68a7245f630c`, based on
`554d8353171d4db283bc3df2248ad6addf769968`. Source-owner tests are distinct from
installed package qualification. No Life activation or deployment is authorized
by this packet.

## Native producer and installation

The existing candidate-only `build-downstream-artifact.yml` runtime-package
owner produces the native archive and `package-candidate.json`; it neither
publishes nor deploys. Producer run 37398915447 selects the exact native commit
with `publish=false`. Admit its output only after successful completion and
verification of run, artifact, producer receipt and actual archive hash.

The producer completed successfully. Artifact `11384762617`, named
`nas-runtime-package-26a9c0faa4124e53ae2eab34291d68a7245f630c-37398915447-1`,
has authenticated envelope digest
`sha256:16257f4f7b5aeb858a10ecd5f5241283263cd34c8058e6005f1a9fce40ef8600`.
The producer receipt and measured native archive agree on
`sha256:e6203c9ba1d01d928f51cb71d7b4ecc77515fa6742f8168d9b5d8175610d6b36`,
OpenClaw 2026.9.8 and exact source `26a9c0f`. The successor's host tuple and
declarative mirrors bind that candidate, not the historical host package.

The native Git archive source digest is
`sha256:2a8ca43ffa1bf56a0ffea11165c73fd7cd7642dd7a50b59b62b12dd3d06f0be3`.
The unchanged runtime capability contract digest is
`sha256:ec170da6eb2bb116bcf6b60cfea795af5dfa41ed83762194526eff977fc52fb6`.
The archive, executable and installed-runtime digests must be measured from the
new produced/installed bytes. Historical 554d receipts cannot supply them.

Reuse the existing npm 12.0.1 strict-lifecycle installation owner with a new
candidate-specific manifest and actual generated lock, preserving its exact
archive layout and reviewed lifecycle allowlist. Then prove clean `npm ci`,
package version 2026.9.8, `dist/build-info.json.commit` equal to the native
candidate and absence of `.openclaw-lifecycle-pending`. Generate a new schema-v2
host receipt/descriptor with the existing `packagedHostDigest` owner. The
candidate tuple, source checkout, archive, installed identity and receipt must
agree before launching a Gateway.

## Installed fictional journey

Run the opt-in `test/attention-compiled-pair.test.mjs` with
`COMMAND_CENTER_ATTENTION_QUALIFICATION=1` and the admitted
`COMMAND_CENTER_ISOLATED_HOST` descriptor, from the measured successor package.
Supply `COMMAND_CENTER_ATTENTION_CC_ARCHIVE` and
`COMMAND_CENTER_ATTENTION_PACKAGE_RECEIPT` as absolute read-only input paths,
and `COMMAND_CENTER_ATTENTION_ADMISSION_ROOT` as a private writable Btrfs
directory. The existing artifact verifier extracts and verifies the archive;
that extracted package is the actual Gateway plugin root. The source checkout
and archive inputs remain read-only.
Browser qualification is required by default. Setting
`COMMAND_CENTER_ATTENTION_BROWSER=0` is an owner-only diagnostic and cannot
satisfy the browser claim.

The journey uses the installed intake CLI, authenticated public CC and
Workboard RPCs, actual SQLite owners, native Control UI and a real host restart.
Only fictional accepted email/Note evidence and isolated pre-existing Topic
setup are supplied. Native Workboard SQLite is never edited by the fixture.
The test covers unchanged retries, read-only refusal, explicit Later, Handled
remaining unpaid, a distinct accepted BILL-102 predecessor, correction conflict
and source disappearance. Browser evidence uses real Review, Later and Handled
controls and verifies Recent handled's conservative attribution. It does not
claim a deterministic compiled-host
queued-revocation barrier or deliberate lost-response proof; those remain
separately identified native source-owner evidence.

The coordinated runner owns scheduling: isolated Btrfs state, UID 1000, two
CPUs, 3 GiB memory, read-only inputs, no secrets, dropped capabilities and no
external network during the journey. Dependency preparation is separate from
network-isolated execution. Preserve failed/skipped outcomes and every exact
source, build, archive, runtime, contract and fixture identity.
