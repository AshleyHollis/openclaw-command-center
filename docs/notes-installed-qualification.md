# Ordered Notes qualification inputs

This is a fixture-only readiness supplement. It consumes the existing immutable PR390 and PR391 archives; it does not replace their source identities or authorize installation in a live deployment. Production policy remains disabled. No NAS job or installed-host journey was run during preparation.

## Immutable inputs

| Mode | Candidate source | Artifact | Packaging run | Compiled gates |
| --- | --- | --- | --- | --- |
| proposals | eafd742937372efeb5c2bac44a1f4715bcc22a3f | 11652068501 | 38009750667 | proposals true; recall/capture false |
| recall | b2e1b213c8fea5720967f6daa39d530816c34608 | 11652879526 | 38010569250 | proposals/recall true; capture false |

Full ZIP/TGZ/build hashes are pinned in `test/fixtures/notes-qualification-artifacts.json`. Both artifacts were independently audited against every232 receipt files. Their GitHub Actions expiry is October24, 2026; fetch and retain the exact files before then, or obtain a verified immutable mirror from the release owner. Recheck artifact availability before the reserved qualification slot. Superseded child archives and PR383/384 alternatives are not inputs.

Cumulative ancestry is verified: compatibility d3f3295ffa736b3010b46986126034c0b8a6a812, capture c0ceacd1100843fa5db1c0f2f5cbb12b231341de, disabled Notes04ea76a3963c0baf1b26f09c55513136897d9836, disabled Recall286f82260a33273568bee6855799e94a625c156d, PR390, then PR391. Both contain all disabled capture source from c0ceacd; enabled capture PR389/63ceca9 is TEST-only and is not a production predecessor. This proves source composition, not installed storage or activation compatibility with an unrelated feature package.

## Download once, reuse unchanged archives

In the existing operations input directory, use an authenticated `gh` session for AshleyHollis/openclaw-command-center. `INPUT_ROOT` is the owner's private absolute directory, not a live plugin/state mount. Keep ZIPs plus extracted receipts/TGZs unchanged. Commands below only retrieve public project artifacts; do not run host commands while the slot/carrier is unavailable.

```sh
set -eu
umask 077
mkdir -p "$INPUT_ROOT/notes" "$INPUT_ROOT/recall"
gh api repos/AshleyHollis/openclaw-command-center/actions/artifacts/11652068501/zip > "$INPUT_ROOT/notes.zip"
printf '%s  %s\n' 76b6e7fb7a8ed7f5dce630afbd4c1da6a9034986b3378b1f16f0b0fe760e5c2f "$INPUT_ROOT/notes.zip" | sha256sum -c -
unzip -n "$INPUT_ROOT/notes.zip" -d "$INPUT_ROOT/notes"
gh api repos/AshleyHollis/openclaw-command-center/actions/artifacts/11652879526/zip > "$INPUT_ROOT/recall.zip"
printf '%s  %s\n' af7072c7fc876363640eab5e13b7e2452cfd1d75184b1854e63aa9957faea965 "$INPUT_ROOT/recall.zip" | sha256sum -c -
unzip -n "$INPUT_ROOT/recall.zip" -d "$INPUT_ROOT/recall"
```

The installed runner additionally pins receipt source/build/TGZ identities, verifies all archive members through the existing verifier, checks the native tuple and compiled gates, and admits only those original packages. Candidate paths or receipt JSON cannot select a new build.

## Reserved-slot execution after the current release

Owner/dependencies: the shared release/qualification owner supplies the repaired carrier path, the reserved serial slot, and its measured native9.9 host descriptor. It must match ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2, the independently verified wrapper/source/runtime/package integrity, and the existing qualification profile. Use Node24.21.0, the existing exact pinned9.9 SDK dependency cache and existing Chromium. Do not install a second SDK/native runtime, invent a descriptor, add grants, or inspect live state.

