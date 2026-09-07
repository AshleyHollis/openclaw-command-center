---
status: accepted
---

# Use native OpenClaw UI for the tactical MVP

On 2026-09-06 the user approved moving the MVP to OpenClaw 2026.9.2 and reusing its native Chat, Session navigation and native plugin UI wherever practical to reduce custom implementation and reach live use sooner. Native plugin UI may run as trusted same-origin code with the signed-in operator's authority; this explicitly replaces the previous iframe-only trust requirement for migrated views, not the host's authentication or authorization checks.

Prefer native pages/panels and host-owned Chat rather than another composer, transcript or Session roster. Retain Topic identity, authoritative Note ownership and safe recovery until a supported native replacement is proven; do not silently migrate or discard data. The old sandbox transport is retired only after its affected operations have a tested native path. Large Notes require a supported authenticated body transport, not an oversized native feature-action payload.

Strategic isolation, SDK stability and Topic/group architecture review is tracked in [#219](https://github.com/AshleyHollis/openclaw-command-center/issues/219), not a pending MVP approval. Tactical implementation is [#218](https://github.com/AshleyHollis/openclaw-command-center/issues/218), and coverage/fix/release work remains [#217](https://github.com/AshleyHollis/openclaw-command-center/issues/217). Keep desktop usability, explicit compatibility, exclusive performance qualification, final coherent acceptance, independent evaluation, backup/rollback and normal live-release admission. This decision does not make an unfinished migration or the existing live installation ready.
