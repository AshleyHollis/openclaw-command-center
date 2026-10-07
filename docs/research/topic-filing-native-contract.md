# Accepted original publication contract adaptation

This Class 3 successor starts at PR373 ec355caaa94c3662d761346ecb59f30fabd462e9.
It consumes native PR67 a20ac2967ee3786475ae55b612513868ea261a86's public
session-transcript-runtime attachment admission v1. All feature flags remain
false. Compatibility pins and deployment are unchanged; this is source candidate
preparation, not matching-host release qualification.

The existing authenticated request runtime optionally binds the actual SDK
prepareAcceptedSessionAttachmentAdmission to its captured principal, grants and
request frame. It passes exact Session, accepted entry, generation, media index
and canonical media reference. The option is build-owned and cannot come from
HTTP JSON. Missing v1 support leaves File unavailable; no read-snapshot fallback
or consumer media locator is supplied.

Native owns source preparation, retained original bytes, source writer admission
and original-media exclusion. Its publish(syncEffect) settles asynchronously.
The host file effect runs synchronously before the worker's commit grant, while
source writer and media custody remain held. The existing CC Note exclusion and
verified Folder witness span staging, awaited publication and causal recovery.
CC's final callback still checks its original Topic/Folder/native Conversation
and authenticated request; no native source lock is used as Topic authority.
Real-owner integration must prove the synchronous Session readback works while
the native source worker waits for this callback.

Review and original preparation are bounded to 5 MiB. File stages only the native
owner's copied original, after comparing originalDigest, sizeBytes and copied
digest to the frozen intent. The former consumer reread at File is removed.
Historical internal v1 recovery retains its existing separately bounded path.
There is no native 100 MiB override. Changed bytes are a conflict, never an
updated original intent.

Note create awaits publication while keeping its synchronous effect callback
active. The callback consumes once before checking the retained destination and
linking the staged original without replacement; settlement expires it. Native
custody closes on every exit, and combined cleanup failure preserves the original
error as a cause. A publication error's not-entered/entered/completed state is
diagnostic; it never authorizes a receipt, retry or deletion. The existing
publication-attempting Note journal precedes the link. A lost response after
publication preserves original causal inode proof for Check result. Completion
still requires the existing causal Note fence and atomic binding/receipt
transaction. Private result delivery remains inside that owner fence.

The real SDK suite seeds accepted transcript facts and an isolated original
media file, then calls the existing filing/Note/metadata owners through actual
native admission. It covers source writer exclusion during the effect, native
Session readback, principal/Session/media retirement after staging, receipt,
Check/reopen, and simulated response loss after actual native settlement. The
existing filesystem identity fixture makes this an ext4 CI owner integration,
not Btrfs crash qualification or an actual composer-upload journey.

Ordinary CI retains the pinned26a9 SDK and proves the unchanged disabled package
plus adapted CC owner tests. The package workflow can additionally consume one
exact PR67 artifact using all three native_run/native_artifact/native_sha256
dispatch inputs. It verifies tarball digest and packageSourceSha against a20ac296
before running the real admission suite in the existing bounded networkless
container. No alternate source checkout, fake API or fallback artifact qualifies
that suite. Packaged PR67 build/type/IPC evidence and matching-host F1-F3 journey
remain prerequisite evidence. The broader feature remains disabled.
