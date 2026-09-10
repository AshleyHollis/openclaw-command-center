# Release performance budget policy

## Native workspace update measurement (2026-09-10)

The native workspace update uses a separately named
`release-performance-baseline.native-workspace.v3.json` for its own exact host
and plugin measurements. That artifact does not exist until actual capture;
missing evidence must fail qualification. The original v3 file below remains
byte-for-byte unchanged and is not relabelled with the new candidate identity.
The supervised update must additionally compare both its measured run and final
coherent capture against the original eight fixed budgets below. A new candidate
measurement cannot raise those limits or turn an earlier failure into a pass.
This is release-specific measurement bookkeeping, not a new performance policy.

Decision date: 2026-09-08. The integration owner selected the rule below under
the user's explicit approval to replace the near-zero-tolerance release ceiling
with a documented, bounded allowance. This decision precedes new qualification
measurements. It changes the acceptance policy, not the original observations.

## Evidence and its limits

The retained [baseline v3](../../test/fixtures/release-performance-baseline.v3.json)
records one first successful pinned-harness observation per metric. Its historical
thresholds are the ceilings of those observations. Startup is
10664.691814999998 ms with a 10665 ms ceiling: approximately 0.308 ms of headroom.
That rounding rule documents the original measurement accurately, but it does
not estimate repeatability. One observation cannot establish sample variance,
percentiles, confidence intervals, or the probability of a future gate failure.
The reported later startup overrun has no retained actual value available to this
decision; neither its size nor its cause is inferred here.

Chrome's official Lighthouse guidance identifies browser nondeterminism even in
controlled labs, warns that concurrent measurements introduce resource
contention, and recommends repeated measurements and aggregates when setting
failure thresholds. This supports preserving exclusive execution and collecting
repeatable evidence. It does not establish the variance of this repository's
custom native journeys. [Lighthouse score variability](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)

Lighthouse CI separately defines collection count and assertion aggregation,
including median, optimistic, and pessimistic strategies. This supports making
the gate's observation-selection rule explicit rather than choosing a favorable
result afterward. [Lighthouse CI configuration](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md)

Google's budget guidance treats a budget as an explicit set of limits that informs
engineering decisions and is enforced during development. Its examples depend
on the tested experience and environment. Its separate 20% example concerns
an improvement target; it does not prescribe a 20% regression allowance. None
of these sources prescribes the numeric allowances selected here.
[Performance budgets 101](https://web.dev/articles/performance-budgets-101),
[Your first performance budget](https://web.dev/articles/your-first-performance-budget)

## Fixed engineering rule

Policy identifier: `bounded-relative-allowance-v1`.

For each positive finite original observation `B`, measured in milliseconds:

```text
allowanceMs = min(2000, max(50, 0.20 * B))
budgetMs = ceil(B + allowanceMs)
pass = positiveFinite(actualMs) && actualMs <= budgetMs
```

The 20% allowance scales with the original journey duration. The 50 ms floor
avoids a tiny absolute tolerance for short pagination operations. The 2000 ms
cap prevents long startup from receiving an unlimited proportional allowance.
All three numbers are explicit engineering choices for this first release,
not measured jitter or externally prescribed standards. Integer rounding adds
less than 1 ms. The rule is uniform across all eight retained metrics and is
fixed before observing the next result.

| Metric | Original observation, ms (rounded for display) | Fixed budget, ms |
| --- | ---: | ---: |
| `startupReadinessMs` | 10664.692 | 12665 |
| `topicsLoadMs` | 1490.396 | 1789 |
| `topicOpenMs` | 1592.657 | 1912 |
| `chatSendMs` | 1305.186 | 1567 |
| `conversationCreateMs` | 1192.244 | 1431 |
| `largeNoteReadMs` | 1568.461 | 1883 |
| `conversationNextPageMs` | 139.035 | 190 |
| `noteNextPageMs` | 419.380 | 504 |

Derivation uses the full precision values in v3, not the display values above.
The budget can admit a real slowdown within its allowance. Passing therefore
means meeting this engineering limit on the recorded runs; it does not prove
no regression or statistical equivalence. In particular, the approximately
12.665-second startup budget is a bound for this pinned release harness, not
a claim that such latency is a desirable general user-experience target.

## Evidence and admission contract

1. Preserve baseline v3 byte for byte, including its original thresholds,
   capture identity, observations digest, and first-observation semantics.
   Preserve the legacy validator for that historical artifact.
2. Store the new policy as a separate fixed artifact. Bind its identifier,
   numeric constants, derived budgets, baseline identity/digest, and policy
   digest into acceptance report v4. Do not accept caller-supplied limits or
   silently infer a policy for a historical report.
3. Seal the policy and candidate before new performance collection. Retain
   exact host, plugin build, browser, viewport, and fixture identity checks;
   matching a duration budget cannot excuse an identity mismatch.
4. Keep the existing exclusive performance qualification and final coherent
   capture. Every required observation in each gate must meet its fixed budget.
   Do not replace these observations with an optimistic run, a cross-run
   selection of favorable metrics, or an aggregate that conceals a failing
   coherent capture. Record actual, baseline, allowance, budget, and verdict
   for every measured metric, including failures.
5. A threshold failure fails that qualification attempt. Preserve its report;
   do not retry until green or recompute the policy from the failing value.
   Investigation may produce a corrected candidate and new qualification,
   with the earlier evidence retained. Missing measurements, timeouts, invalid
   numbers, contention, or identity failures cannot be relabeled as permitted
   variance.
6. Preserve all correctness, conditional-write, accessibility, keyboard,
   recovery, fixture, coverage, independent-evaluation, backup, rollback, and
   live-admission safeguards required by
   [ADR 0004](../adr/0004-first-live-release-core-topics-notes-chat.md).

This tactical rule adds no statistical aggregation claim or new sampling
requirement to the existing release sequence. Future empirical calibration
should predeclare a fixed sequential sample count, environment, aggregation,
and invalid-run rules, retain every result, and version any resulting policy
separately. It must not rewrite the original baseline or retroactively turn
failed evidence into passing evidence.
