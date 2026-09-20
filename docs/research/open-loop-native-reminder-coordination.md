# Open-loop native Reminder coordination

Status: isolated implementation; not registered, activated, deployed or host-qualified.

## Ownership

Open loops retain due and review metadata. Native Scheduler remains the only
timing authority. `createOpenLoopReminderCoordinator` translates one current
open-loop snapshot into one closed Reminder-owner command; it does not poll,
run a second clock or publish notifications.

The exact binding is a deterministic scheduler Source Reference derived from
the open-loop identity. Reminder creation uses the existing staged scheduler
owner: create disabled, bind the exact native identity, then enable through a
revision-fenced write. Create, reschedule and completion receipts remain in the
existing durable operation journal. Retries must reuse the logical operation
ID and original expected scheduler revision.

## Integration hooks

The integration owner should instantiate
`createOpenLoopReminderCoordinator({ api, gateway, metadata })` and call
`reconcile` only after an accepted open-loop state is durable:

- confirmation with an accepted instant creates the owned Reminder;
- a corrected accepted instant reschedules it with the scheduler revision that
  was captured when the correction intent was prepared;
- paid, resolved or cancelled state disables it through Reminder completion;
- removal of an accepted time disables an existing owned Reminder.

The same pending-operation envelope must retain the logical operation ID and
original `expectedConfigRevision` across UI remount and restart. A fresh source
read may diagnose or reconcile an outcome, but must not replace that revision
to make the prior intent succeed. `blocked` and `none` plans are local facts and
must not be presented as native mutation receipts.

The existing `reminders.snooze` owner is the native schedule-only mutation used
for both a user Snooze and a source-date correction. The open-loop coordinator
records `reschedule` in its plan so the product cause remains explicit; this
reuses the registered owner and does not add a parallel Cron command.

## Honest prerequisites and limits

Native Reminders are Topic-owned. A topicless open loop returns
`topic-required`; the coordinator never creates a Topic. A date-only value
returns `date-time-required`; no timezone or time of day is inferred. Missing
time remains unknown. Suggested loops require confirmation before scheduling.

The coordinator emits only native `systemEvent` Reminder declarations with
`next-heartbeat` wake mode. It does not enable Command Center notification
delivery. No bridge registration or background startup scan is included in this
isolated patch. The integration owner must qualify the final packaged
plugin/host pair and explicitly decide when the coordinator is invoked.
