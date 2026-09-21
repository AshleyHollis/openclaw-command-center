---
status: accepted
date: 2026-09-21
issues: [264, 265]
supersedes: 0006 timing ownership for the bounded known-routine case only
---

# Project known routines when the Dashboard is read

## Context

The morning Dashboard is intentionally opened at the user's leisure and does not
need a push, agent run or notification to make a known household routine useful.
Completing a recurring native Scheduler job would disable the whole job, while
the required action applies to one dated occurrence only. A model-run automation
would also make a deterministic household obligation depend on model delivery.

ADR 0006 assigns timing and recurrence to Native Scheduler. That remains correct
for reminders, jobs, wakeups and delivery. The minimum household-routine case has
different semantics: it is a local-calendar projection evaluated only when the
Dashboard is read, with no background execution or external effect.

## Decision

Command Center may own recurrence calculation for explicitly configured, bounded
known routines that meet all of these conditions:

- the routine has a reviewed local timezone, weekday, time and anchor date;
- reading the Dashboard is the only trigger;
- the projection creates no message, notification, agent run or scheduler job;
- each action targets the exact visible calendar-date occurrence;
- completion and deferral are append-only decisions for that occurrence; and
- the original routine source remains reachable through an exact Source Reference.

The configuration may include alternating labels, such as two bin collections.
It contains no personal source content. The mutation owner validates that a
requested occurrence is the one currently visible, then atomically commits the
decision and operation receipt in Command Center SQLite.

Native Scheduler continues to own all active timing, recurrence, wake and
delivery behavior. If a known routine later needs a background wake or device
notification, it must migrate to a native Scheduler occurrence adapter; this
exception cannot be extended into a second job runner.

## Consequences

Opening the Dashboard after the lead window deterministically reveals the same
dated obligation even if an automation failed. Completing it cannot disable the
next recurrence. The Dashboard cannot notify the user while it is closed, which
is deliberate for this on-demand minimum batch.
