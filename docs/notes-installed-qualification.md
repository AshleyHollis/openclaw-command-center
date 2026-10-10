# Ordered Notes qualification candidates

These branches are isolated TEST builds, never production deployment candidates. The disabled cumulative source is capture `c0ceacd1100843fa5db1c0f2f5cbb12b231341de` → review Notes `04ea76a3963c0baf1b26f09c55513136897d9836` → recall `286f82260a33273568bee6855799e94a625c156d`, on reviewed native 9.9 compatibility `d3f3295ffa736b3010b46986126034c0b8a6a812`.

The first TEST package contains this entire cumulative source, enables `noteProposals` only, and leaves `topicNoteRecall` and `acceptedChatCapture` false. Its child TEST package preserves every preceding change and enables `topicNoteRecall` as well. Existing PR383/384 archives are alternatives from before capture composition; they must not be installed sequentially over the capture candidate. Every archive remains unqualified until its own installed journey passes.

## Exact installed command

Run serially in the existing isolated qualification slot, first from the exact Notes TEST checkout, then from the exact child Recall TEST checkout. Use each checkout's independently audited CI archive and receipt. Reuse the qualification owner's measured native 9.9 host descriptor, existing dependency cache and Chromium; no new SDK/native installation or NAS access is authorized by this document.

The following environment values must be supplied by that owner; paths must be absolute. The admission root must be an existing private directory owned by the runner, mode 0700. `COMMAND_CENTER_ISOLATED_HOST` is the JSON descriptor issued by the host measurement owner, with native commit `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`, version 2026.9.9 and the verified wrapper/runtime/build identity. Never synthesize a descriptor to bypass admission.

```sh
export COMMAND_CENTER_ISOLATED_HOST="$(cat "$MEASURED_HOST_DESCRIPTOR")"
export COMMAND_CENTER_NOTES_TEST_ARCHIVE="$AUDITED_TEST_ARCHIVE"
export COMMAND_CENTER_NOTES_TEST_RECEIPT="$AUDITED_TEST_RECEIPT"
export COMMAND_CENTER_NOTES_ADMISSION_ROOT="$PRIVATE_ADMISSION_ROOT"
export COMMAND_CENTER_NOTES_INSTALLED_MODE=proposals # child TEST checkout: recall
node scripts/build.mjs
node --test test/notes-installed-package.test.mjs
```

Use Node 24.21.0 and the exact pinned native 9.9 SDK dependencies from the audited build environment. The runner verifies current `dist` against the audited build digest and verifies the archive again before launch; a digest mismatch is a refusal, not permission to substitute a local artifact. No installed run has been performed while preparing these fixtures.

## Journey and limits

The explicit runner reuses existing archive admission, disposable world, host restart, authenticated RPC, browser transport guard and fictional model owners. Notes review prepares, reloads/restarts, compares, recovers and discards; every step must preserve target and selected source bytes. There is no Apply/write path. Recall adds matching root/nested fictional Notes in two Topics, publishes only fixture projections while the host is stopped, then uses the real native Chat tool path. It validates bounded fresh exact excerpt ranges and Topic identity, clicks the actual answer citation into the Topic reader, retains unsent Chat text/caret, and verifies an old citation refuses the changed source revision.

The loopback fictional provider formats a supported `/plugin` root-path link from the actual tool result. This qualifies that fixture route only. Production model citation formatting and arbitrary Control UI base paths still require explicit integration evidence; a JSON navigation descriptor alone does not prove a model will emit the correct link. Exact in-chat Files selection has no supported native API and is deferred; the existing Dashboard Topic reader is the supported destination.

Source tests cover cancellation, Session reset/reassignment, folder replacement, permission loss, changes across awaits, bounds and exact citations. They do not replace installed host/UI evidence. Record test head, archive SHA256, build digest, measured host identity, command/result and browser evidence together. Activation stays disabled until installed qualification, independent final evaluation and release-owner approval.