Use one fresh disposable checkout of this supplement's exact reviewed head, with the existing dependency cache bound as in the operations owner. This checkout supplies test drivers only. The runner exclusively stages the selected archive's audited `dist` when absent, verifies it through `readBuiltReceipt`, and removes only its own unchanged staged directory on completion. Existing mismatched/symlinked output refuses; it is never overwritten. No build command is needed. Native launches still use the existing isolated world/host lifecycle owners.

```sh
set -eu
test -z "$(git status --porcelain --untracked-files=no)"
export COMMAND_CENTER_NOTES_FIXTURE_REVISION="$(git rev-parse HEAD)"
export COMMAND_CENTER_ISOLATED_HOST="$(cat "$MEASURED_HOST_DESCRIPTOR")"
export COMMAND_CENTER_NOTES_ADMISSION_ROOT="$PRIVATE_ADMISSION_ROOT"
# PRIVATE_ADMISSION_ROOT must already exist, owned by runner, mode0700.
export COMMAND_CENTER_NOTES_INSTALLED_MODE=proposals
export COMMAND_CENTER_NOTES_TEST_ARCHIVE="$INPUT_ROOT/notes/command-center.tgz"
export COMMAND_CENTER_NOTES_TEST_RECEIPT="$INPUT_ROOT/notes/receipt.json"
export COMMAND_CENTER_NOTES_EVIDENCE_PATH="$PRIVATE_ADMISSION_ROOT/notes-evidence.json"
node --test test/notes-installed-package.test.mjs

```

Run this second block separately after the preceding command succeeds and its evidence is reviewed:

```sh
set -eu
export COMMAND_CENTER_NOTES_INSTALLED_MODE=recall
export COMMAND_CENTER_NOTES_TEST_ARCHIVE="$INPUT_ROOT/recall/command-center.tgz"
export COMMAND_CENTER_NOTES_TEST_RECEIPT="$INPUT_ROOT/recall/receipt.json"
export COMMAND_CENTER_NOTES_EVIDENCE_PATH="$PRIVATE_ADMISSION_ROOT/recall-evidence.json"
node --test test/notes-installed-package.test.mjs
```

Evidence paths must be new files immediately inside the private admission root. Reports contain pinned artifact identities, measured host integrity digests, operator-declared supplement head and actual hashes of fixture/shared-owner inputs, fixed case outcomes and pass/fail status; no credentials, configuration, Note bodies, transcripts, generated Session identities or filesystem paths. Do not reuse/overwrite an earlier evidence file. A failure records only completed cases; it cannot qualify a package. Source tests and packaging CI are not installed results.

## Prepared cases and remaining gates

Both packages: actual operator RPC preparation/context/publication/inspection/discard across three restarts; byte preservation; actual read-only caller refusal; stale source/target retirement with private fields removed and target retirement retained after restart and both retired snapshots still absent after original bytes are restored; actual permission loss and recovery; browser preparation, comparison, recovery and discard with target/source byte checks.

Recall additionally: actual native model exposure of the narrow optional tool, exact trusted Session handoff, matching root/nested Notes indexed in two Topics, exact same-Topic two-source excerpts/citation ranges, fresh native tool call after restart, permission-loss partial result that omits the denied Note and recovery, actual answer citation into the exact Topic reader, and mounted Chat draft bytes/caret retained. Stale citation uses explicit All Topics navigation to create a fresh reader mount; repeated identical route clicks alone promise no reread.

Pending installed gates (qualification owner): every prepared case above must pass on the measured9.9 pair and its immutable artifacts. Existing real-owner source tests cover cancellation, Session reset/reassignment, folder replacement and changes across awaits; forcing those races through native requires separate installed evidence before making installed concurrency claims. Production-model citation formatting and non-root Control UI base paths remain a native/CC contract seam for the parent coordinator; the controlled loopback provider proves only the supported root-path fixture. Exact in-chat Files selection has no supported API and remains deferred. The supported destination is the existing Dashboard Topic reader.

Final release owner gates: independent installed evaluation, matching host/performance/failure evidence applicable to Class3, backup/rollback/GitOps admission, and explicit activation decision. Existing permanent filing/Workboard qualification is separately owned. This supplement changes only test fixtures and documentation; no production source, native contract, platform indexing or deployment policy changed.
