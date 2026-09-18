# OpenClaw upgrade PR review — 2026-09-13

Planning research only. No host, plugin, or live deployment changes were made. Status was checked using the official GitHub REST API on 2026-09-13; PR heads and branches can move. API responses were preferred over cached web pages, which showed an outdated open state for #146770.

## Decision summary

The strongest direct candidates are native history efficiency (#146770) and selected-Chat startup ordering (#146591). Neither is proved to fix Command Center's current failure. Workboard changes affect Workboard's database, and the scheduled-delivery fix concerns Doctor normalization, not the plugin scheduler admission contract. Upgrade qualification must still exercise the exact Command Center owners and packaged source.

Do not apply this list as ten independent cherry-picks. Choose a pinned upstream base, establish which changes or equivalent implementations it already contains, and retain only necessary local host contracts. The two substantial merged performance changes need a dependency review before promising a small stable-release backport.

## Verified status and scope

| PR | API status | Verified commit | Assessment for this delivery |
| --- | --- | --- | --- |
| [#146770](https://github.com/openclaw/openclaw/pull/146770) | Merged | `0ee35030ae2d52570c5e1e29f00306b6d633797c` | High relevance to native history polling, directional reads, recovery windows and stable cursors. Prefer upstream implementation if compatible with the selected base. |
| [#146976](https://github.com/openclaw/openclaw/pull/146976) | Open, not draft | Head `f38b5bda0b356242c3da26c49ea15b76c917eaf0` | Defer unmerged port. It moves **Workboard** SQLite to the existing worker transport; it does not move Command Center's own SQLite work. |
| [#146591](https://github.com/openclaw/openclaw/pull/146591) | Merged | `b023df80868e38048a7fdcb2ba028905ac95c387` | High native Chat startup relevance. Broad lifecycle change; not a small request-order patch. |
| [#146748](https://github.com/openclaw/openclaw/pull/146748) | Merged | `d13b0dbc57f9ac1104ea4e6a3651686f62d58ad8` | Useful for Workboard card notification reads. Low direct value to currently scoped Notes/filing/maintenance unless those Workboard operations are on the measured path. |
| [#146672](https://github.com/openclaw/openclaw/pull/146672) | Merged | `65c8b06f2e42f4788d45da3b5573a761ddaf58fd` | Useful native file tabs and HTML preview primitives. Does not replace Topic folder ownership, the authorized Notes explorer, or the agreed Reading view. |
| [#145409](https://github.com/openclaw/openclaw/pull/145409) | Open, draft | Head `5c2f1e61ccb842da896e4769bbe8c626a83abeee` | Narrow plugin theme fix; consider only if the upgraded candidate demonstrably has the mismatch and lacks an equivalent. Requires plugin consumption and focused browser proof. |
| [#146794](https://github.com/openclaw/openclaw/pull/146794) | Merged | `a614d683949b84e621d8aa6e3384bbf13d02dd21` | Protects `current` automation delivery targets during Doctor repair. Relevant to upgrade migration; not a new plugin scheduler API. |
| [#146715](https://github.com/openclaw/openclaw/pull/146715) | Open, not draft | Head `3fd85d77463b351499a08dab9192baafe070446e` | Defer unless current scope actually uses CLI-backed collector subagents with `outputSchema`. Future Topic Analysis relevance is not a release dependency. |
| [#145950](https://github.com/openclaw/openclaw/pull/145950) | Open, **not draft** | Head `f7279d8efc901e9437e1ee7867f20c01e6aaf2ac` | Defer. Shared authenticated connection lifecycle is an architectural extraction with no intended UI behavior change. |
| [#146702](https://github.com/openclaw/openclaw/pull/146702) | Merged | `49c3d463e19f589d4669d628a402fac3cad07ffe` | Future shared-browser interaction. Do not add a dashboard feature to this delivery. If already in the chosen upstream base, retain normal upstream behavior. |

For unmerged PRs, GitHub's `merge_commit_sha` may describe a provisional test merge; it is not evidence of landing. The table therefore records their head SHAs.

## Exact release ancestry

Compared merge commits against published v2026.9.4 at `3a9d69db306cd7f081e06254cb89c4bcc14a7107` and release/2026.9.5 at `c6676cb59b2723a62c1281669508994d92f8f7d7`.

| Merged change | v2026.9.4 contains merge commit | release/2026.9.5 contains merge commit |
| --- | --- | --- |
| #146770 | No | No |
| #146591 | No | No |
| #146748 | No | Yes |
| #146672 | No | No |
| #146794 | No | No |
| #146702 | No | No |

All negative comparisons returned `diverged`, not `ahead`/`identical`. The release branch is five commits ahead of #146748; its other compared merge commits diverge from that same merge base. The five release-only commits concern release preparation, translations and provenance, but commit ancestry alone does not rule out an equivalent backport. Check affected source before applying any patch. [Stable comparison example](https://api.github.com/repos/openclaw/openclaw/compare/0ee35030ae2d52570c5e1e29f00306b6d633797c...3a9d69db306cd7f081e06254cb89c4bcc14a7107), [release comparison example](https://api.github.com/repos/openclaw/openclaw/compare/0ee35030ae2d52570c5e1e29f00306b6d633797c...c6676cb59b2723a62c1281669508994d92f8f7d7), [release-only commits](https://api.github.com/repos/openclaw/openclaw/compare/d13b0dbc57f9ac1104ea4e6a3651686f62d58ad8...c6676cb59b2723a62c1281669508994d92f8f7d7).

## Dependency and compatibility assessment

- **History:** #146770 changes 21 files around the existing session-history owners; v2026.9.4 already has the SQLite history-events module. The final PR was rebased onto canonical main fixes and dropped duplicate prerequisite repairs. Its evidence explicitly does not establish whole-browser or cold-open speedups. A source compatibility/dry-run check is still needed; a clean application alone is insufficient. [PR files](https://github.com/openclaw/openclaw/pull/146770/files), [stable module metadata](https://api.github.com/repos/openclaw/openclaw/contents/src/config/sessions/session-accessor.sqlite-history-events.ts?ref=3a9d69db306cd7f081e06254cb89c4bcc14a7107).
- **Startup:** #146591 changes 80 files and preserves the managed child-query lifecycle introduced by #146410. That prerequisite's merge `1ccb3e114fe3365be5ceb2c23381d4b954a257ce` is not an ancestor of v2026.9.4, but **is** an ancestor of the inspected release/2026.9.5 (147 commits ahead, zero behind). This gives 9.5 better demonstrated prerequisite alignment for #146591, without proving clean application or release qualification. Do not promise a cheap stable backport; inspect the selected base's roster, connection admission, cache, descriptor and reconnect owners first. Do not recursively import unrelated main history just to make it apply. [PR files](https://github.com/openclaw/openclaw/pull/146591/files), [#146410](https://github.com/openclaw/openclaw/pull/146410), [prerequisite/stable comparison](https://api.github.com/repos/openclaw/openclaw/compare/1ccb3e114fe3365be5ceb2c23381d4b954a257ce...3a9d69db306cd7f081e06254cb89c4bcc14a7107), [prerequisite/release comparison](https://api.github.com/repos/openclaw/openclaw/compare/1ccb3e114fe3365be5ceb2c23381d4b954a257ce...c6676cb59b2723a62c1281669508994d92f8f7d7).
- **Workboard worker:** 39 changed files include a shared SQLite broker close/drain change. Qualification must cover other broker clients as well as Workboard lifecycle, package worker entrypoints, Doctor, backup/restore and peer stores. At last check the head had advanced from the body’s qualified `9368d922` to `f38b5bda`; current CI was in progress. Earlier package evidence is not proof for the new head. [Changed files](https://github.com/openclaw/openclaw/pull/146976/files), [current-head checks](https://api.github.com/repos/openclaw/openclaw/commits/f38b5bda0b356242c3da26c49ea15b76c917eaf0/check-runs).
- **Doctor target preservation:** #146794 is a three-file normalization correction. Already-damaged `isolated` jobs are not automatically restored and disabled jobs are not enabled. Prefer this migration protection when the selected base lacks it and the actual Doctor path contains the defect; preserve a sanitized before/after repair regression. [Change](https://github.com/openclaw/openclaw/pull/146794/files).
- **Theme:** #145409 adds frame registration to the existing semantic theme owner, sends after load, and unregisters replaced/disconnected frames. It retains opaque-origin sandboxing. It does not confer capabilities or fix scheduler/tool registration. Unit and standalone browser evidence exist, but the canonical E2E and independent review were not completed according to the PR. [Source patch](https://github.com/openclaw/openclaw/pull/145409/files).

## Native previews are useful primitives, not a Topic ownership replacement

#146672 adds tabs managed by the existing session-workspace owner. File HTML uses a read-only Canvas preview RPC with a 256 KiB UTF-8 cap and the existing separate-origin sandbox. Default sandboxed HTML can execute inline JavaScript; that is a different rendering policy from conservative Topic Markdown. The native docs distinguish formatted **Markdown attachments** from workspace text files shown in CodeMirror. Formatted attachment Markdown existed before this PR. New tabs are transient across reconnect and scoped to the session, agent and connection. [Native Chat documentation and source changes](https://github.com/openclaw/openclaw/pull/146672/files).

The source adds internal Lit components/controller methods, not a declared external-plugin Topic-file resolver API. Therefore retain Command Center's verified Topic/reference/path/revision boundary and current agreed reader. Reuse native pane promotion and layout. Any future native-preview integration must demonstrate a supported adapter, same document identity, stale-read cancellation, permissions, and the agreed Reading/Source behavior before retiring code. A duplicate file copy or session workspace path mapping is not ownership proof.

## Connection to current Command Center code

`src/plugin-service.mjs` obtains `readVisibleSessionTranscriptMessageEntries` from the native transcript SDK for linked-session reads and constructs a separate preserved-history reader. `src/migration/preserved-history-destination.mjs` uses `readSessionTranscriptVisibleMessageDelta` while verifying a complete reserved imported destination. Thus native history optimizations can benefit native-backed paths, but do not eliminate Command Center's own full verification loops or prove faster legacy-source reads. Measure the actual retained history route on the candidate.

No listed PR makes a stale packaged module match the integration source. Before interpreting the next runtime failure as missing upstream functionality, compare a complete source manifest with the package and record a single candidate identity. Keep this source-transfer correction separate from claims of product improvement.

## Terra handoff gates

1. Pin and record base SHA; refresh PR status once at admission, then freeze inputs.
2. Classify each local host delta as already upstream, still required, obsolete or deferred; retain source-specific authorization contracts.
3. For each proposed backport, inspect dependency closure and test relevant upstream contracts. If the required closure is broad, stop that backport and choose the documented fallback rather than expanding this delivery automatically.
4. Keep open/draft PR experimentation off the deployment path. Do not import preview/dashboard/collector features simply because upstream now has them.
5. Qualify current plugin reader, exact Conversation navigation, native upload/filing, working-Note tool, completion scheduling and recovery on one source-matched candidate. Preserve normal auth, identity, data, and backup/rollback requirements.
6. Report native history and startup changes as candidate benefits until measured on the actual retained paths. Do not credit fixes for Workboard as fixes for Command Center SQLite, or Doctor normalization as plugin scheduler support.
