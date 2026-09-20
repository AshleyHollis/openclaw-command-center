import { createSchedulerAdapter } from './scheduler.mjs';

export function createReminderAdapter(options) {
  const scheduler = createSchedulerAdapter(options);
  return Object.freeze({
    list: async (input) => (await scheduler.list(input)).filter((item) => item.sourceReference.sourceKind === 'reminder_schedule'),
    read: scheduler.read.bind(scheduler),
    create: scheduler.createReminder.bind(scheduler),
    // Corrections use the existing closed schedule-only Reminder mutation. The
    // coordinator retains the product distinction between Snooze and a source
    // date correction without adding a second native scheduling owner.
    reschedule: scheduler.snooze.bind(scheduler),
    snooze: scheduler.snooze.bind(scheduler),
    complete: scheduler.complete.bind(scheduler)
  });
}
