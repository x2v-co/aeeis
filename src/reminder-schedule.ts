import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

const maxOccurrences = z.number().int().min(1).max(100_000).optional();
const timeZone = z.string().min(1).max(100).refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value); return true; }
  catch { return false; }
}, 'Use a named IANA time zone, such as Asia/Singapore');
const calendar = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  timeZone, time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).strict().superRefine((value, context) => {
  if ((value.frequency === 'weekly') !== (value.daysOfWeek !== undefined)) {
    context.addIssue({ code: 'custom', path: ['daysOfWeek'], message: 'daysOfWeek is required only for weekly schedules (Monday=1)' });
  }
  if ((value.frequency === 'monthly') !== (value.dayOfMonth !== undefined)) {
    context.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'dayOfMonth is required only for monthly schedules' });
  }
  if (value.daysOfWeek && new Set(value.daysOfWeek).size !== value.daysOfWeek.length) {
    context.addIssue({ code: 'custom', path: ['daysOfWeek'], message: 'Weekdays must be unique' });
  }
});

/** Keep the original interval wire format and request hashes intact. Calendar
 * schedules skip missing local times/dates and fire once at the earlier offset
 * on a repeated local time. Misfires never generate a catch-up burst. */
export const reminderRecurrenceSchema = z.union([
  z.object({ intervalMs: z.number().int().min(60_000).max(31_536_000_000), maxOccurrences }).strict(),
  z.object({ calendar, maxOccurrences }).strict(),
]);
export type ReminderRecurrence = z.infer<typeof reminderRecurrenceSchema>;
export type CalendarSchedule = z.infer<typeof calendar>;

export function nextCalendarOccurrence(schedule: CalendarSchedule, after: string, inclusive = false): string {
  const threshold = Temporal.Instant.from(after);
  let date = threshold.toZonedDateTimeISO(schedule.timeZone).toPlainDate();
  const time = Temporal.PlainTime.from(schedule.time);
  // Daily/weekly/monthly rules always have a match within this bounded window,
  // including missing month days and date-line/DST transitions.
  for (let scanned = 0; scanned < 370; scanned++, date = date.add({ days: 1 })) {
    if (schedule.frequency === 'weekly' && !schedule.daysOfWeek!.includes(date.dayOfWeek)) continue;
    if (schedule.frequency === 'monthly' && date.day !== schedule.dayOfMonth) continue;
    const local = date.toPlainDateTime(time);
    const zoned = local.toZonedDateTime(schedule.timeZone, { disambiguation: 'compatible' });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    const instant = zoned.toInstant();
    const comparison = Temporal.Instant.compare(instant, threshold);
    if (comparison > 0 || (inclusive && comparison === 0)) return instant.toString({ fractionalSecondDigits: 3 });
  }
  throw new RangeError('No calendar reminder occurrence within the supported horizon');
}

export function nextReminderOccurrence(recurrence: ReminderRecurrence, dueAt: string, committedAt: string): string {
  if ('calendar' in recurrence) {
    return nextCalendarOccurrence(recurrence.calendar, Date.parse(dueAt) > Date.parse(committedAt) ? dueAt : committedAt);
  }
  const next = Date.parse(dueAt) + recurrence.intervalMs;
  return new Date(next > Date.parse(committedAt) ? next : Date.parse(committedAt) + recurrence.intervalMs).toISOString();
}
