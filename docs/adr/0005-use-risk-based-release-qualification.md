---
status: accepted
---

# Use risk-based release qualification

On 2026-09-21 the user approved updating repository policy so Command Center can
deploy useful changes faster. The prior first-live policy required coherent
host, performance, independent evaluation, and protected admission for the
whole candidate. That was appropriate for the initial release, but applying the
same qualification to static UI changes and storage mutations delays feedback
without adding evidence about the changed behavior.

Use the three delivery classes in
[the release policy](../agents/release-policy.md). Presentation and read-only UI
changes use focused browser and installed-package proof. Compatible plugin
behavior adds its affected integration boundaries. Writes, recovery, schema,
source scanning, automation, host, and deployment changes retain protected
qualification.

The decision changes evidence selection, not mutation correctness. Mixed
changes inherit their highest class, and evidence may be reused only while all
identities and dependencies relevant to its claim remain unchanged. Personal
data and live automation actions remain separately authorized.

This decision supersedes ADR 0004's blanket release-gate requirement for later
Command Center releases. ADR 0004 still records the first-live product scope,
its transcript exception, and the fixed performance budget where performance
qualification is required.
