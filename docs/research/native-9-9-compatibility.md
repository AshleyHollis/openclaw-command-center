# Native 2026.9.9 compatibility carrier

This compatibility-only successor starts from the deployed Command Center
`018f4aa10a52c1122f0f045063034dbef05e9d05`. It retains that complete feature
composition, schema9, bridge protocol1, declared routes and disabled feature
defaults. It does not include changes from the diverged main branch.

The supported host is exactly native
`ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`, version2026.9.9, with package
SHA256 `acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470`.
Peer/development packages and plugin API admission are exactly2026.9.9; no
wildcard or open-ended version range is introduced. All13 consumed public SDK
subpaths retain their export targets. Three entrypoints change additively:
Control UI navigation, gateway dispatch and visible transcript projection.
The existing call forms remain supported; new APIs are not adopted here.

The committed9.8/26a9 schema9 recovery family is frozen independently of the
new canonical release. Existing committed/coherent-family checks still reject
prepared, mixed, unknown, tampered or incompatible material without rewriting
the database, snapshot or manifest. Earlier9.5/9.7 families remain supported.

This is Class3 under the repository release policy because host/API and recovery
admission identities change. The existing safety and candidate-package workflows
use Node24.21.0, satisfying the9.9 package's Node24.16+ requirement. Packaging
retains its fixed container image, network isolation, read-only mounts and
resource limits, with the pinned Node executable mounted read-only. Its actual
installed public SDK dependencies come from this candidate's frozen npm lock.
The package workflow also runs the affected compatibility, recovery, schema,
native mismatch and host descriptor suites. Its archive receipt records the
exact candidate source, archive SHA256, build digest and compiled file inventory.

Reusable preparation inputs are this successor's exact source commit, frozen
package-lock, native EA package identity above, existing package-candidate
workflow and its identified archive/receipt. Later batches should start from
the reviewed merged successor and retain these owners, rather than independently
repinning9.9 or adding another release framework. A changed dependency or owner
still requires its affected checks and a package for that changed source.

Installed qualification belongs to the sole release operations owner. It needs
the exact9.9 image/source/runtime descriptor, actual installed schema/recovery
inventory, verified backup and rollback, plugin startup and native UI journey,
and the applicable measured scenario under the existing performance policy.
Historical9.5/9.8 host and performance receipts remain historical; this source
carrier does not relabel them as9.9 proof. Source checks, dependency resolution,
independent review and archive production can be prepared before installation;
real-data, serving/browser and restart/rollback observations require that owner's
isolated installed-host preparation or coordinated Life acceptance. No producer
activation, credential grant, source-state migration or production operation is
authorized by this source package.
