# Exact package qualification through the existing workflow

This change is Class 3 under [release policy](agents/release-policy.md): it changes
the package and installed-host admission path used by release qualification.
Its focused checks cover package bytes, producer provenance, host identity and
the two source commits. The full installed-host scenario and independent final
review remain required on the exact candidate before a release claim.

The reusable call to `capture-release-performance.yml` accepts an exact
Command Center harness commit. The worker checks out that commit and records
its actual `git rev-parse HEAD` as the qualification source. The product source
commit is separately bound by the retained package receipt and the produced
candidate identity. In a reusable workflow, the Actions `GITHUB_SHA` identifies
the caller, so it cannot stand in for either of those identities.

The caller supplies a completed assembly run, attempt, reviewed assembly source
commit, and SHA-256 digests for the retained plugin archive, package receipt,
installed-host identity and host provenance. The workflow downloads the named
artifact using the caller's scoped Actions token. It checks the run's repository,
workflow path, source commit, attempt, completed status and successful conclusion,
then checks the input bytes before selecting the immutable image and schema-2
host receipt. The caller must grant `actions: read` for its own artifact; the
workflow does not acquire credentials for another repository.

The worker runs `npm ci` for test dependencies and installs Chromium, but does
not rebuild the plugin in the reusable-call lane. That lane copies only `dist`
from the verified archive into a pristine checkout after checking every member
and the existing root manifests. Historical direct dispatch retains its build
and its original frozen host identity. It verifies the retained archive and every packaged
member against the sealed `dist` tree, then executes the existing Ubuntu 24.04,
4 GiB Btrfs, serial acceptance scenarios. Qualification slices record the
actual harness checkout. The final receipt also records the distinct frozen
product source. Historical performance fixture bytes and numerical budgets
remain unchanged.

A missing assembly artifact, produced installed-host identity, schema-2 receipt,
or independently pinned identity digest stops admission. Local unit fixtures
exercise rejection behavior only; they are not release receipts.
