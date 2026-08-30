import { createSchedulerAdapter } from './scheduler.mjs';

export function createReminderAdapter(options) {
  const scheduler = createSchedulerAdapter(options);
  return Object.freeze({
    list: async (input) => (await scheduler.list(input)).filter((item) => item.sourceReference.sourceKind === 'reminder_schedule'),
    snooze: scheduler.snooze.bind(scheduler),
    complete: scheduler.complete.bind(scheduler)
  });
}
